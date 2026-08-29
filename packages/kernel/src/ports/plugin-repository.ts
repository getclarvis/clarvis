import type { PluginAgentFile } from "@clarvis/loop/host";
import type { PluginRef, PluginSource } from "@clarvis/protocol";

/**
 * Filesystem snapshot of a plugin root read before it belongs to a scope — a
 * staging checkout an install is about to move.
 *
 * @remarks It is {@link InstalledPlugin} minus the exact inventory reference,
 * which only the destination tree can answer. Staging inspection therefore
 * cannot pretend that a checkout already belongs to a scope or convention.
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
  /** Whether the inventory entry itself is a symbolic link Clarvis does not own. */
  readonly linked?: boolean;
  /** Whether the root itself remains a Git checkout. */
  readonly gitCheckout: boolean;
  /** Git origin recorded with the installation, when available. */
  readonly origin?: string;
  /** Resolved Git revision currently installed, when available. */
  readonly revision?: string;
  /** Selected repository subdirectory, when the plugin is not the repository root. */
  readonly subdir?: string;
}

/** Filesystem snapshot of one installed plugin, in the scope that owns it. */
export interface InstalledPlugin extends StagedPlugin {
  /** Exact scope, filesystem convention and name of the installation. */
  readonly ref: PluginRef;
}

/** Temporary fetched plugin root that must be disposed after install. */
export interface PreparedPlugin {
  /** Absolute plugin root selected from the checkout. */
  readonly root: string;
  /** Validated clone origin and resolved checkout revision. */
  readonly origin?: string;
  readonly revision?: string;
  /** Selected plugin subdirectory, absent for a repository-root plugin. */
  readonly subdir?: string;
  /** Remove the staging checkout. */
  dispose(): void | Promise<void>;
}

/** Persistence port for installed plugin directories. */
export interface PluginRepository {
  /** List every installed plugin across global/workspace scopes. */
  list(): Promise<InstalledPlugin[]>;
  /** Inspect one arbitrary prepared plugin root, before it has a config scope. */
  inspect(root: string): Promise<StagedPlugin>;
  /** Find one exact installed plugin. */
  get(ref: PluginRef): Promise<InstalledPlugin | null>;
  /** Atomically move a prepared root into one global install convention. */
  install(
    root: string,
    name: string,
    source: PluginSource,
    prepared?: PreparedPlugin,
  ): Promise<InstalledPlugin>;
  /** Atomically replace one exact global installation with a prepared snapshot. */
  replace(root: string, ref: PluginRef, prepared?: PreparedPlugin): Promise<InstalledPlugin>;
  /** Remove one exact global installation. */
  remove(ref: PluginRef): Promise<boolean>;
}

/** Git checkout/update port used by plugin orchestration. */
export interface PluginFetcher {
  /** Clone and select a plugin root from a source. */
  fetch(source: string, subdir?: string, signal?: AbortSignal): Promise<PreparedPlugin>;
  /** Fetch and reset an existing Git checkout. */
  update(plugin: InstalledPlugin, signal?: AbortSignal): Promise<PreparedPlugin | void>;
}
