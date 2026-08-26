import { promises as fs, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { ensureWorkspaceLocalDir, isMonitorSidecar, workspaceStatePaths } from "@clarvis/paths";
import { ToolError } from "../errors.ts";
import { writeAtomic } from "./atomic.ts";
import { readRawFile } from "./files.ts";
import { NOOP_TOOLS_LOGGER, type ToolsLogger } from "./log.ts";
import { currentShellFlavor } from "./platform.ts";

/** Monitor metadata and exit sentinels are small control records, never logs. */
export const MAX_MONITOR_SIDECAR_BYTES = 256 * 1024;
export const MAX_MONITOR_EXIT_BYTES = 64;

/**
 * The persisted record for one background process (a "monitor"): its identity,
 * the command and directory it ran in, its OS pid, and its readiness predicate.
 * Serialized to a JSON sidecar next to its log and exit files.
 */
export interface MonitorMeta {
  /** Monitor id, minted by {@link mintId} (e.g. `mon_1a2b3c4d`). */
  id: string;
  /** The shell command line that was launched. */
  command: string;
  /** Working directory the command ran in. */
  cwd: string;
  /** OS process id of the launched process (its process group leader). */
  pid: number;
  /** Epoch millis when the monitor was started. */
  startedAt: number;
  /** A substring/pattern signalling the process is ready, or `null` when none
   * was specified. */
  readyWhen: string | null;
}

/** The directory where a workspace's monitor sidecar, log, and exit files live.
 *
 * @remarks Under the user's global root, not the working tree: a background
 * process's bookkeeping is machine-local state, and a repository is not where
 * it belongs. */
export function monitorDir(workspaceRoot: string): string {
  return workspaceStatePaths(workspaceRoot).localDir;
}

/** Path of a monitor's JSON metadata sidecar (`monitor-<id>.json`). */
export function sidecarPath(workspaceRoot: string, id: string): string {
  return workspaceStatePaths(workspaceRoot).monitorSidecar(id);
}

/** Path of a monitor's captured-output log file (`monitor-<id>.log`). */
export function logPath(workspaceRoot: string, id: string): string {
  return workspaceStatePaths(workspaceRoot).monitorLog(id);
}

/** Path of a monitor's exit-code file (`monitor-<id>.exit`), written when the
 * process ends. */
export function exitPath(workspaceRoot: string, id: string): string {
  return workspaceStatePaths(workspaceRoot).monitorExit(id);
}

/** Mint a fresh monitor id of the form `mon_` + 8 random hex chars. */
export function mintId(): string {
  return `mon_${randomBytes(4).toString("hex")}`;
}

/**
 * Ensure the workspace's machine-local scratch directory exists.
 *
 * @param workspaceRoot - the workspace whose scratch dir is created.
 * @returns the absolute path of that directory.
 * @remarks Idempotent, and delegated to `@clarvis/paths` so the directory has a
 *   single creator rather than whichever tool happened to run first. It needs no
 *   `.gitignore` any more, because it is no longer inside a repository.
 */
export async function ensureClarvisDir(workspaceRoot: string): Promise<string> {
  return Promise.resolve(ensureWorkspaceLocalDir(workspaceRoot));
}

/**
 * Test whether a process is still running.
 *
 * @param pid - the process id to probe.
 * @returns `true` if the process exists and is not a zombie; `false` otherwise.
 * @remarks Uses a signal-0 probe, treating `EPERM` as alive (the process exists
 *   but is owned by another user). On Linux it additionally reads `/proc/<pid>/
 *   stat` and reports a defunct (`Z`-state) process as not alive.
 *
 *   Windows needs no counterpart to the `/proc` read: a signal-0 probe there is
 *   implemented as a `GetExitCodeProcess` check for `STILL_ACTIVE`, which
 *   already reports an exited-but-handle-held process as gone - the same case
 *   the zombie check covers.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        if (stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z") return false;
      } catch {
        return false;
      }
    }
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Structural guard that a parsed value is a {@link MonitorMeta} (checks the
 * `id` and `pid` fields), used to reject corrupt sidecars. */
function isMeta(m: unknown): m is MonitorMeta {
  return (
    typeof m === "object" &&
    m !== null &&
    typeof (m as MonitorMeta).id === "string" &&
    typeof (m as MonitorMeta).pid === "number"
  );
}

/** Atomically persist a monitor's metadata to its JSON sidecar. */
export async function writeSidecar(workspaceRoot: string, meta: MonitorMeta): Promise<void> {
  await writeAtomic(sidecarPath(workspaceRoot, meta.id), JSON.stringify(meta));
}

/**
 * Read and validate a monitor's metadata sidecar.
 *
 * @param workspaceRoot - the workspace the monitor belongs to.
 * @param id - the monitor id.
 * @returns the parsed {@link MonitorMeta}.
 * @throws {@link ToolError} with code `monitor_not_found` when the sidecar is
 *   missing, unreadable, unparseable, or fails the {@link isMeta} shape check.
 */
export async function readSidecar(workspaceRoot: string, id: string): Promise<MonitorMeta> {
  let raw: string;
  try {
    raw = (
      await readRawFile(
        sidecarPath(workspaceRoot, id),
        sidecarPath(workspaceRoot, id),
        MAX_MONITOR_SIDECAR_BYTES,
        undefined,
        { noFollow: true },
      )
    ).toString("utf8");
  } catch {
    throw new ToolError("monitor_not_found", `No such monitor: ${id}`, { id });
  }
  try {
    const m: unknown = JSON.parse(raw);
    if (isMeta(m)) return m;
  } catch {
    /* fall through to not_found */
  }
  throw new ToolError("monitor_not_found", `No such monitor: ${id}`, { id });
}

/**
 * Enumerate every valid monitor sidecar in the workspace.
 *
 * @param workspaceRoot - the workspace to scan.
 * @returns the parsed {@link MonitorMeta} list; an empty array when the
 *   `.clarvis` dir is absent. Missing, unreadable, or malformed sidecars are
 *   skipped rather than throwing.
 */
export async function listSidecars(
  workspaceRoot: string,
  maxEntries = Number.POSITIVE_INFINITY,
): Promise<MonitorMeta[]> {
  const dir = monitorDir(workspaceRoot);
  const entries: string[] = [];
  try {
    const handle = await fs.opendir(dir);
    try {
      for await (const entry of handle) {
        if (entries.length >= maxEntries) break;
        entries.push(entry.name);
      }
    } finally {
      await Promise.resolve(handle.close()).catch(() => undefined);
    }
  } catch {
    return [];
  }
  const metas: MonitorMeta[] = [];
  for (const name of entries) {
    if (!isMonitorSidecar(name)) continue;
    try {
      const sidecar = path.join(dir, name);
      const raw = await readRawFile(sidecar, sidecar, MAX_MONITOR_SIDECAR_BYTES, undefined, {
        noFollow: true,
      });
      const m: unknown = JSON.parse(raw.toString("utf8"));
      if (isMeta(m)) metas.push(m);
    } catch {
      continue;
    }
  }
  return metas;
}

/** Whether a monitored process has exited and, if known, its exit code. */
export interface ExitState {
  /** `true` once the exit file exists, i.e. the process has terminated. */
  exited: boolean;
  /** The exit code, or `null` when it has not exited or the code is unreadable
   * or out of safe-integer range. */
  code: number | null;
}

/**
 * Read a monitor's exit state from its `.exit` file.
 *
 * @param workspaceRoot - the workspace the monitor belongs to.
 * @param id - the monitor id.
 * @returns `{ exited: false, code: null }` when the exit file is absent (still
 *   running); otherwise `{ exited: true, code }` with `code` parsed from the file
 *   or `null` if it is non-numeric or not a safe integer.
 */
export async function readExitState(
  workspaceRoot: string,
  id: string,
  logger: ToolsLogger = NOOP_TOOLS_LOGGER,
): Promise<ExitState> {
  const unreadable = (raw: string | null, reason: string): ExitState => {
    logger.warn(
      { event: "tools.monitor_exit_unreadable", id, raw, reason, flavor: currentShellFlavor() },
      "a monitor's exit sentinel could not be read as a number, so its exit code is reported as unknown — indistinguishable from a killed process",
    );
    return { exited: true, code: null };
  };
  let raw: string;
  try {
    const exit = exitPath(workspaceRoot, id);
    raw = (await readRawFile(exit, exit, MAX_MONITOR_EXIT_BYTES, undefined, { noFollow: true }))
      .toString("utf8")
      .trim();
  } catch (error) {
    if (error instanceof ToolError && (error.code === "too_large" || error.code === "not_a_file")) {
      return unreadable(null, error.code);
    }
    return { exited: false, code: null };
  }
  if (!/^-?\d+$/.test(raw)) return unreadable(raw, "non_numeric");
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return unreadable(raw, "out_of_range");
  return { exited: true, code: n };
}

/** Convenience over {@link readExitState} returning just the exit `code` (or
 * `null` when unknown or still running). */
export async function readExitCode(
  workspaceRoot: string,
  id: string,
  logger: ToolsLogger = NOOP_TOOLS_LOGGER,
): Promise<number | null> {
  return (await readExitState(workspaceRoot, id, logger)).code;
}

/**
 * Determine whether a monitored process is still running.
 *
 * @param workspaceRoot - the workspace the monitor belongs to.
 * @param meta - the monitor's metadata.
 * @returns `false` once the exit file is present, otherwise the live
 *   {@link isAlive} probe of `meta.pid`.
 * @remarks The exit file is authoritative and checked first, so a pid reused by
 *   an unrelated process after exit is not mistaken for the monitor.
 */
export async function monitorRunning(
  workspaceRoot: string,
  meta: MonitorMeta,
  logger: ToolsLogger = NOOP_TOOLS_LOGGER,
): Promise<boolean> {
  const { exited } = await readExitState(workspaceRoot, meta.id, logger);
  if (exited) return false;
  return isAlive(meta.pid);
}

/** Remove a monitor's sidecar, log, and exit files, ignoring any that are
 * already gone. */
export async function removeMonitorFiles(workspaceRoot: string, id: string): Promise<void> {
  await Promise.all([
    fs.rm(sidecarPath(workspaceRoot, id), { force: true }),
    fs.rm(logPath(workspaceRoot, id), { force: true }),
    fs.rm(exitPath(workspaceRoot, id), { force: true }),
  ]);
}

/**
 * How long a naturally-exited monitor's file set is kept before collection.
 *
 * @remarks Only ever delays a delete: a monitor whose process is gone is already
 * unreadable as a live thing, and this window exists so its captured output can
 * still be read back after the fact. The unit that matters is the working
 * session — a monitor started in the morning should still be inspectable that
 * afternoon — and a full day is the smallest window that covers one regardless
 * of the hour it began at. Shorter risks collecting output a caller is still
 * reading; longer only leaves dead files on disk, which the next sweep removes
 * anyway.
 */
const MONITOR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Garbage-collect finished monitors: delete the file set of every monitor whose
 * process is no longer running and, when it exited naturally, has stayed
 * finished for longer than {@link MONITOR_MAX_AGE_MS} (24h).
 *
 * @param workspaceRoot - the workspace to sweep.
 * @remarks A monitor's exit file is written the moment its process actually
 *   finished, so its mtime is the completion timestamp the cutoff is measured
 *   from — mirroring `@clarvis/paths`' spill cutoff, which keeps recent spills
 *   referenced by live output. A
 *   monitor whose process died without ever producing an exit file (e.g.
 *   killed outside the tool) has no completion timestamp to preserve and is
 *   reaped immediately, same as before this cutoff existed. Live monitors are
 *   left intact; runs concurrently across monitors.
 */
export async function sweepMonitors(
  workspaceRoot: string,
  options: { maxEntries?: number; concurrency?: number } = {},
): Promise<void> {
  const metas = await listSidecars(workspaceRoot, options.maxEntries ?? 10_000);
  const now = Date.now();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < metas.length) {
      const m = metas[next++]!;
      if (await monitorRunning(workspaceRoot, m)) continue;
      const exitStat = await fs.stat(exitPath(workspaceRoot, m.id)).catch(() => undefined);
      if (exitStat !== undefined && now - exitStat.mtimeMs < MONITOR_MAX_AGE_MS) continue;
      await removeMonitorFiles(workspaceRoot, m.id);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, options.concurrency ?? 4), metas.length) }, () =>
      worker(),
    ),
  );
}
