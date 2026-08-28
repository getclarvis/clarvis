import {
  agentFrontmatterSchema,
  pluginNameField,
  type PluginAgentFile,
  type PluginManifest,
} from "@clarvis/loop/host";
import { statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { createAgentSkills } from "@clarvis/skills";
import {
  pluginSkillScanRoots,
  resolvePluginManifest,
  type ResolvedPluginManifest,
} from "./plugin-manifest.ts";
import type { PluginContributions, PluginRef, PluginService, PluginView } from "@clarvis/protocol";
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
import { pluginDataDir } from "./plugin-runtime.ts";

/**
 * A source naming a place on this filesystem rather than a repository to clone.
 *
 * @remarks A marketplace may list a plugin that lives beside it on disk. Reading
 *   that listing is supported; installing from it is not, and saying so plainly
 *   is better than letting it fall through to the generic refusal.
 */
const LOCAL_PATH_RE = /^(?:[.~]{1,2}[/\\]|\/|[A-Za-z]:[/\\])/;

/** Human-readable exact identity for diagnostics. */
function pluginRefLabel(ref: PluginRef): string {
  return `${ref.scope}/${ref.source}/${ref.name}`;
}

/** Validate an untrusted exact plugin reference before it reaches a filesystem path. */
function checkedPluginRef(value: unknown): PluginRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw kernelError("invalid_request", "plugin reference must be an object");
  }
  const ref = value as Record<string, unknown>;
  const name = pluginNameField.safeParse(ref.name);
  if (
    (ref.scope !== "global" && ref.scope !== "workspace") ||
    (ref.source !== "agents" && ref.source !== "clarvis") ||
    !name.success ||
    Object.keys(ref).some((key) => !["scope", "source", "name"].includes(key))
  ) {
    throw kernelError("invalid_request", "invalid exact plugin reference");
  }
  return { scope: ref.scope, source: ref.source, name: name.data };
}

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
function readManifest(plugin: StagedPlugin, dataDir?: string): ResolvedPluginManifest {
  if (plugin.manifestError !== undefined) {
    return { error: plugin.manifestError, notes: [] };
  }
  if (plugin.manifestRaw === undefined) {
    return { error: "no readable plugin.json", notes: [] };
  }
  return resolvePluginManifest(
    plugin.dir,
    plugin.manifestRaw,
    plugin.manifestLocation,
    plugin.name,
    dataDir === undefined ? undefined : { dataDir },
  );
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
  format?: ResolvedPluginManifest["format"],
): PluginSkills {
  if (manifest === undefined) return { names: [], notes: [] };
  const roots = pluginSkillScanRoots(dir, manifest.skills, manifestLocation, format).filter(
    (root) => {
      try {
        return statSync(root.path).isDirectory();
      } catch {
        return false;
      }
    },
  );
  if (roots.length === 0) return { names: [], notes: [] };
  const rejected: string[] = [];
  try {
    const names = createAgentSkills({
      roots,
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
  /** Home directory owning the global `.agents/plugins` inventory. */
  home?: string;
  /** Optional workspace root owning both workspace plugin inventories. */
  workspaceRoot?: string;
  /** Returns exact plugin installations active in the resolved Environment. */
  enabledPlugins: () => readonly PluginRef[];
  /** Kernel-owned exclusion boundary for a selected plugin's filesystem mutation. */
  withSelectedMutation?<T>(ref: PluginRef, mutation: () => Promise<T>): Promise<T>;
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
 */
export function createPluginService(opts: PluginServiceOptions): PluginService {
  const logger = opts.logger ?? NOOP_LOGGER;
  const processRunner = opts.processRunner ?? createNodeProcessRunner(logger);
  const repository =
    opts.repository ??
    createFilePluginRepository({
      globalDir: opts.globalDir,
      ...(opts.home === undefined ? {} : { home: opts.home }),
      ...(opts.workspaceRoot === undefined ? {} : { workspaceRoot: opts.workspaceRoot }),
    });
  const fetcher =
    opts.fetcher ??
    createGitPluginFetcher({
      globalDir: opts.globalDir,
      processRunner,
      environment: opts.environment,
      logger,
    });

  /** Runtime paths associated with one exact installed instance. */
  const installedDataDir = (plugin: InstalledPlugin): string =>
    pluginDataDir({
      globalDir: opts.globalDir,
      ...(opts.workspaceRoot === undefined ? {} : { workspaceRoot: opts.workspaceRoot }),
      ref: plugin.ref,
    });

  /** Build the full {@link PluginView} for one installed plugin: its enabled flag,
   * manifest-derived fields and contribution summary. A missing/invalid
   * manifest yields a view carrying `error` and no version/description. */
  function viewFor(plugin: InstalledPlugin, enabled: ReadonlySet<string>): PluginView {
    const {
      manifest,
      format,
      error,
      notes: manifestNotes,
      presentation,
    } = readManifest(plugin, installedDataDir(plugin));
    const skills = skillNamesOf(plugin.dir, manifest, plugin.manifestLocation, format);
    const notes = [...manifestNotes, ...skills.notes];
    return {
      name: plugin.name,
      scope: plugin.ref.scope,
      source: plugin.ref.source,
      dir: plugin.dir,
      enabled: enabled.has(pluginRefId(plugin.ref)),
      ...(manifest?.version !== undefined ? { version: manifest.version } : {}),
      ...(manifest?.description !== undefined ? { description: manifest.description } : {}),
      ...(presentation?.displayName !== undefined
        ? { display_name: presentation.displayName }
        : {}),
      ...(presentation?.shortDescription !== undefined
        ? { short_description: presentation.shortDescription }
        : {}),
      ...(plugin.origin !== undefined ? { install_source: plugin.origin } : {}),
      ...(plugin.revision !== undefined ? { revision: plugin.revision } : {}),
      ...(error ? { error } : {}),
      ...(notes.length > 0 ? { notes } : {}),
      contributions: contributionsOf(plugin.name, skills.names, manifest, plugin.agentFiles),
    };
  }

  /** Canonical exact identity used only for in-memory membership checks. */
  function pluginRefId(ref: PluginRef): string {
    return `${ref.scope}\0${ref.source}\0${ref.name}`;
  }

  /** Exact active plugin membership from the pinned Environment snapshot. */
  function enabledKeys(): ReadonlySet<string> {
    return new Set(opts.enabledPlugins().map(pluginRefId));
  }

  async function currentEnabledKeys(): Promise<ReadonlySet<string>> {
    return enabledKeys();
  }

  /** Apply the kernel's run/mutation exclusion only to an exact active installation. */
  async function mutateInstalled<T>(ref: PluginRef, mutation: () => Promise<T>): Promise<T> {
    if (!enabledKeys().has(pluginRefId(ref)) || opts.withSelectedMutation === undefined) {
      return mutation();
    }
    return opts.withSelectedMutation(ref, mutation);
  }

  /** List every installed plugin, retaining all same-name exact installations. */
  async function list(): Promise<PluginView[]> {
    const installed = await repository.list();
    const enabled = enabledKeys();
    return installed.map((plugin) => viewFor(plugin, enabled));
  }

  async function hookReviews(): ReturnType<PluginService["hooks"]> {
    const reviews: Awaited<ReturnType<PluginService["hooks"]>> = [];
    for (const plugin of await repository.list()) {
      const { manifest } = readManifest(plugin, installedDataDir(plugin));
      if (manifest === undefined) continue;
      reviews.push(
        ...pluginHookReviews(opts.globalDir, plugin.ref, manifest.hooks ?? []).map((review) => ({
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
     * @param target - global filesystem convention; defaults to the shared `.agents` inventory.
     * @returns the freshly installed plugin's {@link PluginView}.
     * @throws an `invalid_request` kernel error when the URL is rejected, the
     *   plugin has no valid manifest, the subdir escapes the checkout, or a plugin
     *   of that name is already installed. The staging checkout is always removed.
     */
    async install(url, subdir, target = { source: "agents" }): Promise<PluginView> {
      if (
        (target.source !== "agents" && target.source !== "clarvis") ||
        Object.keys(target).some((key) => key !== "source")
      ) {
        throw kernelError("invalid_request", "invalid plugin install target");
      }
      const safe = validateGitUrl(url);
      const abort = new AbortController();
      const release = opts.lifecycle?.register({ close: () => abort.abort() });
      let prepared: Awaited<ReturnType<PluginFetcher["fetch"]>> | undefined;
      try {
        prepared = await fetcher.fetch(safe, subdir, abort.signal);
        const inspected = await repository.inspect(prepared.root);
        const { manifest, error } = readManifest(inspected);
        if (!manifest) throw kernelError("invalid_request", `refusing to install: ${error}`);
        return viewFor(
          await repository.install(prepared.root, manifest.name, target.source, prepared),
          await currentEnabledKeys(),
        );
      } finally {
        await prepared?.dispose();
        release?.();
      }
    },

    /**
     * Update a git-installed plugin to its origin HEAD (`fetch` + hard `reset`).
     *
     * @param ref - the exact global installation to update.
     * @returns the updated {@link PluginView}.
     * @throws an `invalid_request` kernel error when the plugin was not installed
     *   from git (no `.git`), or a git error if the fetch/reset fails.
     * @throws a `conflict` kernel error when the selected plugin overlaps an active run.
     */
    async update(ref): Promise<PluginView> {
      ref = checkedPluginRef(ref);
      if (ref.scope !== "global") {
        throw kernelError("invalid_request", "managed plugin updates are global-only");
      }
      const plugin = await repository.get(ref);
      if (plugin === null) {
        throw kernelError("not_found", `'${pluginRefLabel(ref)}' is not installed`);
      }
      return mutateInstalled(ref, async () => {
        const abort = new AbortController();
        const release = opts.lifecycle?.register({ close: () => abort.abort() });
        let prepared: Awaited<ReturnType<PluginFetcher["update"]>> = undefined;
        try {
          prepared = await fetcher.update(plugin, abort.signal);
          if (prepared !== undefined) {
            const replacement = prepared;
            const inspected = await repository.inspect(replacement.root);
            const { manifest, error } = readManifest(inspected);
            if (manifest?.name !== ref.name) {
              throw kernelError(
                "invalid_request",
                `refusing update for '${pluginRefLabel(ref)}': ${error ?? `manifest names '${manifest?.name ?? "unknown"}'`}`,
              );
            }
            const enabled = await currentEnabledKeys();
            return viewFor(await repository.replace(replacement.root, ref, replacement), enabled);
          }
        } finally {
          await prepared?.dispose();
          release?.();
        }
        const updated = await repository.get(ref);
        if (updated === null) {
          throw kernelError("not_found", `'${pluginRefLabel(ref)}' is not installed`);
        }
        return viewFor(updated, await currentEnabledKeys());
      });
    },

    /**
     * Remove a globally installed plugin's directory.
     *
     * @param ref - the exact global installation to remove.
     * @throws a `not_found` kernel error when the plugin is not installed globally.
     * @throws a `conflict` kernel error when the selected plugin overlaps an active run.
     */
    async uninstall(ref): Promise<void> {
      ref = checkedPluginRef(ref);
      await mutateInstalled(ref, async () => {
        if (!(await repository.remove(ref))) {
          throw kernelError("not_found", `'${pluginRefLabel(ref)}' is not installed`);
        }
      });
    },

    hooks: hookReviews,
    async approveHook(plugin, fingerprint): Promise<void> {
      plugin = checkedPluginRef(plugin);
      const review = (await hookReviews()).find(
        (entry) =>
          pluginRefId(entry.plugin) === pluginRefId(plugin) && entry.fingerprint === fingerprint,
      );
      if (review === undefined) {
        throw kernelError(
          "not_found",
          `hook '${fingerprint}' is not declared by plugin '${pluginRefLabel(plugin)}'`,
        );
      }
      writeHookApproval(opts.globalDir, plugin, fingerprint, true);
    },
    async revokeHook(plugin, fingerprint): Promise<void> {
      plugin = checkedPluginRef(plugin);
      writeHookApproval(opts.globalDir, plugin, fingerprint, false);
    },
  };
}
