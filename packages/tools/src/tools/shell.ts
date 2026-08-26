import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { ensureWorkspaceLocalDir, workspaceStatePaths } from "@clarvis/paths";
import { ToolError } from "../errors.ts";
import { resolvePath, displayPath } from "../lib/paths.ts";
import { statDirectory } from "../lib/files.ts";
import {
  allocateBudget,
  createCaptureSink,
  createOutputCoalescer,
  CAPTURE_INLINE_FLOOR,
  type CaptureSink,
} from "../lib/output.ts";
import { uniqueToken } from "../lib/token.ts";
import { killTree, ownProcessGroup } from "../lib/process.ts";
import type { RuntimeConfig } from "../config.ts";
import type { ToolDef } from "./types.ts";
import { sandboxCommand } from "../sandbox.ts";
import { currentShellFlavor } from "../shell.ts";
import {
  createdTemporaryDirectories,
  snapshotExplicitTemporaryDirectories,
} from "../lib/temporary-roots.ts";
import { sandboxWithReadableStateArtifacts } from "../lib/state-artifacts.ts";

/**
 * The smallest capture buffer a `shell` call gets, whatever `maxOutputBytes`
 * says.
 *
 * @remarks A floor, not a cap: the capture is what gets *spilled to a file* for
 * the model to read back, so it is deliberately decoupled from how much is
 * rendered inline. Tying the two together meant a host that tightened the inline
 * budget also silently discarded the tail of every build log before anything
 * could be written down. The floor is sized for that artefact — a full test or
 * build run's output — rather than for a tool result.
 */
const MAX_CAPTURE_FLOOR = 8 * 1024 * 1024;
const STDIO_DRAIN_MS = 100;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Build the spill destination for one stream: a uniquely-named
 * `shell-<token>.<stream>.log` in the workspace's state tree, returned as both
 * an absolute path (to write) and a display path (to report).
 *
 * @param config - server configuration; `workspaceRoot` anchors the spill dir.
 * @param stream - which stream the file backs.
 * @returns the absolute and display paths for the spill file.
 * @remarks The spill lives outside the working tree, so {@link displayPath}
 *   reports it absolute of its own accord — it relativizes only what is inside.
 *   `read_file` still reaches it: the read tools admit
 *   {@link RuntimeConfig.stateRoot} alongside the workspace.
 */
