/**
 * PluginService — install and manage plugins plus exact hook reviews.
 *
 * On a hosted kernel this must be server-side (a remote UI has no local git or fs).
 * The kernel scans both scopes and runs git; the UI renders the resulting views.
 */

import type { Scope } from "./common.ts";

/** One external executable a plugin offers to a named capability. */
export interface PluginCapabilityExecutable {
  capability: string;
  command: string;
  args: string[];
  platform_override: boolean;
}

/** What a plugin contributes, classified for display. */
export interface PluginContributions {
  agents: string[];
  /** Agent files present but unparseable (will not load). */
  broken_agents: string[];
  skills: string[];
  servers: string[];
  /** Count of hook entries (not their names); the concrete commands are in {@link executables}. */
  hooks: number;
  /** Declared language-neutral capability services. */
  capability_executables: PluginCapabilityExecutable[];
  /** Trusted per-skill Plans policy declared by this plugin, for operator display. */
  capability_run_policies?: {
    plans?: { skills: Record<string, "off" | "on" | "review"> };
  };
  /**
   * Concrete commands this plugin would run — hook commands and MCP stdio/url
   * specs, pre-formatted for display — so the plugin view shows exactly what
   * executes without the client parsing the manifest.
   */
  executables: string[];
}

/** Installed plugin as presented to the UI. */
export interface PluginView {
  name: string;
  scope: Scope;
  /** Absolute install directory (display + "open" affordance). */
  dir: string;
  /** Enabled in the effective settings for this workspace. */
  enabled: boolean;
  /** Workspace plugin that shadows a global one of the same name. */
  shadows_global: boolean;
  version?: string;
  description?: string;
  /**
   * A name the manifest asks to be shown under, in place of the directory name.
   *
   * Display data only. A plugin cannot widen what it is allowed to do by
   * describing itself well: trust stays with the install, the enable list and
   * the hook reviews.
   */
  display_name?: string;
  /** A one-line summary the manifest offers for the plugin list; display data only. */
  short_description?: string;
  /** Recorded installation origin for a Git-installed plugin, including a selected subdirectory. */
  source?: string;
  /** Resolved Git revision of the installed checkout. */
  revision?: string;
  /** Present when `plugin.json` is missing/invalid (the plugin will not load). */
  error?: string;
  /**
   * What the manifest declares that this kernel does not act on — keys it does
   * not recognize, hooks written for another host that did not translate, a
   * skills location it does not scan.
   *
   * Never fatal, and shown rather than swallowed: a plugin authored for a
   * different agent host installs here, and the operator has to be able to see
   * which of its behaviour came along and which did not.
   */
  notes?: string[];
  contributions: PluginContributions;
}

/** One exact plugin hook definition and its individual review state. */
export interface PluginHookReview {
  plugin: string;
  fingerprint: string;
  definition: unknown;
  approved: boolean;
}

/** Install, update and uninstall plugins, and review unmanaged hooks. */
export interface PluginService {
  /** Every installed plugin across scopes (workspace shadows global by name). */
  list(): Promise<PluginView[]>;

  /**
   * Clone and install from a git URL (`https` / `ssh` / `file`).
   *
   * @param url - Git remote or path.
   * @param subdir - Optional POSIX subdirectory within the cloned repo whose
   *   `plugin.json` is the plugin to install — lets one repo ship several
   *   plugins. Must resolve inside the checkout (no `..`, no absolute path).
   *   Omit to install a plugin at the repo root.
   * @returns The newly installed plugin view.
   */
  install(url: string, subdir?: string): Promise<PluginView>;

  /**
   * Update a Git-installed plugin to origin HEAD. Repository-root plugins reset
   * their checkout; selected subdirectory plugins are fetched and atomically replaced.
   *
   * @param name - Plugin name.
   */
  update(name: string): Promise<PluginView>;

  /**
   * Remove an installed plugin.
   *
   * @param name - Plugin name.
   */
  uninstall(name: string): Promise<void>;

  /** Exact unmanaged hook definitions awaiting or carrying individual approval. */
  hooks(): Promise<PluginHookReview[]>;
  /** Approve exactly one current hook definition. */
  approveHook(plugin: string, fingerprint: string): Promise<void>;
  /** Revoke exactly one hook definition approval. */
  revokeHook(plugin: string, fingerprint: string): Promise<void>;
}
