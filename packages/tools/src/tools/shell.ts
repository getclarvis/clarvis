import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { ToolError } from "../errors.ts";
import { resolvePath } from "../lib/paths.ts";
import { statDirectory } from "../lib/files.ts";
import type { SessionResult, SpawnSessionChild } from "../lib/execution-session.ts";
import { shellSessionView } from "./shell-session.ts";
import type { RuntimeConfig } from "../config.ts";
import type { ToolDef } from "./types.ts";

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_YIELD_MS = 30_000;

function readinessPattern(value: string | undefined): RegExp | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  try {
    return new RegExp(value);
  } catch (error) {
    throw new ToolError("invalid_input", `Invalid ready_when regex: ${(error as Error).message}`);
  }
}

/**
 * Reduce a child's `(code, signal)` termination to a single exit code, using the
 * shell convention `128 + signum` when the process was killed by a signal.
 *
 * @param code - the exit code, or null if the child was signalled.
 * @param signal - the terminating signal name, or null on a normal exit.
 * @returns `code` when present; otherwise `128 + signal number` (0 when neither
 *   is set).
 */
function computeExit(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  const sigNum = signal ? (osConstants.signals[signal] ?? 0) : 0;
  return signal ? 128 + sigNum : 0;
}

/** Injectable process and output seams for {@link createShell}. */
interface ShellDependencies {
  /** Override process creation for lifecycle tests; defaults to Node's spawn. */
  spawn?: SpawnSessionChild;
  /** Directory validation for process-free handler tests. */
  statDirectory?: (path: string, displayPath: string) => Promise<void>;
  /** Override finalized text for lifecycle tests after the manager has drained both pipes. */
  finalizeOutput?: (result: SessionResult) => Promise<{ stdout: string; stderr: string }>;
}

/**
 * Build the `shell` tool: run a command through the host shell to completion and
 * return a JSON string of `{ exit_code, stdout, stderr, signal, timed_out }`.
 *
 * @param dependencies - optional process/output overrides for tests.
 * @returns a {@link ToolDef} whose handler blocks until exit unless a yield is requested.
 * @remarks The command runs with stdin closed and, on POSIX, in its own process
 *   group. A yielded process remains owned by the run and can be polled or stopped
 *   through `shell_session`. Output is bounded in memory; timeout and abort stop
 *   the process group. `bounded: true` keeps the dispatcher from re-clamping it.
 */
export function createShell(dependencies: ShellDependencies = {}): ToolDef {
  const finalize = dependencies.finalizeOutput;
  return {
    name: "shell",
    description:
      "Run a shell command (sh -c) and return stdout, stderr, exit code and a session_id. Blocks until exit unless yield_time_ms is supplied. Returned output is byte-bounded; older bytes may expire from the memory tail. Plain-text session logs preserve the first 16 MiB per stream; use shell_session status, tail or read, or inspect stdout_log/stderr_log for diagnostics instead of rerunning the command. Logs last until run close or session eviction. Prefer focused output.",
    bounded: true,
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "Command run via sh -c with closed stdin; no interactive prompts. Use yield_time_ms for a server or watcher.",
        },
        cwd: { type: "string", description: "Working directory. Default: workspace root." },
        timeout_ms: {
          type: "integer",
          minimum: 0,
          description:
            "Run-time limit in ms, clamped to the configured ceiling. Configuration defaults: " +
            "120000, ceiling 600000. Timeout kills the process tree and returns an error.",
        },
        yield_time_ms: {
          type: "integer",
          minimum: 0,
          maximum: MAX_YIELD_MS,
          description: "Wait at most this many ms, then return a session_id if still running.",
        },
        keep_alive: {
          type: "boolean",
          description:
            "Keep the Linux Sandbox boundary alive after a successful initializer exits. Requires explicit yield_time_ms; retain the returned session_id and stop it when finished.",
        },
        ready_when: {
          type: "string",
          description:
            "Optional readiness regex scanned across bounded output windows. Blank or whitespace-only strings are ignored; yield_time_ms still applies.",
        },
        execution_permissions: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["use_default", "require_escalated", "with_additional_permissions"],
            },
            write_roots: { type: "array", items: { type: "string" } },
            network: { type: "string", enum: ["enabled"] },
          },
          required: ["mode"],
          additionalProperties: false,
        },
        justification: { type: "string" },
        prefix_rule: { type: "array", items: { type: "string" } },
      },
      required: ["command"],
    },
    async handler(args, config, signal, hooks) {
      const command = args.command as string;
      const cwdArg = args.cwd as string | undefined;
      const cwd = cwdArg ? resolvePath(cwdArg, config.workspaceRoot) : config.workspaceRoot;
      const requestedTimeoutMs = (args.timeout_ms as number | undefined) || config.shellTimeoutMs;
      const timeoutMs = Math.min(requestedTimeoutMs, config.shellTimeoutMaxMs, MAX_TIMER_DELAY_MS);
      const yieldMs = args.yield_time_ms as number | undefined;
      const keepAlive = args.keep_alive === true;
      const readyWhen = readinessPattern(args.ready_when as string | undefined);
      const requestedPermissions = args.execution_permissions as
        | {
            mode?: string;
            write_roots?: unknown[];
            network?: string;
          }
        | undefined;

      if (keepAlive && yieldMs === undefined) {
        throw new ToolError("invalid_input", "keep_alive requires an explicit yield_time_ms");
      }
      if (
        keepAlive &&
        requestedPermissions !== undefined &&
        (requestedPermissions.mode !== "use_default" ||
          requestedPermissions.write_roots?.length ||
          requestedPermissions.network !== undefined)
      ) {
        throw new ToolError(
          "invalid_input",
          "keep_alive is supported only with the run's default Sandbox policy",
        );
      }

      if (dependencies.statDirectory) await dependencies.statDirectory(cwd, cwdArg ?? cwd);
      else await statDirectory(cwd, cwdArg ?? cwd);

      return runCommand(
        command,
        cwd,
        timeoutMs,
        config,
        signal,
        finalize,
        hooks?.onOutput,
        hooks?.onExecutionStarted,
        dependencies.spawn,
        yieldMs,
        readyWhen,
        keepAlive,
      );
    },
  };
}

