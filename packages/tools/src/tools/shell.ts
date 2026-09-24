import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { ToolError } from "../errors.ts";
import { resolvePath } from "../lib/paths.ts";
import { statDirectory } from "../lib/files.ts";
import type { SessionResult } from "../lib/execution-session.ts";
import { shellSessionView } from "./shell-session.ts";
import type { RuntimeConfig } from "../config.ts";
import type { ToolDef } from "./types.ts";
import { currentShellFlavor } from "../shell.ts";

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_YIELD_MS = 30_000;

function readinessPattern(value: string | undefined): RegExp | undefined {
  if (value === undefined) return undefined;
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
 * @remarks The signal branch is unreachable on Windows, which reports no
 *   terminating signal and always delivers an exit code.
 */
function computeExit(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  const sigNum = signal ? (osConstants.signals[signal] ?? 0) : 0;
  return signal ? 128 + sigNum : 0;
}

/** Injectable process and output seams for {@link createShell}. */
interface ShellDependencies {
  /** Override process creation for lifecycle tests; defaults to Node's spawn. */
  spawn?: typeof spawn;
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
  const powershell = currentShellFlavor() === "powershell";
  return {
    name: "shell",
    description:
      (powershell
        ? "Run a PowerShell command and return stdout, stderr, and exit code. "
        : "Run a shell command (sh -c) and return stdout, stderr, and exit code. ") +
      "Blocks until exit unless yield_time_ms is supplied; a live command then returns a session_id for shell_session. Output is byte-bounded in memory and older bytes may expire. Prefer focused output." +
      (powershell
        ? " Use PowerShell syntax, not sh or cmd.exe; Windows PowerShell 5.1 has no `&&`. " +
          "Cmdlets report exit code 0 or 1; native executables retain their own code."
        : ""),
    bounded: true,
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: powershell
            ? "PowerShell command with closed stdin; no interactive prompts. Use yield_time_ms for a server or watcher."
            : "Command run via sh -c with closed stdin; no interactive prompts. Use yield_time_ms for a server or watcher.",
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
        ready_when: {
          type: "string",
          description: "Optional readiness regex scanned across bounded output windows.",
        },
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
      const readyWhen = readinessPattern(args.ready_when as string | undefined);

      await statDirectory(cwd, cwdArg ?? cwd);

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
  spawnChild: typeof spawn = spawn,
  yieldMs?: number,
  readyWhen?: RegExp,
): Promise<string> {
  if (signal?.aborted) {
    throw new ToolError("aborted", "Command aborted", { stdout: "", stderr: "" });
  }
  const startedAt = Date.now();
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
  });
  let retained = false;
  try {
    if (yieldMs !== undefined) {
      if (readyWhen !== undefined) await session.waitReady(yieldMs, signal);
      else
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, yieldMs);
          session.completed.then(
            () => {
              clearTimeout(timer);
              resolve();
            },
            () => {
              clearTimeout(timer);
              resolve();
            },
          );
        });
      if (session.running) {
        retained = true;
        return JSON.stringify(shellSessionView(session, undefined, config.maxOutputBytes));
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
        duration_ms: Date.now() - startedAt,
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
      throw new ToolError("timeout", `Command exceeded ${timeoutMs}ms`, {
        timeout_ms: timeoutMs,
        stdout: result.stdout,
        stderr: result.stderr,
        ...outputMeta,
      });
    }
    const page = session.readStreams(undefined, config.maxOutputBytes);
    return JSON.stringify({
      running: false,
      exit_code: computeExit(result.code, result.signal),
      stdout: result.stdout,
      stderr: result.stderr,
      signal: result.signal,
      timed_out: false,
      ready: readyWhen === undefined ? null : session.ready,
      next_cursor: page.nextCursor,
      ...outputMeta,
    });
  } finally {
    if (!retained && (session.terminationConfirmed || (await session.stop())))
      config.sessionManager.forget(session.id);
  }
}
