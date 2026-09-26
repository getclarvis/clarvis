import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { killTree, ownProcessGroup, resolveShell, shellArgs } from "@clarvis/kernel/local";
import { diagnosticEvent } from "../core/diagnostic-events.ts";
import { terminalPlainText } from "../core/terminal-text.ts";

export { stripAnsi } from "../core/terminal-text.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_CAPTURE_BYTES = 64 * 1024;
const KILL_GRACE_MS = 1_500;
const EXIT_DRAIN_MS = 1_000;

/** The outcome of one {@link runLocalBash} call. */
export interface LocalBashResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
}

/** Inputs to {@link runLocalBash}. */
export interface LocalBashOptions {
  cwd: string;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

/** Owned effects for a local shell invocation. */
export interface LocalBashDependencies {
  spawn?: (file: string, args: string[], options: Parameters<typeof spawn>[2]) => LocalShellChild;
  killTree?: typeof killTree;
  ownProcessGroup?: typeof ownProcessGroup;
  resolveShell?: typeof resolveShell;
  shellArgs?: typeof shellArgs;
  now?: () => number;
  timers?: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}

/** Child events and streams consumed by the local shell adapter. */
export interface LocalShellChild {
  readonly pid?: number;
  readonly stdout: Pick<Readable, "on" | "destroy"> | null;
  readonly stderr: Pick<Readable, "on" | "destroy"> | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(
    event: "exit" | "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(signal: NodeJS.Signals): boolean;
}

const REAL_TIMERS = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Collector {
  push(chunk: Buffer): void;
  text(): string;
  truncated(): boolean;
}

/**
 * Accumulates chunks up to `maxBytes`; once the cap is hit the excess of that
 * chunk is dropped and every later `push` is a no-op, so `truncated()` sticks
 * for the rest of the stream instead of only marking the boundary chunk.
 */
function collector(maxBytes: number): Collector {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  return {
    push(chunk) {
      if (truncated) return;
      if (size + chunk.length > maxBytes) {
        chunks.push(chunk.subarray(0, maxBytes - size));
        size = maxBytes;
        truncated = true;
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
    truncated: () => truncated,
  };
}

/**
 * Run a command through the host shell, outside the kernel entirely.
 *
 * @remarks
 * The call path is the `!` prefix in the input dock, so the command is
 * something the user typed and submitted themselves. It does not call
 * `KernelClient` or the agent tool dispatcher.
 *
 * This user command runs through `bash` specifically, rather than the
 * bare `sh` the kernel's tools resolve to: `!` is a user-typed escape hatch
 * that predates this dialect work, and users on a host where `/bin/sh` is
 * `dash` or `ash` (Debian, Ubuntu, Alpine) rely on bash-only syntax here -
 * `[[ ... ]]`, arrays, `source`, brace expansion. Only the executable name
 * changes; `shellArgs` still supplies the ordinary `-c` form for either shell.
 *
 * Every call records a `shell.local.exit` diagnostic carrying the status, the
 * duration and whether it was killed. **The command's text is deliberately not
 * among those fields**: it is whatever the user typed at the `!` prompt, up to
 * and including a credential passed to a one-off script, and `specs/cross-cutting/observability.md`
 * §6 forbids logging a command outright.
 */
export function runLocalBash(
  command: string,
  opts: LocalBashOptions,
  deps: LocalBashDependencies = {},
): Promise<LocalBashResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_CAPTURE_BYTES;
  const now = deps.now ?? Date.now;
  const timers = deps.timers ?? REAL_TIMERS;
  const startedAt = now();
  return new Promise((resolve) => {
    const shell = (deps.resolveShell ?? resolveShell)();
    const file = shell.flavor === "posix" ? "bash" : shell.file;
    const proc: LocalShellChild = (deps.spawn ?? spawn)(
      file,
      (deps.shellArgs ?? shellArgs)(shell, command),
      {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        detached: (deps.ownProcessGroup ?? ownProcessGroup)(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const out = collector(maxBytes);
    const err = collector(maxBytes);
    proc.stdout?.on("data", (c: Buffer) => out.push(c));
    proc.stderr?.on("data", (c: Buffer) => err.push(c));

    let timedOut = false;
    let cancelled = false;
    let spawnError: Error | undefined;
    let settled = false;
    let killTimer: unknown;

    const killAll = (sig: NodeJS.Signals): void => {
      if (proc.pid !== undefined && (deps.killTree ?? killTree)(proc.pid, sig)) return;
      try {
        proc.kill(sig);
      } catch {
        /* already gone */
      }
    };
    const startKill = (): void => {
      killAll("SIGTERM");
      killTimer ??= timers.setTimeout(() => killAll("SIGKILL"), KILL_GRACE_MS);
    };
    const timer = timers.setTimeout(() => {
      timedOut = true;
      startKill();
    }, timeoutMs);
    const onAbort = (): void => {
      cancelled = true;
      startKill();
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    let drainTimer: unknown;
    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      if (killTimer !== undefined) timers.clearTimeout(killTimer);
      if (drainTimer !== undefined) timers.clearTimeout(drainTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      const stderr = terminalPlainText(err.text());
      diagnosticEvent("shell.local.exit", {
        exit_code: code,
        duration_ms: now() - startedAt,
        killed: timedOut || cancelled,
        signal,
        spawn_failed: spawnError !== undefined,
      });
      resolve({
        exitCode: code,
        stdout: terminalPlainText(out.text()),
        stderr: stderr || (spawnError ? spawnError.message : ""),
        signal,
        timedOut,
        cancelled,
        stdoutTruncated: out.truncated(),
        stderrTruncated: err.truncated(),
        durationMs: now() - startedAt,
      });
    };
    proc.on("error", (e) => {
      spawnError = e;
      timers.setTimeout(() => settle(null, null), 0);
    });
    proc.on("exit", (code, signal) => {
      drainTimer = timers.setTimeout(() => {
        proc.stdout?.destroy();
        proc.stderr?.destroy();
        settle(code, signal);
      }, EXIT_DRAIN_MS);
    });
    proc.on("close", (code, signal) => settle(code, signal));
  });
}

function tagBody(text: string, truncated: boolean): string {
  if (!truncated) return text;
  const sep = text.length === 0 || text.endsWith("\n") ? "" : "\n";
  return text + sep + "[output truncated]";
}

/** Renders a `!bash` command and its {@link LocalBashResult} as the tagged text block shown to the model. */
export function formatBashObservation(command: string, r: LocalBashResult): string {
  const attr =
    r.exitCode !== null ? `exit-code="${r.exitCode}"` : `signal="${r.signal ?? "unknown"}"`;
  const lines: string[] = [`<bash-input>${command}</bash-input>`, `<bash-output ${attr}>`];
  const out = tagBody(r.stdout, r.stdoutTruncated);
  if (out.length > 0) lines.push(out);
  lines.push("</bash-output>");
  const errBody = tagBody(r.stderr, r.stderrTruncated);
  if (errBody.length > 0) lines.push("<bash-stderr>", errBody, "</bash-stderr>");
  if (r.timedOut) lines.push("<bash-timed-out />");
  if (r.cancelled) lines.push("<bash-cancelled />");
  return lines.join("\n");
}