function spillTarget(
  config: RuntimeConfig,
  stream: "stdout" | "stderr",
): { absPath: string; displayPath: string } {
  ensureWorkspaceLocalDir(config.workspaceRoot);
  const absPath = workspaceStatePaths(config.workspaceRoot).spillFile(uniqueToken(), stream);
  return { absPath, displayPath: displayPath(absPath, config.workspaceRoot) };
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

/**
 * Fit the two captured streams into the shared shell output budget, spilling the
 * overflow of each to a `.clarvis` log file when it exceeds its allocated share.
 *
 * @param config - runtime configuration; `maxShellOutputBytes` is the combined cap.
 * @param outSink - the stdout capture sink, already settled by the child's exit.
 * @param errSink - the stderr capture sink.
 * @returns the possibly-truncated stdout and stderr, each with a spill pointer
 *   appended when it was written to a file (see {@link CaptureSink.finish}).
 * @remarks The budget is split between the streams by {@link allocateBudget}, so
 *   a large stdout does not starve stderr of its own share. The split reads each
 *   sink's running `bytes` counter rather than measuring its text, which both
 *   saves a full `Buffer.byteLength` pass per stream and is the only figure
 *   available at all once a sink has spilled and no longer holds the text.
 */
async function finalizeOutput(
  config: RuntimeConfig,
  outSink: CaptureSink,
  errSink: CaptureSink,
): Promise<{ stdout: string; stderr: string }> {
  const [outBudget, errBudget] = allocateBudget(
    outSink.bytes,
    errSink.bytes,
    config.maxShellOutputBytes,
  );
  const [stdout, stderr] = await Promise.all([
    outSink.finish(outBudget),
    errSink.finish(errBudget),
  ]);
  return { stdout, stderr };
}

/** Injectable seams for {@link createShell}, for tests to stub output handling. */
interface ShellDependencies {
  /** Override for {@link finalizeOutput}; defaults to the real bounding/spill. */
  finalizeOutput?: typeof finalizeOutput;
}

/**
 * Build the `shell` tool: run a command through the host shell to completion and
 * return a JSON string of `{ exit_code, stdout, stderr, signal, timed_out }`.
 *
 * @param dependencies - optional overrides (a test double for
 *   {@link finalizeOutput}); the real bounding/spill logic is used by default.
 * @returns a {@link ToolDef} whose handler blocks until the command exits.
 * @remarks The command runs with stdin closed - and, on POSIX, in its own
 *   process group (see {@link ownProcessGroup}) - so a
 *   long-lived process must be backgrounded with its output redirected or it
 *   blocks until the timeout. On timeout, abort, or a single stream exceeding
 *   the capture cap, the whole process group is `SIGKILL`ed and the handler
 *   rejects with a typed {@link ToolError} (`timeout` / `aborted` /
 *   `output_limit`) that still carries the captured output. `bounded: true`, so
 *   the dispatcher does not re-clamp the result.
 */
export function createShell(dependencies: ShellDependencies = {}): ToolDef {
  const finalize = dependencies.finalizeOutput ?? finalizeOutput;
  const powershell = currentShellFlavor() === "powershell";
  return {
    name: "shell",
    description:
      (powershell
        ? "Run a PowerShell command and return stdout, stderr, and exit code. "
        : "Run a shell command (sh -c) and return stdout, stderr, and exit code. ") +
      "The command runs to completion and BLOCKS until it exits, so a long-lived process (a dev " +
      "server, file watcher, `bun run dev`, `bun start`) MUST be started with monitor_start " +
      "instead, and then verified separately (sleep + curl the port, or read the log). A server " +
      "left in the foreground will block until the timeout and waste the call. " +
      "Output is byte-bounded from the tail, so an oversized result loses its head, not its " +
      "middle, and the full text is spilled to a file the truncation marker names — pipe through " +
      "grep/head/tail when you only need part of a large output rather than dumping it whole." +
      (powershell
        ? " This host runs PowerShell, not sh: use `Remove-Item -Recurse -Force`, `$null`, " +
          "`Get-ChildItem` and `-and`/`-or`, not `rm -rf`, `/dev/null`, `ls` or `&&`. A pure " +
          "cmdlet reports only exit code 0 or 1; native executables report their real code."
        : ""),
    bounded: true,
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: powershell
            ? "PowerShell command. stdin is closed (no interactive prompts). Background a " +
              "long-lived process with monitor_start rather than a trailing `&`, which " +
              "PowerShell 5.1 does not accept."
            : "Shell command, run via the system shell (sh -c). stdin is closed (no interactive " +
              "prompts). A long-lived process MUST be backgrounded with output redirected (e.g. " +
              "cmd > /tmp/out.log 2>&1 &) or it blocks until timeout.",
        },
        cwd: { type: "string", description: "Working directory. Default: workspace root." },
        timeout_ms: {
          type: "integer",
          minimum: 0,
          description:
            "Max run time in ms. Defaults to 120000 and may be raised up to the configured " +
            "600000 ceiling for a long build/test/install. On timeout the process " +
            "group is killed and a timeout error is returned.",
        },
      },
      required: ["command"],
    },
    async handler(args, config, signal, hooks) {
      const command = args.command as string;
      const cwdArg = args.cwd as string | undefined;
      const cwd = cwdArg
        ? resolvePath(
            cwdArg,
            config.workspaceRoot,
            config.confineToWorkspace,
            config.temporaryRoots,
            config.logger,
          )
        : config.workspaceRoot;
      const requestedTimeoutMs = (args.timeout_ms as number | undefined) || config.shellTimeoutMs;
      const timeoutMs = Math.min(requestedTimeoutMs, config.shellTimeoutMaxMs, MAX_TIMER_DELAY_MS);

      await statDirectory(cwd, cwdArg ?? cwd);

      return runCommand(command, cwd, timeoutMs, config, signal, finalize, hooks?.onOutput);
    },
  };
}

/** The default `shell` tool instance, wired with the real output finalizer. */
export const shell: ToolDef = createShell();

/**
 * Spawn `command` (on POSIX, in its own process group), capture stdout/stderr,
 * and settle once the child closes (or is killed by timeout/abort/output cap).
 *
 * @param command - the shell command, run via the sandbox-resolved shell.
 * @param cwd - the working directory, already resolved and confined.
 * @param timeoutMs - hard wall-clock limit; on expiry the group is `SIGKILL`ed.
 * @param config - server configuration (capture cap, sandbox, spill settings).
 * @param signal - optional abort signal; aborting kills the group.
 * @param finalize - the output finalizer, injectable for tests.
 * @param onOutput - optional live-output callback, coalesced per chunk.
 * @returns a JSON string of `{ exit_code, stdout, stderr, signal, timed_out }`
 *   on a clean exit.
 * @throws {@link ToolError} `io_error` when the spawn or finalize fails,
 *   `aborted` when cancelled, `timeout` on the wall-clock limit, or
 *   `output_limit` when one stream exceeds the capture cap.
 * @remarks Settling is guarded by a one-shot `beginSettle` and deferred a short
 *   `STDIO_DRAIN_MS` past the `exit` event so trailing stdout/stderr is captured
 *   before the streams are torn down; whichever of `exit`+drain or `close` fires
 *   first wins and the other is a no-op.
 */
