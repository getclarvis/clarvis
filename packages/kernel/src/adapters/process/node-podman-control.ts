import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type {
  PodmanAttachedProcess,
  PodmanCommandResult,
  PodmanControl,
} from "../../runtime/podman-backend.ts";

/** Explicit CLI configuration; ambient engine-routing variables are not inherited. */
export interface NodePodmanControlOptions {
  readonly executable: string;
  readonly connection: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

/** Create the concrete argv-only Podman CLI control port. */
export function createNodePodmanControl(options: NodePodmanControlOptions): PodmanControl {
  if (!isAbsolute(options.executable)) throw new Error("Podman executable must be absolute");
  if (options.connection.length === 0) throw new Error("Podman connection must be explicit");
  const prefix = options.connection === "local" ? [] : ["--connection", options.connection];
  const timeoutMs = Math.max(1_000, Math.min(120_000, options.timeoutMs ?? 30_000));
  const maxOutputBytes = Math.max(
    1_024,
    Math.min(16 * 1024 * 1024, options.maxOutputBytes ?? 1024 * 1024),
  );
  return {
    run(args, signal): Promise<PodmanCommandResult> {
      return new Promise((resolve, reject) => {
        if (signal?.aborted === true) {
          reject(signal.reason instanceof Error ? signal.reason : new Error("Podman cancelled"));
          return;
        }
        const child = spawn(options.executable, [...prefix, ...args], {
          env: { ...options.environment },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const abort = (): void => {
          child.kill("SIGTERM");
          finish(signal?.reason instanceof Error ? signal.reason : new Error("Podman cancelled"));
        };
        const finish = (outcome: PodmanCommandResult | Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          if (outcome instanceof Error) reject(outcome);
          else resolve(outcome);
        };
        const append = (current: string, chunk: Buffer): string => {
          const next = current + chunk.toString("utf8");
          if (Buffer.byteLength(next, "utf8") > maxOutputBytes) {
            child.kill("SIGKILL");
            finish(new Error("Podman output exceeded the configured bound"));
          }
          return next;
        };
        child.stdout.on("data", (chunk: Buffer) => {
          stdout = append(stdout, chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = append(stderr, chunk);
        });
        child.once("error", finish);
        child.once("close", (exitCode) => finish({ exitCode, stdout, stderr }));
        signal?.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish(new Error("Podman command timed out"));
        }, timeoutMs);
        timer.unref?.();
      });
    },
    attach(args): PodmanAttachedProcess {
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
        kill: (signal) => {
          child.kill(signal);
        },
      };
    },
  };
}
