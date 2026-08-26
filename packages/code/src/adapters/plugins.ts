import { createSignal, type Accessor } from "solid-js";
import type {
  PluginHookReview,
  PluginService,
  PluginView as ProtoPluginView,
} from "@clarvis/protocol";

/** Where a plugin is installed from. */
export type PluginScope = "global" | "workspace";

/** An external executable offered to a capability. */
export interface PluginCapabilityExecutable {
  capability: string;
  command: string;
  args: string[];
  platformOverride: boolean;
}

/** What a plugin contributes to the workspace, by kind. */
export interface PluginContributions {
  agents: string[];
  brokenAgents: string[];
  skills: string[];
  servers: string[];
  hooks: number;
  capabilityExecutables: PluginCapabilityExecutable[];
  skillPlanPolicies?: { skill: string; mode: "off" | "on" | "review" }[];
  executables: string[];
}

/** A plugin as presented to the UI, adapted from the kernel's {@link ProtoPluginView}. */
export interface PluginView {
  name: string;
  scope: PluginScope;
  dir: string;
  enabled: boolean;
  shadowsGlobal: boolean;
  version?: string;
  description?: string;
  /** A name the manifest asks to be shown under; display data, never authorization. */
  displayName?: string;
  /** A one-line summary the manifest offers; display data, never authorization. */
  shortDescription?: string;
  source?: string;
  revision?: string;
  error?: string;
  /** What the manifest declares that Clarvis does not act on; never fatal. */
  notes?: string[];
  contributions: PluginContributions;
}

/** Adapt a kernel {@link ProtoPluginView} into the UI's {@link PluginView}. */
export function toPluginView(p: ProtoPluginView): PluginView {
  return {
    name: p.name,
    scope: p.scope,
    dir: p.dir,
    enabled: p.enabled,
    shadowsGlobal: p.shadows_global,
    ...(p.version !== undefined ? { version: p.version } : {}),
    ...(p.description !== undefined ? { description: p.description } : {}),
    ...(p.display_name !== undefined ? { displayName: p.display_name } : {}),
    ...(p.short_description !== undefined ? { shortDescription: p.short_description } : {}),
    ...(p.source !== undefined ? { source: p.source } : {}),
    ...(p.revision !== undefined ? { revision: p.revision } : {}),
    ...(p.error !== undefined ? { error: p.error } : {}),
    ...(p.notes !== undefined && p.notes.length > 0 ? { notes: p.notes } : {}),
    contributions: {
      agents: p.contributions.agents,
      brokenAgents: p.contributions.broken_agents,
      skills: p.contributions.skills,
      servers: p.contributions.servers,
      hooks: p.contributions.hooks,
      capabilityExecutables: p.contributions.capability_executables.map((entry) => ({
        capability: entry.capability,
        command: entry.command,
        args: entry.args,
        platformOverride: entry.platform_override,
      })),
      ...(p.contributions.capability_run_policies?.plans !== undefined
        ? {
            skillPlanPolicies: Object.entries(p.contributions.capability_run_policies.plans.skills)
              .map(([skill, mode]) => ({ skill, mode }))
              .sort((left, right) => left.skill.localeCompare(right.skill)),
          }
        : {}),
      executables: p.contributions.executables,
    },
  };
}

/** The reactive plugin list and its lifecycle plus exact-hook review operations. */
export interface PluginsStore {
  list: Accessor<PluginView[]>;
  hooks: Accessor<PluginHookReview[]>;
  install(url: string, subdir?: string): Promise<PluginView>;
  update(name: string): Promise<PluginView>;
  uninstall(name: string): Promise<void>;
  approveHook(plugin: string, fingerprint: string): Promise<void>;
  revokeHook(plugin: string, fingerprint: string): Promise<void>;
  reload(): Promise<void>;
}

/** Fetch and adapt the current plugin list from the kernel. */
export async function loadPlugins(plugins: PluginService): Promise<PluginView[]> {
  return (await plugins.list()).map(toPluginView);
}

/**
 * Build the reactive {@link PluginsStore}: every mutation reloads the list and
 * hook-review state from the kernel afterward, so the store never drifts from
 * what was actually persisted.
 *
 * @param plugins - the kernel plugin service.
 * @param initial - the initial list to seed the signal with, before the first reload.
 */
export function createPluginsStore(
  plugins: PluginService,
  initial: PluginView[] = [],
): PluginsStore {
  const [list, setList] = createSignal<PluginView[]>(initial);
  const [hooks, setHooks] = createSignal<PluginHookReview[]>([]);

  async function reload(): Promise<void> {
    const [views, reviews] = await Promise.all([loadPlugins(plugins), plugins.hooks()]);
    setList(views);
    setHooks(reviews);
  }

  return {
    list,
    hooks,
    install: async (url, subdir) => {
      const view = toPluginView(await plugins.install(url, subdir));
      await reload();
      return view;
    },
    update: async (name) => {
      const view = toPluginView(await plugins.update(name));
      await reload();
      return view;
    },
    uninstall: async (name) => {
      await plugins.uninstall(name);
      await reload();
    },
    approveHook: async (plugin, fingerprint) => {
      await plugins.approveHook(plugin, fingerprint);
      await reload();
    },
    revokeHook: async (plugin, fingerprint) => {
      await plugins.revokeHook(plugin, fingerprint);
      await reload();
    },
    reload,
  };
}
