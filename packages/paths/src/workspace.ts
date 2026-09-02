import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  AGENTS_DIR,
  AGENTS_PLUGINS_DIR,
  CLARVIS_DIR,
  CONTEXT_FILENAMES,
  MARKETPLACE_FILE,
} from "./constants.ts";
import { ownerSegment, workspaceRoot, type RootOptions } from "./roots.ts";

/**
 * Every path Clarvis resolves under a workspace.
 *
 * @remarks
 * **Everything reachable from here is content a human authors or reads.** The
 * workspace's own configuration — `settings.json`, `agents/`, `skills/`,
 * `workflows/`, `plugins/`, `extension-profiles/`, `guard-judge.md`, `memory-policy.md` —
 * belongs in its history, and the
 * two generated trees, {@link WorkspacePaths.plansRoot} and
 * {@link WorkspacePaths.memoryRoot}, hold Markdown the user is expected to open
 * mid-run.
 *
 * Machinery is deliberately **absent from this type**. Monitor sidecars, shell
 * spills, prompt history, the memory wiki's journal and the plan lockfiles are
 * per-workspace *state* and resolve through `workspaceStatePaths` instead,
 * under the user's global root. The keys are removed rather than deprecated so
 * that writing generated bookkeeping into someone's working tree is a
 * compile error rather than a convention.
 *
 * The one residue is transient: a `rename` is atomic only within a filesystem,
 * so an atomic write's temp file must be a sibling of its target. Those carry
 * `TMP_PREFIX`, which `TMP_GLOB` and `INTERNAL_IGNORE_PATTERNS` already hide.
 */
export interface WorkspacePaths {
  /** The working tree root. */
  root: string;
  /** The workspace's `.clarvis` directory. */
  clarvisDir: string;
  /** Workspace settings document. */
  settingsFile: string;
  /** Directory of file-based agent profiles. */
  agentsDir: string;
  /** Workspace skill directory. */
  skillsDir: string;
  /** Directory of authored workflow definitions. */
  workflowsDir: string;
  /** Clarvis-native installed plugin directory. */
  pluginsDir: string;
  /** Shared Extension Profile definitions authored for this workspace. */
  extensionProfilesDir: string;
  /** Workspace-authored guard-judge prompt override. */
  guardJudgeFile: string;
  /**
   * Workspace-authored memory editorial policy — what is worth recording here.
   *
   * @remarks Shared, not personal: the seeded `.gitignore` is selective and
   * leaves an authored file at the `.clarvis` root in the repository's history,
   * so this one is the team's convention. The per-person equivalent is the
   * global file of the same name, and the two are **concatenated** rather than
   * shadowing each other — unlike `guard-judge.md`, which is one complete
   * judging prompt and so takes the nearest scope whole.
   */
  memoryPolicyFile: string;
  /** Shared plan documents. */
  plansRoot: string;
  /** Shared memory wiki. */
  memoryRoot: string;
  /** Agent-context candidates for this scope, absolute, in search order. */
  contextCandidates: readonly string[];
  /**
   * Resolve an owner's plan root.
   *
   * @param owner - the raw owner id; encoded here so it cannot escape `owners/`.
   * @returns the absolute plans directory for that owner.
   */
  plansRootForOwner(owner: string): string;
  /**
   * Resolve an owner's memory root.
   *
   * @param owner - the raw owner id; encoded here so it cannot escape `owners/`.
   * @returns the absolute memory directory for that owner.
   */
  memoryRootForOwner(owner: string): string;
  /**
   * Resolve a named agent profile document.
   *
   * @param name - the agent name, without extension.
   * @returns the absolute path to `<agentsDir>/<name>.md`.
   */
  agentFile(name: string): string;
}

/**
 * Build the workspace path set for a working tree.
 *
 * @param root - the working tree root; when omitted, resolved with
 *   {@link workspaceRoot}.
 * @param opts - ambient overrides used only when `root` is omitted.
 * @returns a fully resolved {@link WorkspacePaths}.
 */
