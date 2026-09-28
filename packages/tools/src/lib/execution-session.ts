import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import type { Readable } from "node:stream";
import { ToolError } from "../errors.ts";
import type { RuntimeConfig } from "../config.ts";
import { ToolIsolationSetupError } from "../execution/isolation-port.ts";
import {
  SESSION_SUPERVISOR_PROTOCOL_VERSION,
  SupervisorChild,
  sessionSupervisorPath,
  verifySessionSupervisorSource,
  type SupervisorCommandStatus,
} from "../execution/session-supervisor.ts";
import { resolveShell, shellArgs, type ShellSpec } from "../shell.ts";
import { ownProcessGroup } from "./process.ts";
import { ownedTreeRunning, stopOwnedProcess, type OwnedProcess } from "./process-owner.ts";
import { allocateBudget, createOutputCoalescer, type OutputCoalescer } from "./output.ts";
import { createScanBudget } from "./scan-budget.ts";
import { SessionWindow, decodeCursor, encodeCursor, type OutputSlice } from "./session-window.ts";
import { createSessionLog, type SessionLog } from "./session-log.ts";

const SESSION_WINDOW_BYTES = 256 * 1024;
const READY_WINDOW_BYTES = 64 * 1024;
const STDIO_DRAIN_MS = 100;

