import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { DIR_MODE, TOOL_OUTPUT_PREFIX, TOOL_OUTPUT_SUFFIX } from "./constants.ts";
import { globalPaths } from "./global.ts";
import { ownerFromWorkspace, ownerSegment, workspaceRoot, type RootOptions } from "./roots.ts";

/**
 * Every machine-local path Clarvis resolves *for* a workspace but writes
 * *outside* it, under the user's global root.
 *
 * @remarks
 * This family exists so that a working tree is never the place generated
 * machinery lands. `<ws>/.clarvis` carries what a human authors or reads —
 * `settings.json`, `agents/`, `skills/`, `workflows/`, `plugins/`, and the
 * Markdown of `plans/` and `memory/` — and nothing else. Prompt history,
 * generic tool-result spills, the memory wiki's journal and the plan
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
  /** Machine-local scratch: prompt history, UI prefs and generic tool-result spills. */
  localDir: string;
  /** Bounded, opt-in terminal UI diagnostic sessions. */
  diagnosticsDir: string;
  /** Where `@clarvis/memory` keeps the wiki's journal, revision history, index
   * queue and tree lock. */
  memoryMachineryRoot: string;
  /** Where `@clarvis/plan` keeps its compare-and-swap lockfiles. */
  plansLockDir: string;
  /** Cross-process trace locks for this workspace across runtime placements. */
  traceLocksDir: string;
  /** Persistent writable state supplied to workspace plugin processes. */
  pluginDataRoot: string;
  /** Persisted prompt history for the terminal UI. */
  promptHistoryFile: string;
  /** The terminal UI's workspace-scoped preferences. */
  codeConfigFile: string;
  /** Machine-local Extension Profile selection for this workspace. */
  extensionProfileSelectionFile: string;
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
   * Resolve the untruncated copy of an oversized tool result.
   *
   * @param token - a unique token identifying the result.
   * @returns the absolute spill path.
   *
   * @remarks This is a generic tool-result artifact, never a command stream.
   */
  toolOutputSpill(token: string): string;
}

/**
 * Test whether a bare filename is a collectable generic tool-result spill.
 *
 * @param name - a filename, without directory.
 * @returns `true` when a sweeper should consider it for collection.
 *
 * @remarks Kept beside {@link WorkspaceStatePaths.toolOutputSpill} so the
 *   collector uses the same filename convention as its producer.
 */
export function isSpillFile(name: string): boolean {
  return name.startsWith(TOOL_OUTPUT_PREFIX) && name.endsWith(TOOL_OUTPUT_SUFFIX);
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
  return workspaceStatePathsFromRoot(ws, base);
}

/**
 * Rebuild the complete path set from a trusted, already-selected state root.
 *
 * @param root - the workspace root selected by the host.
 * @param stateRoot - the matching per-workspace state root selected by the host.
 * @returns paths and owner/spill builders rooted at that exact state tree.
 *
 * @remarks Used across process boundaries where functions cannot be serialized.
 * The caller owns the association between the workspace and state roots.
 */
export function workspaceStatePathsFromRoot(root: string, stateRoot: string): WorkspaceStatePaths {
  const ws = resolve(root);
  const base = resolve(stateRoot);
  const localDir = join(base, "local");
  const ownerBase = (owner: string) => join(base, "owners", ownerSegment(owner));
  return {
    root: base,
    workspaceRoot: ws,
    localDir,
    diagnosticsDir: join(localDir, "diagnostics"),
    memoryMachineryRoot: join(base, "memory"),
    plansLockDir: join(base, "plans"),
    traceLocksDir: join(base, "trace-locks"),
    pluginDataRoot: join(base, "plugin-data"),
    promptHistoryFile: join(localDir, "prompt-history"),
    codeConfigFile: join(localDir, "code.json"),
    extensionProfileSelectionFile: join(localDir, "extension-profile.json"),
    memoryMachineryRootForOwner: (owner: string) => join(ownerBase(owner), "memory"),
    plansLockDirForOwner: (owner: string) => join(ownerBase(owner), "plans"),
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
 * @param root - the working tree root or trusted pre-resolved state paths. Explicit
 *   state paths bypass ambient root discovery; when omitted, uses {@link workspaceRoot}.
 * @param opts - ambient overrides; see {@link RootOptions}.
 * @returns the absolute local directory.
 *
 * @remarks The direct replacement for the removed `ensureLocalDir`, which
 *   created `<ws>/.clarvis/local` and had to seed a blanket `.gitignore` beside
 *   it. Nothing needs ignoring here, because nothing here is in a repository.
 */
export function ensureWorkspaceLocalDir(
  root?: string | WorkspaceStatePaths,
  opts?: RootOptions,
): string {
  const dir = (typeof root === "object" ? root : workspaceStatePaths(root, opts)).localDir;
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  return dir;
}
