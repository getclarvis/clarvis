import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync, unwatchFile, watchFile } from "node:fs";
import { join } from "node:path";
import {
  pluginSettingsFragment,
  PLUGIN_RESOURCE_LIMITS,
  readPluginAgentFiles,
  splitAgentFrontmatter,
  type PluginBootstrapSkill,
  type PluginManifest,
  type SettingsScope,
  type SkillRootInput,
} from "@clarvis/loop/host";
import {
  NOOP_LOGGER,
  type CapabilityExecutableDeclaration,
  type CapabilitySkillPlansMode,
  type Logger,
} from "@clarvis/capability";
import {
  agentsPluginsDirs,
  globalPaths,
  withoutGitRepositoryEnvironment,
  workspacePaths,
} from "@clarvis/paths";
import type { AgentRecord } from "../config/config-store.ts";
import type { ExtensionProfilePluginRef, PluginSource, Scope } from "@clarvis/protocol";
import {
  pluginSkillRoots,
  pluginSkillScanRoots,
  readPluginManifestSource,
  resolvePluginManifest,
} from "./plugin-manifest.ts";
import {
  createAgentSkills,
  enumerateResources,
  hashBoundedFile,
  readBoundedBytes,
  type SkillContent,
  type SkillInfo,
  type SkillResource,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILE_CHARS,
  MAX_SKILL_RESOURCE_FILE_BYTES,
  MAX_SKILL_RESOURCE_SNAPSHOT_BYTES,
  MAX_SKILL_ROOTS,
} from "@clarvis/skills";
import { readPluginInstallRecord } from "./plugin-install-record.ts";
import type { PluginInstallRecord } from "./plugin-install-record.ts";
import { ensurePluginDataDir } from "./plugin-runtime.ts";
import { kernelError } from "../core/errors.ts";
import {
  snapshotPluginExecutables,
  type PluginExecutableFileSnapshot,
} from "./plugin-executable-snapshot.ts";

/** Exact hashing bounds for all bundled resources contributed by one plugin. */
export const PLUGIN_SKILL_RESOURCE_LIMITS = Object.freeze({
  fileBytes: MAX_SKILL_RESOURCE_FILE_BYTES,
  aggregateBytes: MAX_SKILL_RESOURCE_SNAPSHOT_BYTES,
});

type PluginSelection = readonly ExtensionProfilePluginRef[];

/** One selected plugin whose package-local executable surface changed on disk. */
export interface PluginRuntimeDriftNotice {
  plugin: string;
  path: string;
}

interface PluginRuntimeWatcher {
  close(): void;
}

/**
 * Turns installed + enabled plugins into the inputs a run consumes: skill roots,
 * settings fragments (hooks / mcpServers / capability blocks), and agent records.
 *
 * Installation and explicit Extension Profile selection authorize every contribution
 * from the plugin as one atomic unit, including its normalized hooks.
 *
 * Every method takes exact operator-enabled plugin references as an argument
 * (never reads settings itself) so it can be folded into the config store's
 * settings merge without recursing through `readSettings()`.
 */
export interface PluginContributions {
  /** Resolve a fresh exact contribution set without changing the active snapshot. */
  snapshot(enabled: PluginSelection): readonly PluginContributionSnapshot[];
  /** Capture the exact contribution bytes selected for this kernel process. */
  pin(enabled: PluginSelection): readonly PluginContributionSnapshot[];
  /** Skill roots for enabled + loadable plugins, or the process-pinned projection after pinning. */
  skillRoots(enabled: PluginSelection): SkillRootInput[];
  /** Already-pinned skill roots without a filesystem validation. */
  pinnedSkillRoots(enabled: PluginSelection): SkillRootInput[];
  /**
   * Bootstrap skills declared by enabled + loadable plugins, in `enabled` order.
   *
   * @remarks A bootstrap is a declaration about a file the plugin already ships.
   *   Unlike {@link PluginContributions.skillRoots} this does
   *   not check that `skills/` exists — a plugin with no skills root contributes no
   *   skills either, so the name cannot resolve to it and the loop's own resolution
   *   reports the miss.
   */
  skillBootstraps(enabled: PluginSelection): PluginBootstrapSkill[];
  /** Settings scopes for enabled plugins, including their normalized hooks. */
  settingsScopes(enabled: PluginSelection): SettingsScope[];
  /** Namespaced MCP declarations plus the plugin provenance used by provider identity. */
  mcpServers(enabled: PluginSelection): ResolvedPluginMcpContribution[];
  /** Agent records (`<plugin>:<agent>`, scope `plugin`) for enabled plugins. */
  agents(enabled: PluginSelection): AgentRecord[];
  /** Resolve one `<plugin>:<agent>` record, or null if the plugin is not enabled. */
  readAgent(enabled: PluginSelection, qualifiedName: string): AgentRecord | null;
  /** Locate one executable an installed + enabled + selected plugin offers. */
  locateCapabilityExecutable(
    enabled: PluginSelection,
    capability: string,
    plugin: string,
  ): { root: string; declaration: CapabilityExecutableDeclaration } | { error: string };
  /** Trusted Plans mode declared for one skill packaged by the selected plugin. */
  skillPlansMode(
    enabled: PluginSelection,
    plugin: string,
    skill: string,
  ): CapabilitySkillPlansMode | undefined;
  /** Return captured skills whose bytes no longer match the exact process-pinned contribution. */
  verifyPinnedSkillCatalog(skills: readonly SkillContent[]): readonly SkillContent[];
  /** Release asynchronous executable-file monitors owned by this contribution snapshot. */
  close(): void;
}

