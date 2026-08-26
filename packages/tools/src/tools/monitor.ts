import { spawn } from "node:child_process";
import { openSync, closeSync, promises as fs } from "node:fs";
import { ToolError } from "../errors.ts";
import { resolvePath } from "../lib/paths.ts";
import { statDirectory } from "../lib/files.ts";
import { readLogSlice } from "../lib/logslice.ts";
import {
  type MonitorMeta,
  ensureClarvisDir,
  exitPath,
  isAlive,
  listSidecars,
  logPath,
  mintId,
  monitorRunning,
  readExitState,
  readSidecar,
  removeMonitorFiles,
  writeSidecar,
} from "../lib/monitor.ts";
import { killTree, ownProcessGroup } from "../lib/process.ts";
import type { RuntimeConfig } from "../config.ts";
import type { ToolDef } from "./types.ts";
import { sandboxCommand } from "../sandbox.ts";
import { sandboxWithReadableStateArtifacts } from "../lib/state-artifacts.ts";
import { exitCaptureWrapper, resolveShell, type ShellSpec } from "../shell.ts";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * How often `monitor_start` re-checks for its readiness pattern while waiting.
 *
 * @remarks Paid only inside an explicit wait the caller already asked for, and
 * bounded by that caller's own deadline, so the cost of polling faster is
 * wasted syscalls and the cost of polling slower is latency added to every
 * successful start. Sub-100 ms keeps the added latency below what a caller can
 * perceive against a process launch, which is the only thing this delay is
 * measured against.
 */
const READY_POLL_MS = 75;

/**
 * How long a monitor's process tree has between `SIGTERM` and `SIGKILL`.
 *
 * @remarks Blocking: `monitor_stop` waits this out before escalating, so it is
 * added to every stop of a still-running monitor. The bracket is asymmetric —
 * too short kills a process mid-`SIGTERM` handler, losing whatever flush or
 * cleanup it was performing; too long only makes an explicit stop feel slow.
 * The grace is for a handler that is already running, not for a process to
 * finish its work, which is what keeps it in the hundreds of milliseconds
 * rather than seconds.
 */
const STOP_GRACE_MS = 400;

/**
 * Compile a caller-supplied regex, converting a syntax error into a typed
 * `invalid_input` {@link ToolError} that names the offending field.
 *
 * @param pattern - the regular-expression source.
 * @param field - the input field name, used in the error and its detail.
 * @returns the compiled {@link RegExp}.
 * @throws {@link ToolError} `invalid_input` when `pattern` is not a valid regex.
 */