export function workspacePaths(root?: string, opts?: RootOptions): WorkspacePaths {
  const base = root === undefined ? workspaceRoot(opts) : resolve(root);
  const clarvisDir = join(base, CLARVIS_DIR);
  const agentsDir = join(clarvisDir, "agents");
  const ownerRoot = (owner: string) => join(clarvisDir, "owners", ownerSegment(owner));
  return {
    root: base,
    clarvisDir,
    settingsFile: join(clarvisDir, "settings.json"),
    agentsDir,
    skillsDir: join(clarvisDir, "skills"),
    workflowsDir: join(clarvisDir, "workflows"),
    pluginsDir: join(clarvisDir, "plugins"),
    extensionProfilesDir: join(clarvisDir, "extension-profiles"),
    guardJudgeFile: join(clarvisDir, "guard-judge.md"),
    memoryPolicyFile: join(clarvisDir, "memory-policy.md"),
    plansRoot: join(clarvisDir, "plans"),
    memoryRoot: join(clarvisDir, "memory"),
    contextCandidates: CONTEXT_FILENAMES.map((name) => join(base, name)),
    plansRootForOwner: (owner: string) => join(ownerRoot(owner), "plans"),
    memoryRootForOwner: (owner: string) => join(ownerRoot(owner), "memory"),
    agentFile: (name: string) => join(agentsDir, `${name}.md`),
  };
}

/**
 * Resolve the `.agents/skills` directories Clarvis reads, in both scopes.
 *
 * @param opts - ambient overrides; see {@link RootOptions}.
 * @returns the user and workspace `.agents/skills` directories.
 *
 * @remarks
 * Standalone skills are read as operator-authored input. Both rank *below*
 * their `.clarvis` equivalents in skill precedence.
 */
export function agentsSkillsDirs(opts: RootOptions = {}): { user: string; workspace: string } {
  const home = opts.home ?? homedir();
  return {
    user: join(home, AGENTS_DIR, "skills"),
    workspace: join(workspaceRoot(opts), AGENTS_DIR, "skills"),
  };
}

/**
 * Resolve the shared plugin directory under one `.agents` root.
 *
 * @param root - a home directory, workspace root, or marketplace checkout root.
 * @returns `<root>/.agents/plugins`.
 *
 * @remarks This subtree is a first-class plugin surface. Readers discover
 * plugin directories and `marketplace.json` here, while the managed plugin
 * lifecycle may mutate an exact plugin directory without claiming ownership of
 * unrelated `.agents` content.
 */
export function agentsPluginsDir(root: string): string {
  return join(resolve(root), AGENTS_DIR, AGENTS_PLUGINS_DIR);
}

/** Resolve the user and workspace shared plugin roots. */
export function agentsPluginsDirs(opts: RootOptions = {}): { user: string; workspace: string } {
  return {
    user: agentsPluginsDir(opts.home ?? homedir()),
    workspace: agentsPluginsDir(workspaceRoot(opts)),
  };
}

/**
 * Resolve the cross-runtime plugin marketplace document under one root.
 *
 * @param root - the directory holding the `.agents` tree: a home directory, a
 *   working tree, or a checkout Clarvis has fetched.
 * @returns the absolute path to that root's marketplace document.
 *
 * @remarks
 * Always *below* the marketplace document a source publishes at its own root.
 */
export function agentsMarketplaceFile(root: string): string {
  return join(agentsPluginsDir(root), MARKETPLACE_FILE);
}

/**
 * Resolve the cross-runtime marketplace documents Clarvis reads, in both scopes.
 *
 * @param opts - ambient overrides; see {@link RootOptions}.
 * @returns the user and workspace marketplace documents.
 */
export function agentsMarketplaceFiles(opts: RootOptions = {}): {
  user: string;
  workspace: string;
} {
  return {
    user: agentsMarketplaceFile(opts.home ?? homedir()),
    workspace: agentsMarketplaceFile(workspaceRoot(opts)),
  };
}

/**
 * Whether a path is a cross-runtime marketplace document.
 *
 * @param candidate - an absolute or relative path.
 * @returns `true` when it is `<root>/.agents/plugins/marketplace.json`.
 *
 * @remarks Ships beside {@link agentsMarketplaceFile} for the same reason every
 *   other builder here ships with its recogniser: a reader that has to tell one
 *   of these documents from a source URL must not re-spell the layout itself.
 */
export function isAgentsMarketplaceFile(candidate: string): boolean {
  const parts = candidate.split(/[/\\]/);
  return (
    parts.length >= 3 &&
    parts.at(-1) === MARKETPLACE_FILE &&
    parts.at(-2) === AGENTS_PLUGINS_DIR &&
    parts.at(-3) === AGENTS_DIR
  );
}
