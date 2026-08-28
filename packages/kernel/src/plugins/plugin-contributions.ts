import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
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
import type { EnvironmentPluginRef, PluginSource, Scope } from "@clarvis/protocol";
import {
  pluginSkillRoots,
  pluginSkillScanRoots,
  readPluginManifestSource,
  resolvePluginManifest,
} from "./plugin-manifest.ts";
import { createAgentSkills, MAX_SKILL_ROOTS } from "@clarvis/skills";
import { pluginHookReviews } from "./hook-trust.ts";
import { readPluginInstallRecord } from "./plugin-install-record.ts";
import type { PluginInstallRecord } from "./plugin-install-record.ts";
import { ensurePluginDataDir } from "./plugin-runtime.ts";
import { kernelError } from "../core/errors.ts";

type PluginSelection = readonly EnvironmentPluginRef[];

/**
 * Turns installed + enabled plugins into the inputs a run consumes: skill roots,
 * settings fragments (hooks / mcpServers / capability blocks), and agent records.
 *
 * Installation and explicit enabling authorize ordinary plugin contributions.
 * Unmanaged hooks are the exception: each normalized definition is withheld
 * until it has been approved through the hook review service.
 *
 * Every method takes exact operator-enabled plugin references as an argument
 * (never reads settings itself) so it can be folded into the config store's
 * settings merge without recursing through `readSettings()`.
 */
export interface PluginContributions {
  /** Hash a fresh exact contribution set without changing the active snapshot. */
  snapshot(enabled: PluginSelection): Readonly<Record<string, string>>;
  /** Capture the exact contribution bytes selected for this kernel process. */
  pin(enabled: PluginSelection): Readonly<Record<string, string>>;
  /** Skill roots for enabled + loadable plugins. */
  skillRoots(enabled: PluginSelection): SkillRootInput[];
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
  /** Settings scopes for enabled plugins, with unapproved hooks removed. */
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
  ref: EnvironmentPluginRef;
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
}