function compileRegex(pattern: string, field: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (err) {
    throw new ToolError("invalid_input", `Invalid ${field} regex: ${(err as Error).message}`, {
      [field]: pattern,
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Outcome of a {@link waitForReady} poll: whether the readiness regex matched,
 * whether the process is still alive, and the log snapshot with its next offset. */
interface ReadyResult {
  ready: boolean;
  running: boolean;
  output: string;
  nextOffset: number;
}

/**
 * Poll a monitor's combined log until its readiness regex matches, the process
 * dies, or the deadline/abort fires.
 *
 * @param config - server configuration; `maxOutputBytes` caps the log window
 *   the regex is tested against.
 * @param id - the monitor id whose log to read.
 * @param pid - the monitor's process id, checked for liveness each pass.
 * @param re - the readiness regex.
 * @param timeoutMs - maximum time to wait before giving up.
 * @param signal - optional abort signal that ends the wait early.
 * @returns a {@link ReadyResult}: `ready:true` on a match; `ready:false` with
 *   `running:false` if the process exited first; `ready:false` with
 *   `running:true` on timeout or abort.
 * @remarks The regex is only ever tested against the first `maxOutputBytes` of
 *   output, so a readiness marker beyond that window is never observed.
 */
async function waitForReady(
  config: RuntimeConfig,
  id: string,
  pid: number,
  re: RegExp,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ReadyResult> {
  const lp = logPath(config.workspaceRoot, id);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const slice = await readLogSlice(lp, 0, config.maxOutputBytes);
    if (re.test(slice.text)) {
      return {
        ready: true,
        running: isAlive(pid),
        output: slice.text,
        nextOffset: slice.nextOffset,
      };
    }
    if (!isAlive(pid)) {
      return { ready: false, running: false, output: slice.text, nextOffset: slice.nextOffset };
    }
    if (signal?.aborted || Date.now() >= deadline) {
      return { ready: false, running: true, output: slice.text, nextOffset: slice.nextOffset };
    }
    await delay(READY_POLL_MS);
  }
}

/** The `child_process.spawn` signature, injectable into {@link createMonitorStart}. */
type SpawnProcess = typeof spawn;

/**
 * Build the `monitor_start` tool: launch a long-lived command in the background
 * under a `.clarvis` log + exit sidecar and return its monitor id immediately.
 *
 * @param spawnProcess - the spawner to use; defaults to `child_process.spawn`,
 *   overridable in tests.
 * @returns a {@link ToolDef} whose handler returns a JSON string of
 *   `{ id, running, ready, output, next_offset }`.
 * @throws {@link ToolError} `too_many_monitors` when live monitors are at
 *   `maxMonitors`, `invalid_input` for a bad `ready_when` regex, or `io_error`
 *   when the spawn fails or yields no pid.
 * @remarks The command is wrapped by {@link exitCaptureWrapper} so its status
 *   reaches the exit sidecar, and is spawned with stdin closed and both
 *   streams redirected into one log - on POSIX in its own process group (see
 *   {@link ownProcessGroup}), which is what keeps it alive past this process;
 *   the caller must NOT append a trailing `&`,
 *   which would leave the id tracking the wrong process. When `ready_when` is
 *   given, the handler blocks via {@link waitForReady} (up to
 *   `ready_timeout_ms`) before returning; otherwise it returns at once with
 *   `ready:null`.
 *
 *   The shell is resolved once and the same {@link ShellSpec} is threaded into
 *   both the wrapper and {@link sandboxCommand}. Resolving twice would let the
 *   wrapper's syntax drift from the shell that runs it, which is the local form
 *   of the analyzer/executor mismatch the whole design exists to prevent.
 *
 *   The `tools.monitor_spawn` record is one half of a deliberate pair. It names
 *   the **write** side — platform, `detached`, the stdio slots and the log path —
 *   and `monitor_poll`'s record names the read side. `specs/known-issues.md`
 *   records that a monitor captures no output on Windows and that establishing
 *   which side fails took an abandoned two-handle experiment (`50aa7c2`,
 *   reverted in `2705c3a`); a `running` monitor whose poll reports zero bytes
 *   answers it directly, which matters because no CI job currently runs this
 *   package on Windows at all.
 */
export function createMonitorStart(
  spawnProcess: SpawnProcess = spawn,
  shell: () => ShellSpec = resolveShell,
): ToolDef {
  return {
    name: "monitor_start",
    description:
      "Start a long-lived command in the BACKGROUND and return a monitor id immediately — unlike " +
      "shell, which blocks until the command exits. Use it for a dev server, file watcher, `tail -f`, " +
      "or anything that keeps producing output over time. Read incremental output with monitor_poll " +
      "and stop it with monitor_stop. If `ready_when` (a regex) is given, blocks until the output " +
      "matches it (or `ready_timeout_ms` elapses) before returning. Do NOT background inside the " +
      "command (no trailing `&`) — the monitor backgrounds it for you, and a trailing `&` makes the " +
      "id track the wrong process.",
    bounded: true,
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "Shell command run via `sh -c`, in the background. stdin is closed. Its stdout and " +
            "stderr are combined into one log you read with monitor_poll.",
        },
        cwd: { type: "string", description: "Working directory. Default: workspace root." },
        ready_when: {
          type: "string",
          description:
            "Optional regex. When set, monitor_start blocks until the combined output matches it " +
            '(e.g. "listening on"), then returns with ready:true. Times out per ready_timeout_ms. ' +
            "Matched against the first MAX_OUTPUT_BYTES of output.",
        },
        ready_timeout_ms: {
          type: "integer",
          minimum: 0,
          description:
            "Max time to wait for ready_when, in ms. Default: MONITOR_READY_TIMEOUT_MS (30000). " +
            "Ignored unless ready_when is set.",
        },
      },
      required: ["command"],
    },
    async handler(args, config, signal) {
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
      await statDirectory(cwd, cwdArg ?? cwd);

      const readyWhen = args.ready_when as string | undefined;
      const readyRe = readyWhen === undefined ? undefined : compileRegex(readyWhen, "ready_when");
      const readyTimeoutMs = Math.min(
        (args.ready_timeout_ms as number | undefined) || config.monitorReadyTimeoutMs,
        MAX_TIMER_DELAY_MS,
      );

      const liveness = await Promise.all(
        (await listSidecars(config.workspaceRoot)).map((m) =>
          monitorRunning(config.workspaceRoot, m, config.logger),
        ),
      );
      const aliveCount = liveness.filter(Boolean).length;
      if (aliveCount >= config.maxMonitors) {
        throw new ToolError(
          "too_many_monitors",
          `Too many live monitors (${aliveCount}/${config.maxMonitors}); stop some with monitor_stop first`,
          { limit: config.maxMonitors },
        );
      }

      const id = mintId();
      await ensureClarvisDir(config.workspaceRoot);
      const lp = logPath(config.workspaceRoot, id);
      const ep = exitPath(config.workspaceRoot, id);
      const host = shell();
      const wrapped = exitCaptureWrapper(command, host.flavor);

      const fd = openSync(lp, "a");
      let child;
      try {
        const spec = sandboxCommand({
          command: wrapped,
          cwd,
          workspaceRoot: config.workspaceRoot,
          gitMetadataPaths: config.gitMetadataPaths,
          temporaryRoot: config.temporaryRoots[0],
          sandbox: sandboxWithReadableStateArtifacts(command, config),
          secretEnvNames: config.secretEnvNames,
          shell: () => host,
          logger: config.logger,
        });
        const detached = ownProcessGroup();
        config.logger.debug(
          {
            event: "tools.monitor_spawn",
            id,
            platform: process.platform,
            detached,
            stdio_slots: ["ignore", "fd", "fd"],
            log_path: lp,
            flavor: host.flavor,
          },
          "a background monitor is being spawned with both streams redirected into one log; this is the write side of the pair that decides whether output can be captured at all",
        );
        child = spawnProcess(spec.file, spec.args, {
          ...spec.options,
          env: { ...spec.options.env, MON_EXIT: ep },
          stdio: ["ignore", fd, fd],
          detached,
        });
      } catch (err) {
        closeSync(fd);
        await fs.rm(lp, { force: true });
        throw new ToolError("io_error", `Failed to spawn monitor: ${(err as Error).message}`);
      }
      closeSync(fd);
      child.on("error", () => {});
      if (child.pid === undefined) {
        await fs.rm(lp, { force: true });
        throw new ToolError("io_error", "Failed to spawn monitor: process has no pid");
      }
      child.unref();

      const meta: MonitorMeta = {
        id,
        command,
        cwd,
        pid: child.pid,
        startedAt: Date.now(),
        readyWhen: readyWhen ?? null,
      };
      await writeSidecar(config.workspaceRoot, meta);

      if (readyRe) {
        const r = await waitForReady(config, id, child.pid, readyRe, readyTimeoutMs, signal);
        return JSON.stringify({
          id,
          running: r.running,
          ready: r.ready,
          output: r.output,
          next_offset: r.nextOffset,
        });
      }
      return JSON.stringify({ id, running: true, ready: null, output: "", next_offset: 0 });
    },
  };
}

/** The default `monitor_start` tool instance, wired with the real spawner. */
export const monitorStart: ToolDef = createMonitorStart();

/**
 * The `monitor_poll` tool: read a monitor's combined log from a byte offset and
 * report its liveness, so the caller can page forward with the returned
 * `next_offset`.
 *
 * @remarks
 * Returns a JSON string of `{ running, output, next_offset, exit_code }`. An
 * optional `match` regex keeps only matching lines. `exit_code` is populated
 * only after a natural exit - it is null while running and null when the monitor
 * was stopped or killed. While the process is still running, a trailing partial
 * line (no final newline) is held back and `next_offset` rewound to its start,
 * so a line is never split across two polls. When more output is buffered than
 * the byte window allows, a "continue with offset=..." marker is appended.
 */
export const monitorPoll: ToolDef = {
  name: "monitor_poll",
  description:
    "Read new output from a monitor since a byte offset. Returns { running, output, next_offset, " +
    "exit_code }: pass next_offset back on the next call to page forward. `match` (a regex) keeps " +
    "only matching lines. exit_code is set only after a natural exit — it is null while running, " +
    "and null if the monitor was stopped or killed.",
  bounded: true,
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Monitor id returned by monitor_start." },
      offset: {
        type: "integer",
        minimum: 0,
        description:
          "Byte offset to read from. Use the next_offset from the previous poll. Default 0.",
      },
      match: {
        type: "string",
        description: "Optional regex; only lines matching it are returned.",
      },
    },
    required: ["id"],
  },
  async handler(args, config) {
    const id = args.id as string;
    const offset = (args.offset as number | undefined) ?? 0;
    const matchStr = args.match as string | undefined;

    const meta = await readSidecar(config.workspaceRoot, id);
    const exitState = await readExitState(config.workspaceRoot, id, config.logger);
    const running = !exitState.exited && isAlive(meta.pid);
    const slice = await readLogSlice(
      logPath(config.workspaceRoot, id),
      offset,
      config.maxOutputBytes,
    );
    config.logger.debug(
      {
        event: "tools.monitor_poll",
        id,
        running,
        offset,
        log_bytes: slice.nextOffset,
      },
      "a monitor was polled; this is the read side of the pair — zero bytes against a running monitor means the capture never happened, not that the command is quiet",
    );

    let output = slice.text;
    let nextOffset = slice.nextOffset;

    if (!slice.more && running && output.includes("\n") && !output.endsWith("\n")) {
      const lastNl = output.lastIndexOf("\n");
      const held = output.slice(lastNl + 1);
      nextOffset -= Buffer.byteLength(held, "utf8");
      output = output.slice(0, lastNl + 1);
    }

    if (matchStr !== undefined) {
      const re = compileRegex(matchStr, "match");
      const body = output.endsWith("\n") ? output.slice(0, -1) : output;
      const lines = body.length > 0 ? body.split("\n") : [];
      output = lines.filter((l) => re.test(l)).join("\n");
    }

    if (slice.more) {
      output += `\n[... more output buffered; continue with offset=${nextOffset} ...]`;
    }

    const exitCode = exitState.exited ? exitState.code : null;
    return JSON.stringify({ running, output, next_offset: nextOffset, exit_code: exitCode });
  },
};