/** Child events, streams, status and release consumed by a live session. */
export interface SessionChild {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly stdout: Pick<Readable, "setEncoding" | "on" | "removeAllListeners" | "destroy"> | null;
  readonly stderr: Pick<Readable, "setEncoding" | "on" | "removeAllListeners" | "destroy"> | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(
    event: "exit" | "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  once(event: "spawn", listener: () => void): unknown;
  unref(): unknown;
}

/** Launch contract used by the shell handler and session manager. */
export type SpawnSessionChild = (
  file: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
) => SessionChild;

/** One session manager's clock and scheduled work. */
export interface SessionClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Tree probes and confirmed termination for children admitted by one manager. */
export interface SessionOwnership {
  isRunning(owner: OwnedProcess): boolean;
  stop(owner: OwnedProcess, logger: RuntimeConfig["logger"], deadline: number): Promise<boolean>;
}

/** Effects owned by a session manager, including its children. */
export interface ExecutionSessionDependencies {
  clock: SessionClock;
  ownership: SessionOwnership;
  /** Omit for effect-free tests; production allocates run-owned plain-text logs. */
  createLog?: (logger: RuntimeConfig["logger"]) => SessionLog;
}

const REAL_SESSION_DEPS: ExecutionSessionDependencies = {
  clock: {
    now: Date.now,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
  ownership: { isRunning: ownedTreeRunning, stop: stopOwnedProcess },
  createLog: createSessionLog,
};

interface LaunchRequest {
  readonly config: RuntimeConfig;
  readonly agent: object;
  readonly command: string;
  readonly cwd: string;
  readonly shell?: ShellSpec;
  readonly timeoutMs?: number;
  readonly readyWhen?: RegExp;
  readonly signal?: AbortSignal;
  readonly onOutput?: (chunk: string) => void;
  readonly onExecutionStarted?: () => void;
  readonly spawnChild?: SpawnSessionChild;
  readonly keepAlive?: boolean;
  /** Preserve command output for later inspection until confirmed cleanup or eviction. */
  readonly retainOutput?: boolean;
}

export interface SessionPage {
  readonly stdout: OutputSlice;
  readonly stderr: OutputSlice;
  readonly nextCursor: string;
}

export interface SessionResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly stdoutOmittedBytes: number;
  readonly stderrOmittedBytes: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly commandStatus?: SupervisorCommandStatus;
  readonly commandExitCode?: number | null;
  readonly commandSignal?: NodeJS.Signals | null;
}

export type SessionPhase =
  "starting" | "running" | "exited_pending_status" | "exited_draining" | "closed";

export interface SessionSnapshot {
  readonly phase: SessionPhase;
  readonly running: boolean;
  readonly terminationConfirmed: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly ready: boolean;
  readonly timedOut: boolean;
  readonly keepAlive?: true;
  readonly commandStatus?: SupervisorCommandStatus;
  readonly commandExitCode?: number | null;
  readonly commandSignal?: NodeJS.Signals | null;
}

export interface ExecutionSession {
  readonly id: string;
  readonly agent: object;
  readonly command: string;
  readonly cwd: string;
  readonly startedAt: number;
  readonly child: SessionChild;
  readonly completed: Promise<SessionResult>;
  readonly running: boolean;
  readonly terminationConfirmed: boolean;
  readonly ready: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly keepAlive: boolean;
  readonly commandStatus?: SupervisorCommandStatus;
  readonly commandExitCode?: number | null;
  readonly commandSignal?: NodeJS.Signals | null;
  snapshot(): SessionSnapshot;
  readStreams(cursor: string | undefined, limit: number): SessionPage;
  /** Read recent output without paging through historical log bytes. */
  readTail(limit: number): SessionPage;
  /** Report byte totals, log paths and whether capture reached a bound or failed. */
  outputInfo(): Record<string, unknown>;
  /** Batch output until the wait expires, completion, or cancellation; output does not wake it. */
  waitForChange(cursor: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<void>;
  waitReady(timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
  stop(deadline?: number): Promise<boolean>;
}

function utf8Tail(buf: Buffer, maxBytes: number): Buffer {
  if (buf.length <= maxBytes) return buf;
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
  return Buffer.from(buf.subarray(start));
}

class LiveSession implements ExecutionSession {
  readonly startedAt: number;
  readonly completed: Promise<SessionResult>;
  private resolveCompleted!: (result: SessionResult) => void;
  private rejectCompleted!: (error: Error) => void;
  private readonly live: OutputCoalescer | undefined;
  private readonly stdoutWindow = new SessionWindow(SESSION_WINDOW_BYTES);
  private readonly stderrWindow = new SessionWindow(SESSION_WINDOW_BYTES);
  private readyWindow: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private readyMatched = false;
  private readyError: ToolError | undefined;
  private readonly readyBudget;
  private settled = false;
  private didTimeOut = false;
  private wasAborted = false;
  private stopConfirmed = false;
  private spawned = false;
  private timer: unknown;
  private drainTimer: unknown;
  private abortListener: (() => void) | undefined;
  private readonly activityListeners = new Set<() => void>();
  private logFailed = false;
  private logDisposed = false;

  constructor(
    readonly id: string,
    readonly agent: object,
    readonly command: string,
    readonly cwd: string,
    readonly child: SessionChild,
    private readonly config: RuntimeConfig,
    private readonly readyWhen: RegExp | undefined,
    onOutput: ((chunk: string) => void) | undefined,
    private readonly deps: ExecutionSessionDependencies,
    private readonly log?: SessionLog,
    private readonly commandState?: {
      status: SupervisorCommandStatus;
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    },
  ) {
    this.startedAt = deps.clock.now();
    this.completed = new Promise((resolve, reject) => {
      this.resolveCompleted = resolve;
      this.rejectCompleted = reject;
    });
    this.completed.catch(() => undefined);
    this.readyBudget = createScanBudget(config.regexScanBudgetMs, () => deps.clock.now());
    this.live = onOutput ? createOutputCoalescer(onOutput, 200, deps.clock) : undefined;
  }

  get keepAlive(): boolean {
    return this.commandState !== undefined;
  }

  get commandStatus(): SupervisorCommandStatus | undefined {
    return this.commandState?.status;
  }

  get commandExitCode(): number | null | undefined {
    return this.commandState?.exitCode;
  }

  get commandSignal(): NodeJS.Signals | null | undefined {
    return this.commandState?.signal;
  }

  get running(): boolean {
    return this.snapshot().running;
  }

  snapshot(): SessionSnapshot {
    const statusKnown = this.child.exitCode !== null || this.child.signalCode !== null;
    const terminationConfirmed = this.stopConfirmed || (this.spawned && !this.treeRunning());
    const phase: SessionPhase = this.settled
      ? "closed"
      : statusKnown
        ? "exited_draining"
        : terminationConfirmed
          ? "exited_pending_status"
          : this.spawned
            ? "running"
            : "starting";
    return {
      phase,
      running: phase === "running" || phase === "starting",
      terminationConfirmed,
      exitCode: this.child.exitCode,
      signal: this.child.signalCode,
      ready: this.readyMatched,
      timedOut: this.didTimeOut,
      ...(this.commandState === undefined
        ? {}
        : {
            keepAlive: true as const,
            commandStatus: this.commandState.status,
            commandExitCode: this.commandState.exitCode,
            commandSignal: this.commandState.signal,
          }),
    };
  }

  get ready(): boolean {
    return this.readyMatched;
  }

  get terminationConfirmed(): boolean {
    return this.snapshot().terminationConfirmed;
  }

  get exitCode(): number | null {
    return this.child.exitCode;
  }

  get signal(): NodeJS.Signals | null {
    return this.child.signalCode;
  }

  get timedOut(): boolean {
    return this.didTimeOut;
  }

  get aborted(): boolean {
    return this.wasAborted;
  }

  treeRunning(): boolean {
    return this.child.pid !== undefined && this.deps.ownership.isRunning(this.ownedProcess());
  }

  private ownedProcess() {
    return {
      pid: this.child.pid!,
      child: this.child,
    };
  }

  start(signal?: AbortSignal, timeoutMs?: number, onExecutionStarted?: () => void): void {
    const deadline = timeoutMs === undefined ? undefined : this.deps.clock.now() + timeoutMs;
    const expire = () => {
      if (this.didTimeOut || this.settled || !this.running) return;
      this.didTimeOut = true;
      this.stop(this.deps.clock.now() + 1_200).catch((error: unknown) => {
        this.config.logger.warn(
          {
            event: "tools.session_stop_failed",
            cause: error instanceof Error ? error.name : "unknown",
          },
          "command stop failed",
        );
      });
    };
    const capture = (stream: "stdout" | "stderr") => (text: string) => {
      if (deadline !== undefined && this.deps.clock.now() >= deadline) expire();
      this.live?.push(text);
      (stream === "stdout" ? this.stdoutWindow : this.stderrWindow).push(text);
      if (this.log && !this.logFailed && !this.logDisposed) {
        try {
          this.log[stream].push(text);
        } catch {
          this.logFailed = true;
          this.config.logger.warn(
            { event: "tools.session_log_failed" },
            "Session log capture failed; recent output remains available",
          );
        }
      }
      this.scanReady(text);
      this.notifyActivity();
    };
    this.child.stdout?.setEncoding("utf8");
    this.child.stderr?.setEncoding("utf8");
    this.child.stdout?.on("data", capture("stdout"));
    this.child.stderr?.on("data", capture("stderr"));
    if (timeoutMs !== undefined) this.timer = this.deps.clock.setTimeout(expire, timeoutMs);
    if (signal !== undefined) {
      this.abortListener = () => {
        if (this.settled || !this.running) return;
        this.wasAborted = true;
        this.stop(this.deps.clock.now() + 1_200).catch((error: unknown) => {
          this.config.logger.warn(
            {
              event: "tools.session_stop_failed",
              cause: error instanceof Error ? error.name : "unknown",
            },
            "command stop failed",
          );
        });
      };
      if (signal.aborted) this.abortListener();
      else signal.addEventListener("abort", this.abortListener, { once: true });
    }
    this.child.on("error", (error) => {
      if (!this.beginSettle(signal)) return;
      this.rejectCompleted(new ToolError("io_error", `Failed to run command: ${error.message}`));
    });
    this.child.on("exit", (code, exitSignal) => {
      if (this.timer !== undefined) this.deps.clock.clearTimeout(this.timer);
      if (this.drainTimer !== undefined) this.deps.clock.clearTimeout(this.drainTimer);
      this.drainTimer = this.deps.clock.setTimeout(
        () => void this.finish(code, exitSignal, signal),
        STDIO_DRAIN_MS,
      );
    });
    this.child.on("close", (code, exitSignal) => void this.finish(code, exitSignal, signal));
    this.child.once("spawn", () => {
      this.spawned = true;
      if (!this.settled && !signal?.aborted) onExecutionStarted?.();
    });
  }

  private scanReady(text: string): void {
    const chunk = Buffer.from(text, "utf8");
    if (this.readyWhen === undefined || this.readyMatched || this.readyError !== undefined) return;
    this.readyWindow = utf8Tail(Buffer.concat([this.readyWindow, chunk]), READY_WINDOW_BYTES);
    if (this.readyBudget.exhausted()) {
      this.readyError = new ToolError("invalid_input", "ready_when regex scan budget exhausted");
      return;
    }
    this.readyMatched = this.readyBudget.charge(() =>
      this.readyWhen!.test(this.readyWindow.toString("utf8")),
    );
  }

  readStreams(cursor: string | undefined, limit: number): SessionPage {
    const offsets = decodeCursor(cursor);
    const outPending = this.stdoutWindow.totalBytes > offsets.stdout;
    const errPending = this.stderrWindow.totalBytes > offsets.stderr;
    const outLimit = outPending && errPending ? Math.max(1, Math.floor(limit / 2)) : limit;
    const errLimit = outPending && errPending ? Math.max(1, limit - outLimit) : limit;
    const read = (stream: "stdout" | "stderr", offset: number, budget: number) => {
      const window = stream === "stdout" ? this.stdoutWindow : this.stderrWindow;
      const archive = this.log?.[stream];
      if (!this.logFailed && !this.logDisposed && archive && offset < archive.totalBytes) {
        const slice = archive.read(offset, budget);
        return { ...slice, more: slice.nextOffset < window.totalBytes };
      }
      return window.read(offset, budget);
    };
    const stdout = read("stdout", offsets.stdout, outLimit);
    const stderr = read("stderr", offsets.stderr, errLimit);
    return {
      stdout,
      stderr,
      nextCursor: encodeCursor({ stdout: stdout.nextOffset, stderr: stderr.nextOffset }),
    };
  }

  readTail(limit: number): SessionPage {
    const [outBudget, errBudget] = allocateBudget(
      this.stdoutWindow.totalBytes,
      this.stderrWindow.totalBytes,
      limit,
    );
    const read = (window: SessionWindow, budget: number) =>
      window.read(Math.max(0, window.totalBytes - budget), Math.max(1, budget));
    const stdout = read(this.stdoutWindow, outBudget);
    const stderr = read(this.stderrWindow, errBudget);
    return {
      stdout,
      stderr,
      nextCursor: encodeCursor({ stdout: stdout.nextOffset, stderr: stderr.nextOffset }),
    };
  }

  outputInfo(): Record<string, unknown> {
    return {
      stdout_bytes: this.stdoutWindow.totalBytes,
      stderr_bytes: this.stderrWindow.totalBytes,
      ...(this.log
        ? {
            stdout_log: this.log.stdoutPath,
            stderr_log: this.log.stderrPath,
            log_truncated:
              this.logFailed ||
              this.stdoutWindow.totalBytes > this.log.stdout.totalBytes ||
              this.stderrWindow.totalBytes > this.log.stderr.totalBytes,
          }
        : {}),
    };
  }

  disposeOutput(): void {
    this.logDisposed = true;
    this.log?.dispose();
  }

  private notifyActivity(): void {
    for (const listener of this.activityListeners) listener();
  }

  async waitForChange(
    cursor: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    decodeCursor(cursor);
    const changed = () => this.settled || signal?.aborted === true;
    if (changed() || timeoutMs <= 0) return;
    await new Promise<void>((resolve) => {
      const wake = () => {
        if (!changed()) return;
        this.deps.clock.clearTimeout(timer);
        this.activityListeners.delete(wake);
        signal?.removeEventListener("abort", wake);
        resolve();
      };
      const timer = this.deps.clock.setTimeout(() => {
        this.activityListeners.delete(wake);
        signal?.removeEventListener("abort", wake);
        resolve();
      }, timeoutMs);
      this.activityListeners.add(wake);
      signal?.addEventListener("abort", wake, { once: true });
      wake();
    });
  }

  async waitReady(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (this.readyError !== undefined) throw this.readyError;
    if (signal?.aborted) throw new ToolError("aborted", "Session readiness wait aborted");
    if (this.readyMatched || this.settled || timeoutMs <= 0) return this.readyMatched;
    return new Promise<boolean>((resolve, reject) => {
      const finish = (ready: boolean, error?: Error) => {
        if (timer !== undefined) this.deps.clock.clearTimeout(timer);
        this.activityListeners.delete(check);
        signal?.removeEventListener("abort", check);
        if (error !== undefined) reject(error);
        else resolve(ready);
      };
      const check = () => {
        if (this.readyError !== undefined) finish(false, this.readyError);
        else if (signal?.aborted)
          finish(false, new ToolError("aborted", "Session readiness wait aborted"));
        else if (this.readyMatched || this.settled) finish(this.readyMatched);
      };
      this.activityListeners.add(check);
      signal?.addEventListener("abort", check, { once: true });
      const timer = this.deps.clock.setTimeout(() => finish(false), timeoutMs);
      check();
    });
  }

  async stop(deadline = this.deps.clock.now() + 1_200): Promise<boolean> {
    if (this.child.pid === undefined) return !this.running;
    const confirmed = await this.deps.ownership.stop(
      this.ownedProcess(),
      this.config.logger,
      deadline,
    );
    if (confirmed) this.stopConfirmed = true;
    return confirmed;
  }

  private beginSettle(signal?: AbortSignal): boolean {
    if (this.settled) return false;
    this.settled = true;
    if (this.timer !== undefined) this.deps.clock.clearTimeout(this.timer);
    if (this.drainTimer !== undefined) this.deps.clock.clearTimeout(this.drainTimer);
    if (signal !== undefined && this.abortListener !== undefined)
      signal.removeEventListener("abort", this.abortListener);
    this.live?.settle();
    this.notifyActivity();
    this.child.stdout?.removeAllListeners("data");
    this.child.stderr?.removeAllListeners("data");
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
    this.child.unref();
    return true;
  }

  private finish(code: number | null, exitSignal: NodeJS.Signals | null, signal?: AbortSignal) {
    if (!this.beginSettle(signal)) return;
    try {
      const stdoutBytes = this.stdoutWindow.totalBytes;
      const stderrBytes = this.stderrWindow.totalBytes;
      const [outBudget, errBudget] = allocateBudget(
        stdoutBytes,
        stderrBytes,
        this.config.maxShellOutputBytes,
      );
      const tail = (window: SessionWindow, budget: number) => {
        if (budget === 0) return { text: "", omitted: window.totalBytes };
        const offset = Math.max(0, window.totalBytes - budget);
        const slice = window.read(offset, budget);
        const omitted = offset + slice.omittedBefore;
        return {
          text:
            omitted > 0
              ? `[... earlier output truncated: last ${window.totalBytes - omitted} of ${window.totalBytes} bytes shown ...]\n${slice.text}`
              : slice.text,
          omitted,
        };
      };
      const stdout = tail(this.stdoutWindow, outBudget);
      const stderr = tail(this.stderrWindow, errBudget);
      this.resolveCompleted({
        code,
        signal: exitSignal,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutBytes,
        stderrBytes,
        stdoutTruncated: stdout.omitted > 0,
        stderrTruncated: stderr.omitted > 0,
        stdoutOmittedBytes: stdout.omitted,
        stderrOmittedBytes: stderr.omitted,
        timedOut: this.didTimeOut,
        aborted: this.wasAborted,
        ...(this.commandState === undefined
          ? {}
          : {
              commandStatus: this.commandState.status,
              commandExitCode: this.commandState.exitCode,
              commandSignal: this.commandState.signal,
            }),
      });
    } catch (error) {
      this.rejectCompleted(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

/** One run-local authority for shell processes and their bounded output. */
export class ExecutionSessionManager {
  private readonly sessions = new Map<string, LiveSession>();
  private closed = false;

  constructor(
    private readonly afterSpawn?: (child: SessionChild) => void,
    private readonly deps: ExecutionSessionDependencies = REAL_SESSION_DEPS,
  ) {}

  get clock(): SessionClock {
    return this.deps.clock;
  }

  async launch(request: LaunchRequest): Promise<ExecutionSession> {
    if (this.closed) throw new ToolError("aborted", "Process admission is closed");
    if (request.signal?.aborted) throw new ToolError("aborted", "Command aborted");
    for (const [id, session] of this.sessions) {
      if (!session.treeRunning() && this.sessions.size >= request.config.maxSessions)
        this.forget(id);
    }
    if (this.sessions.size >= request.config.maxSessions) {
      throw new ToolError("too_many_sessions", "Too many live command sessions");
    }
    const id = `ses_${randomBytes(16).toString("hex")}`;
    const resolvedShell = request.shell ?? resolveShell();
    const env = { ...process.env };
    for (const name of request.config.secretEnvNames ?? []) delete env[name];
    if (request.config.executionPolicy?.mode === "sandbox") {
      env.HOME = request.config.executionPolicy.homeRoot;
      env.CLARVIS_HOME = request.config.executionPolicy.globalRoot;
    }
    const temporaryRoot = request.config.temporaryRoots[0];
    if (temporaryRoot !== undefined) {
      env.TMPDIR = temporaryRoot;
      env.TEMP = temporaryRoot;
      env.TMP = temporaryRoot;
    }
    const shellSpec = {
      file: resolvedShell.file,
      args: shellArgs(resolvedShell, request.command),
      options: { cwd: request.cwd, env },
    };
    if (request.keepAlive && request.config.actionValid?.() === false) {
      throw new ToolError("sandbox_denied", "Action authority changed before session retention");
    }
    const supervisor = request.keepAlive
      ? this.prepareSupervisor(
          request.config,
          shellSpec.options.cwd,
          shellSpec.options.env as Record<string, string>,
        )
      : undefined;
    const prepared = request.config.executionPolicy
      ? request.config.sandboxBackend?.prepare(
          request.config.executionPolicy,
          supervisor ?? {
            file: shellSpec.file,
            args: shellSpec.args,
            cwd: shellSpec.options.cwd,
            env: shellSpec.options.env as Record<string, string>,
          },
        )
      : undefined;
    const spec = prepared
      ? {
          file: prepared.file,
          args: [...prepared.args],
          options: { cwd: prepared.cwd, env: prepared.env },
        }
      : shellSpec;
    const detached = ownProcessGroup();
    request.config.logger.debug(
      {
        event: "tools.shell_spawn",
        shell_file: spec.file,
        flavor: resolvedShell.flavor,
        detached,
        cwd: request.cwd,
        timeout_ms: request.timeoutMs,
        execution_mode: prepared?.backend ?? "host",
      },
      "a shell command is being spawned under the run-owned process manager",
    );
    if (request.config.actionValid?.() === false || request.signal?.aborted) {
      throw new ToolError("sandbox_denied", "Action authority changed before process launch");
    }
    let child: SessionChild;
    let supervisorChild: SupervisorChild | undefined;
    const log = request.retainOutput ? this.deps.createLog?.(request.config.logger) : undefined;
    try {
      if (request.keepAlive) {
        supervisorChild = new SupervisorChild(
          spawn(spec.file, spec.args, {
            ...spec.options,
            stdio: ["pipe", "pipe", "pipe"],
            detached,
          }),
        );
        child = supervisorChild;
      } else {
        child = (request.spawnChild ?? spawn)(spec.file, spec.args, {
          ...spec.options,
          stdio: ["ignore", "pipe", "pipe"],
          detached,
        });
      }
    } catch (error) {
      log?.dispose();
      throw new ToolError("io_error", `Failed to spawn command: ${(error as Error).message}`);
    }
    if (child.pid === undefined) {
      log?.dispose();
      child.on("error", () => {});
      throw new ToolError("io_error", "Failed to run command: process has no pid");
    }
    request.config.actionStarted?.(prepared?.backend ?? "host");
    const session = new LiveSession(
      id,
      request.agent,
      request.command,
      request.cwd,
      child,
      request.config,
      request.readyWhen,
      request.onOutput,
      this.deps,
      log,
      supervisorChild?.commandState,
    );
    try {
      this.sessions.set(id, session);
      session.start(request.signal, request.timeoutMs, request.onExecutionStarted);
      this.afterSpawn?.(child);
      if (supervisorChild && supervisor) {
        supervisorChild.sendInit({
          version: SESSION_SUPERVISOR_PROTOCOL_VERSION,
          type: "init",
          file: shellSpec.file,
          args: shellSpec.args,
          cwd: shellSpec.options.cwd,
          env: shellSpec.options.env as Record<string, string>,
        });
      }
      if (this.closed) throw new ToolError("aborted", "Process admission is closed");
      return session;
    } catch (error) {
      if (await session.stop()) this.forget(id);
      throw error;
    }
  }

  private prepareSupervisor(
    config: RuntimeConfig,
    cwd: string,
    env: Record<string, string>,
  ): { file: string; args: string[]; cwd: string; env: Record<string, string> } {
    const policy = config.executionPolicy;
    const backend = config.sandboxBackend;
    if (
      process.platform !== "linux" ||
      policy?.mode !== "sandbox" ||
      backend?.name !== "bubblewrap" ||
      backend.capabilities?.pidNamespace !== true
    ) {
      throw new ToolIsolationSetupError(
        "sandbox_unavailable",
        "Retained sessions require the Linux Bubblewrap PID namespace backend",
        backend && policy ? { backend: backend.name, policyId: policy.id } : undefined,
      );
    }
    const helper = sessionSupervisorPath();
    try {
      verifySessionSupervisorSource(helper);
      const canonical = realpathSync(helper);
      const installed = policy.installationRoots.some((root) => {
        const suffix = relative(realpathSync(root), canonical);
        return (
          suffix === "" ||
          (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
        );
      });
      if (!installed) throw new Error("supervisor is outside installation roots");
    } catch {
      throw new ToolIsolationSetupError(
        "sandbox_setup_failed",
        "Retained-session supervisor cannot be verified",
        { backend: backend.name, policyId: policy.id },
      );
    }
    return {
      file: process.execPath,
      args: [helper],
      cwd,
      env,
    };
  }

  getSession(id: string, agent: object): ExecutionSession {
    const session = this.sessions.get(id);
    if (this.closed || session === undefined || session.agent !== agent)
      throw new ToolError("not_found", `No such session: ${id}`, { session_id: id });
    return session;
  }

  listSessions(agent: object): ExecutionSession[] {
    if (this.closed) return [];
    return [...this.sessions.values()].filter((session) => session.agent === agent);
  }

  forget(id: string): void {
    this.sessions.get(id)?.disposeOutput();
    this.sessions.delete(id);
  }

  /** Close admission, stop every tracked process and confirm physical exit. */
  async close(budgetMs = 1_200): Promise<boolean> {
    this.closed = true;
    const deadline = this.deps.clock.now() + budgetMs;
    const outcomes = await Promise.all([
      ...[...this.sessions.values()].map(async (session) => {
        const confirmed = await session.stop(deadline);
        if (confirmed) {
          this.forget(session.id);
        }
        return confirmed;
      }),
    ]);
    return outcomes.every(Boolean);
  }
}
