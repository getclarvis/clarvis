import { promises as fs } from "node:fs";
import { join } from "node:path";

import { pathsLogger, type PathsLogger } from "./diag.ts";
import { FILE_MODE } from "./constants.ts";
import { globalPaths } from "./global.ts";
import { isSpillFile, workspaceStatePaths } from "./workspace-state.ts";

const SPILL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ignoreFsFailure = (): undefined => undefined;

export interface GlobalStateSweepReport {
  workspaces: number;
  spillsScanned: number;
  spillsRemoved: number;
  spillModesRepaired: number;
  runDirsRemoved: number;
  truncated: boolean;
}

interface SpillSweepReport {
  scanned: number;
  candidates: number;
  removed: number;
  modesRepaired: number;
  truncated: boolean;
}

async function sweepLocalSpills(
  dir: string,
  options: { maxEntries: number; concurrency: number },
): Promise<SpillSweepReport> {
  const candidates: string[] = [];
  const handle = await fs.opendir(dir).catch(ignoreFsFailure);
  if (handle === undefined) {
    return { scanned: 0, candidates: 0, removed: 0, modesRepaired: 0, truncated: false };
  }
  let scanned = 0;
  let truncated = false;
  let removed = 0;
  let modesRepaired = 0;
  try {
    for await (const entry of handle) {
      if (scanned++ >= options.maxEntries) {
        truncated = true;
        break;
      }
      if (entry.isFile() && isSpillFile(entry.name)) candidates.push(entry.name);
    }
  } catch {
  } finally {
    await Promise.resolve(handle.close()).catch(ignoreFsFailure);
  }
  const now = Date.now();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < candidates.length) {
      const name = candidates[next++]!;
      const file = join(dir, name);
      try {
        const info = await fs.lstat(file);
        if (!info.isFile()) continue;
        if (process.platform !== "win32" && (info.mode & 0o777) !== FILE_MODE) {
          await fs.chmod(file, FILE_MODE);
          modesRepaired += 1;
        }
        if (now - info.mtimeMs > SPILL_MAX_AGE_MS) {
          await fs.rm(file, { force: true });
          removed += 1;
        }
      } catch {}
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, options.concurrency), candidates.length) }, () =>
      worker(),
    ),
  );
  return { scanned, candidates: candidates.length, removed, modesRepaired, truncated };
}

async function removeStaleEmptyRunDirs(runsDir: string, maxEntries: number): Promise<number> {
  const handle = await fs.opendir(runsDir).catch(ignoreFsFailure);
  if (handle === undefined) return 0;
  const now = Date.now();
  let scanned = 0;
  let removed = 0;
  try {
    for await (const entry of handle) {
      if (scanned++ >= maxEntries) break;
      if (!entry.isDirectory()) continue;
      const runDir = join(runsDir, entry.name);
      try {
        const info = await fs.lstat(runDir);
        if (!info.isDirectory() || now - info.mtimeMs <= SPILL_MAX_AGE_MS) continue;
        const descendants = await fs.readdir(runDir, { recursive: true });
        if (descendants.some((name) => !name.endsWith("tmp"))) continue;
        await fs.rm(runDir, { recursive: true, force: true });
        removed += 1;
      } catch {}
    }
  } catch {
  } finally {
    await Promise.resolve(handle.close()).catch(ignoreFsFailure);
  }
  try {
    await fs.rmdir(runsDir);
  } catch {}
  return removed;
}

/**
 * Delete stale output spill files left in a workspace's machine-local state.
 *
 * @param workspaceRoot - the workspace whose state directory is swept.
 * @param options - scan bounds, and where to report the pass.
 * @returns nothing; a missing directory or per-file errors are ignored.
 * @remarks Only recognised shell and generic-result spills older than 24 hours
 *   are removed. Recent spills, monitor files and unrelated entries survive.
 *
 *   The pass returns `void`, so a workspace that has grown past `maxEntries`
 *   would otherwise stop being swept silently and permanently. That is what the
 *   `truncated` field of `paths.spill_sweep` exists to say.
 */
export async function sweepSpillDir(
  workspaceRoot: string,
  options: { maxEntries?: number; concurrency?: number; logger?: PathsLogger } = {},
): Promise<void> {
  const dir = workspaceStatePaths(workspaceRoot).localDir;
  const maxEntries = Math.max(0, options.maxEntries ?? 10_000);
  const logger = options.logger ?? pathsLogger();
  const report = await sweepLocalSpills(dir, {
    maxEntries,
    concurrency: options.concurrency ?? 4,
  });
  logger.debug(
    {
      event: "paths.spill_sweep",
      dir,
      scanned: report.scanned,
      candidates: report.candidates,
      removed: report.removed,
      modes_repaired: report.modesRepaired,
      truncated: report.truncated,
    },
    "a spill housekeeping pass finished; a truncated pass leaves the rest of the directory unswept",
  );
}

/**
 * Sweep bounded disposable artifacts across every persisted workspace state root.
 *
 * @param root - Clarvis global root; defaults through {@link globalPaths}.
 * @param options - Workspace/entry/concurrency bounds for one pass.
 * @returns Aggregate work performed and whether a scan bound truncated the pass.
 */
export async function sweepGlobalStateArtifacts(
  root?: string,
  options: { maxWorkspaces?: number; maxEntriesPerWorkspace?: number; concurrency?: number } = {},
): Promise<GlobalStateSweepReport> {
  const workspacesDir = join(globalPaths(root).state, "workspaces");
  const maxWorkspaces = Math.max(0, options.maxWorkspaces ?? 1_000);
  const maxEntries = Math.max(0, options.maxEntriesPerWorkspace ?? 10_000);
  const report: GlobalStateSweepReport = {
    workspaces: 0,
    spillsScanned: 0,
    spillsRemoved: 0,
    spillModesRepaired: 0,
    runDirsRemoved: 0,
    truncated: false,
  };
  const handle = await fs.opendir(workspacesDir).catch(ignoreFsFailure);
  if (handle === undefined) return report;
  try {
    for await (const entry of handle) {
      if (!entry.isDirectory()) continue;
      if (report.workspaces >= maxWorkspaces) {
        report.truncated = true;
        break;
      }
      report.workspaces += 1;
      const localDir = join(workspacesDir, entry.name, "local");
      const spills = await sweepLocalSpills(localDir, {
        maxEntries,
        concurrency: options.concurrency ?? 4,
      });
      report.spillsScanned += spills.candidates;
      report.spillsRemoved += spills.removed;
      report.spillModesRepaired += spills.modesRepaired;
      report.truncated ||= spills.truncated;
      report.runDirsRemoved += await removeStaleEmptyRunDirs(join(localDir, "runs"), maxEntries);
    }
  } catch {
  } finally {
    await Promise.resolve(handle.close()).catch(ignoreFsFailure);
  }
  return report;
}
