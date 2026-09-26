import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { ToolError } from "../errors.ts";
import type { RuntimeConfig } from "../config.ts";
import { resolveShell, shellArgs, type ShellSpec } from "../shell.ts";
import { ownProcessGroup } from "./process.ts";
import { ownedTreeRunning, stopOwnedProcess } from "./process-owner.ts";
import { allocateBudget, createOutputCoalescer, type OutputCoalescer } from "./output.ts";
import { createScanBudget } from "./scan-budget.ts";
import { SessionWindow, decodeCursor, encodeCursor, type OutputSlice } from "./session-window.ts";

const SESSION_WINDOW_BYTES = 256 * 1024;
const READY_WINDOW_BYTES = 64 * 1024;
const STDIO_DRAIN_MS = 100;

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
  readonly spawnChild?: typeof spawn;
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
}

export interface ExecutionSession {
  readonly id: string;
  readonly agent: object;
  readonly command: string;
  readonly cwd: string;
  readonly startedAt: number;
  readonly child: ChildProcess;
  readonly completed: Promise<SessionResult>;
  readonly running: boolean;
  readonly terminationConfirmed: boolean;
  readonly ready: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  snapshot(): SessionSnapshot;
  readStreams(cursor: string | undefined, limit: number): SessionPage;
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
  readonly startedAt = Date.now();
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
  private timer: ReturnType<typeof setTimeout> | undefined;
  private drainTimer: ReturnType<typeof setTimeout> | undefined;
  private abortListener: (() => void) | undefined;
  private readonly activityListeners = new Set<() => void>();

  constructor(
    readonly id: string,
    readonly agent: object,
    readonly command: string,
    readonly cwd: string,
    readonly child: ChildProcess,
    private readonly config: RuntimeConfig,
    private readonly readyWhen: RegExp | undefined,
    onOutput: ((chunk: string) => void) | undefined,
  ) {
    this.completed = new Promise((resolve, reject) => {
      this.resolveCompleted = resolve;
      this.rejectCompleted = reject;
    });
    this.completed.catch(() => undefined);
    this.readyBudget = createScanBudget(config.regexScanBudgetMs);
    this.live = onOutput ? createOutputCoalescer(onOutput) : undefined;
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
    return this.child.pid !== undefined && ownedTreeRunning(this.ownedProcess());
  }

  private ownedProcess() {
    return {
      pid: this.child.pid!,
      child: this.child,
    };
  }

  start(signal?: AbortSignal, timeoutMs?: number, onExecutionStarted?: () => void): void {
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    const expire = () => {
      if (this.didTimeOut || this.settled || !this.running) return;
      this.didTimeOut = true;
      this.stop(Date.now() + 1_200).catch((error: unknown) => {
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
      if (deadline !== undefined && Date.now() >= deadline) expire();
      this.live?.push(text);
      (stream === "stdout" ? this.stdoutWindow : this.stderrWindow).push(text);
      this.scanReady(text);
      this.notifyActivity();
    };
    this.child.stdout?.setEncoding("utf8");
    this.child.stderr?.setEncoding("utf8");
    this.child.stdout?.on("data", capture("stdout"));
    this.child.stderr?.on("data", capture("stderr"));
    if (timeoutMs !== undefined) this.timer = setTimeout(expire, timeoutMs);
    if (signal !== undefined) {
      this.abortListener = () => {
        if (this.settled || !this.running) return;
        this.wasAborted = true;
        this.stop(Date.now() + 1_200).catch((error: unknown) => {
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
      if (this.timer !== undefined) clearTimeout(this.timer);
      if (this.drainTimer !== undefined) clearTimeout(this.drainTimer);
      this.drainTimer = setTimeout(
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
    const stdout = this.stdoutWindow.read(offsets.stdout, outLimit);
    const stderr = this.stderrWindow.read(offsets.stderr, errLimit);
    return {
      stdout,
      stderr,
      nextCursor: encodeCursor({ stdout: stdout.nextOffset, stderr: stderr.nextOffset }),
    };
  }

  private notifyActivity(): void {
    for (const listener of this.activityListeners) listener();
  }

  async waitForChange(
    cursor: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const offsets = decodeCursor(cursor);
    const changed = () =>
      this.stdoutWindow.totalBytes > offsets.stdout ||
      this.stderrWindow.totalBytes > offsets.stderr ||
      this.settled ||
      signal?.aborted === true;
    if (changed() || timeoutMs <= 0) return;
    await new Promise<void>((resolve) => {
      const wake = () => {
        if (!changed()) return;
        clearTimeout(timer);
        this.activityListeners.delete(wake);
        signal?.removeEventListener("abort", wake);
        resolve();
      };
      const timer = setTimeout(() => {
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
    const deadline = Date.now() + timeoutMs;
    while (!this.readyMatched && !this.settled && Date.now() < deadline && !signal?.aborted) {
      if (this.readyError !== undefined) throw this.readyError;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (this.readyError !== undefined) throw this.readyError;
    if (signal?.aborted) throw new ToolError("aborted", "Session readiness wait aborted");
    return this.readyMatched;
  }

  async stop(deadline = Date.now() + 1_200): Promise<boolean> {
    if (this.child.pid === undefined) return !this.running;
    const confirmed = await stopOwnedProcess(this.ownedProcess(), this.config.logger, deadline);
    if (confirmed) this.stopConfirmed = true;
    return confirmed;
  }

  private beginSettle(signal?: AbortSignal): boolean {
    if (this.settled) return false;
    this.settled = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.drainTimer !== undefined) clearTimeout(this.drainTimer);
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

  constructor(private readonly afterSpawn?: (child: ChildProcess) => void) {}

  async launch(request: LaunchRequest): Promise<ExecutionSession> {
    if (this.closed) throw new ToolError("aborted", "Process admission is closed");
    if (request.signal?.aborted) throw new ToolError("aborted", "Command aborted");
    for (const [id, session] of this.sessions) {
      if (!session.treeRunning() && this.sessions.size >= request.config.maxSessions)
        this.sessions.delete(id);
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
    const prepared = request.config.executionPolicy
      ? request.config.sandboxBackend?.prepare(request.config.executionPolicy, {
          file: shellSpec.file,
          args: shellSpec.args,
          cwd: shellSpec.options.cwd,
          env: shellSpec.options.env as Record<string, string>,
        })
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
    let child: ChildProcess;
    try {
      child = (request.spawnChild ?? spawn)(spec.file, spec.args, {
        ...spec.options,
        stdio: ["ignore", "pipe", "pipe"],
        detached,
      });
    } catch (error) {
      throw new ToolError("io_error", `Failed to spawn command: ${(error as Error).message}`);
    }
    if (child.pid === undefined) {
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
    );
    try {
      this.sessions.set(id, session);
      session.start(request.signal, request.timeoutMs, request.onExecutionStarted);
      this.afterSpawn?.(child);
      if (this.closed) throw new ToolError("aborted", "Process admission is closed");
      return session;
    } catch (error) {
      if (await session.stop()) this.sessions.delete(id);
      throw error;
    }
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
    this.sessions.delete(id);
  }

  /** Close admission, stop every tracked process and confirm physical exit. */
  async close(budgetMs = 1_200): Promise<boolean> {
    this.closed = true;
    const deadline = Date.now() + budgetMs;
    const outcomes = await Promise.all([
      ...[...this.sessions.values()].map((session) => session.stop(deadline)),
    ]);
    return outcomes.every(Boolean);
  }
}
