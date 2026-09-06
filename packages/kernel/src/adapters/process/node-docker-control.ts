import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type {
  DockerAttachedProcess,
  DockerCommandResult,
  DockerControl,
  DockerRunOptions,
} from "../../runtime/docker-backend.ts";

/** Explicit Docker CLI configuration; ambient context and host routing are not inherited. */
export interface NodeDockerControlOptions {
  readonly executable: string;
  readonly context: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

/** Create the argv-only Docker CLI control port. */
export function createNodeDockerControl(options: NodeDockerControlOptions): DockerControl {
  if (!isAbsolute(options.executable)) throw new Error("Docker executable must be absolute");
  if (options.context.length === 0) throw new Error("Docker context must be explicit");
  const prefix = ["--context", options.context];
  const timeoutMs = Math.max(1_000, Math.min(120_000, options.timeoutMs ?? 30_000));
  const maxOutputBytes = Math.max(
    1_024,
    Math.min(16 * 1024 * 1024, options.maxOutputBytes ?? 1024 * 1024),
  );
  return {
    run(args, signal, runOptions: DockerRunOptions = {}): Promise<DockerCommandResult> {
      return new Promise((resolve, reject) => {
        if (signal?.aborted === true) {
          reject(signal.reason instanceof Error ? signal.reason : new Error("Docker cancelled"));
          return;
        }
        const child = spawn(options.executable, [...prefix, ...args], {
          env: { ...options.environment },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const commandTimeoutMs = Math.max(
          1_000,
          Math.min(30 * 60 * 1_000, runOptions.timeoutMs ?? timeoutMs),
        );
        const commandMaxOutputBytes = Math.max(
          1_024,
          Math.min(16 * 1024 * 1024, runOptions.maxOutputBytes ?? maxOutputBytes),
        );
        const finish = (outcome: DockerCommandResult | Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          if (outcome instanceof Error) reject(outcome);
          else resolve(outcome);
        };
        const abort = (): void => {
          child.kill("SIGTERM");
          finish(signal?.reason instanceof Error ? signal.reason : new Error("Docker cancelled"));
        };
        const append = (current: string, chunk: Buffer): string => {
          const next = current + chunk.toString("utf8");
          if (Buffer.byteLength(next, "utf8") > commandMaxOutputBytes) {
            child.kill("SIGKILL");
            finish(new Error("Docker output exceeded the configured bound"));
          }
          return next;
        };
        child.stdout.on("data", (chunk: Buffer) => (stdout = append(stdout, chunk)));
        child.stderr.on("data", (chunk: Buffer) => (stderr = append(stderr, chunk)));
        child.once("error", finish);
        child.once("close", (exitCode) => finish({ exitCode, stdout, stderr }));
        signal?.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish(new Error("Docker command timed out"));
        }, commandTimeoutMs);
        timer.unref?.();
      });
    },
    attach(args): DockerAttachedProcess {
      const child = spawn(options.executable, [...prefix, ...args], {
        env: { ...options.environment },
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
        kill: (signal) => child.kill(signal),
      };
    },
  };
}
