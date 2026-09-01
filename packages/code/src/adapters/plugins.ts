import { createSignal, type Accessor } from "solid-js";
import type {
  PluginRef,
  PluginInstallSource,
  PluginService,
  PluginSource,
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
  /** Shared `.agents` or Clarvis-native `.clarvis` inventory. */
  source: PluginSource;
  version?: string;
  description?: string;
  author?: { name: string; email?: string; url?: string };
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  /** A name the manifest asks to be shown under; display data, never authorization. */
  displayName?: string;
  /** A one-line summary the manifest offers; display data, never authorization. */
  shortDescription?: string;
  longDescription?: string;
  developerName?: string;
  category?: string;
  capabilities?: string[];
  websiteURL?: string;
  privacyPolicyURL?: string;
  termsOfServiceURL?: string;
  defaultPrompt?: string[];
  brandColor?: string;
  composerIcon?: string;
  logo?: string;
  screenshots?: string[];
  installSource?: string;
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
    source: p.source,
    ...(p.version !== undefined ? { version: p.version } : {}),
    ...(p.description !== undefined ? { description: p.description } : {}),
    ...(p.author !== undefined ? { author: p.author } : {}),
    ...(p.homepage !== undefined ? { homepage: p.homepage } : {}),
    ...(p.repository !== undefined ? { repository: p.repository } : {}),
    ...(p.license !== undefined ? { license: p.license } : {}),
    ...(p.keywords !== undefined ? { keywords: p.keywords } : {}),
    ...(p.display_name !== undefined ? { displayName: p.display_name } : {}),
    ...(p.short_description !== undefined ? { shortDescription: p.short_description } : {}),
    ...(p.long_description !== undefined ? { longDescription: p.long_description } : {}),
    ...(p.developer_name !== undefined ? { developerName: p.developer_name } : {}),
    ...(p.category !== undefined ? { category: p.category } : {}),
    ...(p.capabilities !== undefined ? { capabilities: p.capabilities } : {}),
    ...(p.website_url !== undefined ? { websiteURL: p.website_url } : {}),
    ...(p.privacy_policy_url !== undefined ? { privacyPolicyURL: p.privacy_policy_url } : {}),
    ...(p.terms_of_service_url !== undefined ? { termsOfServiceURL: p.terms_of_service_url } : {}),
    ...(p.default_prompt !== undefined ? { defaultPrompt: p.default_prompt } : {}),
    ...(p.brand_color !== undefined ? { brandColor: p.brand_color } : {}),
    ...(p.composer_icon !== undefined ? { composerIcon: p.composer_icon } : {}),
    ...(p.logo !== undefined ? { logo: p.logo } : {}),
    ...(p.screenshots !== undefined ? { screenshots: p.screenshots } : {}),
    ...(p.install_source !== undefined ? { installSource: p.install_source } : {}),
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

/** The reactive installed-plugin list and lifecycle. */
export interface PluginsStore {
  list: Accessor<PluginView[]>;
  install(url: string, subdir?: string, source?: PluginSource): Promise<PluginView>;
  installSource(source: PluginInstallSource, target?: PluginSource): Promise<PluginView>;
  update(ref: PluginRef): Promise<PluginView>;
  uninstall(ref: PluginRef): Promise<void>;
  reload(): Promise<void>;
}

/** Fetch and adapt the current plugin list from the kernel. */
export async function loadPlugins(plugins: PluginService): Promise<PluginView[]> {
  return (await plugins.list()).map(toPluginView);
}

/**
 * Build the reactive {@link PluginsStore}: every mutation reloads the list from
 * the kernel afterward, so the store never drifts from what was actually persisted.
 *
 * @param plugins - the kernel plugin service.
 * @param initial - the initial list to seed the signal with, before the first reload.
 */
export function createPluginsStore(
  plugins: PluginService,
  initial: PluginView[] = [],
): PluginsStore {
  const [list, setList] = createSignal<PluginView[]>(initial);

  async function reload(): Promise<void> {
    setList(await loadPlugins(plugins));
  }

  return {
    list,
    install: async (url, subdir, source = "agents") => {
      const view = toPluginView(await plugins.install(url, subdir, { source }));
      await reload();
      return view;
    },
    installSource: async (source, target = "agents") => {
      const view = toPluginView(await plugins.installSource(source, { source: target }));
      await reload();
      return view;
    },
    update: async (ref) => {
      const view = toPluginView(await plugins.update(ref));
      await reload();
      return view;
    },
    uninstall: async (ref) => {
      await plugins.uninstall(ref);
      await reload();
    },
    reload,
  };
}
