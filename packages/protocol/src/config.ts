/**
 * ConfigService — everything the UI reads and writes about workspace configuration.
 *
 * The kernel owns on-disk formats and validation; the UI exchanges structured DTOs
 * and commands rather than touching files directly.
 */

import type { Scope, Timestamp, Unsubscribe } from "./common.ts";

/** Trust verdict for executable declarations owned by the current workspace. */
export interface WorkspaceTrustVerdict {
  state: "inert" | "unapproved" | "trusted" | "changed";
  fingerprint?: string;
  approved?: string;
}

/**
 * Payload of `settings.json`, as validated by the kernel.
 *
 * Modeled with the fields the UI actually touches; deep blocks may be typed loosely
 * in this draft — the kernel remains the authority on the real schema.
 */
export interface SettingsData {
  default_model?: string;
  /**
   * Provider list (each entry carries its own `name`) — mirrors the engine’s shape.
   */
  providers?: ProviderConfig[];
  mcp_servers?: Record<string, McpServerConfig>;
  guard?: GuardConfig;
  sandbox?: SandboxConfig;
  memory?: MemoryConfig;
  budget?: unknown;
  /** Inline agent profiles (vs. file-based agents under `.clarvis/agents`). */
  profiles?: Record<string, unknown>;
  /** Forward-compatible: the kernel owns the exhaustive schema. */
  [block: string]: unknown;
}

/** One configured LLM / completion provider. */
export interface ProviderConfig {
  name: string;
  /** Provider family (e.g. `anthropic`, `openai`); selects the SDK adapter. */
  kind?: string;
  base_url?: string;
  /** Name of the environment variable that holds this provider's API key (not the key itself). */
  api_key_env?: string;
  /** Forward-compatible: the kernel owns the exhaustive provider schema. */
  [k: string]: unknown;
}

/** How a downstream MCP tool server is reached. */
export type ToolTransport = "stdio" | "http" | "sse";

/** Live connection state of a downstream MCP server, as the kernel reports it. */
export type MCPStatus = "connected" | "lost" | "unavailable";

/** Configuration for one MCP server entry in settings. */
export interface McpServerConfig {
  command?: string;
  args?: string[];
  url?: string;
  [k: string]: unknown;
}

/** Guard / command-approval settings block. */
export interface GuardConfig {
  mode?: "off" | "on" | "auto";
  allowed_commands?: string[];
  denied_commands?: string[];
  [k: string]: unknown;
}

/**
 * Sandbox settings block. `bubblewrap` is currently the only sandbox type. The
 * kernel resolves this into the concrete jail for command execution; the UI
 * reads it back through {@link SandboxInspection} via
 * {@link ConfigService.inspectSandbox}.
 */
export interface SandboxConfig {
  /** Sandbox implementation; only `bubblewrap` is defined today. */
  type: "bubblewrap";
  enabled?: boolean;
  /** `required` fails a run when the sandbox is unavailable; `optional` runs unsandboxed instead. */
  availability?: "required" | "optional";
  /** Whether the workspace mount is writable or read-only inside the jail. */
  filesystem?: "workspace-write" | "workspace-read-only";
  /** `host` shares the host network; `none` isolates it. */
  network?: "host" | "none";
  /** Host environment variables to pass through into the sandboxed process. */
  pass_env?: string[];
  /** Which language toolchains are made visible on the sandbox `PATH`. */
  toolchains?: {
    /** `auto` discovers and includes toolchains; `manual` includes none unless listed. */
    mode?: "auto" | "manual";
    /** Toolchain ids to force-include (by {@link SandboxToolchainStatus.id}). */
    include?: string[];
    /** Toolchain ids to exclude. */
    exclude?: string[];
    /** Extra host directories to expose read-only inside the jail. */
    extra_paths?: string[];
    /** Entries from {@link extra_paths} to suppress (e.g. one inherited from another scope). */
    excluded_paths?: string[];
  };
}

/**
 * Where a discovered toolchain (or read-only path) originates: `system` (already
 * on the host `PATH`), `auto` (found by discovery), or the `global` / `workspace`
 * settings scope that declared it.
 */
export type SandboxToolchainScope = "system" | "auto" | "global" | "workspace";

/**
 * Doctor status for one toolchain the sandbox discovered or probed, as reported
 * by {@link ConfigService.inspectSandbox}.
 */
