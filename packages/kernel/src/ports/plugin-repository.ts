import type { PluginAgentFile } from "@clarvis/loop/host";
import type { Scope } from "@clarvis/protocol";

/**
 * Filesystem snapshot of a plugin root read before it belongs to a scope — a
 * staging checkout an install is about to move.
 *
 * @remarks It is {@link InstalledPlugin} minus the two fields only a config
 * scope can answer. `inspect()` used to return the full shape with
 * `scope: "global"` and `shadowsGlobal: false` hardcoded, which happened to be
 * unobservable — its one caller reads the manifest and throws the rest away —
 * but was a wrong report waiting for a second caller.
 */
export interface StagedPlugin {
  /** Directory name or requested identity. */
  readonly name: string;
  /** Absolute plugin root. */
  readonly dir: string;
  /** Raw manifest text, absent when unreadable. */
  readonly manifestRaw?: string;
  /**
   * Where the manifest was found, relative to {@link StagedPlugin.dir}.
   *
   * @remarks A manifest under `.<host>-plugin/` writes its relative paths from
   *   beside itself, so resolving them needs the directory it came from.
   */
  readonly manifestLocation?: string;
  /** Any resource/manifest/agent/install-record admission failure for this plugin. */
  readonly manifestError?: string;
  /** Agent files used for validation and contribution discovery. */
  readonly agentFiles: PluginAgentFile[];
  /** Whether the root itself remains a Git checkout. */
  readonly gitCheckout: boolean;
  /** Git origin recorded with the installation, when available. */
  readonly source?: string;
  /** Resolved Git revision currently installed, when available. */
  readonly revision?: string;
  /** Selected repository subdirectory, when the plugin is not the repository root. */
  readonly subdir?: string;
}

/** Filesystem snapshot of one installed plugin, in the scope that owns it. */
export interface InstalledPlugin extends StagedPlugin {
  /** Config scope that owns the installation. */
  readonly scope: Scope;
  /** Whether a workspace installation shadows a global one. */
  readonly shadowsGlobal: boolean;
}

/** Temporary fetched plugin root that must be disposed after install. */
export interface PreparedPlugin {
  /** Absolute plugin root selected from the checkout. */
  readonly root: string;
  /** Validated clone origin and resolved checkout revision. */
  readonly source?: string;
  readonly revision?: string;
  /** Selected plugin subdirectory, absent for a repository-root plugin. */
  readonly subdir?: string;
  /** Remove the staging checkout. */
  dispose(): void | Promise<void>;
}

/** Persistence port for installed plugin directories. */
export interface PluginRepository {
  /** List effective installed plugins across global/workspace scopes. */
  list(): Promise<InstalledPlugin[]>;
  /** Inspect one arbitrary prepared plugin root, before it has a config scope. */
  inspect(root: string): Promise<StagedPlugin>;
  /** Find one globally installed plugin. */
  global(name: string): Promise<InstalledPlugin | null>;
  /** Atomically move a prepared root into the global install location. */
  install(root: string, name: string, prepared?: PreparedPlugin): Promise<InstalledPlugin>;
  /** Atomically replace an existing global installation with a prepared snapshot. */
  replace(root: string, name: string, prepared?: PreparedPlugin): Promise<InstalledPlugin>;
  /** Remove one global installation. */
  remove(name: string): Promise<boolean>;
}

/** Git checkout/update port used by plugin orchestration. */
export interface PluginFetcher {
  /** Clone and select a plugin root from a source. */
  fetch(source: string, subdir?: string, signal?: AbortSignal): Promise<PreparedPlugin>;
  /** Fetch and reset an existing Git checkout. */
  update(plugin: InstalledPlugin, signal?: AbortSignal): Promise<PreparedPlugin | void>;
}
