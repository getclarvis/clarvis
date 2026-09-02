/**
 * ExtensionProfileService — deterministic activation of already-installed extensions.
 *
 * An Extension Profile never installs an extension and never carries ordinary Clarvis
 * settings. A custom definition is a complete allow-list of plugin installations
 * and standalone skills; the immutable `builtin:default` resolves the configured
 * `enabledPlugins` plus four-root skill discovery behavior.
 */

import type { Scope } from "./common.ts";
import type { WorkspaceTrustVerdict } from "./config.ts";
import type { PluginRef } from "./plugins.ts";

/** Scope that owns an Extension Profile definition or the virtual builtin. */
export type ExtensionProfileScope = "builtin" | Scope;

/** Stable, qualified identity of an Extension Profile definition. */
export interface ExtensionProfileRef {
  scope: ExtensionProfileScope;
  name: string;
}

/** Exact installed plugin selected by an Extension Profile. */
export type ExtensionProfilePluginRef = PluginRef;

/** Exact standalone skill selected from one of Clarvis's standard roots. */
export interface ExtensionProfileSkillRef {
  scope: "user" | "workspace";
  source: "agents" | "clarvis";
  name: string;
}

/** Version-one, complete allow-list persisted as one Extension Profile JSON file. */
export interface ExtensionProfileDefinition {
  schema_version: 1;
  description?: string;
  plugins: ExtensionProfilePluginRef[];
  skills: ExtensionProfileSkillRef[];
}

/** Persisted definition plus its exact-byte compare-and-swap revision. */
export interface ExtensionProfileDefinitionView {
  ref: ExtensionProfileRef;
  immutable: boolean;
  revision?: string;
  definition?: ExtensionProfileDefinition;
  error?: string;
}

/** How the active selection was chosen for this kernel process. */
export type ExtensionProfileSelectionOrigin = "cli" | "workspace" | "global" | "builtin";

/** Whether all selected inventory resolved and validated. */
export type ExtensionProfileStatus = "ready" | "degraded" | "invalid";

/** Stable diagnostic code for one missing or invalid Extension Profile component. */
export type ExtensionProfileIssueCode =
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
export interface ExtensionProfileIssue {
  code: ExtensionProfileIssueCode;
  message: string;
  plugin?: ExtensionProfilePluginRef;
  skill?: ExtensionProfileSkillRef;
}

/** One plugin in the resolved snapshot, including its executable surface. */
export interface ResolvedExtensionProfilePlugin {
  ref: ExtensionProfilePluginRef;
  active: boolean;
  installed: boolean;
  valid: boolean;
  version?: string;
  revision?: string;
  agents: string[];
  skills: string[];
  mcp_servers: string[];
  hooks: { total: number };
  capability_executables: string[];
  error?: string;
}

/** One selected standalone skill and whether its exact qualified source resolved. */
export interface ResolvedExtensionProfileSkill {
  ref: ExtensionProfileSkillRef;
  active: boolean;
  found: boolean;
  description?: string;
  digest?: string;
  error?: string;
}

/** Complete exact installed/discovered inventory available to an Extension Profile composer. */
export interface ExtensionProfileInventory {
  plugins: ResolvedExtensionProfilePlugin[];
  standalone_skills: ResolvedExtensionProfileSkill[];
}

/** Counts rendered by the Extension Profile browser without reinterpreting inventory. */
export interface ExtensionProfileCounts {
  plugins_active: number;
  standalone_skills_active: number;
  plugin_skills_active: number;
  mcp_servers_active: number;
  hooks_declared: number;
}

/** Immutable extension snapshot used by this kernel process. */
export interface ResolvedExtensionProfile {
  id: string;
  ref: ExtensionProfileRef;
  immutable: boolean;
  status: ExtensionProfileStatus;
  fingerprint: string;
  selection_origin: ExtensionProfileSelectionOrigin;
  definition?: ExtensionProfileDefinition;
  definition_revision?: string;
  description?: string;
  workspace_trust?: WorkspaceTrustVerdict;
  plugins: ResolvedExtensionProfilePlugin[];
  standalone_skills: ResolvedExtensionProfileSkill[];
  issues: ExtensionProfileIssue[];
  counts: ExtensionProfileCounts;
}

/** Minimal identity persisted with each run and session turn. */
export interface ExtensionProfileRunRef {
  id: string;
  fingerprint: string;
}

/** Exact entering/leaving extension surface shown before selection is applied. */
export interface ExtensionProfileDelta {
  plugins_entering: ExtensionProfilePluginRef[];
  plugins_leaving: ExtensionProfilePluginRef[];
  skills_entering: string[];
  skills_leaving: string[];
  mcp_servers_entering: string[];
  mcp_servers_leaving: string[];
  hooks_entering: { plugin: ExtensionProfilePluginRef; total: number }[];
  hooks_leaving: { plugin: ExtensionProfilePluginRef; total: number }[];
}