export interface SandboxToolchainStatus {
  /** Stable toolchain identifier (e.g. `bun`, `node`), matched by include/exclude. */
  id: string;
  /** The executables this toolchain provides. */
  commands: string[];
  /** Whether the toolchain resolved and (when Bubblewrap is up) passed a probe run. */
  available: boolean;
  /** Whether it is folded into the effective sandbox `PATH`. */
  enabled: boolean;
  scope: SandboxToolchainScope;
  /** Version manager that owns it (e.g. `mise`, `asdf`, `system`), when known. */
  manager?: string;
  version?: string;
  /** The symlink/shim path as it appears on `PATH` (pre-resolution). */
  logical_path?: string;
  /** The real path {@link logical_path} resolves to. */
  resolved_path?: string;
  /** Directory added to the sandbox `PATH` to expose this toolchain. */
  root?: string;
  /** Populated when discovery or the probe run failed. */
  error?: string;
}

/**
 * Doctor status for one configured read-only extra path
 * ({@link SandboxConfig.toolchains}.`extra_paths`).
 */
export interface SandboxPathStatus {
  /** The path exactly as configured (before resolution). */
  path: string;
  /** Settings scope that declared this path. */
  scope: "global" | "workspace";
  /** Whether the path resolved successfully and can be mounted. */
  available: boolean;
  error?: string;
}

/**
 * Full sandbox doctor snapshot returned by {@link ConfigService.inspectSandbox}:
 * the Bubblewrap probe plus the resolved toolchains, extra paths, and effective
 * `PATH` a sandboxed run would see.
 */
export interface SandboxInspection {
  bubblewrap: {
    available: boolean;
    /**
     * `fresh-proc` (full isolation), `host-proc` (degraded, shares host pid/proc),
     * or `unavailable` (Bubblewrap not usable).
     */
    mode: "fresh-proc" | "host-proc" | "unavailable";
    /** True when running in a reduced-isolation mode (`host-proc`). */
    degraded: boolean;
    /** Why the sandbox is unavailable or degraded, when applicable. */
    reason?: string;
  };
  toolchains: SandboxToolchainStatus[];
  extra_paths: SandboxPathStatus[];
  /** The `PATH` entries a sandboxed process would run with, in order. */
  effective_path: string[];
}

/** Memory subsystem settings block. */
export interface MemoryConfig {
  enabled?: boolean;
  model?: string;
  [k: string]: unknown;
}

/** Provenance of one settings scope on disk. */
export interface SettingsSource {
  scope: Scope;
  path: string;
  exists: boolean;
  /** SHA-256 of exact source bytes, or `null` when the scope is absent. */
  revision: string | null;
  /**
   * Present when the file exists but failed to parse/validate — the UI shows this
   * instead of silently treating the scope as empty.
   */
  error?: string;
}

/** Merged + per-scope settings view the UI edits against. */
export interface SettingsView {
  /**
   * Effective settings after the plugin ← global ← workspace merge — layers in
   * ascending precedence, so a workspace value outranks a global one and both
   * outrank a plugin's.
   */
  merged: SettingsData;
  /** Raw per-scope contents the UI edits. */
  scopes: Partial<Record<Scope, SettingsData>>;
  sources: SettingsSource[];
  /**
   * Workspace-scope fields present on disk but withheld from
   * {@link SettingsView.merged | merged} because a repository may not contribute
   * them on its own authority. Absent when nothing was withheld.
   *
   * @remarks `scopes.workspace` still carries the raw file, so a client can show
   *   what the repository asked for next to what was refused. Surface this to
   *   the human; it is not something the model needs to know.
   */
  withheld_workspace_fields?: readonly string[];
  /**
   * Whether this workspace's executable surface is approved: `inert` when it
   * declares none (the overwhelming majority of repositories, which must never
   * be prompted about), otherwise `trusted` / `unapproved` / `changed`.
   */
  workspace_trust?: WorkspaceTrustVerdict;
  /**
   * Every capability grant an agent profile in this workspace may name: the
   * engine's built-ins plus whatever the kernel's composed capability registry
   * declares.
   *
   * @remarks Only the kernel can answer this — an optional feature package
   *   contributes its own grant, so the set is a property of what this kernel
   *   actually composed rather than of any static list. Without it a client
   *   checking a profile's readiness had to skip grants entirely, and a profile
   *   naming an undeclared one (a stale `image` left by the vision-routing
   *   refactor) was reported "runnable" by Doctor and the agent editor while
   *   every run in the workspace was rejected before its first model call.
   *   Absent when the kernel did not report it; a client must then skip the
   *   check rather than assume a vocabulary.
   */
  known_grants?: readonly string[];
}

