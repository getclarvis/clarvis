/**
 * PluginService — install and manage atomic plugin extension units.
 *
 * On a hosted kernel this must be server-side (a remote UI has no local git or fs).
 * The kernel scans both scopes and runs git; the UI renders the resulting views.
 */

import type { Scope } from "./common.ts";

/** Filesystem convention that owns one installed plugin. */
export type PluginSource = "agents" | "clarvis";

/** Exact identity of one installed plugin across scope and filesystem convention. */
export interface PluginRef {
  scope: Scope;
  source: PluginSource;
  name: string;
}

/** Global install tree selected for a managed plugin lifecycle operation. */
export interface PluginInstallTarget {
  source: PluginSource;
}

/** A normalized marketplace source the kernel can fetch without dialect inference. */
export type PluginInstallSource =
  | {
      kind: "git";
      url: string;
      subdir?: string;
      ref?: string;
      sha?: string;
      expected_name?: string;
    }
  | { kind: "local"; path: string; expected_name?: string }
  | {
      kind: "npm";
      package: string;
      version?: string;
      registry?: string;
      expected_name?: string;
    };

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

/** Publisher identity declared by the plugin itself. */
export interface PluginAuthor {
  name: string;
  email?: string;
  url?: string;
}

/** Installed plugin as presented to the UI. */
export interface PluginView {
  name: string;
  scope: Scope;
  /** Shared `.agents` inventory or Clarvis-native `.clarvis` inventory. */
  source: PluginSource;
  /** Absolute install directory (display + "open" affordance). */
  dir: string;
  /** Active in the kernel's pinned resolved Extension Profile. */
  enabled: boolean;
  version?: string;
  description?: string;
  /** Publisher and discovery metadata, preserved from the installed manifest. */
  author?: PluginAuthor;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  /**
   * A name the manifest asks to be shown under, in place of the directory name.
   *
   * Display data only. A plugin cannot widen what it is allowed to do by
   * describing itself well: trust stays with the install, the enable list and
   * the process-pinned Extension Profile and workspace trust boundary.
   */
  display_name?: string;
  /** A one-line summary the manifest offers for the plugin list; display data only. */
  short_description?: string;
  long_description?: string;
  developer_name?: string;
  category?: string;
  capabilities?: string[];
  website_url?: string;
  privacy_policy_url?: string;
  terms_of_service_url?: string;
  default_prompt?: string[];
  brand_color?: string;
  composer_icon?: string;
  logo?: string;
  screenshots?: string[];
  /** Recorded Git origin for a managed install, including a selected subdirectory. */
  install_source?: string;
  /** Resolved Git revision of the installed checkout. */
  revision?: string;
  /** Whether this exact installation has a managed Git checkout that can be updated. */
  updateable?: boolean;
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

/** Install, update and uninstall plugins. */
export interface PluginService {
  /** Every installed plugin across scopes and filesystem conventions. */
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
  install(url: string, subdir?: string, target?: PluginInstallTarget): Promise<PluginView>;

  /** Install one normalized local, Git, or npm marketplace source. */
  installSource(source: PluginInstallSource, target?: PluginInstallTarget): Promise<PluginView>;

  /**
   * Update a Git-installed plugin to origin HEAD. Repository-root plugins reset
   * their checkout; selected subdirectory plugins are fetched and atomically replaced.
   *
   * @param ref - Exact global plugin installation.
   */
  update(ref: PluginRef): Promise<PluginView>;

  /**
   * Remove an installed plugin.
   *
   * @param ref - Exact global plugin installation.
   */
  uninstall(ref: PluginRef): Promise<void>;
}
