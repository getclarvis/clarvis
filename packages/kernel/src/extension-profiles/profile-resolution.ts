import { createHash } from "node:crypto";
import type {
  ExtensionProfileDefinitionView,
  ExtensionProfileDelta,
  ExtensionProfileIssue,
  ExtensionProfilePluginRef,
  ExtensionProfileRef,
  ExtensionProfileSelectionOrigin,
  ExtensionProfileSkillRef,
  ResolvedExtensionProfile,
  ResolvedExtensionProfilePlugin,
  ResolvedExtensionProfileSkill,
  WorkspaceTrustVerdict,
} from "@clarvis/protocol";
import type { PluginContributionSnapshot } from "../plugins/plugin-contributions.ts";

export interface SelectedExtensionProfile {
  ref: ExtensionProfileRef;
  origin: ExtensionProfileSelectionOrigin;
  error?: string;
}

/** Stable qualified string identity used in traces, sessions and diagnostics. */
export function extensionProfileId(ref: ExtensionProfileRef): string {
  return `${ref.scope}:${ref.name}`;
}

/** Canonical key for one exact plugin installation. */
export function pluginRefId(ref: ExtensionProfilePluginRef): string {
  return `${ref.scope}:${ref.source}:${ref.name}`;
}

/** Filesystem-shaped plugin identity for operator-facing diagnostics. */
function pluginRefLabel(ref: ExtensionProfilePluginRef): string {
  return `${ref.scope}/${ref.source}/${ref.name}`;
}

/** Canonicalize JSON-like data for stable hashing. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]),
  );
}

/** SHA-256 over a stable JSON projection. */
export function fingerprintOf(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")}`;
}

/** Set difference preserving deterministic sorted output. */
function stringDifference(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return [...new Set(left)].filter((value) => !rightSet.has(value)).sort();
}

/** Exact Extension Profile delta between two resolved snapshots. */
export function deltaOf(
  current: ResolvedExtensionProfile,
  target: ResolvedExtensionProfile,
): ExtensionProfileDelta {
  const pluginKey = (plugin: ResolvedExtensionProfilePlugin): string => pluginRefId(plugin.ref);
  const currentPlugins = current.plugins.filter((plugin) => plugin.active);
  const targetPlugins = target.plugins.filter((plugin) => plugin.active);
  const currentPluginKeys = new Set(currentPlugins.map(pluginKey));
  const targetPluginKeys = new Set(targetPlugins.map(pluginKey));
  const currentSkills = [
    ...current.standalone_skills
      .filter((skill) => skill.active)
      .map((skill) =>
        extensionProfileId({
          scope: skill.ref.scope === "user" ? "global" : "workspace",
          name: `${skill.ref.source}:${skill.ref.name}`,
        }),
      ),
    ...currentPlugins.flatMap((plugin) =>
      plugin.skills.map((skill) => `plugin:${pluginRefId(plugin.ref)}:${skill}`),
    ),
  ];
  const targetSkills = [
    ...target.standalone_skills
      .filter((skill) => skill.active)
      .map((skill) =>
        extensionProfileId({
          scope: skill.ref.scope === "user" ? "global" : "workspace",
          name: `${skill.ref.source}:${skill.ref.name}`,
        }),
      ),
    ...targetPlugins.flatMap((plugin) =>
      plugin.skills.map((skill) => `plugin:${pluginRefId(plugin.ref)}:${skill}`),
    ),
  ];
  return {
    plugins_entering: targetPlugins
      .filter((plugin) => !currentPluginKeys.has(pluginKey(plugin)))
      .map((plugin) => plugin.ref),
    plugins_leaving: currentPlugins
      .filter((plugin) => !targetPluginKeys.has(pluginKey(plugin)))
      .map((plugin) => plugin.ref),
    skills_entering: stringDifference(targetSkills, currentSkills),
    skills_leaving: stringDifference(currentSkills, targetSkills),
    mcp_servers_entering: stringDifference(
      targetPlugins.flatMap((plugin) => plugin.mcp_servers),
      currentPlugins.flatMap((plugin) => plugin.mcp_servers),
    ),
    mcp_servers_leaving: stringDifference(
      currentPlugins.flatMap((plugin) => plugin.mcp_servers),
      targetPlugins.flatMap((plugin) => plugin.mcp_servers),
    ),
    hooks_entering: targetPlugins
      .filter((plugin) => !currentPluginKeys.has(pluginKey(plugin)) && plugin.hooks.total > 0)
      .map((plugin) => ({ plugin: plugin.ref, ...plugin.hooks })),
    hooks_leaving: currentPlugins
      .filter((plugin) => !targetPluginKeys.has(pluginKey(plugin)) && plugin.hooks.total > 0)
      .map((plugin) => ({ plugin: plugin.ref, ...plugin.hooks })),
  };
}