/**
 * Optimistic repair proposed for one corrupt settings scope.
 *
 * @remarks `revision` is the SHA-256 digest of the exact source bytes inspected
 *   by the kernel. Applying the plan succeeds only while those bytes are still
 *   current, so a repair can never overwrite a concurrent edit.
 */
export type SettingsRepairPlan =
  | {
      scope: Scope;
      revision: string;
      action: "strip";
      /** Dotted paths the kernel will remove from otherwise parseable JSON. */
      dropped: string[];
    }
  | {
      scope: Scope;
      revision: string;
      action: "reset";
      /** Why no safe field-level repair could be produced. */
      reason: string;
    };

/** A lead agent's spend policy, projected from the agent's frontmatter. */
export interface AgentBudget {
  on_exceed?: string;
  total_token_limit?: number;
}

/**
 * What a config file did to the agent Clarvis ships under the same name.
 *
 * @remarks Present exactly when both exist. `status` says whether the file's
 *   fields are in effect: a file whose frontmatter does not parse or does not
 *   validate is **refused**, the shipped default runs unchanged, and `reason`
 *   carries why — so a client can tell the user their customization is not
 *   running instead of leaving them to wonder why an edit did nothing.
 */
export interface AgentOverlay {
  scope: Scope;
  status: "applied" | "rejected";
  /** Why the file was refused; present exactly when `status` is `"rejected"`. */
  reason?: string;
  /** Other scopes holding a file of this name, i.e. a cross-scope duplicate. */
  shadowed?: readonly Scope[];
}

/** List projection of one agent (shipped, file- or plugin-shipped). */
export interface AgentSummary {
  name: string;
  scope: Scope | "plugin" | "builtin";
  model?: string;
  description?: string;
  /** For plugin-shipped agents: which plugin. */
  plugin?: string;
  /**
   * Tool grants declared in the agent's frontmatter, projected by the kernel so a
   * client can render capability badges without reading the file itself.
   * Absent (`undefined`) means the frontmatter could not be parsed.
   */
  grants?: string[];
  /** Names this agent may spawn as sub-agents (a lead has ≥ 1). */
  can_spawn?: string[];
  /** Spend policy (`on_exceed` / `total_token_limit`) from the frontmatter. */
  budget?: AgentBudget;
  /** For an agent Clarvis ships that a config file overlays: see {@link AgentOverlay}. */
  overlay?: AgentOverlay;
}

/** Full agent document (frontmatter + markdown body). */
export interface AgentDoc {
  name: string;
  /** The layer this document was read from; `"builtin"` for one Clarvis ships. */
  scope: Scope | "builtin";
  /** Parsed frontmatter (model, tools, budget, base_prompt, output_schema, …). */
  frontmatter: Record<string, unknown>;
  /** Markdown body (the agent prompt). */
  body: string;
  /**
   * Why the frontmatter could not be parsed, when it could not be.
   *
   * @remarks Present exactly when the document's YAML is malformed. The
   * `frontmatter` above is then the lenient fallback (`{}`), not the file's
   * real content, so a client must treat this document as broken rather than
   * as an agent that merely declares nothing.
   */
  malformed?: string;
}

/** Write payload for creating or updating an agent document. */
export interface AgentWrite {
  frontmatter: Record<string, unknown>;
  body: string;
}

/** Context preamble document (e.g. `CLARVIS.md` / `AGENTS.md`). */
export interface ContextDoc {
  scope: Scope;
  path: string;
  content: string;
}

/** Kind of configuration surface that changed. */
export type ConfigChangeKind = "settings" | "agents" | "context";

/** Notification that config changed on disk or via another client. */
export interface ConfigChange {
  kind: ConfigChangeKind;
  scope?: Scope;
  at: Timestamp;
}

/**
 * Read/write workspace configuration and subscribe to external changes.
 *
 * Covers settings, agent docs, and context preambles.
 */
export interface ConfigService {
  /** Current settings view (merged + per-scope). */
  getSettings(): Promise<SettingsView>;

  /**
   * Preview a safe repair for one corrupt settings scope.
   *
   * @returns a revision-bound plan, or `null` when the scope is absent or valid.
   */
  previewSettingsRepair(scope: Scope): Promise<SettingsRepairPlan | null>;