/** Injectable seams for {@link createMonitorStop}, for tests to stub liveness,
 * signalling and the escalation clock without spawning or sleeping. */
interface MonitorStopDependencies {
  /** Override for the {@link isAlive} pid check. */
  isAlive?: typeof isAlive;
  /** Override for the {@link killTree} process-tree signaller. */
  killTree?: typeof killTree;
  /** Override for the grace-period wait. */
  wait?: (ms: number) => Promise<void>;
}

/**
 * Build the `monitor_stop` tool: signal a monitor's whole process tree
 * (`SIGTERM`, then `SIGKILL` after {@link STOP_GRACE_MS}) and delete its files.
 *
 * @param dependencies - optional test overrides for the liveness check and the
 *   tree signaller; the real implementations are used by default.
 * @returns a {@link ToolDef} whose handler returns `{ stopped: true, id }`.
 * @remarks Idempotent: stopping an already-exited or unknown monitor just cleans
 *   up its sidecar files without signalling.
 *
 *   The escalation is uniform across platforms. On Windows the first call
 *   already force-kills, so the process is gone before the grace elapses and the
 *   `SIGKILL` step is skipped - the grace becomes latency there rather than a
 *   behavioural difference, which is worth the uniformity.
 */
export function createMonitorStop(dependencies: MonitorStopDependencies = {}): ToolDef {
  const isProcessAlive = dependencies.isAlive ?? isAlive;
  const killProcessTree = dependencies.killTree ?? killTree;
  const wait = dependencies.wait ?? delay;
  return {
    name: "monitor_stop",
    description:
      "Stop a monitor: signal its whole process group (SIGTERM, then SIGKILL after a short grace) " +
      "and remove its files. Idempotent — stopping an already-exited monitor just cleans up.",
    bounded: true,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Monitor id returned by monitor_start." },
      },
      required: ["id"],
    },
    async handler(args, config) {
      const id = args.id as string;
      const meta = await readSidecar(config.workspaceRoot, id);
      const { exited } = await readExitState(config.workspaceRoot, id, config.logger);
      if (!exited && isProcessAlive(meta.pid)) {
        killProcessTree(meta.pid, "SIGTERM", { logger: config.logger });
        await wait(STOP_GRACE_MS);
        if (isProcessAlive(meta.pid)) {
          killProcessTree(meta.pid, "SIGKILL", { logger: config.logger });
        }
      }
      await removeMonitorFiles(config.workspaceRoot, id);
      return JSON.stringify({ stopped: true, id });
    },
  };
}

/** The default `monitor_stop` tool instance, wired with the real signaller. */
export const monitorStop: ToolDef = createMonitorStop();

/**
 * The `monitor_list` tool: enumerate every monitor (running and finished) with
 * its id, command, live flag, start time, and cwd, newest first.
 *
 * @remarks
 * Returns a JSON string of `{ monitors }`. Liveness is recomputed per entry from
 * the sidecar (see {@link monitorRunning}); use it to find and stop leaked
 * monitors.
 */
export const monitorList: ToolDef = {
  name: "monitor_list",
  description:
    "List all monitors (running and finished) with their id, command, running flag, start time, " +
    "and cwd. Use it to find and stop leaked monitors.",
  bounded: true,
  inputSchema: {
    type: "object",
    properties: {},
  },
  async handler(args, config) {
    const metas = await listSidecars(config.workspaceRoot);
    const monitors = await Promise.all(
      metas.map(async (m) => ({
        id: m.id,
        command: m.command,
        running: await monitorRunning(config.workspaceRoot, m, config.logger),
        started_at: m.startedAt,
        cwd: m.cwd,
      })),
    );
    monitors.sort((a, b) => b.started_at - a.started_at);
    return JSON.stringify({ monitors });
  },
};