export const defaultStandaloneSelection = (
  inventory: readonly ResolutionSkill[],
): ExtensionProfileSkillRef[] => {
  const winners = new Map<string, ResolutionSkill>();
  for (const entry of [...inventory].sort((left, right) => left.rootOrder - right.rootOrder)) {
    winners.set(entry.ref.name, entry);
  }
  return [...winners.values()]
    .sort((left, right) => left.ref.name.localeCompare(right.ref.name))
    .map((entry) => entry.ref);
};

export interface ResolutionSkill {
  ref: ExtensionProfileSkillRef;
  rootOrder: number;
  description: string;
}

export interface ResolutionPreparation {
  selection: SelectedExtensionProfile;
  definitionView?: ExtensionProfileDefinitionView;
  workspaceTrust: WorkspaceTrustVerdict;
  issues: ExtensionProfileIssue[];
  selectedPlugins: readonly ExtensionProfilePluginRef[];
  selectedSkills: readonly ExtensionProfileSkillRef[];
  validDefinition: boolean;
  requiresTrust: boolean;
  trusted: boolean;
  admittedPlugins: readonly ExtensionProfilePluginRef[];
}

/** Decide exact references and trust from already collected definition and catalog data. */
export function prepareProfileResolution(input: {
  selection: SelectedExtensionProfile;
  definitionView?: ExtensionProfileDefinitionView;
  enabledPlugins: readonly ExtensionProfilePluginRef[];
  workspaceTrust: WorkspaceTrustVerdict;
  assumeWorkspaceTrusted: boolean;
  discovered: readonly ResolutionSkill[];
}): ResolutionPreparation {
  const {
    selection,
    definitionView,
    enabledPlugins,
    workspaceTrust,
    assumeWorkspaceTrusted,
    discovered,
  } = input;
  const issues: ExtensionProfileIssue[] = [];
  if (selection.error !== undefined) {
    issues.push({ code: "invalid_selection", message: selection.error });
  }
  if (definitionView?.error !== undefined) {
    issues.push({
      code: definitionView.revision === undefined ? "missing_definition" : "invalid_definition",
      message: definitionView.error,
    });
  }
  const definition = definitionView?.definition;
  const definitionIsValid =
    selection.error === undefined &&
    (selection.ref.scope === "builtin" || definition !== undefined);
  const selectedPlugins =
    selection.ref.scope === "builtin" ? [...enabledPlugins] : (definition?.plugins ?? []);
  const selectedSkills =
    selection.ref.scope === "builtin"
      ? defaultStandaloneSelection(discovered)
      : (definition?.skills ?? []);
  const selectedPluginNames = new Set<string>();
  let pluginNamesAreUnique = true;
  for (const ref of selectedPlugins) {
    if (selectedPluginNames.has(ref.name)) {
      pluginNamesAreUnique = false;
      issues.push({
        code: "duplicate_plugin_name",
        plugin: ref,
        message:
          `plugin namespace '${ref.name}' is selected more than once; ` +
          "choose exactly one qualified installation",
      });
    }
    selectedPluginNames.add(ref.name);
  }
  const validDefinition = definitionIsValid && pluginNamesAreUnique;
  const requiresTrust =
    selection.ref.scope === "workspace" && selectedPlugins.some((ref) => ref.scope === "workspace");
  const trusted =
    assumeWorkspaceTrusted ||
    !requiresTrust ||
    workspaceTrust.state === "trusted" ||
    workspaceTrust.state === "inert";
  if (validDefinition && !trusted) {
    issues.push({
      code: "workspace_untrusted",
      message:
        "the workspace Extension Profile selects workspace-owned executable plugins but its current fingerprint is not approved",
    });
  }
  const admittedPlugins = trusted
    ? selectedPlugins
    : selectedPlugins.filter((ref) => ref.scope !== "workspace");
  return {
    selection,
    definitionView,
    workspaceTrust,
    issues,
    selectedPlugins,
    selectedSkills,
    validDefinition,
    requiresTrust,
    trusted,
    admittedPlugins,
  };
}