  /**
   * Recompute and apply a repair only if the source still has `expectedRevision`.
   *
   * @throws a `conflict` kernel error when the file changed or disappeared after
   *   preview; no bytes are overwritten in that case.
   */
  repairSettings(scope: Scope, expectedRevision: string): Promise<SettingsView>;

  /**
   * Approve this workspace's current executable surface, so its `hooks`,
   * `mcpServers`, `enabledPlugins`, `marketplaces` and `.clarvis/agents/*.md`
   * take effect.
   *
   * @returns the refreshed {@link SettingsView}; a no-op for an inert workspace.
   * @remarks Approval binds to the *surface*, not the path: editing any approved
   *   file moves the verdict to `changed` and withholds the fields again. This
   *   lives on the config service rather than a service of its own because the
   *   verdict already rides on {@link SettingsView} — the approval and the thing
   *   it gates are one subject.
   */
  approveWorkspace(): Promise<SettingsView>;

  /**
   * Revoke every approval recorded for this workspace.
   *
   * @returns the refreshed {@link SettingsView}.
   */
  revokeWorkspace(): Promise<SettingsView>;

  /** The workspace trust store's parse error, or `null` when it is readable. */
  workspaceTrustError(): Promise<string | null>;

  /**
   * Patch settings in one scope and return the refreshed view.
   *
   * @param scope - Target scope (`global` or `workspace`).
   * @param patch - Partial settings to merge into that scope.
   * @param expectedRevision - SHA-256 revision from the last read, or `null`
   *   when that read observed no file. A mismatch is a typed conflict and never
   *   overwrites the concurrent edit.
   */
  updateSettings(
    scope: Scope,
    patch: Partial<SettingsData>,
    expectedRevision: string | null,
  ): Promise<SettingsView>;

  /** Inspect Bubblewrap and the toolchains visible on the kernel host. */
  inspectSandbox(options?: { refresh?: boolean }): Promise<SandboxInspection>;

  /**
   * All agents visible in the workspace: shipped, file-backed and plugin-shipped.
   *
   * @remarks In presentation order — the fleet Clarvis ships first, in its own
   *   order, then everything else ascending by name. An agent Clarvis ships
   *   appears once, already resolved against any file overlaying it.
   */
  listAgents(): Promise<AgentSummary[]>;

  /**
   * Load one agent document as stored in one layer.
   *
   * @param scope - Scope that owns the agent file, or `"builtin"` to read the
   *   agent as Clarvis ships it, ignoring any file that overlays it.
   * @param name - Agent name.
   * @remarks Layer-precise rather than effective: an editor must show the bytes
   *   the user wrote. What a run would actually enter is the `listAgents`
   *   projection.
   */
  getAgent(scope: Scope | "builtin", name: string): Promise<AgentDoc>;

  /**
   * Create or overwrite an agent document.
   *
   * @param scope - Target scope.
   * @param name - Agent name.
   * @param doc - Frontmatter + body to write.
   */
  writeAgent(scope: Scope, name: string, doc: AgentWrite): Promise<AgentSummary>;

  /**
   * Delete an agent document.
   *
   * @param scope - Scope that owns the agent file.
   * @param name - Agent name.
   */
  deleteAgent(scope: Scope, name: string): Promise<void>;

  /**
   * Rename an agent within its current scope. Does not move an agent between
   * scopes — write a new agent under the target scope for that.
   *
   * @param scope - Scope that owns the agent (unchanged by the rename).
   * @param oldName - The agent's current name.
   * @param newName - The new name.
   */
  renameAgent(scope: Scope, oldName: string, newName: string): Promise<AgentSummary>;

  /**
   * Load the context preamble for a scope, if present.
   *
   * @param scope - Scope to read.
   */
  getContext(scope: Scope): Promise<ContextDoc | null>;

  /**
   * Subscribe to reactive config refresh.
   *
   * Fires when config changes on disk or via another client. Backed by
   * resource-update notifications on whatever transport is in use — this replaces
   * mtime-cache re-reads in the UI.
   *
   * @param kinds - Change kinds to listen for.
   * @param listener - Callback invoked with each change.
   * @returns Unsubscribe handle.
   */
  subscribe(kinds: ConfigChangeKind[], listener: (change: ConfigChange) => void): Unsubscribe;
}
