/**
 * EnvironmentService — deterministic activation of already-installed extensions.
 *
 * An Environment never installs an extension and never carries ordinary Clarvis
 * settings. A custom definition is a complete allow-list of plugin installations
 * and standalone skills; the immutable `builtin:default` resolves the configured
 * `enabledPlugins` plus four-root skill discovery behavior.
 */

import type { Scope } from "./common.ts";
import type { WorkspaceTrustVerdict } from "./config.ts";
import type { PluginRef } from "./plugins.ts";

/** Scope that owns an Environment definition or the virtual builtin. */
export type EnvironmentScope = "builtin" | Scope;

/** Stable, qualified identity of an Environment definition. */
export interface EnvironmentRef {
  scope: EnvironmentScope;
  name: string;
}

/** Exact installed plugin selected by an Environment. */
export type EnvironmentPluginRef = PluginRef;

/** Exact standalone skill selected from one of Clarvis's standard roots. */
export interface EnvironmentSkillRef {
  scope: "user" | "workspace";
  source: "agents" | "clarvis";
  name: string;
}

/** Version-one, complete allow-list persisted as one Environment JSON file. */
export interface EnvironmentDefinition {
  schema_version: 1;
  description?: string;
  plugins: EnvironmentPluginRef[];
  skills: EnvironmentSkillRef[];
}

/** Persisted definition plus its exact-byte compare-and-swap revision. */
export interface EnvironmentDefinitionView {
  ref: EnvironmentRef;
  immutable: boolean;
  revision?: string;
  definition?: EnvironmentDefinition;
  error?: string;
}

/** How the active selection was chosen for this kernel process. */
export type EnvironmentSelectionOrigin = "cli" | "workspace" | "global" | "builtin";

/** Whether all selected inventory resolved and validated. */
export type EnvironmentStatus = "ready" | "degraded" | "invalid";

/** Stable diagnostic code for one missing or invalid Environment component. */
export type EnvironmentIssueCode =
  | "invalid_definition"
  | "invalid_selection"
  | "missing_definition"
  | "missing_plugin"
  | "invalid_plugin"
  | "missing_skill"
  | "duplicate_plugin_name"
  | "scope_not_allowed"
  | "workspace_untrusted";

/** Actionable resolution diagnostic; no issue silently activates a fallback. */
export interface EnvironmentIssue {
  code: EnvironmentIssueCode;
  message: string;
  plugin?: EnvironmentPluginRef;
  skill?: EnvironmentSkillRef;
}

/** One plugin in the resolved snapshot, including its executable surface. */
export interface ResolvedEnvironmentPlugin {
  ref: EnvironmentPluginRef;
  active: boolean;
  installed: boolean;
  valid: boolean;
  version?: string;
  revision?: string;
  agents: string[];
  skills: string[];
  mcp_servers: string[];
  hooks: { total: number; approved: number };
  capability_executables: string[];
  error?: string;
}

/** One selected standalone skill and whether its exact qualified source resolved. */
export interface ResolvedEnvironmentSkill {
  ref: EnvironmentSkillRef;
  active: boolean;
  found: boolean;
  description?: string;
  digest?: string;
  error?: string;
}

/** Counts rendered by the Environment browser without reinterpreting inventory. */
export interface EnvironmentCounts {
  plugins_active: number;
  plugins_installed: number;
  standalone_skills_active: number;
  standalone_skills_discovered: number;
  plugin_skills_active: number;
  plugin_skills_discovered: number;
  mcp_servers_active: number;
  hooks_declared: number;
  hooks_approved: number;
}

/** Immutable extension snapshot used by this kernel process. */
export interface ResolvedEnvironment {
  id: string;
  ref: EnvironmentRef;
  immutable: boolean;
  status: EnvironmentStatus;
  fingerprint: string;
  selection_origin: EnvironmentSelectionOrigin;
  definition?: EnvironmentDefinition;
  definition_revision?: string;
  description?: string;
  workspace_trust?: WorkspaceTrustVerdict;
  plugins: ResolvedEnvironmentPlugin[];
  standalone_skills: ResolvedEnvironmentSkill[];
  issues: EnvironmentIssue[];
  counts: EnvironmentCounts;
}

/** Minimal identity persisted with each run and session turn. */
export interface EnvironmentRunRef {
  id: string;
  fingerprint: string;
}

/** Exact entering/leaving extension surface shown before selection is applied. */
export interface EnvironmentDelta {
  plugins_entering: EnvironmentPluginRef[];
  plugins_leaving: EnvironmentPluginRef[];
  skills_entering: string[];
  skills_leaving: string[];
  mcp_servers_entering: string[];
  mcp_servers_leaving: string[];
  hooks_entering: { plugin: EnvironmentPluginRef; total: number; approved: number }[];
  hooks_leaving: { plugin: EnvironmentPluginRef; total: number; approved: number }[];
}

/** Preview pinned by a token so selection cannot apply a different target. */
export interface EnvironmentPreview {
  current: ResolvedEnvironment;
  target: ResolvedEnvironment;
  delta: EnvironmentDelta;
  token: string;
  requires_workspace_trust: boolean;
}

/** Where a persisted selection is written. */
export type EnvironmentSelectionScope = "global" | "workspace";

/** Result of a selection mutation; the active kernel remains pinned until reconnect. */
export interface EnvironmentApplyResult {
  selected: EnvironmentRef;
  reconnect_required: true;
}

/** Create/update input for an authored Environment definition. */
export interface EnvironmentDefinitionInput {
  ref: { scope: Scope; name: string };
  definition: EnvironmentDefinition;
}

/** Control plane for Environment definitions, selection, resolution and diagnostics. */
export interface EnvironmentService {
  /** List the builtin and every authored definition, including invalid files. */
  list(): Promise<EnvironmentDefinitionView[]>;
  /** Return the process-pinned Environment snapshot. */
  current(): Promise<ResolvedEnvironment>;
  /** Resolve one definition against current installed inventory without selecting it. */
  get(ref: EnvironmentRef): Promise<ResolvedEnvironment>;
  /** Compute the exact activation delta and a single-use apply token. */
  preview(
    ref: EnvironmentRef,
    options: { selection_scope: EnvironmentSelectionScope },
  ): Promise<EnvironmentPreview>;
  /** Preview the fallback that would become selected after clearing one persisted choice. */
  previewClear(scope: EnvironmentSelectionScope): Promise<EnvironmentPreview>;
  /** Persist a selection after verifying the preview token. */
  select(
    ref: EnvironmentRef,
    options: {
      selection_scope: EnvironmentSelectionScope;
      preview_token: string;
      approve_workspace?: boolean;
    },
  ): Promise<EnvironmentApplyResult>;
  /** Clear one persisted selection after verifying the exact fallback preview. */
  clearSelection(
    scope: EnvironmentSelectionScope,
    options: { preview_token: string },
  ): Promise<EnvironmentApplyResult>;
  /** Create one new global or workspace definition. */
  create(input: EnvironmentDefinitionInput): Promise<EnvironmentDefinitionView>;
  /** Compare-and-swap an existing definition. */
  update(
    input: EnvironmentDefinitionInput & { expected_revision: string },
  ): Promise<EnvironmentDefinitionView>;
  /** Copy a resolved custom definition to a new authored identity. */
  clone(
    source: EnvironmentRef,
    target: { scope: Scope; name: string },
  ): Promise<EnvironmentDefinitionView>;
}