/** Immutable projection captured from one loadable plugin contribution. */
export interface PluginContributionSnapshot {
  ref: ExtensionProfilePluginRef;
  digest: string;
  version?: string;
  revision?: string;
  agents: string[];
  skills: string[];
  mcpServers: string[];
  hooks: { total: number };
  capabilityExecutables: string[];
}

/** One plugin MCP declaration after the host has assigned its collision-free name. */
export interface ResolvedPluginMcpContribution {
  effectiveName: string;
  plugin: string;
  pluginVersion?: string;
  resolvedRevision?: string;
  declaration: NonNullable<PluginManifest["mcpServers"]>[string];
}

/** Assign the single host-owned effective name used by settings, UI, and providers. */
export function effectivePluginMcpName(plugin: string, server: string): string {
  return `${plugin}:${server}`;
}

/**
 * One installed and enabled plugin that may contribute to a run.
 */
interface Loadable {
  /** The plugin name used as the runtime namespace. */
  name: string;
  /** Exact inventory identity selected by the operator. */
  ref: ExtensionProfilePluginRef;
  /** Absolute install directory the plugin resolved to. */
  dir: string;
  /** Exact selected manifest source admitted with its normalized projection. */
  manifestRaw: string;
  /** The parsed `plugin.json` manifest. */
  manifest: PluginManifest;
  /** Dialect-specific discovery contract applied to bundled skills. */
  format: "native" | "agent-plugin-v1";
  /** Where that manifest was found, relative to {@link Loadable.dir}. */
  manifestLocation: string;
  /** Agent snapshot admitted atomically with the manifest and install record. */
  agentFiles: ReturnType<typeof readPluginAgentFiles> & { ok: true };
  /** Install provenance read once during admission, so runtime identity cannot race that check. */
  installRecord: PluginInstallRecord;
  /** Source revision captured with the rest of the admitted contribution. */
  resolvedRevision?: string;
  /** Package-local process files captured with the executable declarations that reference them. */
  executableFiles: PluginExecutableFileSnapshot[];
}

/**
 * Build the {@link PluginContributions} loader over a global install root and an
 * optional workspace one.
 *
 * @param opts - Clarvis global state, optional home, and optional workspace root
 *   from which all exact `.agents/plugins` and `.clarvis/plugins` inventories are
 *   derived.
 * @returns a {@link PluginContributions} whose every method is passed the
 *   operator-enabled plugin names. Before an Extension Profile is pinned, contribution
 *   files are discovered per call; afterwards the admitted manifests and agents
 *   remain immutable while asynchronous monitors withdraw changed executable
 *   projections until reconnect. Hook
 *   Workspace settings-hook approvals remain live because they are independent
 *   authorization state; a selected plugin's own hooks stay in its atomic snapshot.
 * @remarks Reads the filesystem synchronously and never consults settings itself,
 *   so it can be folded into the config store's settings merge without recursing
 *   through `readSettings()`. Repeated exact references are de-duplicated; the
 *   Extension Profile resolver rejects two different installations sharing a runtime
 *   plugin name before this loader is called.
 */
