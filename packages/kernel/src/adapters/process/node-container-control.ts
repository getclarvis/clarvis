import { spawn, type ChildProcess } from "node:child_process";
import { killTree, ownProcessGroup } from "@clarvis/tools/shell";
import type { ContainerCommandResult, ContainerControl } from "../../runtime/types.ts";

const KILL_GRACE_MS = 500;
const EXIT_DRAIN_MS = 1_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Engine adapters supply explicit routing and environment; the executor owns process lifetime. */
export interface NodeContainerControlOptions {
  readonly engine: "Docker" | "Podman";
  readonly executable: string;
  readonly prefix: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value! : fallback));
}

function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined && killTree(child.pid, signal)) return;
  child.kill(signal);
}

/**
 * Execute bounded engine CLI calls, settling only after physical exit and output drainage.
 * Cancellation retains the deadline and escalates after a grace period. Capture stops at the
 * byte ceiling even while termination is pending. POSIX children own a process group; Windows
 * uses the shared process-tree termination policy without detached process creation.
 */
export function createNodeContainerControl(options: NodeContainerControlOptions): ContainerControl {
  const timeoutMs = bounded(options.timeoutMs, 30_000, 1_000, 120_000);
  const maxOutputBytes = bounded(options.maxOutputBytes, 1024 * 1024, 1_024, MAX_OUTPUT_BYTES);
  const spawnOptions = { env: { ...options.environment }, detached: ownProcessGroup() };
  return {
    run(args, signal, runOptions = {}) {
      const cancelled = (): Error =>
        signal?.reason instanceof Error ? signal.reason : new Error(`${options.engine} cancelled`);
      if (signal?.aborted === true) return Promise.reject(cancelled());
      return new Promise<ContainerCommandResult>((resolve, reject) => {
        const child = spawn(options.executable, [...options.prefix, ...args], {
          ...spawnOptions,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const outputBound = bounded(
          runOptions.maxOutputBytes,
          maxOutputBytes,
          1_024,
          MAX_OUTPUT_BYTES,
        );
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let failure: Error | undefined;
        let settled = false;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        let drainTimer: ReturnType<typeof setTimeout> | undefined;
        const stop = (error: Error, immediate = false): void => {
          failure ??= error;
          if (settled) return;
          if (immediate) terminate(child, "SIGKILL");
          else if (killTimer === undefined) {
            terminate(child, "SIGTERM");
            killTimer = setTimeout(() => terminate(child, "SIGKILL"), KILL_GRACE_MS);
          }
        };
        const abort = (): void => stop(cancelled());
        const timer = setTimeout(
          () => stop(new Error(`${options.engine} command timed out`), true),
          bounded(runOptions.timeoutMs, timeoutMs, 1_000, 30 * 60 * 1_000),
        );
        const finish = (exitCode: number | null): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(killTimer);
          clearTimeout(drainTimer);
          signal?.removeEventListener("abort", abort);
          if (failure !== undefined) reject(failure);
          else
            resolve({
              exitCode,
              stdout: Buffer.concat(stdout).toString("utf8"),
              stderr: Buffer.concat(stderr).toString("utf8"),
            });
        };
        const append = (chunks: Buffer[], bytes: number, chunk: Buffer): number => {
          if (failure !== undefined) return bytes;
          if (bytes + chunk.length > outputBound) {
            stop(new Error(`${options.engine} output exceeded the configured bound`), true);
            return bytes;
          }
          chunks.push(chunk);
          return bytes + chunk.length;
        };
        child.stdout.on("data", (chunk: Buffer) => {
          stdoutBytes = append(stdout, stdoutBytes, chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderrBytes = append(stderr, stderrBytes, chunk);
        });
        child.once("error", (error) => {
          failure ??= error;
        });
        child.once("exit", (exitCode) => {
          drainTimer = setTimeout(() => {
            stop(new Error(`${options.engine} output did not close after process exit`), true);
            child.stdout.destroy();
            child.stderr.destroy();
            finish(exitCode);
          }, EXIT_DRAIN_MS);
        });
        child.once("close", finish);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted === true) abort();
      });
    },
    attach(args) {
      const child = spawn(options.executable, [...options.prefix, ...args], {
        ...spawnOptions,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        exited: new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        }),
        kill: (signal) => terminate(child, signal),
      };
    },
  };
}
