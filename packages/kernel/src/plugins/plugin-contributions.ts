import { spawnSync } from "node:child_process";
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
import { globalPaths, withoutGitRepositoryEnvironment } from "@clarvis/paths";
import type { AgentRecord } from "../config/config-store.ts";
import {
  pluginSkillRoots,
  readPluginManifestSource,
  resolvePluginManifest,
} from "./plugin-manifest.ts";
import { MAX_SKILL_ROOTS } from "@clarvis/skills";
import { pluginHookReviews } from "./hook-trust.ts";
import { readPluginInstallRecord } from "./plugin-install-record.ts";
import type { PluginInstallRecord } from "./plugin-install-record.ts";

/**
 * Turns installed + enabled plugins into the inputs a run consumes: skill roots,
 * settings fragments (hooks / mcpServers / capability blocks), and agent records.
 *
 * Installation and explicit enabling authorize ordinary plugin contributions.
 * Unmanaged hooks are the exception: each normalized definition is withheld
 * until it has been approved through the hook review service.
 *
 * Every method takes the operator-enabled plugin names as an argument (never reads
 * settings itself) so it can be folded into the config store's settings merge
 * without recursing through `readSettings()`. A workspace plugin shadows a global
 * one of the same name.
 */
export interface PluginContributions {
  /** Skill roots for enabled + loadable plugins. */
  skillRoots(enabled: readonly string[]): SkillRootInput[];
  /**
   * Bootstrap skills declared by enabled + loadable plugins, in `enabled` order.
   *
   * @remarks A bootstrap is a declaration about a file the plugin already ships.
   *   Unlike {@link PluginContributions.skillRoots} this does
   *   not check that `skills/` exists — a plugin with no skills root contributes no
   *   skills either, so the name cannot resolve to it and the loop's own resolution
   *   reports the miss.
   */
  skillBootstraps(enabled: readonly string[]): PluginBootstrapSkill[];
  /** Settings scopes for enabled plugins, with unapproved hooks removed. */
  settingsScopes(enabled: readonly string[]): SettingsScope[];
  /** Namespaced MCP declarations plus the plugin provenance used by provider identity. */
  mcpServers(enabled: readonly string[]): ResolvedPluginMcpContribution[];
  /** Agent records (`<plugin>:<agent>`, scope `plugin`) for enabled plugins. */
  agents(enabled: readonly string[]): AgentRecord[];
  /** Resolve one `<plugin>:<agent>` record, or null if the plugin is not enabled. */
  readAgent(enabled: readonly string[], qualifiedName: string): AgentRecord | null;
  /** Locate one executable an installed + enabled + selected plugin offers. */
  locateCapabilityExecutable(
    enabled: readonly string[],
    capability: string,
    plugin: string,
  ): { root: string; declaration: CapabilityExecutableDeclaration } | { error: string };
  /** Trusted Plans mode declared for one skill packaged by the selected plugin. */
  skillPlansMode(
    enabled: readonly string[],
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
  /** The plugin name (as enabled by the operator). */
  name: string;
  /** Absolute install directory the plugin resolved to. */
  dir: string;
  /** Which install root it resolved from; see {@link InstallScope}. */
  installScope: InstallScope;
  /** The parsed `plugin.json` manifest. */
  manifest: PluginManifest;
  /** Where that manifest was found, relative to {@link Loadable.dir}. */
  manifestLocation: string;
  /** Agent snapshot admitted atomically with the manifest and install record. */
  agentFiles: ReturnType<typeof readPluginAgentFiles> & { ok: true };
  /** Install provenance read once during admission, so runtime identity cannot race that check. */
  installRecord: PluginInstallRecord;
}

/**
 * Which install root a plugin was found under.
 *
 * @remarks The plugin domain's own axis (`global` vs `workspace`), kept separate
 * from the skills domain's `user`/`workspace` scope and translated only where the
 * two meet, in {@link PluginContributions.skillRoots}.
 */
type InstallScope = "global" | "workspace";

/**
 * Build the {@link PluginContributions} loader over a global install root and an
 * optional workspace one.
 *
 * @param opts - install locations: `globalDir` holds `plugins/` and hook trust;
 *   `workspaceConfigDir`, when given, adds a workspace
 *   `plugins/` root that is searched first, so a workspace plugin shadows a global
 *   one of the same name.
 * @returns a {@link PluginContributions} whose every method is passed the
 *   operator-enabled plugin names, reading manifests, agent files, and hook
 *   approvals fresh on each call.
 * @remarks Reads the filesystem synchronously and never consults settings itself,
 *   so it can be folded into the config store's settings merge without recursing
 *   through `readSettings()`. Duplicate names in `enabled` are de-duplicated.
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
  workspaceConfigDir?: string;
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
    plugin: string,
    scope: InstallScope | "none",
    phase: "manifest" | "dir" | "skills" | "agents" | "install_record",
    cause: string,
  ): void => {
    logger.warn(
      { event: "kernel.plugin.skipped", plugin, scope, phase, cause },
      "an enabled plugin contributes nothing this run; its agents, hooks, MCP servers and skills are all absent",
    );
  };
  const installRoots: { path: string; scope: InstallScope }[] = [
    ...(opts.workspaceConfigDir !== undefined
      ? [{ path: join(opts.workspaceConfigDir, "plugins"), scope: "workspace" as const }]
      : []),
    { path: globalPaths(opts.globalDir).pluginsDir, scope: "global" as const },
  ];

  /** First install root (workspace before global) that holds a directory named
   * `name`, with the scope it was found under, or undefined when the plugin is
   * installed nowhere. */
  const dirFor = (name: string): { dir: string; installScope: InstallScope } | undefined => {
    for (const root of installRoots) {
      const dir = join(root.path, name);
      try {
        if (statSync(dir).isDirectory()) return { dir, installScope: root.scope };
      } catch {
        /* not here — try the next root */
      }
    }
    return undefined;
  };

