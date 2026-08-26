import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  DIR_MODE,
  LOG_SUFFIX,
  MONITOR_PREFIX,
  MONITOR_SIDECAR_SUFFIX,
  SPILL_PREFIX,
  TOOL_OUTPUT_PREFIX,
  TOOL_OUTPUT_SUFFIX,
} from "./constants.ts";
import { globalPaths } from "./global.ts";
import { ownerFromWorkspace, ownerSegment, workspaceRoot, type RootOptions } from "./roots.ts";

/** The two streams a shell tool may spill to disk. */
export type SpillStream = "stdout" | "stderr";

/**
 * Every machine-local path Clarvis resolves *for* a workspace but writes
 * *outside* it, under the user's global root.
 *
 * @remarks
 * This family exists so that a working tree is never the place generated
 * machinery lands. `<ws>/.clarvis` carries what a human authors or reads —
 * `settings.json`, `agents/`, `skills/`, `workflows/`, `plugins/`, and the
 * Markdown of `plans/` and `memory/` — and nothing else. Monitor sidecars,
 * shell spills, prompt history, the memory wiki's journal and the plan
 * lockfiles are all per-workspace *state*, so they hang off
 * `<global>/state/workspaces/<segment>/` instead, keyed by the workspace's own
 * canonical owner id.
 *
 * Nothing here is seeded with a `.gitignore`: this tree is not inside anyone's
 * repository, which is the entire point of it.
 */
export interface WorkspaceStatePaths {
  /** The per-workspace state root itself. */
  root: string;
  /** The working tree this state belongs to. */
  workspaceRoot: string;
  /** Machine-local scratch: prompt history, UI prefs, monitors, spills. */
  localDir: string;
  /** Bounded, opt-in terminal UI diagnostic sessions. */
  diagnosticsDir: string;
  /** Where `@clarvis/memory` keeps the wiki's journal, revision history, index
   * queue and tree lock. */
  memoryMachineryRoot: string;
  /** Where `@clarvis/plan` keeps its compare-and-swap lockfiles. */
  plansLockDir: string;
  /** Persisted prompt history for the terminal UI. */
  promptHistoryFile: string;
  /** The terminal UI's workspace-scoped preferences. */
  codeConfigFile: string;
  /** Parent directory containing every run-owned scratch directory. */
  runsDir: string;
  /** One run's scratch container, removed after its final temporary root. */
  runDir(executionId: string): string;
  /** Run-owned scratch root shared by shell and native coding tools. */
  runTempDir(executionId: string): string;
  /**
   * Resolve an owner's memory machinery root.
   *
   * @param owner - the raw owner id; encoded here so it cannot escape `owners/`.
   * @returns the absolute machinery directory for that owner's wiki.
   */
  memoryMachineryRootForOwner(owner: string): string;
  /**
   * Resolve an owner's plan lock directory.
   *
   * @param owner - the raw owner id; encoded here so it cannot escape `owners/`.
   * @returns the absolute lock directory for that owner's plans.
   */
  plansLockDirForOwner(owner: string): string;
  /**
   * Resolve a monitor's JSON sidecar.
   *
   * @param id - the monitor id.
   * @returns the absolute sidecar path.
   */
  monitorSidecar(id: string): string;
  /**
   * Resolve a monitor's captured output log.
   *
   * @param id - the monitor id.
   * @returns the absolute log path.
   */
  monitorLog(id: string): string;
  /**
   * Resolve a monitor's exit-status file.
   *
   * @param id - the monitor id.
   * @returns the absolute exit-file path.
   */
  monitorExit(id: string): string;
  /**
   * Resolve a shell tool's overflow capture.
   *
   * @param token - a unique token identifying the call.
   * @param stream - which stream overflowed.
   * @returns the absolute spill path.
   */
  spillFile(token: string, stream: SpillStream): string;
  /**
   * Resolve the untruncated copy of an oversized tool result.
   *
   * @param token - a unique token identifying the result.
   * @returns the absolute spill path.
   *
   * @remarks Separate from {@link WorkspaceStatePaths.spillFile} because the two
   *   have different producers and different shapes — a shell spill is
   *   per-stream captured output, this is one tool result written whole. They
   *   share a directory and a sweeper, not a name.
   */
  toolOutputSpill(token: string): string;
}

/**
 * Test whether a bare filename is a monitor sidecar.
 *
 * @param name - a filename, without directory.
 * @returns `true` when a directory scan should treat it as a sidecar.
 *
 * @remarks
 * Paired with {@link WorkspaceStatePaths.monitorSidecar} on purpose. A scanner
 * that re-spells the convention drifts from the builder, which is exactly how
 * shell spills went uncollected.
 */
export function isMonitorSidecar(name: string): boolean {
  return name.startsWith(MONITOR_PREFIX) && name.endsWith(MONITOR_SIDECAR_SUFFIX);
}