/**
 * Build the {@link PluginContributions} loader over a global install root and an
 * optional workspace one.
 *
 * @param opts - Clarvis global state, optional home, and optional workspace root
 *   from which all exact `.agents/plugins` and `.clarvis/plugins` inventories are
 *   derived.
 * @returns a {@link PluginContributions} whose every method is passed the
 *   operator-enabled plugin names. Before an Environment is pinned, contribution
 *   files are discovered per call; afterwards the admitted manifests and agents
 *   remain immutable and any content drift is rejected until reconnect. Hook
 *   approvals remain live because they are independent authorization state.
 * @remarks Reads the filesystem synchronously and never consults settings itself,
 *   so it can be folded into the config store's settings merge without recursing
 *   through `readSettings()`. Repeated exact references are de-duplicated; the
 *   Environment resolver rejects two different installations sharing a runtime
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
}): PluginContributions {
  const logger = opts.logger ?? NOOP_LOGGER;
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
    plugin: EnvironmentPluginRef,
    phase: "manifest" | "dir" | "skills" | "agents" | "install_record",
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

  const refId = (ref: EnvironmentPluginRef): string => `${ref.scope}:${ref.source}:${ref.name}`;
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
  const dirFor = (ref: EnvironmentPluginRef): { dir: string } | undefined => {
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
  function loadableOf(ref: EnvironmentPluginRef): Loadable | undefined {
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

  const skillSurface = (plugin: Loadable): unknown => {
    const roots = pluginSkillScanRoots(
      plugin.dir,
      plugin.manifest.skills,
      plugin.manifestLocation,
      plugin.format,
    );
    if (roots.length === 0) return [];
    try {
      const skills = createAgentSkills({
        workspace: plugin.dir,
        roots,
        warningSink: () => undefined,
        logger,
      });
      return skills
        .listSkills()
        .map((info) => {
          const content = skills.loadSkill(info.name);
          if (content === undefined) return { name: info.name, unavailable: true };
          return {
            name: info.name,
            description: info.description,
            metadata: info.metadata,
            body: content.body,
            resources: content.resources
              .map((resource) => ({
                rel: resource.rel,
                content: skills.readResource(info.name, resource.rel),
              }))
              .sort((left, right) => left.rel.localeCompare(right.rel)),
          };
        })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      return [{ unavailable: true }];
    }
  };

  const contributionDigest = (plugin: Loadable): string =>
    digest({
      ref: plugin.ref,
      format: plugin.format,
      manifest_location: plugin.manifestLocation,
      manifest_source: plugin.manifestRaw,
      manifest: plugin.manifest,
      agents: plugin.agentFiles.files.map((file) => ({ name: file.name, content: file.content })),
      skills: skillSurface(plugin),
      install_record: plugin.installRecord,
      resolved_revision: plugin.resolvedRevision,
    });

  let pinned:
    | {
        selection: string;
        refs: readonly EnvironmentPluginRef[];
        loadables: readonly Loadable[];
        digests: Readonly<Record<string, string>>;
      }
    | undefined;

  const loadables = (enabled: PluginSelection): readonly Loadable[] =>
    pinned !== undefined && pinned.selection === selectionId(enabled)
      ? pinned.loadables
      : freshLoadables(enabled);

  const assertPinnedSnapshot = (enabled: PluginSelection): void => {
    if (pinned === undefined) return;
    if (pinned.selection !== selectionId(enabled)) {
      throw kernelError(
        "unavailable",
        "active plugin selection changed after the Environment snapshot was pinned; reconnect the kernel",
      );
    }
    const current = freshLoadables(pinned.refs);
    const currentDigests = Object.fromEntries(
      current.map((plugin) => [refId(plugin.ref), contributionDigest(plugin)]),
    );
    if (JSON.stringify(currentDigests) !== JSON.stringify(pinned.digests)) {
      throw kernelError(
        "unavailable",
        "selected plugin content changed after the Environment snapshot was pinned; reconnect the kernel",
      );
    }
  };

  const captureDigests = (loadable: readonly Loadable[]): Readonly<Record<string, string>> =>
    Object.freeze(
      Object.fromEntries(loadable.map((plugin) => [refId(plugin.ref), contributionDigest(plugin)])),
    );

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
      return captureDigests(freshLoadables(enabled));
    },

    pin(enabled) {
      const captured = freshLoadables(enabled);
      const digests = captureDigests(captured);
      pinned = {
        selection: selectionId(enabled),
        refs: [...enabled],
        loadables: captured,
        digests,
      };
      return digests;
    },

    skillRoots(enabled) {
      assertPinnedSnapshot(enabled);
      let budget = PLUGIN_SKILL_ROOT_BUDGET;
      return loadables(enabled).flatMap((p) => {
        const declared = skillsDirsOf(p);
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
            p.ref,
            "skills",
            refused ?? `none of ${String(declared.length)} declared skill roots is a directory`,
          );
          return [];
        }
        if (budget <= 0) {
          skipped(p.ref, "skills", "the run's plugin skill-root budget is spent");
          return [];
        }
        const admitted = present.slice(0, budget);
        if (admitted.length < present.length) {
          skipped(
            p.ref,
            "skills",
            `only ${String(admitted.length)} of ${String(present.length)} skill roots fit the ` +
              "run's plugin budget",
          );
        }
        budget -= admitted.length;
        const scanRoots = new Map(
          pluginSkillScanRoots(p.dir, p.manifest.skills, p.manifestLocation, p.format).map(
            (root) => [root.path, root],
          ),
        );
        return admitted.map((path) => ({
          ...scanRoots.get(path),
          path,
          scope: p.ref.scope === "workspace" ? ("workspace" as const) : ("user" as const),
          source: `plugin:${p.name}`,
        }));
      });
    },

    skillBootstraps(enabled) {
      assertPinnedSnapshot(enabled);
      return loadables(enabled).flatMap((p) =>
        p.manifest.bootstrapSkill === undefined
          ? []
          : [{ plugin: p.name, skill: p.manifest.bootstrapSkill, roots: skillsDirsOf(p) }],
      );
    },

    settingsScopes(enabled) {
      assertPinnedSnapshot(enabled);
      return loadables(enabled).map((p) => {
        const settings = pluginSettingsFragment(p.manifest);
        const namespacedServers = Object.fromEntries(
          resolvedMcpServers(p).map((server) => [server.effectiveName, server.declaration]),
        );
        const approvedHooks = pluginHookReviews(opts.globalDir, p.ref, p.manifest.hooks ?? [])
          .filter((review) => review.approved)
          .map((review) => review.definition);
        return {
          origin: "plugin" as const,
          settings: {
            ...settings,
            ...(p.manifest.mcpServers === undefined ? {} : { mcpServers: namespacedServers }),
            ...(approvedHooks.length > 0 ? { hooks: approvedHooks } : { hooks: undefined }),
          },
        };
      });
    },

    mcpServers(enabled) {
      assertPinnedSnapshot(enabled);
      return loadables(enabled).flatMap(resolvedMcpServers);
    },

    agents(enabled) {
      assertPinnedSnapshot(enabled);
      return loadables(enabled).flatMap((p) =>
        p.agentFiles.files.map((f) =>
          toAgentRecord(p.name, f.name.replace(/\.md$/i, ""), f.content),
        ),
      );
    },

    readAgent(enabled, qualifiedName) {
      assertPinnedSnapshot(enabled);
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
      assertPinnedSnapshot(enabled);
      const ref = enabled.find((candidate) => candidate.name === plugin);
      if (ref === undefined) {
        return { error: `plugin '${plugin}' is not enabled for this workspace` };
      }
      const l = loadables(enabled).find((candidate) => refId(candidate.ref) === refId(ref));
      if (l === undefined) return { error: `plugin '${plugin}' has no readable manifest` };
      const declared = l.manifest.capabilityExecutables?.[capability];
      if (declared === undefined) {
        return { error: `plugin '${plugin}' offers no capability executable '${capability}'` };
      }
      return { root: l.dir, declaration: declared };
    },

    skillPlansMode(enabled, plugin, skill) {
      assertPinnedSnapshot(enabled);
      const ref = enabled.find((candidate) => candidate.name === plugin);
      if (ref === undefined) return undefined;
      return loadables(enabled).find((candidate) => refId(candidate.ref) === refId(ref))?.manifest
        .capabilityRunPolicies?.plans?.skills[skill];
    },
  };
}
