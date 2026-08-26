import {
  agentFrontmatterSchema,
  type PluginAgentFile,
  type PluginManifest,
} from "@clarvis/loop/host";
import { statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { createAgentSkills } from "@clarvis/skills";
import {
  pluginSkillRoots,
  resolvePluginManifest,
  type ResolvedPluginManifest,
} from "./plugin-manifest.ts";
import type { PluginContributions, PluginService, PluginView } from "@clarvis/protocol";
import { kernelError } from "../core/errors.ts";
import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import { parseAgentFrontmatter } from "../config/frontmatter.ts";
import type { ProcessRunner } from "../ports/process-runner.ts";
import { createNodeProcessRunner } from "../adapters/process/node-process-runner.ts";
import type { KernelLifecycle } from "../application/lifecycle.ts";
import { createFilePluginRepository } from "../adapters/filesystem/plugin-repository.ts";
import { createGitPluginFetcher } from "../adapters/git/plugin-fetcher.ts";
import type {
  InstalledPlugin,
  StagedPlugin,
  PluginFetcher,
  PluginRepository,
} from "../ports/plugin-repository.ts";
import { pluginHookReviews, writeHookApproval } from "./hook-trust.ts";
import { effectivePluginMcpName } from "./plugin-contributions.ts";

/**
 * A source naming a place on this filesystem rather than a repository to clone.
 *
 * @remarks A marketplace may list a plugin that lives beside it on disk. Reading
 *   that listing is supported; installing from it is not, and saying so plainly
 *   is better than letting it fall through to the generic refusal.
 */
const LOCAL_PATH_RE = /^(?:[.~]{1,2}[/\\]|\/|[A-Za-z]:[/\\])/;

/**
 * Validates and returns a git clone URL safe for install.
 * Rejects empty values, flag-like strings, `ext::`, cleartext `http`/`git`
 * transports, and local filesystem paths.
 */
export function validateGitUrl(raw: string): string {
  const url = raw.trim();
  if (url.length === 0) throw new Error("a git URL is required");
  if (url.startsWith("-"))
    throw new Error(`refusing '${url}': a URL starting with '-' would be read by git as a flag`);
  if (/ext::/i.test(url))
    throw new Error(`refusing '${url}': git's ext:: transport runs an arbitrary command`);
  if (LOCAL_PATH_RE.test(url))
    throw new Error(
      `refusing '${url}': that names a local path, and Clarvis installs a plugin from git. ` +
        `Use https://, ssh (user@host:path), or file:// for a local checkout.`,
    );
  if (/^(?:http|git):\/\//i.test(url))
    throw new Error(
      `refusing '${url}': ${url.slice(0, url.indexOf(":"))}:// is unauthenticated cleartext, so ` +
        `anyone on the path can swap the code you are about to install. Use https:// or ssh.`,
    );
  const ssh = /^(?:ssh:\/\/)?[A-Za-z0-9._-]+@[A-Za-z0-9._-]+[:/][A-Za-z0-9._~/-]+$/;
  if (/^(?:https|file):\/\//i.test(url) || ssh.test(url)) return url;
  throw new Error(
    `refusing '${url}': install from https://, ssh (user@host:path), or file:// for a local checkout`,
  );
}

/**
 * Resolve one repository snapshot's manifest, following whatever it expresses in
 * another host's dialect; see {@link resolvePluginManifest}.
 */
function readManifest(plugin: StagedPlugin): ResolvedPluginManifest {
  if (plugin.manifestError !== undefined) {
    return { error: plugin.manifestError, notes: [] };
  }
  if (plugin.manifestRaw === undefined) {
    return { error: "no readable plugin.json", notes: [] };
  }
  return resolvePluginManifest(plugin.dir, plugin.manifestRaw, plugin.manifestLocation);
}

/** True when an agent file's leniently-parsed frontmatter satisfies
 * {@link agentFrontmatterSchema} (i.e. it would load as a usable agent). */
function parsesAsAgent(content: string): boolean {
  return agentFrontmatterSchema.safeParse(parseAgentFrontmatter(content, "lenient").data).success;
}

/** Split plugin agent files (by base name, `.md` stripped) into those that parse
 * as agents and those that do not, each list sorted. */
function partitionAgents(files: PluginAgentFile[]): { agents: string[]; broken_agents: string[] } {
  const agents: string[] = [];
  const broken_agents: string[] = [];
  for (const file of files) {
    const name = file.name.replace(/\.md$/i, "");
    (parsesAsAgent(file.content) ? agents : broken_agents).push(name);
  }
  agents.sort();
  broken_agents.sort();
  return { agents, broken_agents };
}

/** Human-readable list of the executable surface a manifest declares - one `$`
 * line per hook command and per MCP server (its stdio command+args, or its URL) -
 * as shown to the operator in the plugin detail view. */
function executablesOf(name: string, manifest: PluginManifest | undefined): string[] {
  const out: string[] = [];
  for (const h of manifest?.hooks ?? []) out.push(`$ ${h.command}`);
  for (const [server, s] of Object.entries(manifest?.mcpServers ?? {})) {
    const spec = s.type === "stdio" ? [s.command, ...(s.args ?? [])].join(" ") : s.url;
    out.push(`$ ${name}:${server}  ${spec}`);
  }
  for (const [capability, declaration] of Object.entries(manifest?.capabilityExecutables ?? {})) {
    const override = declaration.platforms?.[process.platform];
    const argv = [
      override?.command ?? declaration.command,
      ...(override?.args ?? declaration.args),
    ];
    out.push(`$ ${name}:${capability}  ${argv.join(" ")}`);
  }
  return out;
}

/** Capability executable declarations projected for provider selection. */
function capabilityExecutablesOf(
  manifest: PluginManifest | undefined,
): PluginContributions["capability_executables"] {
  return Object.entries(manifest?.capabilityExecutables ?? {})
    .map(([capability, declaration]) => {
      const override = declaration.platforms?.[process.platform];
      return {
        capability,
        command: override?.command ?? declaration.command,
        args: [...(override?.args ?? declaration.args)],
        platform_override: override !== undefined,
      };
    })
    .sort((a, b) => a.capability.localeCompare(b.capability));
}

/**
 * How many individually-named skill rejections one plugin may contribute before
 * the rest are reported as a count.
 */
const MAX_SKILL_REJECTION_NOTES = 3;

/** What a plugin's skill roots yielded: the servable names, and what they cost. */
interface PluginSkills {
  /** Skill names this host would actually serve, sorted. */
  names: string[];
  /** What was present and could not be read; see {@link skillNamesOf}. */
  notes: string[];
}

/**
 * Condense one catalog warning into a note an operator can act on.
 *
 * @param warning - the raw sink message, which carries an absolute path.
 * @param dir - the plugin's install directory, stripped from that path.
 * @returns the note, or `undefined` when the warning is not about one skill.
 */
function skillRejectionNote(warning: string, dir: string): string | undefined {
  const text = warning
    .replace(/^clarvis-skills:\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  const skipped = /^skipping (\S+?SKILL\.md): (.+)$/i.exec(text);
  if (skipped === null) return undefined;
  const [, path, reason] = skipped as unknown as [string, string, string];
  const name = basename(dirname(path));
  const relative = path.startsWith(dir) ? path.slice(dir.length).replace(/^[/\\]/, "") : path;
  return `skills: '${name}' was not read — ${reason.split(" at line ")[0] ?? reason} (${relative})`;
}

/**
 * Skill names this host would serve for one plugin, and what it could not read.
 *
 * @param dir - the plugin's install directory.
 * @param manifest - its validated manifest, absent when it did not parse.
 * @param manifestLocation - where that manifest was found, so a relative
 *   `skills` path resolves from the directory its author wrote it in.
 * @returns the names a run would see, sorted, and a note for each skill present
 *   but unreadable; both empty when the manifest is unusable, since a plugin
 *   that does not load contributes nothing.
 * @remarks
 * **The same scan the run performs, over the same roots.** The panel used to
 * list every child directory holding a `SKILL.md`, which is a different question
 * from the one the operator is asking: a skill whose frontmatter the catalog
 * rejects has such a directory and is never served. The two answers disagreed by
 * one skill on the first real plugin they were compared on — listed in the
 * panel, absent from the model's catalog, with nothing anywhere saying so.
 *
 * Reading it through {@link createAgentSkills} rather than re-deriving it is the
 * point: there is one definition of "a skill this host can serve", and a second
 * one here would be free to drift into promising things again.
 *
 * The catalog's warnings are **kept**, not discarded. Silencing them made a
 * plugin shipping twenty skills read as "18 skills" with nothing to say about
 * the other two, so the panel under-reported and the operator had no way to
 * learn why — the usual cause being a `description:` whose prose contains a
 * colon, which strict YAML rejects and quoting fixes in one edit.
 */
function skillNamesOf(
  dir: string,
  manifest: PluginManifest | undefined,
  manifestLocation?: string,
): PluginSkills {
  if (manifest === undefined) return { names: [], notes: [] };
  const roots = pluginSkillRoots(dir, manifest.skills, manifestLocation).roots.filter((root) => {
    try {
      return statSync(root).isDirectory();
    } catch {
      return false;
    }
  });
  if (roots.length === 0) return { names: [], notes: [] };
  const rejected: string[] = [];
  try {
    const names = createAgentSkills({
      roots: roots.map((path) => ({ path })),
      workspace: dir,
      warningSink: (message) => {
        const note = skillRejectionNote(message, dir);
        if (note !== undefined) rejected.push(note);
      },
    })
      .listSkills()
      .map((skill) => skill.name)
      .sort();
    const notes = rejected.slice(0, MAX_SKILL_REJECTION_NOTES);
    if (rejected.length > notes.length) {
      notes.push(
        `skills: ${String(rejected.length - notes.length)} further skill(s) could not be read`,
      );
    }
    return { names, notes };
  } catch {
    return { names: [], notes: [] };
  }
}

/** Assemble the protocol {@link PluginContributions} summary for one plugin:
 * partitioned agents, skill names, MCP server names, hook count, and the
 * executable-surface lines. */
function contributionsOf(
  name: string,
  skillNames: string[],
  manifest: PluginManifest | undefined,
  agentFiles: PluginAgentFile[],
): PluginContributions {
  return {
    ...partitionAgents(agentFiles),
    skills: skillNames,
    servers: Object.keys(manifest?.mcpServers ?? {})
      .map((server) => effectivePluginMcpName(name, server))
      .sort(),
    hooks: manifest?.hooks?.length ?? 0,
    capability_executables: capabilityExecutablesOf(manifest),
    ...(manifest?.capabilityRunPolicies !== undefined
      ? { capability_run_policies: manifest.capabilityRunPolicies }
      : {}),
    executables: executablesOf(name, manifest),
  };
}

/** Configuration for {@link createPluginService}. */
export interface PluginServiceOptions {
  /** Global config dir holding `plugins/` and per-definition hook approvals. */
  globalDir: string;
  /** Optional workspace config dir; when present its `plugins/` are also listed and
   * shadow global plugins of the same name. */
  workspaceConfigDir?: string;
  /** Returns the currently enabled plugin names from merged settings. */
  enabledPlugins: () => string[];
  /** Asynchronous process port; defaults to the Node/Bun child-process adapter. */
  processRunner?: ProcessRunner;
  /** Immutable environment inherited by Git with interactive prompts disabled. */
  environment: Readonly<Record<string, string | undefined>>;
  /** Kernel lifecycle that cancels active Git operations during shutdown. */
  lifecycle?: KernelLifecycle;
  /** Installed-plugin persistence override for policy-only tests or alternate hosts. */
  repository?: PluginRepository;
  /** Checkout/update override for policy-only tests or alternate hosts. */
  fetcher?: PluginFetcher;
  /** Where local process and Git failures are reported. */
  logger?: Logger;
}

/**
 * Protocol {@link PluginService}: install/update/uninstall from git, list
 * contributions, and manage exact hook-definition approvals.
 * Workspace plugins shadow global ones with the same name when both are present.
 */
export function createPluginService(opts: PluginServiceOptions): PluginService {
  const logger = opts.logger ?? NOOP_LOGGER;
  const processRunner = opts.processRunner ?? createNodeProcessRunner(logger);
  const repository =
    opts.repository ??
    createFilePluginRepository({
      globalDir: opts.globalDir,
      ...(opts.workspaceConfigDir !== undefined
        ? { workspaceConfigDir: opts.workspaceConfigDir }
        : {}),
    });
  const fetcher =
    opts.fetcher ??
    createGitPluginFetcher({
      globalDir: opts.globalDir,
      processRunner,
      environment: opts.environment,
      logger,
    });

  /** Build the full {@link PluginView} for one installed plugin: its enabled flag,
   * manifest-derived fields and contribution summary. A missing/invalid
   * manifest yields a view carrying `error` and no version/description. */
  function viewFor(plugin: InstalledPlugin): PluginView {
    const enabled = opts.enabledPlugins().includes(plugin.name);
    const { manifest, error, notes: manifestNotes, presentation } = readManifest(plugin);
    const skills = skillNamesOf(plugin.dir, manifest, plugin.manifestLocation);
    const notes = [...manifestNotes, ...skills.notes];
    return {
      name: plugin.name,
      scope: plugin.scope,
      dir: plugin.dir,
      enabled,
      shadows_global: plugin.shadowsGlobal,
      ...(manifest?.version !== undefined ? { version: manifest.version } : {}),
      ...(manifest?.description !== undefined ? { description: manifest.description } : {}),
      ...(presentation?.displayName !== undefined
        ? { display_name: presentation.displayName }
        : {}),
      ...(presentation?.shortDescription !== undefined
        ? { short_description: presentation.shortDescription }
        : {}),
      ...(plugin.source !== undefined ? { source: plugin.source } : {}),
      ...(plugin.revision !== undefined ? { revision: plugin.revision } : {}),
      ...(error ? { error } : {}),
      ...(notes.length > 0 ? { notes } : {}),
      contributions: contributionsOf(plugin.name, skills.names, manifest, plugin.agentFiles),
    };
  }

  /** List every installed plugin across scopes, name-sorted; when a name exists in
   * both, the workspace entry wins and is flagged `shadows_global`. */
  async function list(): Promise<PluginView[]> {
    return (await repository.list()).map(viewFor);
  }

  async function hookReviews(): ReturnType<PluginService["hooks"]> {
    const reviews: Awaited<ReturnType<PluginService["hooks"]>> = [];
    for (const plugin of await repository.list()) {
      const { manifest } = readManifest(plugin);
      if (manifest === undefined) continue;
      reviews.push(
        ...pluginHookReviews(opts.globalDir, plugin.name, manifest.hooks ?? []).map((review) => ({
          plugin: review.plugin,
          fingerprint: review.fingerprint,
          definition: review.definition,
          approved: review.approved,
        })),
      );
    }
    return reviews;
  }

  return {
    list,

    /**
     * Clone a plugin repo (optionally a subdirectory) into the global install root.
     *
     * @param url - git URL, validated by {@link validateGitUrl}.
     * @param subdir - optional path within the repo holding the plugin.
     * @returns the freshly installed plugin's {@link PluginView}.
     * @throws an `invalid_request` kernel error when the URL is rejected, the
     *   plugin has no valid manifest, the subdir escapes the checkout, or a plugin
     *   of that name is already installed. The staging checkout is always removed.
     */
    async install(url, subdir): Promise<PluginView> {
      const safe = validateGitUrl(url);
      const abort = new AbortController();
      const release = opts.lifecycle?.register({ close: () => abort.abort() });
      let prepared: Awaited<ReturnType<PluginFetcher["fetch"]>> | undefined;
      try {
        prepared = await fetcher.fetch(safe, subdir, abort.signal);
        const inspected = await repository.inspect(prepared.root);
        const { manifest, error } = readManifest(inspected);
        if (!manifest) throw kernelError("invalid_request", `refusing to install: ${error}`);
        return viewFor(await repository.install(prepared.root, manifest.name, prepared));
      } finally {
        await prepared?.dispose();
        release?.();
      }
    },

    /**
     * Update a git-installed plugin to its origin HEAD (`fetch` + hard `reset`).
     *
     * @param name - the installed plugin name.
     * @returns the updated {@link PluginView}.
     * @throws an `invalid_request` kernel error when the plugin was not installed
     *   from git (no `.git`), or a git error if the fetch/reset fails.
     */
    async update(name): Promise<PluginView> {
      const plugin = await repository.global(name);
      if (plugin === null) throw kernelError("not_found", `'${name}' is not installed globally`);
      const abort = new AbortController();
      const release = opts.lifecycle?.register({ close: () => abort.abort() });
      let prepared: Awaited<ReturnType<PluginFetcher["update"]>> = undefined;
      try {
        prepared = await fetcher.update(plugin, abort.signal);
        if (prepared !== undefined) {
          const inspected = await repository.inspect(prepared.root);
          const { manifest, error } = readManifest(inspected);
          if (manifest?.name !== name) {
            throw kernelError(
              "invalid_request",
              `refusing update for '${name}': ${error ?? `manifest names '${manifest?.name ?? "unknown"}'`}`,
            );
          }
          return viewFor(await repository.replace(prepared.root, name, prepared));
        }
      } finally {
        await prepared?.dispose();
        release?.();
      }
      const updated = await repository.global(name);
      if (updated === null) throw kernelError("not_found", `'${name}' is not installed globally`);
      return viewFor(updated);
    },

    /**
     * Remove a globally installed plugin's directory.
     *
     * @param name - the installed plugin name.
     * @throws a `not_found` kernel error when the plugin is not installed globally.
     */
    async uninstall(name): Promise<void> {
      if (!(await repository.remove(name))) {
        throw kernelError("not_found", `'${name}' is not installed globally`);
      }
    },

    hooks: hookReviews,
    async approveHook(plugin, fingerprint): Promise<void> {
      const review = (await hookReviews()).find(
        (entry) => entry.plugin === plugin && entry.fingerprint === fingerprint,
      );
      if (review === undefined) {
        throw kernelError(
          "not_found",
          `hook '${fingerprint}' is not declared by plugin '${plugin}'`,
        );
      }
      writeHookApproval(opts.globalDir, plugin, fingerprint, true);
    },
    async revokeHook(plugin, fingerprint): Promise<void> {
      writeHookApproval(opts.globalDir, plugin, fingerprint, false);
    },
  };
}