/**
 * Test whether a bare filename is a collectable spill — a shell tool's overflow
 * capture or the untruncated copy of an oversized tool result.
 *
 * @param name - a filename, without directory.
 * @returns `true` when a sweeper should consider it for collection.
 *
 * @remarks One predicate for both producers, kept beside
 *   {@link WorkspaceStatePaths.spillFile} and
 *   {@link WorkspaceStatePaths.toolOutputSpill} for the same reason
 *   {@link isMonitorSidecar} sits beside its builder: a scanner that re-spells
 *   the convention drifts from it, which is exactly how shell spills went
 *   uncollected.
 */
export function isSpillFile(name: string): boolean {
  return (
    (name.startsWith(SPILL_PREFIX) && name.endsWith(LOG_SUFFIX)) ||
    (name.startsWith(TOOL_OUTPUT_PREFIX) && name.endsWith(TOOL_OUTPUT_SUFFIX))
  );
}

/**
 * Derive the state-tree segment a working tree's machinery lives under.
 *
 * @param root - an already-resolved working tree root.
 * @returns exactly one non-escaping path segment.
 *
 * @remarks The same composition `@clarvis/trace` and `@clarvis/kernel` use for
 *   their own per-workspace trees, so a workspace's traces, sessions and
 *   machinery all land under the same name.
 */
function segmentFor(root: string): string {
  return ownerSegment(ownerFromWorkspace(root));
}

/**
 * Build the per-workspace state path set.
 *
 * @param root - the working tree root; when omitted, resolved with
 *   {@link workspaceRoot}.
 * @param opts - ambient overrides; see {@link RootOptions}. Unlike
 *   {@link workspacePaths}, these are consulted even when `root` is given,
 *   because the *global* root still has to be resolved.
 * @returns a fully resolved {@link WorkspaceStatePaths}.
 */
export function workspaceStatePaths(root?: string, opts?: RootOptions): WorkspaceStatePaths {
  const ws = root === undefined ? workspaceRoot(opts) : resolve(root);
  const base = join(globalPaths(undefined, opts).state, "workspaces", segmentFor(ws));
  const localDir = join(base, "local");
  const runsDir = join(localDir, "runs");
  const ownerBase = (owner: string) => join(base, "owners", ownerSegment(owner));
  const runDir = (executionId: string): string => join(runsDir, ownerSegment(executionId));
  return {
    root: base,
    workspaceRoot: ws,
    localDir,
    diagnosticsDir: join(localDir, "diagnostics"),
    memoryMachineryRoot: join(base, "memory"),
    plansLockDir: join(base, "plans"),
    promptHistoryFile: join(localDir, "prompt-history"),
    codeConfigFile: join(localDir, "code.json"),
    runsDir,
    runDir,
    runTempDir: (executionId: string) => join(runDir(executionId), "tmp"),
    memoryMachineryRootForOwner: (owner: string) => join(ownerBase(owner), "memory"),
    plansLockDirForOwner: (owner: string) => join(ownerBase(owner), "plans"),
    monitorSidecar: (id: string) =>
      join(localDir, `${MONITOR_PREFIX}${id}${MONITOR_SIDECAR_SUFFIX}`),
    monitorLog: (id: string) => join(localDir, `${MONITOR_PREFIX}${id}${LOG_SUFFIX}`),
    monitorExit: (id: string) => join(localDir, `${MONITOR_PREFIX}${id}.exit`),
    spillFile: (token: string, stream: SpillStream) =>
      join(localDir, `${SPILL_PREFIX}${token}.${stream}${LOG_SUFFIX}`),
    toolOutputSpill: (token: string) =>
      join(localDir, `${TOOL_OUTPUT_PREFIX}${token}${TOOL_OUTPUT_SUFFIX}`),
  };
}

/**
 * Ensure a workspace's state root exists, owner-only.
 *
 * @param root - the working tree root; when omitted, resolved with
 *   {@link workspaceRoot}.
 * @param opts - ambient overrides; see {@link RootOptions}.
 * @returns the absolute state root.
 */
export function ensureWorkspaceStateDir(root?: string, opts?: RootOptions): string {
  const dir = workspaceStatePaths(root, opts).root;
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  return dir;
}

/**
 * Ensure a workspace's machine-local scratch directory exists, owner-only.
 *
 * @param root - the working tree root; when omitted, resolved with
 *   {@link workspaceRoot}.
 * @param opts - ambient overrides; see {@link RootOptions}.
 * @returns the absolute local directory.
 *
 * @remarks The direct replacement for the removed `ensureLocalDir`, which
 *   created `<ws>/.clarvis/local` and had to seed a blanket `.gitignore` beside
 *   it. Nothing needs ignoring here, because nothing here is in a repository.
 */
export function ensureWorkspaceLocalDir(root?: string, opts?: RootOptions): string {
  const dir = workspaceStatePaths(root, opts).localDir;
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  return dir;
}
