import { join } from "node:path";

import { CONTEXT_FILENAMES } from "./constants.ts";
import { globalRoot, ownerSegment, type RootOptions } from "./roots.ts";

/**
 * Every path Clarvis resolves under the user's global root.
 *
 * @remarks
 * **Operator-owned configuration sits at the root**, not under a `config/`
 * subdirectory: `~/.clarvis/settings.json`, `~/.clarvis/agents/` and their
 * siblings are what a user opens and edits by hand, and burying them one level
 * down made the global tree disagree with the workspace one, where
 * `<ws>/.clarvis/settings.json` and `<ws>/.clarvis/agents/` have always been at
 * the root. The two roots now read the same way.
 *
 * What remains nested is what a user never edits: {@link state} is generated and
 * recoverable but costly to lose, {@link cache} may be deleted at any moment
 * without consequence, and `exports/` is output a user opens to read.
 */
export interface GlobalPaths {
  /** The global root itself, and the directory the operator's own files live in. */
  root: string;
  /** Generated state that is recoverable but costly to lose. */
  state: string;
  /** Derived data that may be deleted at any time. */
  cache: string;
  /** Persistent writable state supplied to portable plugin processes. */
  pluginDataRoot: string;
  /** Global settings document. */
  settingsFile: string;
  /** Directory of file-based agent profiles. */
  agentsDir: string;
  /** Provider credential store. */
  keysFile: string;
  /** Renewable local-user subscription credentials, separate from API keys. */
  subscriptionsFile: string;
  /** Private machine state for remote MCP OAuth registrations and tokens. */
  mcpOAuthFile: string;
  /** Installed plugin directory. */
  pluginsDir: string;
  /** Operator-authored reusable Extension Profile definitions. */
  extensionProfilesDir: string;
  /** Recorded workspace-surface trust decisions. */
  workspaceTrustFile: string;
  /** Global skill directory. */
  skillsDir: string;
  /**
   * Global directory of authored workflow definitions.
   *
   * @remarks Distinct from {@link GlobalPaths.workflowRecordsDir}, which holds the
   * generated record of workflows that have *run*. This one is operator-authored
   * configuration and sits at the root beside `agents/` and `skills/`, because
   * that is what it is.
   */
  workflowsDir: string;
  /** Operator-authored guard-judge prompt override. */
  guardJudgeFile: string;
  /**
   * Operator-authored memory editorial policy — what this person wants recorded.
   *
   * @remarks Personal and portable: it follows the operator across every
   * workspace and is never shared, which is the half of the split a committed
   * workspace file cannot serve. Concatenated ahead of the workspace file, so
   * the more specific scope reads as a refinement rather than a replacement.
   */
  memoryPolicyFile: string;
  /** The server's client enrolment table. */
  authFile: string;
  /** The server's token signing key. */
  authKeyFile: string;
  /** Persisted session records. */
  sessionsDir: string;
  /** Persisted execution traces. */
  tracesDir: string;
  /** Persisted records of workflows that have run. */
  workflowRecordsDir: string;
  /** Operator-wide default Extension Profile selection. */
  extensionProfileSelectionFile: string;
  /** The terminal UI's own preferences. */
  codeConfigFile: string;
  /** Cached model catalogue snapshot. */
  modelsCacheFile: string;
  /** Agent-context candidates for this scope, absolute, in search order. */
  contextCandidates: readonly string[];
  /**
   * Resolve an owner's export directory.
   *
   * @param owner - the raw owner id; encoded here so it cannot escape `exports/`.
   * @returns the absolute directory exported transcripts are written to.
   */
  exportsDirForOwner(owner: string): string;
  /**
   * Resolve a named agent profile document.
   *
   * @param name - the agent name, without extension.
   * @returns the absolute path to `<agentsDir>/<name>.md`.
   */
  agentFile(name: string): string;
}

/**
 * Build the global path set for a root.
 *
 * @param root - the global root; when omitted, resolved with {@link globalRoot}.
 * @param opts - ambient overrides used only when `root` is omitted.
 * @returns a fully resolved {@link GlobalPaths}.
 */
export function globalPaths(root?: string, opts?: RootOptions): GlobalPaths {
  const base = root ?? globalRoot(opts);
  const state = join(base, "state");
  const cache = join(base, "cache");
  const agentsDir = join(base, "agents");
  return {
    root: base,
    state,
    cache,
    pluginDataRoot: join(state, "plugin-data"),
    settingsFile: join(base, "settings.json"),
    agentsDir,
    keysFile: join(base, "keys.json"),
    subscriptionsFile: join(base, "subscriptions.json"),
    mcpOAuthFile: join(state, "mcp-oauth.json"),
    pluginsDir: join(base, "plugins"),
    extensionProfilesDir: join(base, "extension-profiles"),
    workspaceTrustFile: join(base, "workspace-trust.json"),
    skillsDir: join(base, "skills"),
    workflowsDir: join(base, "workflows"),
    guardJudgeFile: join(base, "guard-judge.md"),
    memoryPolicyFile: join(base, "memory-policy.md"),
    authFile: join(base, "auth.json"),
    authKeyFile: join(base, "auth-key.json"),
    sessionsDir: join(state, "sessions"),
    tracesDir: join(state, "traces"),
    workflowRecordsDir: join(state, "workflows"),
    extensionProfileSelectionFile: join(state, "extension-profile.json"),
    codeConfigFile: join(state, "code.json"),
    modelsCacheFile: join(cache, "models-dev.json"),
    contextCandidates: CONTEXT_FILENAMES.map((name) => join(base, name)),
    exportsDirForOwner: (owner: string) => join(base, "exports", ownerSegment(owner)),
    agentFile: (name: string) => join(agentsDir, `${name}.md`),
  };
}