/** Preview pinned by a token so selection cannot apply a different target. */
export interface ExtensionProfilePreview {
  current: ResolvedExtensionProfile;
  target: ResolvedExtensionProfile;
  delta: ExtensionProfileDelta;
  token: string;
  /** Whether workspace-owned plugins need their single workspace-wide inventory approval. */
  requires_workspace_trust: boolean;
}

/** Complete authored definition plus the local selection it should replace. */
export interface ExtensionProfileCompositionInput extends ExtensionProfileDefinitionInput {
  /** Exact prior definition revision, or `null` when the target must not exist. */
  expected_revision: string | null;
  selection_scope: ExtensionProfileSelectionScope;
}

/** Exact authored and effective snapshots reviewed before one composition transaction. */
export interface ExtensionProfileCompositionPreview extends ExtensionProfilePreview {
  /** The proposed authored definition, even when a workspace selection shadows a global write. */
  authored: ResolvedExtensionProfile;
}

/** Definition and selection committed together; the current kernel remains pinned until reconnect. */
export interface ExtensionProfileCompositionApplyResult extends ExtensionProfileApplyResult {
  definition: ExtensionProfileDefinitionView;
  effective: ExtensionProfileRef;
}

/** Where a persisted selection is written. */
export type ExtensionProfileSelectionScope = "global" | "workspace";

/** Result of a selection mutation; the active kernel remains pinned until reconnect. */
export interface ExtensionProfileApplyResult {
  selected: ExtensionProfileRef;
  reconnect_required: true;
}

/** Create/update input for an authored Extension Profile definition. */
export interface ExtensionProfileDefinitionInput {
  ref: { scope: Scope; name: string };
  definition: ExtensionProfileDefinition;
}

/** Control plane for Extension Profile definitions, selection, resolution and diagnostics. */
export interface ExtensionProfileService {
  /** List the builtin and every authored definition, including invalid files. */
  list(): Promise<ExtensionProfileDefinitionView[]>;
  /** Return the process-pinned Extension Profile snapshot. */
  current(): Promise<ResolvedExtensionProfile>;
  /** Resolve one definition against current installed inventory without selecting it. */
  get(ref: ExtensionProfileRef): Promise<ResolvedExtensionProfile>;
  /** Return every exact installed plugin and discovered standalone skill once for composition UI. */
  inventory(): Promise<ExtensionProfileInventory>;
  /** Compute the exact activation delta and a single-use apply token. */
  preview(
    ref: ExtensionProfileRef,
    options: { selection_scope: ExtensionProfileSelectionScope },
  ): Promise<ExtensionProfilePreview>;
  /** Preview the fallback that would become selected after clearing one persisted choice. */
  previewClear(scope: ExtensionProfileSelectionScope): Promise<ExtensionProfilePreview>;
  /** Resolve a complete draft and its effective activation delta without writing it. */
  previewComposition(
    input: ExtensionProfileCompositionInput,
  ): Promise<ExtensionProfileCompositionPreview>;
  /** Persist a selection after verifying the preview token. */
  select(
    ref: ExtensionProfileRef,
    options: {
      selection_scope: ExtensionProfileSelectionScope;
      preview_token: string;
      approve_workspace?: boolean;
    },
  ): Promise<ExtensionProfileApplyResult>;
  /** Clear one persisted selection after verifying the exact fallback preview. */
  clearSelection(
    scope: ExtensionProfileSelectionScope,
    options: { preview_token: string },
  ): Promise<ExtensionProfileApplyResult>;
  /** Atomically persist the previewed draft and selection, then require a kernel reconnect. */
  applyComposition(
    input: ExtensionProfileCompositionInput,
    options: { preview_token: string; approve_workspace?: boolean },
  ): Promise<ExtensionProfileCompositionApplyResult>;
  /** Create one new global or workspace definition. */
  create(input: ExtensionProfileDefinitionInput): Promise<ExtensionProfileDefinitionView>;
  /** Compare-and-swap an existing definition. */
  update(
    input: ExtensionProfileDefinitionInput & { expected_revision: string },
  ): Promise<ExtensionProfileDefinitionView>;
  /** Delete one inactive authored definition after verifying its exact revision. */
  delete(
    ref: { scope: Scope; name: string },
    options: { expected_revision: string },
  ): Promise<void>;
  /** Copy a resolved custom definition to a new authored identity. */
  clone(
    source: ExtensionProfileRef,
    target: { scope: Scope; name: string },
  ): Promise<ExtensionProfileDefinitionView>;
}