  /** The directories a plugin's skills are scanned from, as its manifest asks.
   * The single place that encodes a plugin's skills layout; both contributions
   * below go through it, and so does the panel that lists what it offers. */
  const skillsDirsOf = (p: Loadable): string[] =>
    pluginSkillRoots(p.dir, p.manifest.skills, p.manifestLocation).roots;

  /** Resolve the installed snapshot without treating the manifest version as source identity. */
  const revisionOf = (plugin: Loadable): string | undefined => {
    if (plugin.installRecord.revision !== undefined) return plugin.installRecord.revision;
    /* Unmanaged local plugins have no install record; Git is the fallback. */
    const result = spawnSync("git", ["-C", plugin.dir, "rev-parse", "HEAD"], {
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
    const resolvedRevision = revisionOf(plugin);
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
  function loadableOf(name: string): Loadable | undefined {
    const found = dirFor(name);
    if (found === undefined) {
      skipped(name, "none", "dir", "no install root holds a directory of this name");
      return undefined;
    }
    const { dir, installScope } = found;
    const source = readPluginManifestSource(dir);
    if (!("raw" in source)) {
      skipped(name, installScope, "manifest", source.error);
      return undefined;
    }
    const resolved = resolvePluginManifest(dir, source.raw, source.location, name);
    const { manifest } = resolved;
    if (manifest === undefined) {
      skipped(name, installScope, "manifest", resolved.error ?? "manifest did not resolve");
      return undefined;
    }
    const agents = readPluginAgentFiles(join(dir, "agents"));
    if (!agents.ok) {
      skipped(name, installScope, "agents", agents.error);
      return undefined;
    }
    const installed = readPluginInstallRecord(dir);
    if (!installed.ok) {
      skipped(name, installScope, "install_record", installed.error);
      return undefined;
    }
    return {
      name,
      dir,
      installScope,
      manifest,
      manifestLocation: source.location,
      agentFiles: agents,
      installRecord: installed.record,
    };
  }

  /** Map the enabled names to their {@link Loadable}s in order, de-duplicating
   * repeated names and dropping any that fail manifest resolution. */
  const loadables = (enabled: readonly string[]): Loadable[] => {
    const out: Loadable[] = [];
    const seen = new Set<string>();
    for (const name of enabled) {
      if (seen.has(name)) continue;
      seen.add(name);
      const l = loadableOf(name);
      if (l !== undefined) out.push(l);
    }
    return out;
  };

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
    skillRoots(enabled) {
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
            p.name,
            p.installScope,
            "skills",
            refused ?? `none of ${String(declared.length)} declared skill roots is a directory`,
          );
          return [];
        }
        if (budget <= 0) {
          skipped(p.name, p.installScope, "skills", "the run's plugin skill-root budget is spent");
          return [];
        }
        const admitted = present.slice(0, budget);
        if (admitted.length < present.length) {
          skipped(
            p.name,
            p.installScope,
            "skills",
            `only ${String(admitted.length)} of ${String(present.length)} skill roots fit the ` +
              "run's plugin budget",
          );
        }
        budget -= admitted.length;
        return admitted.map((path) => ({
          path,
          scope: p.installScope === "workspace" ? ("workspace" as const) : ("user" as const),
          source: `plugin:${p.name}`,
        }));
      });
    },

    skillBootstraps(enabled) {
      return loadables(enabled).flatMap((p) =>
        p.manifest.bootstrapSkill === undefined
          ? []
          : [{ plugin: p.name, skill: p.manifest.bootstrapSkill, roots: skillsDirsOf(p) }],
      );
    },

    settingsScopes(enabled) {
      return loadables(enabled).map((p) => {
        const settings = pluginSettingsFragment(p.manifest);
        const namespacedServers = Object.fromEntries(
          resolvedMcpServers(p).map((server) => [server.effectiveName, server.declaration]),
        );
        const approvedHooks = pluginHookReviews(opts.globalDir, p.name, p.manifest.hooks ?? [])
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
      return loadables(enabled).flatMap(resolvedMcpServers);
    },

    agents(enabled) {
      return loadables(enabled).flatMap((p) =>
        p.agentFiles.files.map((f) =>
          toAgentRecord(p.name, f.name.replace(/\.md$/i, ""), f.content),
        ),
      );
    },

    readAgent(enabled, qualifiedName) {
      const sep = qualifiedName.indexOf(":");
      if (sep <= 0) return null;
      const plugin = qualifiedName.slice(0, sep);
      const agentName = qualifiedName.slice(sep + 1);
      if (!enabled.includes(plugin)) return null;
      const l = loadableOf(plugin);
      if (l === undefined) return null;
      const expected = `${agentName}.md`;
      const file = l.agentFiles.files.find((candidate) => candidate.name === expected);
      return file === undefined ? null : toAgentRecord(plugin, agentName, file.content);
    },

    locateCapabilityExecutable(enabled, capability, plugin) {
      if (!enabled.includes(plugin)) {
        return { error: `plugin '${plugin}' is not enabled for this workspace` };
      }
      if (dirFor(plugin) === undefined) {
        return { error: `plugin '${plugin}' is not installed` };
      }
      const l = loadableOf(plugin);
      if (l === undefined) return { error: `plugin '${plugin}' has no readable manifest` };
      const declared = l.manifest.capabilityExecutables?.[capability];
      if (declared === undefined) {
        return { error: `plugin '${plugin}' offers no capability executable '${capability}'` };
      }
      return { root: l.dir, declaration: declared };
    },

    skillPlansMode(enabled, plugin, skill) {
      if (!enabled.includes(plugin)) return undefined;
      return loadableOf(plugin)?.manifest.capabilityRunPolicies?.plans?.skills[skill];
    },
  };
}