/** Build the immutable snapshot from captured values, with no filesystem or runtime callback. */
export function resolveProfileData(input: {
  prepared: ResolutionPreparation;
  contributionSnapshots: readonly PluginContributionSnapshot[];
  installedPlugins: readonly ResolvedExtensionProfilePlugin[];
  capturedSkills: readonly (ResolutionSkill & { digest?: string })[];
}): ResolvedExtensionProfile {
  const { contributionSnapshots, installedPlugins, capturedSkills } = input;
  const {
    selection,
    definitionView,
    workspaceTrust,
    selectedPlugins,
    selectedSkills,
    validDefinition,
    requiresTrust,
    trusted,
  } = input.prepared;
  const issues = [...input.prepared.issues];
  const definition = definitionView?.definition;
  const contributionByRef = new Map(
    contributionSnapshots.map((snapshot) => [pluginRefId(snapshot.ref), snapshot] as const),
  );
  const unresolvedInstalled = new Map(
    installedPlugins.map((view) => [pluginRefId(view.ref), view] as const),
  );
  const pluginViews: ResolvedExtensionProfilePlugin[] = validDefinition
    ? selectedPlugins.map((ref) => {
        const snapshot = contributionByRef.get(pluginRefId(ref));
        if (snapshot !== undefined) {
          return {
            ref,
            active: trusted || ref.scope !== "workspace",
            installed: true,
            valid: true,
            ...(snapshot.version === undefined ? {} : { version: snapshot.version }),
            ...(snapshot.revision === undefined ? {} : { revision: snapshot.revision }),
            agents: snapshot.agents,
            skills: snapshot.skills,
            mcp_servers: snapshot.mcpServers,
            hooks: snapshot.hooks,
          };
        }
        const installed = unresolvedInstalled.get(pluginRefId(ref));
        if (installed === undefined) {
          issues.push({
            code: "missing_plugin",
            plugin: ref,
            message: `plugin '${pluginRefLabel(ref)}' is not installed`,
          });
          return {
            ref,
            active: false,
            installed: false,
            valid: false,
            agents: [],
            skills: [],
            mcp_servers: [],
            hooks: { total: 0 },
            error: "not installed",
          };
        }
        const error =
          installed.error ?? `plugin '${pluginRefLabel(ref)}' could not be captured atomically`;
        issues.push({ code: "invalid_plugin", plugin: ref, message: error });
        return {
          ...installed,
          active: false,
          valid: false,
          error,
        };
      })
    : [];
  const skillByRef = new Map(
    capturedSkills.map((entry) => [
      `${entry.ref.scope}\0${entry.ref.source}\0${entry.ref.name}`,
      entry,
    ]),
  );
  const skillViews: ResolvedExtensionProfileSkill[] = validDefinition
    ? selectedSkills.map((ref) => {
        const entry = skillByRef.get(`${ref.scope}\0${ref.source}\0${ref.name}`);
        if (entry === undefined) {
          issues.push({
            code: "missing_skill",
            skill: ref,
            message: `skill '${ref.scope}/${ref.source}/${ref.name}' was not discovered`,
          });
          return { ref, active: false, found: false, error: "not discovered" };
        }
        const digest = entry.digest;
        if (digest === undefined) {
          issues.push({
            code: "missing_skill",
            skill: ref,
            message: `skill '${ref.scope}/${ref.source}/${ref.name}' could not be captured`,
          });
          return { ref, active: false, found: false, error: "could not be captured" };
        }
        return {
          ref,
          active: true,
          found: true,
          description: entry.description,
          digest,
        };
      })
    : [];
  const activePlugins = pluginViews.filter((plugin) => plugin.active);
  const activeSkills = skillViews.filter((skill) => skill.active);
  const status = !validDefinition ? "invalid" : issues.length > 0 ? "degraded" : "ready";
  const identity = {
    id: extensionProfileId(selection.ref),
    definition_revision: definitionView?.revision,
    status,
    plugins: activePlugins.map((plugin) => ({
      ref: plugin.ref,
      digest: contributionByRef.get(pluginRefId(plugin.ref))?.digest,
    })),
    skills: activeSkills.map((skill) => ({ ref: skill.ref, digest: skill.digest })),
    issues,
    workspace_trust: requiresTrust
      ? { state: workspaceTrust.state, fingerprint: workspaceTrust.fingerprint }
      : undefined,
  };
  return {
    id: extensionProfileId(selection.ref),
    ref: selection.ref,
    immutable: selection.ref.scope === "builtin",
    status,
    fingerprint: fingerprintOf(identity),
    selection_origin: selection.origin,
    ...(definition === undefined ? {} : { definition }),
    ...(definitionView?.revision === undefined
      ? {}
      : { definition_revision: definitionView.revision }),
    ...(definition?.description === undefined ? {} : { description: definition.description }),
    ...(requiresTrust ? { workspace_trust: workspaceTrust } : {}),
    plugins: pluginViews,
    standalone_skills: skillViews,
    issues,
    counts: {
      plugins_active: activePlugins.length,
      standalone_skills_active: activeSkills.length,
      plugin_skills_active: activePlugins.reduce(
        (count, plugin) => count + plugin.skills.length,
        0,
      ),
      mcp_servers_active: activePlugins.reduce(
        (count, plugin) => count + plugin.mcp_servers.length,
        0,
      ),
      hooks_declared: activePlugins.reduce((count, plugin) => count + plugin.hooks.total, 0),
    },
  };
}
