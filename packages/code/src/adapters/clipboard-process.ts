import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { killTree, ownProcessGroup } from "@clarvis/kernel/local";

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_STDOUT_BYTES = 20 * 1024 * 1024;
const MAX_STDERR_BYTES = 4 * 1024;
const KILL_GRACE_MS = 250;

/** Inputs for one clipboard helper process. */
export interface ClipboardProcessRequest {
  command: string;
  args: readonly string[];
  stdin?: string | Buffer;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxStdoutBytes?: number;
}

/** Settled outcome of a clipboard helper process. */
export interface ClipboardProcessResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  outputExceeded: boolean;
  error?: Error;
}

type SpawnClipboardProcess = (
  command: string,
  args: readonly string[],
  options: Parameters<typeof spawn>[2],
) => ChildProcessWithoutNullStreams;

/** Injectable seams for deterministic process lifecycle tests. */
export interface ClipboardProcessDependencies {
  spawn?: SpawnClipboardProcess;
  killTree?: typeof killTree;
  ownProcessGroup?: typeof ownProcessGroup;
  killGraceMs?: number;
}

function appendCapped(chunks: Buffer[], size: number, chunk: Buffer, cap: number): number {
  const remaining = cap - size;
  if (remaining <= 0) return size;
  chunks.push(chunk.length <= remaining ? chunk : chunk.subarray(0, remaining));
  return size + Math.min(chunk.length, remaining);
}

/**
 * Run one native clipboard helper without blocking the TUI event loop.
 *
 * The process tree is bounded by a hard timeout/cancellation signal, stdout is
 * captured as bytes for PNG payloads, and oversized output terminates the
 * helper instead of growing the process indefinitely.
 */
export function runClipboardProcess(
  request: ClipboardProcessRequest,
  dependencies: ClipboardProcessDependencies = {},
): Promise<ClipboardProcessResult> {
  const spawnProcess = dependencies.spawn ?? spawn;
  const signalTree = dependencies.killTree ?? killTree;
  const detached = (dependencies.ownProcessGroup ?? ownProcessGroup)();
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxStdoutBytes = request.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const killGraceMs = dependencies.killGraceMs ?? KILL_GRACE_MS;

  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnProcess(request.command, request.args, {
        env: process.env,
        detached,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        exitCode: null,
        stdout: Buffer.alloc(0),
        stderr: "",
        timedOut: false,
        cancelled: false,
        outputExceeded: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let timedOut = false;
    let cancelled = false;
    let outputExceeded = false;
    let processError: Error | undefined;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const kill = (processSignal: NodeJS.Signals): void => {
      if (child.pid !== undefined && signalTree(child.pid, processSignal)) return;
      try {
        child.kill(processSignal);
      } catch {
        // The process may have exited between the state check and the signal.
      }
    };
    const terminate = (): void => {
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), killGraceMs);
      killTimer.unref?.();
    };
    const onAbort = (): void => {
      cancelled = true;
      terminate();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timer.unref?.();

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      request.signal?.removeEventListener("abort", onAbort);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        cancelled,
        outputExceeded,
        ...(processError !== undefined ? { error: processError } : {}),
      });
    };

    child.stdout.on("data", (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (stdoutSize + chunk.length > maxStdoutBytes) {
        outputExceeded = true;
        stdoutSize = appendCapped(stdout, stdoutSize, chunk, maxStdoutBytes);
        terminate();
        return;
      }
      stdout.push(chunk);
      stdoutSize += chunk.length;
    });
    child.stderr.on("data", (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      stderrSize = appendCapped(stderr, stderrSize, chunk, MAX_STDERR_BYTES);
    });
    child.once("error", (error) => {
      processError = error;
      finish(null);
    });
    child.once("close", (exitCode) => finish(exitCode));

    if (request.signal?.aborted) onAbort();
    else request.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdin.on("error", () => {
      // EPIPE is represented by the child's exit result and is not fatal here.
    });
    child.stdin.end(request.stdin);
  });
}
