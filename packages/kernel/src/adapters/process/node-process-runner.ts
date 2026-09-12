import { spawn } from "node:child_process";
import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import type {
  ProcessRunner,
  ProcessRunRequest,
  ProcessRunResult,
} from "../../ports/process-runner.ts";

/**
 * Report a child process that did not exit cleanly.
 *
 * @param logger - the local component's logger.
 * @param request - the request that was run; only its command is recorded.
 * @param result - the captured exit.
 * @param durationMs - wall time from spawn to close.
 * @remarks The command's *name* only. Its arguments are not logged: a plugin
 *   fetch carries a repository URL, and a URL can carry credentials.
 *   `stderr` is likewise absent — it is third-party output and the field name
 *   is redacted by the diagnostic sink anyway.
 */
function reportFailure(
  logger: Logger,
  request: ProcessRunRequest,
  result: ProcessRunResult,
  durationMs: number,
): void {
  if (result.exitCode === 0) return;
  logger.warn(
    {
      event: "local.process.failed",
      command: request.command,
      exit_code: result.exitCode,
      duration_ms: durationMs,
      stdout_chars: result.stdout.length,
      stderr_chars: result.stderr.length,
    },
    "a child process exited non-zero; whatever asked for it reports its own failure",
  );
}

/** Convert an environment snapshot into the string-only shape child processes accept. */
function processEnvironment(
  values: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/** Normalize arbitrary abort reasons to the Error contract used by rejected runs. */
function cancellationError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error(typeof reason === "string" ? reason : "process cancelled");
}

/**
 * Create the Node/Bun child-process adapter.
 *
 * @returns a runner that captures output and terminates children on timeout or cancellation.
 */
export function createNodeProcessRunner(logger: Logger = NOOP_LOGGER): ProcessRunner {
  return {
    run(request: ProcessRunRequest): Promise<ProcessRunResult> {
      const startedAt = Date.now();
      return new Promise<ProcessRunResult>((resolve, reject) => {
        if (request.signal?.aborted === true) {
          reject(cancellationError(request.signal.reason));
          return;
        }
        const child = spawn(request.command, [...request.args], {
          ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
          env: processEnvironment(request.environment),
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        let outputBytes = 0;

        const finish = (outcome: { result: ProcessRunResult } | { error: Error }): void => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          request.signal?.removeEventListener("abort", cancel);
          if ("error" in outcome) reject(outcome.error);
          else resolve(outcome.result);
        };
        const cancel = (): void => {
          child.kill("SIGTERM");
          finish({ error: cancellationError(request.signal?.reason) });
        };

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        const admitOutput = (chunk: string): boolean => {
          if (settled) return false;
          outputBytes += Buffer.byteLength(chunk, "utf8");
          if (request.maxOutputBytes !== undefined && outputBytes > request.maxOutputBytes) {
            child.kill("SIGKILL");
            finish({ error: new Error("process output exceeded the admitted limit") });
            return false;
          }
          return true;
        };
        child.stdout.on("data", (chunk: string) => {
          if (admitOutput(chunk)) stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
          if (admitOutput(chunk)) stderr += chunk;
        });
        child.once("error", (error) => finish({ error }));
        child.once("close", (exitCode) => {
          const result: ProcessRunResult = { exitCode, stdout, stderr };
          reportFailure(logger, request, result, Date.now() - startedAt);
          finish({ result });
        });
        request.signal?.addEventListener("abort", cancel, { once: true });
        if (request.timeoutMs !== undefined) {
          timer = setTimeout(() => {
            child.kill("SIGTERM");
            finish({
              error: new Error(`${request.command} timed out after ${String(request.timeoutMs)}ms`),
            });
          }, request.timeoutMs);
          timer.unref?.();
        }
      });
    },
  };
}