/** The default `shell` tool instance, wired with the real output finalizer. */
export const shell: ToolDef = createShell();

/** Execute a blocking shell call through the run-owned process manager. */
async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  config: RuntimeConfig,
  signal?: AbortSignal,
  finalize?: (result: SessionResult) => Promise<{ stdout: string; stderr: string }>,
  onOutput?: (chunk: string) => void,
  onExecutionStarted?: () => void,
  spawnChild: SpawnSessionChild = spawn,
  yieldMs?: number,
  readyWhen?: RegExp,
  keepAlive = false,
): Promise<string> {
  if (signal?.aborted) {
    throw new ToolError("aborted", "Command aborted", { stdout: "", stderr: "" });
  }
  const clock = config.sessionManager.clock;
  const startedAt = clock.now();
  const session = await config.sessionManager.launch({
    config,
    agent: config.sessionAgent,
    command,
    cwd,
    timeoutMs,
    readyWhen,
    signal,
    onOutput,
    onExecutionStarted,
    spawnChild,
    keepAlive,
    retainOutput: true,
  });
  let retained = false;
  try {
    if (yieldMs !== undefined) {
      if (readyWhen !== undefined) await session.waitReady(yieldMs, signal);
      else
        await new Promise<void>((resolve) => {
          const timer = clock.setTimeout(resolve, yieldMs);
          session.completed.then(
            () => {
              clock.clearTimeout(timer);
              resolve();
            },
            () => {
              clock.clearTimeout(timer);
              resolve();
            },
          );
        });
      if (session.running) {
        retained = true;
        return JSON.stringify(
          shellSessionView(session, undefined, Math.min(config.maxOutputBytes, 8192), true),
        );
      }
    }
    let result = await session.completed;
    if (finalize !== undefined) {
      try {
        result = { ...result, ...(await finalize(result)) };
      } catch (error) {
        throw new ToolError("io_error", `Failed to finalize output: ${(error as Error).message}`);
      }
    }
    const outputMeta = {
      stdout_truncated: result.stdoutTruncated,
      stderr_truncated: result.stderrTruncated,
      stdout_omitted_bytes: result.stdoutOmittedBytes,
      stderr_omitted_bytes: result.stderrOmittedBytes,
    };
    config.logger.debug(
      {
        event: "tools.shell_exit",
        exit_code: computeExit(result.code, result.signal),
        signal: result.signal,
        timed_out: result.timedOut,
        aborted: result.aborted,
        stdout_bytes: result.stdoutBytes,
        stderr_bytes: result.stderrBytes,
        ...outputMeta,
        duration_ms: clock.now() - startedAt,
      },
      "a shell command settled under the run-owned process manager",
    );
    if (result.aborted) {
      throw new ToolError("aborted", "Command aborted", {
        stdout: result.stdout,
        stderr: result.stderr,
        ...outputMeta,
      });
    }
    if (result.timedOut) {
      retained = true;
      throw new ToolError("timeout", `Command exceeded ${timeoutMs}ms`, {
        session_id: session.id,
        ...session.outputInfo(),
        timeout_ms: timeoutMs,
        stdout: result.stdout,
        stderr: result.stderr,
        ...outputMeta,
      });
    }
    retained = true;
    const page = session.readTail(config.maxShellOutputBytes);
    return JSON.stringify({
      session_id: session.id,
      ...session.outputInfo(),
      running: false,
      exit_code: computeExit(result.code, result.signal),
      stdout: result.stdout,
      stderr: result.stderr,
      signal: result.signal,
      timed_out: false,
      ready: readyWhen === undefined ? null : session.ready,
      next_cursor: page.nextCursor,
      ...outputMeta,
      ...(session.keepAlive
        ? {
            keep_alive: true,
            command_status: result.commandStatus,
            command_exit_code: result.commandExitCode ?? null,
            command_signal: result.commandSignal ?? null,
          }
        : {}),
    });
  } finally {
    if (!retained && (session.terminationConfirmed || (await session.stop())))
      config.sessionManager.forget(session.id);
  }
}