function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  config: RuntimeConfig,
  signal?: AbortSignal,
  finalize: typeof finalizeOutput = finalizeOutput,
  onOutput?: (chunk: string) => void,
): Promise<string> {
  const startedAt = Date.now();
  const temporarySnapshots = snapshotExplicitTemporaryDirectories(command);
  return new Promise((resolve, reject) => {
    let child;
    try {
      const spec = sandboxCommand({
        command,
        cwd,
        workspaceRoot: config.workspaceRoot,
        gitMetadataPaths: config.gitMetadataPaths,
        temporaryRoot: config.temporaryRoots[0],
        sandbox: sandboxWithReadableStateArtifacts(command, config),
        secretEnvNames: config.secretEnvNames,
        logger: config.logger,
      });
      const detached = ownProcessGroup();
      config.logger.debug(
        {
          event: "tools.shell_spawn",
          shell_file: spec.file,
          flavor: currentShellFlavor(),
          detached,
          cwd,
          timeout_ms: timeoutMs,
          sandboxed: spec.sandboxed,
        },
        "a shell command is being spawned; everything it does from here is attributed to this process group",
      );
      child = spawn(spec.file, spec.args, {
        ...spec.options,
        stdio: ["ignore", "pipe", "pipe"],
        detached,
      });
    } catch (err) {
      reject(new ToolError("io_error", `Failed to spawn command: ${(err as Error).message}`));
      return;
    }

    const captureCap = Math.max(config.maxOutputBytes, MAX_CAPTURE_FLOOR);
    const inlineLimit = Math.max(config.maxShellOutputBytes, CAPTURE_INLINE_FLOOR);
    const live = onOutput !== undefined ? createOutputCoalescer(onOutput) : undefined;
    const sinkFor = (stream: "stdout" | "stderr"): CaptureSink =>
      createCaptureSink({
        inlineLimit,
        captureCap,
        spill: () => spillTarget(config, stream),
        stream,
        logger: config.logger,
      });
    const stdoutSink = sinkFor("stdout");
    const stderrSink = sinkFor("stderr");
    let timedOut = false;
    let aborted = false;
    let outputLimited = false;
    let settled = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;

    const killAll = (): void => {
      if (child.pid !== undefined && killTree(child.pid, "SIGKILL", { logger: config.logger })) {
        return;
      }
      child.kill("SIGKILL");
    };

    const onAbort = (): void => {
      aborted = true;
      killAll();
    };

    const onData =
      (sink: CaptureSink) =>
      (d: string): void => {
        if (sink.capped) return;
        live?.push(d);
        sink.push(d);
        if (sink.capped && !outputLimited) {
          outputLimited = true;
          killAll();
        }
      };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", onData(stdoutSink));
    child.stderr.on("data", onData(stderrSink));

    const timer = setTimeout(() => {
      timedOut = true;
      killAll();
    }, timeoutMs);

    if (signal !== undefined) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const teardown = (): void => {
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    };

    const beginSettle = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      signal?.removeEventListener("abort", onAbort);
      live?.settle();
      teardown();
      return true;
    };

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (!beginSettle()) return;

      void finalize(config, stdoutSink, stderrSink).then(
        ({ stdout, stderr }) => {
          for (const root of createdTemporaryDirectories(temporarySnapshots)) {
            try {
              config.registerTemporaryRoot(root);
            } catch (error) {
              config.logger.warn(
                {
                  event: "tools.temporary_root_registration_failed",
                  cause: error instanceof Error ? error.message : String(error),
                },
                "a shell-created temporary directory changed before it could be registered",
              );
            }
          }
          config.logger.debug(
            {
              event: "tools.shell_exit",
              exit_code: computeExit(code, signal),
              signal,
              timed_out: timedOut,
              aborted,
              output_limited: outputLimited,
              stdout_bytes: stdoutSink.bytes,
              stderr_bytes: stderrSink.bytes,
              duration_ms: Date.now() - startedAt,
            },
            "a shell command settled; the trace keeps its output as opaque text and indexes none of these",
          );
          if (aborted) {
            reject(new ToolError("aborted", "Command aborted (run cancelled)", { stdout, stderr }));
            return;
          }

          if (timedOut) {
            reject(
              new ToolError("timeout", `Command exceeded ${timeoutMs}ms`, {
                timeout_ms: timeoutMs,
                stdout,
                stderr,
              }),
            );
            return;
          }

          if (outputLimited) {
            reject(
              new ToolError(
                "output_limit",
                `Command output exceeded ${captureCap} bytes on a single stream and was killed`,
                { max_capture_bytes: captureCap, stdout, stderr },
              ),
            );
            return;
          }

          resolve(
            JSON.stringify({
              exit_code: computeExit(code, signal),
              stdout,
              stderr,
              signal: signal ?? null,
              timed_out: false,
            }),
          );
        },
        (err) =>
          reject(new ToolError("io_error", `Failed to finalize output: ${(err as Error).message}`)),
      );
    };

    child.on("error", (err) => {
      if (!beginSettle()) return;
      Promise.all([stdoutSink.dispose(), stderrSink.dispose()]).catch(() => undefined);
      reject(new ToolError("io_error", `Failed to run command: ${err.message}`));
    });

    child.on("exit", (code, signal) => {
      clearTimeout(timer);

      if (drainTimer) clearTimeout(drainTimer);
      drainTimer = setTimeout(() => finish(code, signal), STDIO_DRAIN_MS);
    });

    child.on("close", (code, signal) => finish(code, signal));
  });
}