/**
 * How many skill roots every enabled plugin may contribute between them.
 *
 * @remarks
 * `@clarvis/skills` refuses a scan above {@link MAX_SKILL_ROOTS} roots, and the
 * engine turns that refusal into an *empty* skills provider — so exceeding it
 * does not cost the last plugin its skills, it costs the workspace all of them.
 * The reserve left below the ceiling is for the roots the host contributes
 * itself. `clarvisSkillRoots` returns exactly four — `.agents` and `.clarvis`,
 * each at user and workspace scope — so the reserve is double what the host
 * spends today. That margin is deliberate and cheap: adding a host root must not
 * silently narrow what plugins may contribute, and the cost of being one short
 * is not the marginal plugin's skills but *every* skill in the workspace, since
 * the refusal degrades to an empty provider. Plugins are bounded here so they
 * cannot spend the host's share.
 */
const PLUGIN_SKILL_ROOT_BUDGET = MAX_SKILL_ROOTS - 8;

export function createPluginContributions(opts: {
  globalDir: string;
  home?: string;
  workspaceRoot?: string;
  /** Where a plugin dropped from the catalog is reported. */
  logger?: Logger;
  /** Inform the host that executable contributions from one plugin were withdrawn. */
  onRuntimeDrift?: (notice: PluginRuntimeDriftNotice) => void;
  /** Injectable asynchronous path monitor for deterministic tests. */
  watchRuntimePath?: (path: string, onChange: () => void) => PluginRuntimeWatcher;
}): PluginContributions {
  const logger = opts.logger ?? NOOP_LOGGER;
  const watchRuntimePath =
    opts.watchRuntimePath ??
    ((path: string, onChange: () => void): PluginRuntimeWatcher => {
      const listener = (
        current: {
          mtimeMs: number;
          ctimeMs: number;
          size: number;
          mode: number;
          ino: number;
          dev: number;
        },
        previous: {
          mtimeMs: number;
          ctimeMs: number;
          size: number;
          mode: number;
          ino: number;
          dev: number;
        },
      ): void => {
        if (
          current.mtimeMs === previous.mtimeMs &&
          current.ctimeMs === previous.ctimeMs &&
          current.size === previous.size &&
          current.mode === previous.mode &&
          current.ino === previous.ino &&
          current.dev === previous.dev
        )
          return;
        onChange();
      };
      watchFile(path, { persistent: false, interval: 1_000 }, listener);
      return { close: () => unwatchFile(path, listener) };
    });
  const runtimeWatchers = new Map<string, PluginRuntimeWatcher[]>();
  const driftedRuntime = new Set<string>();
  /**
   * Report a plugin the operator enabled that contributes nothing.
   *
   * @param plugin - the enabled name.
   * @param scope - where it was installed, or `none` when it was found nowhere.
   * @param phase - the step that dropped it.
   * @param cause - the specific failure.
   * @remarks Enabling a plugin and having it *do* something are two different
   *   facts, and before this only the first was observable: a manifest that did
   *   not parse, an agents tree over its limit and an absent install were all
   *   the same silent `undefined`.
   */
  const skipped = (
    plugin: ExtensionProfilePluginRef,
    phase: "manifest" | "dir" | "skills" | "agents" | "install_record" | "executables",
    cause: string,
  ): void => {
    logger.warn(
      {
        event: "kernel.plugin.skipped",
        plugin: plugin.name,
        scope: plugin.scope,
        source: plugin.source,
        phase,
        cause,
      },
      "an enabled plugin contributes nothing this run; its agents, hooks, MCP servers and skills are all absent",
    );
  };
  const agents = agentsPluginsDirs({
    env: {},
    ...(opts.home === undefined ? {} : { home: opts.home }),
    ...(opts.workspaceRoot === undefined ? {} : { cwd: opts.workspaceRoot }),
  });
  const installRoots: { path: string; scope: Scope; source: PluginSource }[] = [
    { path: globalPaths(opts.globalDir).pluginsDir, scope: "global", source: "clarvis" },
    { path: agents.user, scope: "global", source: "agents" },
    ...(opts.workspaceRoot === undefined
      ? []
      : [
          {
            path: workspacePaths(opts.workspaceRoot).pluginsDir,
            scope: "workspace" as const,
            source: "clarvis" as const,
          },
          { path: agents.workspace, scope: "workspace" as const, source: "agents" as const },
        ]),
  ];

  const refId = (ref: ExtensionProfilePluginRef): string =>
    `${ref.scope}:${ref.source}:${ref.name}`;
  const selectionId = (enabled: PluginSelection): string => enabled.map(refId).join("\0");
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  };
  const digest = (value: unknown): string =>
    `sha256:${createHash("sha256")
      .update(JSON.stringify(canonical(value)))
      .digest("hex")}`;

  /** Exact install root and directory selected by one qualified reference. */
  const dirFor = (ref: ExtensionProfilePluginRef): { dir: string } | undefined => {
    const root = installRoots.find(
      (candidate) => candidate.scope === ref.scope && candidate.source === ref.source,
    );
    if (root === undefined) return undefined;
    const dir = join(root.path, ref.name);
    try {
      if (statSync(dir).isDirectory()) return { dir };
    } catch {
      /* absent or unreadable */
    }
    return undefined;
  };

  /** The directories a plugin's skills are scanned from, as its manifest asks.
   * The single place that encodes a plugin's skills layout; both contributions
   * below go through it, and so does the panel that lists what it offers. */
  const skillsDirsOf = (p: Loadable): string[] =>
    pluginSkillRoots(p.dir, p.manifest.skills, p.manifestLocation).roots;

  /** Resolve the installed snapshot without treating the manifest version as source identity. */
  const revisionOf = (dir: string, installRecord: PluginInstallRecord): string | undefined => {
    if (installRecord.revision !== undefined) return installRecord.revision;
    /* Unmanaged local plugins have no install record; Git is the fallback. */
    const result = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], {
      encoding: "utf8",
      env: withoutGitRepositoryEnvironment(process.env),
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: PLUGIN_RESOURCE_LIMITS.installRecordBytes,
    });
    const revision =
      result.status === 0 && typeof result.stdout === "string" ? result.stdout.trim() : "";
    return revision.length > 0 ? revision : undefined;
  };

  const resolvedMcpServers = (plugin: Loadable): ResolvedPluginMcpContribution[] => {
    const declarations = Object.entries(plugin.manifest.mcpServers ?? {});
    if (declarations.length === 0) return [];
    const resolvedRevision = plugin.resolvedRevision;
    return declarations.map(([name, declaration]) => ({
      effectiveName: effectivePluginMcpName(plugin.name, name),
      plugin: plugin.name,
      ...(plugin.manifest.version === undefined ? {} : { pluginVersion: plugin.manifest.version }),
      ...(resolvedRevision === undefined ? {} : { resolvedRevision }),
      declaration,
    }));
  };

  /** Resolve one plugin to a {@link Loadable}, or undefined when it is not
   * installed or has no readable/parseable `plugin.json`. */
  function loadableOf(ref: ExtensionProfilePluginRef): Loadable | undefined {
    const name = ref.name;
    const found = dirFor(ref);
    if (found === undefined) {
      skipped(ref, "dir", "the exact inventory does not hold a directory of this name");
      return undefined;
    }
    const { dir } = found;
    const source = readPluginManifestSource(dir);
    if (!("raw" in source)) {
      skipped(ref, "manifest", source.error);
      return undefined;
    }
    const dataDir = ensurePluginDataDir({
      globalDir: opts.globalDir,
      ...(opts.workspaceRoot === undefined ? {} : { workspaceRoot: opts.workspaceRoot }),
      ref,
    });
    const resolved = resolvePluginManifest(dir, source.raw, source.location, name, { dataDir });
    const { manifest } = resolved;
    if (manifest === undefined) {
      skipped(ref, "manifest", resolved.error ?? "manifest did not resolve");
      return undefined;
    }
    const agents = readPluginAgentFiles(join(dir, "agents"));
    if (!agents.ok) {
      skipped(ref, "agents", agents.error);
      return undefined;
    }
    const installed = readPluginInstallRecord(dir);
    if (!installed.ok) {
      skipped(ref, "install_record", installed.error);
      return undefined;
    }
    const executableSurface = snapshotPluginExecutables(dir, manifest);
    if (!executableSurface.ok) {
      skipped(ref, "executables", executableSurface.error);
      return undefined;
    }
    const resolvedRevision = revisionOf(dir, installed.record);
    return {
      name,
      ref,
      dir,
      manifestRaw: source.raw,
      manifest,
      format: resolved.format ?? "native",
      manifestLocation: source.location,
      agentFiles: agents,
      installRecord: installed.record,
      executableFiles: executableSurface.files,
      ...(resolvedRevision === undefined ? {} : { resolvedRevision }),
    };
  }

  /** Resolve exact references in order, de-duplicating identical entries. */
  const freshLoadables = (enabled: PluginSelection): Loadable[] => {
    const out: Loadable[] = [];
    const seen = new Set<string>();
    for (const ref of enabled) {
      const key = `${ref.scope}\0${ref.source}\0${ref.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const l = loadableOf(ref);
      if (l !== undefined) out.push(l);
    }
    return out;
  };

  /** Return the raw-byte digest of one descriptor-bounded snapshot file. */
  const snapshotFileDigest = (path: string, maxBytes: number, maxChars?: number): string =>
    `sha256:${createHash("sha256")
      .update(
        readBoundedBytes(path, {
          maxBytes,
          ...(maxChars === undefined ? {} : { maxChars }),
          code: "invalid_skill",
          label: "plugin skill file",
          logger,
        }),
      )
      .digest("hex")}`;

  const capturedSkillSurfaces = new WeakMap<
    PluginContributionSnapshot,
    readonly ({ name: string; digest: string } | { unavailable: true })[]
  >();

  /** Hash one discovered skill through the canonical record used by contribution pinning. */
  const skillDigest = (
    info: SkillInfo,
    resources: readonly SkillResource[],
    aggregate: { bytes: number },
  ): string =>
    digest({
      manifest: snapshotFileDigest(info.path, MAX_SKILL_FILE_BYTES, MAX_SKILL_FILE_CHARS),
      catalog: {
        name: info.name,
        description: info.description,
        metadata: info.metadata,
        allowed_tools: info.allowedTools,
        user_invocable: info.userInvocable,
        catalog_suppressed: info.catalogSuppressed,
        dependencies: info.dependencies,
        presentation: info.presentation,
        defaulted: info.defaulted,
      },
      resources: [...resources]
        .sort((left, right) => left.rel.localeCompare(right.rel))
        .map((resource) => {
          const snapshot = hashBoundedFile(resource.path, {
            maxBytes: PLUGIN_SKILL_RESOURCE_LIMITS.fileBytes,
            code: "invalid_skill",
            label: "plugin skill resource",
            logger,
          });
          aggregate.bytes += snapshot.bytes;
          if (aggregate.bytes > PLUGIN_SKILL_RESOURCE_LIMITS.aggregateBytes) {
            throw new Error(
              `plugin skill resources exceed the ${String(
                PLUGIN_SKILL_RESOURCE_LIMITS.aggregateBytes,
              )}-byte aggregate limit`,
            );
          }
          return {
            rel: resource.rel,
            digest: snapshot.digest,
            bytes: snapshot.bytes,
            mode: snapshot.mode,
          };
        }),
    });

  const skillSurface = (
    plugin: Loadable,
  ): ({ name: string; digest: string } | { unavailable: true })[] => {
    const roots = pluginSkillScanRoots(
      plugin.dir,
      plugin.manifest.skills,
      plugin.manifestLocation,
      plugin.format,
    );
    if (roots.length === 0) return [];
    try {
      const aggregate = { bytes: 0 };
      const skills = createAgentSkills({
        workspace: plugin.dir,
        roots,
        warningSink: () => undefined,
        logger,
      });
      return skills
        .listSkills()
        .map((info) => ({
          name: info.name,
          digest: skillDigest(
            info,
            enumerateResources(info.dir, skills.config.followSymlinks, skills.config),
            aggregate,
          ),
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      return [{ unavailable: true }];
    }
  };

  const unavailableSkillSnapshots = new WeakSet<PluginContributionSnapshot>();

  const contributionSnapshot = (plugin: Loadable): PluginContributionSnapshot => {
    const skills = skillSurface(plugin);
    const hooks = plugin.manifest.hooks ?? [];
    const snapshot: PluginContributionSnapshot = {
      ref: plugin.ref,
      digest: digest({
        ref: plugin.ref,
        format: plugin.format,
        manifest_location: plugin.manifestLocation,
        manifest_source: plugin.manifestRaw,
        manifest: plugin.manifest,
        agents: plugin.agentFiles.files.map((file) => ({ name: file.name, content: file.content })),
        skills,
        executable_files: plugin.executableFiles,
        install_record: plugin.installRecord,
        resolved_revision: plugin.resolvedRevision,
      }),
      ...(plugin.manifest.version === undefined ? {} : { version: plugin.manifest.version }),
      ...(plugin.resolvedRevision === undefined ? {} : { revision: plugin.resolvedRevision }),
      agents: plugin.agentFiles.files.map((file) => file.name.replace(/\.md$/i, "")).sort(),
      skills: skills.flatMap((skill) => ("name" in skill ? [skill.name] : [])).sort(),
      mcpServers: Object.keys(plugin.manifest.mcpServers ?? {})
        .map((name) => effectivePluginMcpName(plugin.name, name))
        .sort(),
      hooks: { total: hooks.length },
      capabilityExecutables: Object.keys(plugin.manifest.capabilityExecutables ?? {}).sort(),
    };
    if (skills.some((skill) => "unavailable" in skill)) {
      unavailableSkillSnapshots.add(snapshot);
    }
    capturedSkillSurfaces.set(snapshot, skills);
    return snapshot;
  };

  let pinned:
    | {
        selection: string;
        refs: readonly ExtensionProfilePluginRef[];
        loadables: readonly Loadable[];
        snapshots: readonly PluginContributionSnapshot[];
        skillRoots: readonly SkillRootInput[];
        skillDigests: ReadonlyMap<string, string>;
      }
    | undefined;

  const loadables = (enabled: PluginSelection): readonly Loadable[] =>
    pinned !== undefined && pinned.selection === selectionId(enabled)
      ? pinned.loadables
      : freshLoadables(enabled);

  const assertPinnedSelection = (enabled: PluginSelection): void => {
    if (pinned === undefined) return;
    if (pinned.selection !== selectionId(enabled)) {
      throw kernelError(
        "unavailable",
        "active plugin selection changed after the Extension Profile snapshot was pinned; reconnect the kernel",
      );
    }
  };

  const captureSnapshots = (loadable: readonly Loadable[]): readonly PluginContributionSnapshot[] =>
    Object.freeze(loadable.map(contributionSnapshot));

  const closeRuntimeWatchers = (): void => {
    for (const watchers of runtimeWatchers.values()) {
      for (const watcher of watchers) watcher.close();
    }
    runtimeWatchers.clear();
  };

  /** Monitor only bytes that a later process launch could otherwise reread from disk. */
  const observeRuntimeFiles = (loadables: readonly Loadable[]): void => {
    closeRuntimeWatchers();
    driftedRuntime.clear();
    for (const plugin of loadables) {
      const key = refId(plugin.ref);
      const watchers: PluginRuntimeWatcher[] = [];
      const onChange = (path: string): void => {
        if (driftedRuntime.has(key)) return;
        driftedRuntime.add(key);
        for (const watcher of runtimeWatchers.get(key) ?? []) watcher.close();
        runtimeWatchers.delete(key);
        logger.warn(
          {
            event: "kernel.plugin.runtime_drift",
            plugin: plugin.name,
            scope: plugin.ref.scope,
            source: plugin.ref.source,
            path,
          },
          "changed plugin runtime files were withdrawn; runs remain available",
        );
        try {
          opts.onRuntimeDrift?.({ plugin: plugin.name, path });
        } catch (error) {
          logger.warn(
            {
              event: "kernel.plugin.runtime_drift_notice_failed",
              plugin: plugin.name,
              cause: error instanceof Error ? error.message : String(error),
            },
            "the host's plugin drift notice callback failed",
          );
        }
      };
      for (const file of plugin.executableFiles) {
        const path = join(plugin.dir, file.path);
        try {
          watchers.push(watchRuntimePath(path, () => onChange(path)));
        } catch (error) {
          logger.warn(
            {
              event: "kernel.plugin.runtime_watch_unavailable",
              plugin: plugin.name,
              path,
              cause: error instanceof Error ? error.message : String(error),
            },
            "live plugin runtime drift monitoring is unavailable for one file",
          );
        }
      }
      if (watchers.length > 0) runtimeWatchers.set(key, watchers);
    }
  };

  const runtimeAvailable = (plugin: Loadable): boolean => !driftedRuntime.has(refId(plugin.ref));

  /** Project roots once from the same loadables and snapshots the Extension Profile pins. */
  const projectSkillRoots = (
    selectedLoadables: readonly Loadable[],
    snapshots: readonly PluginContributionSnapshot[],
  ): SkillRootInput[] => {
    const snapshotsByRef = new Map(snapshots.map((snapshot) => [refId(snapshot.ref), snapshot]));
    let budget = PLUGIN_SKILL_ROOT_BUDGET;
    return selectedLoadables.flatMap((plugin) => {
      const snapshot = snapshotsByRef.get(refId(plugin.ref));
      if (snapshot === undefined || unavailableSkillSnapshots.has(snapshot)) {
        skipped(
          plugin.ref,
          "skills",
          "the selected skill surface could not be captured atomically",
        );
        return [];
      }
      const declared = skillsDirsOf(plugin);
      let refused: string | undefined;
      const present = declared.filter((path) => {
        try {
          return statSync(path).isDirectory();
        } catch (error) {
          refused ??= error instanceof Error ? error.message : String(error);
          return false;
        }
      });
      if (present.length === 0) {
        skipped(
          plugin.ref,
          "skills",
          refused ?? `none of ${String(declared.length)} declared skill roots is a directory`,
        );
        return [];
      }
      if (budget <= 0) {
        skipped(plugin.ref, "skills", "the run's plugin skill-root budget is spent");
        return [];
      }
      const admitted = present.slice(0, budget);
      if (admitted.length < present.length) {
        skipped(
          plugin.ref,
          "skills",
          `only ${String(admitted.length)} of ${String(present.length)} skill roots fit the ` +
            "run's plugin budget",
        );
      }
      budget -= admitted.length;
      const scanRoots = new Map(
        pluginSkillScanRoots(
          plugin.dir,
          plugin.manifest.skills,
          plugin.manifestLocation,
          plugin.format,
        ).map((root) => [root.path, root]),
      );
      return admitted.map((path) => ({
        ...scanRoots.get(path),
        path,
        executionRoot: plugin.dir,
        scope: plugin.ref.scope === "workspace" ? ("workspace" as const) : ("user" as const),
        source: `plugin:${plugin.name}`,
      }));
    });
  };
  const copySkillRoots = (roots: readonly SkillRootInput[]): SkillRootInput[] =>
    roots.map((root) => ({
      ...root,
      ...(root.include === undefined ? {} : { include: [...root.include] }),
    }));

  /** Parse a plugin agent's markdown into an {@link AgentRecord} qualified as
   * `<plugin>:<agent>` with scope `plugin`, lifting `model`/`description` from the
   * (leniently parsed) frontmatter when they are strings. */
  function toAgentRecord(plugin: string, agentName: string, content: string): AgentRecord {
    const { data, body } = splitAgentFrontmatter(content, "lenient");
    const fm = (data ?? {}) as Record<string, unknown>;
    return {
      name: `${plugin}:${agentName}`,
      scope: "plugin",
      plugin,
      frontmatter: fm,
      body,
      ...(typeof fm.model === "string" ? { model: fm.model } : {}),
      ...(typeof fm.description === "string" ? { description: fm.description } : {}),
    };
  }

  return {
    snapshot(enabled) {
      return captureSnapshots(freshLoadables(enabled));
    },

    pin(enabled) {
      const captured = freshLoadables(enabled);
      const snapshots = captureSnapshots(captured);
      const refs = captured.map((plugin) => plugin.ref);
      const skillRoots = projectSkillRoots(captured, snapshots);
      const skillDigests = new Map<string, string>();
      for (const snapshot of snapshots) {
        const scope = snapshot.ref.scope === "workspace" ? "workspace" : "user";
        for (const skill of capturedSkillSurfaces.get(snapshot) ?? []) {
          if ("name" in skill) {
            skillDigests.set(`${scope}\0plugin:${snapshot.ref.name}\0${skill.name}`, skill.digest);
          }
        }
      }
      pinned = {
        selection: selectionId(refs),
        refs,
        loadables: captured,
        snapshots,
        skillRoots: Object.freeze(skillRoots),
        skillDigests,
      };
      observeRuntimeFiles(captured);
      return snapshots;
    },

    skillRoots(enabled) {
      assertPinnedSelection(enabled);
      if (pinned !== undefined && pinned.selection === selectionId(enabled)) {
        return copySkillRoots(pinned.skillRoots);
      }
      const selectedLoadables = loadables(enabled);
      const snapshots = captureSnapshots(selectedLoadables);
      return projectSkillRoots(selectedLoadables, snapshots);
    },

    pinnedSkillRoots(enabled) {
      assertPinnedSelection(enabled);
      if (pinned === undefined) {
        throw kernelError("unavailable", "plugin contribution snapshot has not been pinned");
      }
      return copySkillRoots(pinned.skillRoots);
    },

    skillBootstraps(enabled) {
      assertPinnedSelection(enabled);
      return loadables(enabled).flatMap((p) =>
        p.manifest.bootstrapSkill === undefined
          ? []
          : [{ plugin: p.name, skill: p.manifest.bootstrapSkill, roots: skillsDirsOf(p) }],
      );
    },

    settingsScopes(enabled) {
      assertPinnedSelection(enabled);
      return loadables(enabled)
        .filter(runtimeAvailable)
        .map((p) => {
          const settings = pluginSettingsFragment(p.manifest);
          const namespacedServers = Object.fromEntries(
            resolvedMcpServers(p).map((server) => [server.effectiveName, server.declaration]),
          );
          return {
            origin: "plugin" as const,
            settings: {
              ...settings,
              ...(p.manifest.mcpServers === undefined ? {} : { mcpServers: namespacedServers }),
            },
          };
        });
    },

    mcpServers(enabled) {
      assertPinnedSelection(enabled);
      return loadables(enabled).filter(runtimeAvailable).flatMap(resolvedMcpServers);
    },

    agents(enabled) {
      assertPinnedSelection(enabled);
      return loadables(enabled).flatMap((p) =>
        p.agentFiles.files.map((f) =>
          toAgentRecord(p.name, f.name.replace(/\.md$/i, ""), f.content),
        ),
      );
    },

    readAgent(enabled, qualifiedName) {
      assertPinnedSelection(enabled);
      const sep = qualifiedName.indexOf(":");
      if (sep <= 0) return null;
      const plugin = qualifiedName.slice(0, sep);
      const agentName = qualifiedName.slice(sep + 1);
      const ref = enabled.find((candidate) => candidate.name === plugin);
      if (ref === undefined) return null;
      const l = loadables(enabled).find((candidate) => refId(candidate.ref) === refId(ref));
      if (l === undefined) return null;
      const expected = `${agentName}.md`;
      const file = l.agentFiles.files.find((candidate) => candidate.name === expected);
      return file === undefined ? null : toAgentRecord(plugin, agentName, file.content);
    },

    locateCapabilityExecutable(enabled, capability, plugin) {
      assertPinnedSelection(enabled);
      const ref = enabled.find((candidate) => candidate.name === plugin);
      if (ref === undefined) {
        return { error: `plugin '${plugin}' is not enabled for this workspace` };
      }
      const l = loadables(enabled).find((candidate) => refId(candidate.ref) === refId(ref));
      if (l === undefined) return { error: `plugin '${plugin}' has no readable manifest` };
      if (!runtimeAvailable(l)) {
        return {
          error: `plugin '${plugin}' changed on disk; its executable contributions are withheld until reconnect`,
        };
      }
      const declared = l.manifest.capabilityExecutables?.[capability];
      if (declared === undefined) {
        return { error: `plugin '${plugin}' offers no capability executable '${capability}'` };
      }
      return { root: l.dir, declaration: declared };
    },

    skillPlansMode(enabled, plugin, skill) {
      assertPinnedSelection(enabled);
      const ref = enabled.find((candidate) => candidate.name === plugin);
      if (ref === undefined) return undefined;
      const loadable = loadables(enabled).find((candidate) => refId(candidate.ref) === refId(ref));
      if (loadable === undefined || !runtimeAvailable(loadable)) return undefined;
      return loadable.manifest.capabilityRunPolicies?.plans?.skills[skill];
    },

    verifyPinnedSkillCatalog(skills) {
      if (pinned === undefined) {
        throw kernelError("unavailable", "plugin contribution snapshot has not been pinned");
      }
      const current = new Map<string, string>();
      for (const plugin of pinned.loadables) {
        const scope = plugin.ref.scope === "workspace" ? "workspace" : "user";
        for (const skill of skillSurface(plugin)) {
          if ("name" in skill) {
            current.set(`${scope}\0plugin:${plugin.name}\0${skill.name}`, skill.digest);
          }
        }
      }
      const changed: SkillContent[] = [];
      for (const skill of skills) {
        if (!skill.source.startsWith("plugin:")) continue;
        const key = `${skill.scope}\0${skill.source}\0${skill.name}`;
        const expected = pinned.skillDigests.get(key);
        if (expected === undefined || current.get(key) !== expected) changed.push(skill);
      }
      return changed;
    },

    close() {
      closeRuntimeWatchers();
    },
  };
}
