import { constants, closeSync, fstatSync, openSync, opendirSync, readSync, rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  acquireLocalLeaseSync,
  globalPaths,
  workspacePaths,
  workspaceStatePaths,
  writeFileAtomicSync,
} from "@clarvis/paths";
import { clarvisSkillRoots, createAgentSkills, type SkillRootInput } from "@clarvis/skills";
import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import type {
  EnvironmentApplyResult,
  EnvironmentDefinition,
  EnvironmentDefinitionInput,
  EnvironmentDefinitionView,
  EnvironmentDelta,
  EnvironmentIssue,
  EnvironmentPluginRef,
  EnvironmentPreview,
  EnvironmentRef,
  EnvironmentRunRef,
  EnvironmentSelectionOrigin,
  EnvironmentSelectionScope,
  EnvironmentService,
  EnvironmentSkillRef,
  ResolvedEnvironment,
  ResolvedEnvironmentPlugin,
  ResolvedEnvironmentSkill,
  Scope,
  WorkspaceTrustVerdict,
} from "@clarvis/protocol";
import { kernelError } from "../core/errors.ts";
import { listInstalledPlugins } from "../adapters/filesystem/plugin-repository.ts";
import type { InstalledPlugin } from "../ports/plugin-repository.ts";
import type { PluginContributions } from "../plugins/plugin-contributions.ts";
import { pluginHookReviews } from "../plugins/hook-trust.ts";
import { pluginSkillScanRoots, resolvePluginManifest } from "../plugins/plugin-manifest.ts";
import { pluginDataDir } from "../plugins/plugin-runtime.ts";

const BUILTIN_REF: EnvironmentRef = { scope: "builtin", name: "default" };
const MAX_ENVIRONMENT_BYTES = 1024 * 1024;
const MAX_ENVIRONMENTS_PER_SCOPE = 128;
const MAX_ENVIRONMENT_DIRECTORY_ENTRIES = 256;
const PREVIEW_TTL_MS = 5 * 60_000;
const MAX_PREVIEWS = 32;
const ENVIRONMENT_LOCK_STALE_MS = 30_000;
const NAME_RE = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;

const nameSchema = z.string().regex(NAME_RE, "must be a safe Environment identifier");
const pluginRefSchema = z
  .object({
    scope: z.enum(["global", "workspace"]),
    source: z.enum(["agents", "clarvis"]),
    name: nameSchema,
  })
  .strict();
const skillRefSchema = z
  .object({
    scope: z.enum(["user", "workspace"]),
    source: z.enum(["agents", "clarvis"]),
    name: nameSchema,
  })
  .strict();
const environmentRefSchema = z
  .object({ scope: z.enum(["builtin", "global", "workspace"]), name: nameSchema })
  .strict();
const authoredRefSchema = z
  .object({ scope: z.enum(["global", "workspace"]), name: nameSchema })
  .strict();
const definitionSchema = z
  .object({
    schema_version: z.literal(1),
    description: z.string().max(4096).optional(),
    plugins: z.array(pluginRefSchema).max(64),
    skills: z.array(skillRefSchema).max(256),
  })
  .strict()
  .superRefine((definition, context) => {
    const pluginNames = new Set<string>();
    for (const [index, plugin] of definition.plugins.entries()) {
      if (pluginNames.has(plugin.name)) {
        context.addIssue({
          code: "custom",
          path: ["plugins", index, "name"],
          message: `plugin name '${plugin.name}' is already selected in another scope`,
        });
      }
      pluginNames.add(plugin.name);
    }
    const skillNames = new Set<string>();
    for (const [index, skill] of definition.skills.entries()) {
      if (skillNames.has(skill.name)) {
        context.addIssue({
          code: "custom",
          path: ["skills", index, "name"],
          message: `skill name '${skill.name}' is already selected from another root`,
        });
      }
      skillNames.add(skill.name);
    }
  });
const definitionInputSchema = z
  .object({ ref: authoredRefSchema, definition: definitionSchema })
  .strict();
const definitionUpdateInputSchema = definitionInputSchema
  .extend({ expected_revision: z.string().regex(/^sha256:[0-9a-f]{64}$/) })
  .strict();
const selectOptionsSchema = z
  .object({
    selection_scope: z.enum(["global", "workspace"]),
    preview_token: z.uuid(),
    approve_workspace: z.boolean().optional(),
  })
  .strict();
const previewOptionsSchema = z
  .object({ selection_scope: z.enum(["global", "workspace"]) })
  .strict();
const clearOptionsSchema = z.object({ preview_token: z.uuid() }).strict();
const selectionSchema = z
  .object({
    schema_version: z.literal(1),
    environment: environmentRefSchema,
  })
  .strict();

interface ReadDocument {
  raw?: string;
  revision?: string;
  missing?: boolean;
  error?: string;
}

interface SelectedEnvironment {
  ref: EnvironmentRef;
  origin: EnvironmentSelectionOrigin;
  error?: string;
}

interface StandaloneInventoryEntry {
  ref: EnvironmentSkillRef;
  root: SkillRootInput;
  rootOrder: number;
  description: string;
  digest: string;
}

interface PluginInventoryEntry {
  view: ResolvedEnvironmentPlugin;
  digest: string;
}

interface DefinitionCatalog {
  names?: string[];
  entries?: number;
  error?: string;
  resourceExhausted?: true;
}

interface PreviewEntry {
  mutation:
    | {
        kind: "select";
        ref: EnvironmentRef;
        scope: EnvironmentSelectionScope;
        selectionRevision: string | null;
      }
    | {
        kind: "clear";
        scope: EnvironmentSelectionScope;
        selectionRevisions: Record<EnvironmentSelectionScope, string | null>;
      };
  fingerprint: string;
  expiresAt: number;
}

/** Runtime hooks supplied after config composition has been constructed. */
export interface EnvironmentRuntimeBinding {
  readWorkspaceTrust(): WorkspaceTrustVerdict;
  approveWorkspace(): void;
}

/** File-backed Environment manager options. */
export interface EnvironmentManagerOptions {
  globalDir: string;
  workspaceRoot: string;
  pluginContributions: PluginContributions;
  /** Home directory owning user-scoped `.agents/skills` and `.agents/plugins`. */
  home?: string;
  cliSelection?: string;
  logger?: Logger;
}

/** Stable qualified string identity used in traces, sessions and diagnostics. */
export function environmentId(ref: EnvironmentRef): string {
  return `${ref.scope}:${ref.name}`;
}

/** Canonical key for one exact plugin installation. */
function pluginRefId(ref: EnvironmentPluginRef): string {
  return `${ref.scope}:${ref.source}:${ref.name}`;
}

/** Filesystem-shaped plugin identity for operator-facing diagnostics. */
function pluginRefLabel(ref: EnvironmentPluginRef): string {
  return `${ref.scope}/${ref.source}/${ref.name}`;
}

/** Parse an untrusted protocol value or raise the public request error. */
function parsedInput<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw kernelError("invalid_request", `${label}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** Validate a reference and reject nonexistent builtin names. */
function environmentRef(value: unknown): EnvironmentRef {
  const ref = parsedInput(environmentRefSchema, value, "invalid Environment reference");
  if (ref.scope === "builtin" && ref.name !== BUILTIN_REF.name) {
    throw kernelError("not_found", `unknown builtin Environment '${ref.name}'`);
  }
  return ref;
}

/** Exact-byte revision used by Environment definition CAS. */
function documentRevision(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Compare two qualified references without relying on object identity. */
function sameRef(left: EnvironmentRef, right: EnvironmentRef): boolean {
  return left.scope === right.scope && left.name === right.name;
}

/** Canonicalize JSON-like data for stable hashing. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]),
  );
}

/** SHA-256 over a stable JSON projection. */
function fingerprintOf(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")}`;
}

/** Read one regular file with a hard byte bound and no final symlink traversal. */
function readBounded(path: string, label: string): ReadDocument {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { error: `${label} is not a regular file` };
    if (stat.size > MAX_ENVIRONMENT_BYTES) {
      return {
        error: `${label} exceeds the ${String(MAX_ENVIRONMENT_BYTES)}-byte resource limit`,
      };
    }
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    if (offset !== bytes.length) return { error: `${label} changed while it was read` };
    const raw = bytes.toString("utf8");
    return { raw, revision: documentRevision(bytes) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { missing: true };
    return { error: `${label} could not be read: ${(error as Error).message}` };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Parse a definition and enforce the stricter global-definition scope rule. */
function parseDefinition(
  ref: EnvironmentRef,
  raw: string,
): { definition?: EnvironmentDefinition; error?: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return { error: `invalid JSON: ${(error as Error).message}` };
  }
  const parsed = definitionSchema.safeParse(json);
  if (!parsed.success) return { error: z.prettifyError(parsed.error) };
  const definition = parsed.data;
  if (
    ref.scope === "global" &&
    (definition.plugins.some((plugin) => plugin.scope !== "global") ||
      definition.skills.some((skill) => skill.scope !== "user"))
  ) {
    return {
      error: "a global Environment may reference only global plugins and user-scoped skills",
    };
  }
  return { definition };
}

/** List bounded JSON definition names without following entries as directories. */
function definitionNames(dir: string): DefinitionCatalog {
  let opened: ReturnType<typeof opendirSync>;
  try {
    opened = opendirSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { names: [], entries: 0 };
    return { error: `Environment directory could not be opened: ${(error as Error).message}` };
  }
  const names: string[] = [];
  let entries = 0;
  try {
    for (;;) {
      const entry = opened.readSync();
      if (entry === null) break;
      entries += 1;
      if (entries > MAX_ENVIRONMENT_DIRECTORY_ENTRIES) {
        return {
          error:
            `Environment directory exceeds the ` +
            `${String(MAX_ENVIRONMENT_DIRECTORY_ENTRIES)}-entry resource limit`,
          resourceExhausted: true,
        };
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const name = entry.name.slice(0, -5);
      if (NAME_RE.test(name)) names.push(name);
    }
  } finally {
    opened.closeSync();
  }
  if (names.length > MAX_ENVIRONMENTS_PER_SCOPE) {
    return {
      error:
        `Environment directory contains more than ` +
        `${String(MAX_ENVIRONMENTS_PER_SCOPE)} definitions`,
      resourceExhausted: true,
    };
  }
  return { names: names.sort((left, right) => left.localeCompare(right)), entries };
}

/** Set difference preserving deterministic sorted output. */
function stringDifference(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return [...new Set(left)].filter((value) => !rightSet.has(value)).sort();
}

/** Exact Environment delta between two resolved snapshots. */
function deltaOf(current: ResolvedEnvironment, target: ResolvedEnvironment): EnvironmentDelta {
  const pluginKey = (plugin: ResolvedEnvironmentPlugin): string => pluginRefId(plugin.ref);
  const currentPlugins = current.plugins.filter((plugin) => plugin.active);
  const targetPlugins = target.plugins.filter((plugin) => plugin.active);
  const currentPluginKeys = new Set(currentPlugins.map(pluginKey));
  const targetPluginKeys = new Set(targetPlugins.map(pluginKey));
  const currentSkills = [
    ...current.standalone_skills
      .filter((skill) => skill.active)
      .map((skill) =>
        environmentId({
          scope: skill.ref.scope === "user" ? "global" : "workspace",
          name: `${skill.ref.source}:${skill.ref.name}`,
        }),
      ),
    ...currentPlugins.flatMap((plugin) =>
      plugin.skills.map((skill) => `plugin:${pluginRefId(plugin.ref)}:${skill}`),
    ),
  ];
  const targetSkills = [
    ...target.standalone_skills
      .filter((skill) => skill.active)
      .map((skill) =>
        environmentId({
          scope: skill.ref.scope === "user" ? "global" : "workspace",
          name: `${skill.ref.source}:${skill.ref.name}`,
        }),
      ),
    ...targetPlugins.flatMap((plugin) =>
      plugin.skills.map((skill) => `plugin:${pluginRefId(plugin.ref)}:${skill}`),
    ),
  ];
  return {
    plugins_entering: targetPlugins
      .filter((plugin) => !currentPluginKeys.has(pluginKey(plugin)))
      .map((plugin) => plugin.ref),
    plugins_leaving: currentPlugins
      .filter((plugin) => !targetPluginKeys.has(pluginKey(plugin)))
      .map((plugin) => plugin.ref),
    skills_entering: stringDifference(targetSkills, currentSkills),
    skills_leaving: stringDifference(currentSkills, targetSkills),
    mcp_servers_entering: stringDifference(
      targetPlugins.flatMap((plugin) => plugin.mcp_servers),
      currentPlugins.flatMap((plugin) => plugin.mcp_servers),
    ),
    mcp_servers_leaving: stringDifference(
      currentPlugins.flatMap((plugin) => plugin.mcp_servers),
      targetPlugins.flatMap((plugin) => plugin.mcp_servers),
    ),
    hooks_entering: targetPlugins
      .filter((plugin) => !currentPluginKeys.has(pluginKey(plugin)) && plugin.hooks.total > 0)
      .map((plugin) => ({ plugin: plugin.ref, ...plugin.hooks })),
    hooks_leaving: currentPlugins
      .filter((plugin) => !targetPluginKeys.has(pluginKey(plugin)) && plugin.hooks.total > 0)
      .map((plugin) => ({ plugin: plugin.ref, ...plugin.hooks })),
  };
}

/**
 * Create the file-backed Environment resolver and protocol service.
 *
 * The first runtime resolution is pinned for this manager's lifetime. Definition
 * and selection mutations remain visible to management reads and return
 * `reconnect_required`, but cannot mutate an execution already using this kernel.
 */
export function createEnvironmentManager(options: EnvironmentManagerOptions): {
  service: EnvironmentService;
  bindRuntime(binding: EnvironmentRuntimeBinding): void;
  resolveActive(
    enabledPlugins: readonly EnvironmentPluginRef[],
    workspaceTrust: WorkspaceTrustVerdict,
  ): ResolvedEnvironment;
  activePlugins(): EnvironmentPluginRef[];
  skillRoots(): SkillRootInput[];
  runRef(): EnvironmentRunRef;
  workspaceTrustSurface(): unknown;
} {
  const logger = options.logger ?? NOOP_LOGGER;
  const global = globalPaths(options.globalDir);
  const workspace = workspacePaths(options.workspaceRoot);
  const workspaceState = workspaceStatePaths(options.workspaceRoot, {
    env: { CLARVIS_HOME: options.globalDir },
  });
  const standardRoots = clarvisSkillRoots({
    workspace: options.workspaceRoot,
    ...(options.home === undefined ? {} : { home: options.home }),
    env: { CLARVIS_HOME: options.globalDir },
  });
  const previews = new Map<string, PreviewEntry>();
  let runtime: EnvironmentRuntimeBinding | undefined;
  let pinned: ResolvedEnvironment | undefined;
  let pinnedEnabled: readonly EnvironmentPluginRef[] = [];
  let pinnedTrust: WorkspaceTrustVerdict = { state: "inert" };

  const definitionDir = (scope: Scope): string =>
    scope === "global" ? global.environmentsDir : workspace.environmentsDir;
  const definitionPath = (ref: EnvironmentRef): string | undefined =>
    ref.scope === "builtin" ? undefined : join(definitionDir(ref.scope), `${ref.name}.json`);
  const selectionPath = (scope: EnvironmentSelectionScope): string =>
    scope === "global" ? global.environmentSelectionFile : workspaceState.environmentSelectionFile;

  /** Run one synchronous filesystem transaction under a crash-recoverable local lease. */
  const underLease = <T>(path: string, label: string, operation: () => T): T => {
    const lease = acquireLocalLeaseSync(`${path}.lock`, {
      staleMs: ENVIRONMENT_LOCK_STALE_MS,
    });
    if (lease === null)
      throw kernelError("conflict", `${label} is being changed by another process`);
    try {
      return operation();
    } finally {
      lease.release();
    }
  };

  /** Lock several selection documents in stable order, avoiding cross-process deadlock. */
  const underSelectionLeases = <T>(
    scopes: readonly EnvironmentSelectionScope[],
    operation: () => T,
  ): T => {
    const ordered = [...new Set(scopes)].sort((left, right) => left.localeCompare(right));
    const run = (index: number): T => {
      const scope = ordered[index];
      if (scope === undefined) return operation();
      return underLease(selectionPath(scope), `${scope} Environment selection`, () =>
        run(index + 1),
      );
    };
    return run(0);
  };

  /** Lock an authored definition while a mutation validates its exact resolved target. */
  const underDefinitionLease = <T>(selection: SelectedEnvironment, operation: () => T): T => {
    if (selection.error !== undefined || selection.ref.scope === "builtin") return operation();
    return underLease(
      definitionPath(selection.ref)!,
      `Environment '${environmentId(selection.ref)}'`,
      operation,
    );
  };

  /** Exact selection-document revision; malformed JSON still has valid compare-and-swap bytes. */
  const selectionRevision = (scope: EnvironmentSelectionScope): string | null => {
    const document = readBounded(selectionPath(scope), `${scope} Environment selection`);
    if (document.missing === true) return null;
    if (document.revision !== undefined) return document.revision;
    throw kernelError("unavailable", document.error ?? `${scope} selection could not be read`);
  };

  const selectionRevisions = (): Record<EnvironmentSelectionScope, string | null> => ({
    global: selectionRevision("global"),
    workspace: selectionRevision("workspace"),
  });

  const readDefinition = (input: EnvironmentRef): EnvironmentDefinitionView => {
    const ref = environmentRef(input);
    if (ref.scope === "builtin") return { ref: BUILTIN_REF, immutable: true };
    const path = definitionPath(ref)!;
    const document = readBounded(path, `Environment '${environmentId(ref)}'`);
    if (document.missing === true) {
      return { ref, immutable: false, error: `Environment '${environmentId(ref)}' does not exist` };
    }
    if (document.raw === undefined) {
      return { ref, immutable: false, error: document.error ?? "Environment could not be read" };
    }
    const parsed = parseDefinition(ref, document.raw);
    return {
      ref,
      immutable: false,
      ...(document.revision === undefined ? {} : { revision: document.revision }),
      ...(parsed.definition === undefined ? {} : { definition: parsed.definition }),
      ...(parsed.error === undefined ? {} : { error: parsed.error }),
    };
  };

  const selectionFromFile = (
    scope: EnvironmentSelectionScope,
  ): { missing?: true; ref?: EnvironmentRef; error?: string } => {
    const document = readBounded(selectionPath(scope), `${scope} Environment selection`);
    if (document.missing === true) return { missing: true };
    if (document.raw === undefined)
      return { error: document.error ?? "selection could not be read" };
    let json: unknown;
    try {
      json = JSON.parse(document.raw);
    } catch (error) {
      return { error: `invalid JSON: ${(error as Error).message}` };
    }
    const parsed = selectionSchema.safeParse(json);
    if (!parsed.success) return { error: z.prettifyError(parsed.error) };
    const ref = parsed.data.environment;
    if (ref.scope === "builtin" && ref.name !== BUILTIN_REF.name) {
      return { error: `unknown builtin Environment '${ref.name}'` };
    }
    if (scope === "global" && ref.scope === "workspace") {
      return { error: "a global selection cannot point at a workspace Environment" };
    }
    return { ref };
  };

  const selectorRef = (selector: string): EnvironmentRef => {
    const trimmed = selector.trim();
    const separator = trimmed.indexOf(":");
    if (separator > 0) {
      const scope = trimmed.slice(0, separator);
      const name = trimmed.slice(separator + 1);
      if (!(["builtin", "global", "workspace"] as string[]).includes(scope)) {
        throw kernelError("invalid_request", `unknown Environment scope '${scope}'`);
      }
      return environmentRef({ scope, name });
    }
    if (trimmed === "default") return BUILTIN_REF;
    if (!NAME_RE.test(trimmed)) throw kernelError("invalid_request", "invalid --env value");
    const workspaceRef: EnvironmentRef = { scope: "workspace", name: trimmed };
    const workspaceDocument = readBounded(
      definitionPath(workspaceRef)!,
      `Environment '${environmentId(workspaceRef)}'`,
    );
    if (workspaceDocument.missing !== true) return workspaceRef;
    return { scope: "global", name: trimmed };
  };

  const selectedNow = (without?: EnvironmentSelectionScope): SelectedEnvironment => {
    if (options.cliSelection !== undefined) {
      return { ref: selectorRef(options.cliSelection), origin: "cli" };
    }
    if (without !== "workspace") {
      const local = selectionFromFile("workspace");
      if (local.error !== undefined) {
        return {
          ref: { scope: "workspace", name: "invalid-selection" },
          origin: "workspace",
          error: local.error,
        };
      }
      if (local.ref !== undefined) return { ref: local.ref, origin: "workspace" };
    }
    if (without !== "global") {
      const operator = selectionFromFile("global");
      if (operator.error !== undefined) {
        return {
          ref: { scope: "global", name: "invalid-selection" },
          origin: "global",
          error: operator.error,
        };
      }
      if (operator.ref !== undefined) return { ref: operator.ref, origin: "global" };
    }
    return { ref: BUILTIN_REF, origin: "builtin" };
  };

  const standaloneInventory = (): StandaloneInventoryEntry[] => {
    const out: StandaloneInventoryEntry[] = [];
    for (const [rootOrder, root] of standardRoots.entries()) {
      try {
        const skills = createAgentSkills({
          workspace: options.workspaceRoot,
          roots: [root],
          warningSink: (message) =>
            logger.warn(
              { event: "kernel.environment.skill_warning", warning: message.trimEnd() },
              "a standalone skill was skipped while resolving the Environment inventory",
            ),
          logger,
        });
        for (const info of skills.listSkills()) {
          const content = skills.loadSkill(info.name);
          if (content === undefined) continue;
          const ref: EnvironmentSkillRef = {
            scope: root.scope ?? "workspace",
            source: root.source === "agents" ? "agents" : "clarvis",
            name: info.name,
          };
          out.push({
            ref,
            root,
            rootOrder,
            description: info.description,
            digest: fingerprintOf({
              metadata: info.metadata,
              body: content.body,
              resources: content.resources.map((resource) => resource.rel).sort(),
            }),
          });
        }
      } catch (error) {
        logger.warn(
          {
            event: "kernel.environment.skill_root_failed",
            path: root.path,
            cause: error instanceof Error ? error.message : String(error),
          },
          "one standalone skill root could not be inventoried",
        );
      }
    }
    return out.sort(
      (left, right) =>
        left.ref.name.localeCompare(right.ref.name) || left.rootOrder - right.rootOrder,
    );
  };

  const defaultStandaloneSelection = (
    inventory: readonly StandaloneInventoryEntry[],
  ): EnvironmentSkillRef[] => {
    const winners = new Map<string, StandaloneInventoryEntry>();
    for (const entry of [...inventory].sort((left, right) => left.rootOrder - right.rootOrder)) {
      winners.set(entry.ref.name, entry);
    }
    return [...winners.values()]
      .sort((left, right) => left.ref.name.localeCompare(right.ref.name))
      .map((entry) => entry.ref);
  };

  const pluginSkillNames = (
    plugin: InstalledPlugin,
    manifest: NonNullable<ReturnType<typeof resolvePluginManifest>["manifest"]>,
    format: ReturnType<typeof resolvePluginManifest>["format"],
  ): string[] => {
    const roots = pluginSkillScanRoots(
      plugin.dir,
      manifest.skills,
      plugin.manifestLocation,
      format,
    );
    if (roots.length === 0) return [];
    try {
      return createAgentSkills({
        workspace: plugin.dir,
        roots,
        warningSink: () => undefined,
        logger,
      })
        .listSkills()
        .map((skill) => skill.name)
        .sort();
    } catch {
      return [];
    }
  };

  const pluginInventory = (): PluginInventoryEntry[] =>
    listInstalledPlugins({
      globalDir: options.globalDir,
      ...(options.home === undefined ? {} : { home: options.home }),
      workspaceRoot: options.workspaceRoot,
    }).map((plugin) => {
      const ref = plugin.ref;
      const resolved =
        plugin.manifestError === undefined && plugin.manifestRaw !== undefined
          ? resolvePluginManifest(
              plugin.dir,
              plugin.manifestRaw,
              plugin.manifestLocation,
              plugin.name,
              {
                dataDir: pluginDataDir({
                  globalDir: options.globalDir,
                  workspaceRoot: options.workspaceRoot,
                  ref: plugin.ref,
                }),
              },
            )
          : { notes: [], error: plugin.manifestError ?? "no readable plugin manifest" };
      const manifest = resolved.manifest;
      const hooks =
        manifest === undefined
          ? []
          : pluginHookReviews(options.globalDir, plugin.ref, manifest.hooks ?? []);
      const view: ResolvedEnvironmentPlugin = {
        ref,
        active: false,
        installed: true,
        valid: manifest !== undefined,
        ...(manifest?.version === undefined ? {} : { version: manifest.version }),
        ...(plugin.revision === undefined ? {} : { revision: plugin.revision }),
        agents: plugin.agentFiles.map((file) => file.name.replace(/\.md$/i, "")).sort(),
        skills: manifest === undefined ? [] : pluginSkillNames(plugin, manifest, resolved.format),
        mcp_servers:
          manifest === undefined
            ? []
            : Object.keys(manifest.mcpServers ?? {})
                .map((name) => `${plugin.name}:${name}`)
                .sort(),
        hooks: { total: hooks.length, approved: hooks.filter((hook) => hook.approved).length },
        capability_executables: Object.keys(manifest?.capabilityExecutables ?? {}).sort(),
        ...(resolved.error === undefined ? {} : { error: resolved.error }),
      };
      return {
        view,
        digest: fingerprintOf({
          ref,
          manifest: plugin.manifestRaw,
          manifest_error: plugin.manifestError,
          agents: plugin.agentFiles.map((file) => ({ name: file.name, content: file.content })),
          origin: plugin.origin,
          revision: plugin.revision,
          subdir: plugin.subdir,
        }),
      };
    });

  const resolved = (
    selection: SelectedEnvironment,
    enabledPlugins: readonly EnvironmentPluginRef[],
    workspaceTrust: WorkspaceTrustVerdict,
    assumeWorkspaceTrusted = false,
  ): ResolvedEnvironment => {
    const installed = pluginInventory();
    const discovered = standaloneInventory();
    const definitionView =
      selection.error === undefined ? readDefinition(selection.ref) : undefined;
    const issues: EnvironmentIssue[] = [];
    if (selection.error !== undefined) {
      issues.push({ code: "invalid_selection", message: selection.error });
    }
    if (definitionView?.error !== undefined) {
      issues.push({
        code: definitionView.revision === undefined ? "missing_definition" : "invalid_definition",
        message: definitionView.error,
      });
    }
    const definition = definitionView?.definition;
    const definitionIsValid =
      selection.error === undefined &&
      (selection.ref.scope === "builtin" || definition !== undefined);
    const selectedPlugins =
      selection.ref.scope === "builtin" ? [...enabledPlugins] : (definition?.plugins ?? []);
    const selectedSkills =
      selection.ref.scope === "builtin"
        ? defaultStandaloneSelection(discovered)
        : (definition?.skills ?? []);
    const selectedPluginNames = new Set<string>();
    let pluginNamesAreUnique = true;
    for (const ref of selectedPlugins) {
      if (selectedPluginNames.has(ref.name)) {
        pluginNamesAreUnique = false;
        issues.push({
          code: "duplicate_plugin_name",
          plugin: ref,
          message:
            `plugin namespace '${ref.name}' is selected more than once; ` +
            "choose exactly one qualified installation",
        });
      }
      selectedPluginNames.add(ref.name);
    }
    const validDefinition = definitionIsValid && pluginNamesAreUnique;
    const requiresTrust = selection.ref.scope === "workspace" && selectedPlugins.length > 0;
    const trusted =
      assumeWorkspaceTrusted ||
      !requiresTrust ||
      workspaceTrust.state === "trusted" ||
      workspaceTrust.state === "inert";
    if (validDefinition && !trusted) {
      issues.push({
        code: "workspace_untrusted",
        message:
          "the workspace Environment selects executable plugins but its current fingerprint is not approved",
      });
    }
    const installedByRef = new Map(
      installed.map((entry) => [pluginRefId(entry.view.ref), entry] as const),
    );
    const pluginViews: ResolvedEnvironmentPlugin[] = validDefinition
      ? selectedPlugins.map((ref) => {
          const inventory = installedByRef.get(pluginRefId(ref));
          if (inventory === undefined) {
            issues.push({
              code: "missing_plugin",
              plugin: ref,
              message: `plugin '${pluginRefLabel(ref)}' is not installed`,
            });
            return {
              ref,
              active: false,
              installed: false,
              valid: false,
              agents: [],
              skills: [],
              mcp_servers: [],
              hooks: { total: 0, approved: 0 },
              capability_executables: [],
              error: "not installed",
            };
          }
          if (!inventory.view.valid) {
            issues.push({
              code: "invalid_plugin",
              plugin: ref,
              message: inventory.view.error ?? `plugin '${pluginRefLabel(ref)}' is invalid`,
            });
          }
          return {
            ...inventory.view,
            active: trusted && inventory.view.valid,
          };
        })
      : [];
    const skillByRef = new Map(
      discovered.map((entry) => [
        `${entry.ref.scope}\0${entry.ref.source}\0${entry.ref.name}`,
        entry,
      ]),
    );
    const skillViews: ResolvedEnvironmentSkill[] = validDefinition
      ? selectedSkills.map((ref) => {
          const entry = skillByRef.get(`${ref.scope}\0${ref.source}\0${ref.name}`);
          if (entry === undefined) {
            issues.push({
              code: "missing_skill",
              skill: ref,
              message: `skill '${ref.scope}/${ref.source}/${ref.name}' was not discovered`,
            });
            return { ref, active: false, found: false, error: "not discovered" };
          }
          return {
            ref,
            active: true,
            found: true,
            description: entry.description,
            digest: entry.digest,
          };
        })
      : [];
    const activePlugins = pluginViews.filter((plugin) => plugin.active);
    const activeSkills = skillViews.filter((skill) => skill.active);
    const status = !validDefinition ? "invalid" : issues.length > 0 ? "degraded" : "ready";
    const identity = {
      id: environmentId(selection.ref),
      definition_revision: definitionView?.revision,
      status,
      plugins: activePlugins.map((plugin) => ({
        ref: plugin.ref,
        digest: installedByRef.get(pluginRefId(plugin.ref))?.digest,
      })),
      skills: activeSkills.map((skill) => ({ ref: skill.ref, digest: skill.digest })),
      issues,
      workspace_trust: requiresTrust ? workspaceTrust.state : undefined,
    };
    return {
      id: environmentId(selection.ref),
      ref: selection.ref,
      immutable: selection.ref.scope === "builtin",
      status,
      fingerprint: fingerprintOf(identity),
      selection_origin: selection.origin,
      ...(definition === undefined ? {} : { definition }),
      ...(definitionView?.revision === undefined
        ? {}
        : { definition_revision: definitionView.revision }),
      ...(definition?.description === undefined ? {} : { description: definition.description }),
      ...(requiresTrust ? { workspace_trust: workspaceTrust } : {}),
      plugins: pluginViews,
      standalone_skills: skillViews,
      issues,
      counts: {
        plugins_active: activePlugins.length,
        plugins_installed: installed.length,
        standalone_skills_active: activeSkills.length,
        standalone_skills_discovered: discovered.length,
        plugin_skills_active: activePlugins.reduce(
          (count, plugin) => count + plugin.skills.length,
          0,
        ),
        plugin_skills_discovered: installed.reduce(
          (count, plugin) => count + plugin.view.skills.length,
          0,
        ),
        mcp_servers_active: activePlugins.reduce(
          (count, plugin) => count + plugin.mcp_servers.length,
          0,
        ),
        hooks_declared: activePlugins.reduce((count, plugin) => count + plugin.hooks.total, 0),
        hooks_approved: activePlugins.reduce((count, plugin) => count + plugin.hooks.approved, 0),
      },
    };
  };

  const freshSelection = (
    selection: SelectedEnvironment,
    assumeTrusted = false,
  ): ResolvedEnvironment => {
    const observedTrust = runtime?.readWorkspaceTrust() ?? pinnedTrust;
    const effectiveTrust: WorkspaceTrustVerdict = assumeTrusted
      ? {
          state: "trusted",
          ...(observedTrust.fingerprint === undefined
            ? {}
            : { fingerprint: observedTrust.fingerprint }),
        }
      : observedTrust;
    return resolved(selection, pinnedEnabled, effectiveTrust, assumeTrusted);
  };

  const freshTarget = (input: EnvironmentRef, assumeTrusted = false): ResolvedEnvironment => {
    const ref = environmentRef(input);
    return freshSelection(
      {
        ref,
        origin:
          ref.scope === "workspace" ? "workspace" : ref.scope === "global" ? "global" : "builtin",
      },
      assumeTrusted,
    );
  };

  const activePlugins = (): EnvironmentPluginRef[] =>
    (pinned?.plugins ?? []).filter((plugin) => plugin.active).map((plugin) => plugin.ref);

  const skillRoots = (): SkillRootInput[] => {
    if (pinned === undefined) throw kernelError("unavailable", "Environment has not been resolved");
    const pluginRoots = options.pluginContributions.skillRoots(activePlugins());
    if (pinned.ref.scope === "builtin") return [...pluginRoots, ...standardRoots];
    const selected = pinned.standalone_skills
      .filter((skill) => skill.active)
      .map((skill) => skill.ref);
    const exact = standardRoots.flatMap((root) => {
      const include = selected
        .filter((ref) => ref.scope === root.scope && ref.source === root.source)
        .map((ref) => ref.name)
        .sort();
      return include.length === 0 ? [] : [{ ...root, include }];
    });
    return [...pluginRoots, ...exact];
  };

  const workspaceTrustSurface = (): unknown => {
    const selection = selectedNow();
    if (selection.error !== undefined || selection.ref.scope !== "workspace") return undefined;
    const view = readDefinition(selection.ref);
    if (view.definition === undefined || view.definition.plugins.length === 0) return undefined;
    return {
      environment: selection.ref,
      definition_revision: view.revision,
      plugins: view.definition.plugins,
    };
  };

  const list = async (): Promise<EnvironmentDefinitionView[]> => {
    const out: EnvironmentDefinitionView[] = [{ ref: BUILTIN_REF, immutable: true }];
    for (const scope of ["global", "workspace"] as const) {
      const listed = definitionNames(definitionDir(scope));
      if (listed.error !== undefined) {
        out.push({
          ref: { scope, name: "invalid-directory" },
          immutable: false,
          error: listed.error,
        });
        continue;
      }
      for (const name of listed.names ?? []) out.push(readDefinition({ scope, name }));
    }
    return out;
  };

  const rememberPreview = (
    mutation: PreviewEntry["mutation"],
    target: ResolvedEnvironment,
  ): string => {
    const token = randomUUID();
    const now = Date.now();
    for (const [key, entry] of previews) {
      if (entry.expiresAt <= now) previews.delete(key);
    }
    while (previews.size >= MAX_PREVIEWS) previews.delete(previews.keys().next().value!);
    previews.set(token, {
      mutation,
      fingerprint: target.fingerprint,
      expiresAt: now + PREVIEW_TTL_MS,
    });
    return token;
  };

  /** Whether the current workspace approval covers this exact selected definition. */
  const workspaceTargetNeedsApproval = (
    ref: EnvironmentRef,
    definition: EnvironmentDefinition | undefined,
    trust: WorkspaceTrustVerdict,
  ): boolean => {
    if (ref.scope !== "workspace" || (definition?.plugins.length ?? 0) === 0) return false;
    const current = selectedNow();
    return current.error !== undefined || !sameRef(current.ref, ref) || trust.state !== "trusted";
  };

  const preview = async (
    input: EnvironmentRef,
    inputOptions: { selection_scope: EnvironmentSelectionScope },
  ): Promise<EnvironmentPreview> => {
    const ref = environmentRef(input);
    const previewOptions = parsedInput(
      previewOptionsSchema,
      inputOptions,
      "invalid Environment preview options",
    );
    if (previewOptions.selection_scope === "global" && ref.scope === "workspace") {
      throw kernelError(
        "invalid_request",
        "a global selection cannot point at a workspace Environment",
      );
    }
    if (pinned === undefined) throw kernelError("unavailable", "Environment has not been resolved");
    const actualTrust = runtime?.readWorkspaceTrust() ?? pinnedTrust;
    const view = readDefinition(ref);
    const requiresWorkspaceTrust = workspaceTargetNeedsApproval(ref, view.definition, actualTrust);
    const target = freshSelection(
      { ref, origin: previewOptions.selection_scope },
      requiresWorkspaceTrust,
    );
    return {
      current: pinned,
      target,
      delta: deltaOf(pinned, target),
      token: rememberPreview(
        {
          kind: "select",
          ref,
          scope: previewOptions.selection_scope,
          selectionRevision: selectionRevision(previewOptions.selection_scope),
        },
        target,
      ),
      requires_workspace_trust: requiresWorkspaceTrust,
    };
  };

  const previewClear = async (input: EnvironmentSelectionScope): Promise<EnvironmentPreview> => {
    const scope = parsedInput(
      z.enum(["global", "workspace"]),
      input,
      "invalid Environment selection scope",
    );
    if (options.cliSelection !== undefined) {
      throw kernelError("conflict", "the active --env override cannot be changed by this process");
    }
    if (pinned === undefined) throw kernelError("unavailable", "Environment has not been resolved");
    const target = freshSelection(selectedNow(scope));
    return {
      current: pinned,
      target,
      delta: deltaOf(pinned, target),
      token: rememberPreview(
        { kind: "clear", scope, selectionRevisions: selectionRevisions() },
        target,
      ),
      requires_workspace_trust: false,
    };
  };

  const writeSelection = (
    ref: EnvironmentRef,
    scope: EnvironmentSelectionScope,
  ): EnvironmentApplyResult => {
    if (options.cliSelection !== undefined) {
      throw kernelError("conflict", "the active --env override cannot be changed by this process");
    }
    if (scope === "global" && ref.scope === "workspace") {
      throw kernelError(
        "invalid_request",
        "a global selection cannot point at a workspace Environment",
      );
    }
    writeFileAtomicSync(
      selectionPath(scope),
      `${JSON.stringify({ schema_version: 1, environment: ref }, null, 2)}\n`,
    );
    return { selected: ref, reconnect_required: true };
  };

  const writeDefinition = (
    input: EnvironmentDefinitionInput,
    expectedRevision?: string,
  ): EnvironmentDefinitionView => {
    const ref = input.ref;
    const serialized = `${JSON.stringify(input.definition, null, 2)}\n`;
    const parsed = parseDefinition(ref, serialized);
    if (parsed.definition === undefined) {
      throw kernelError("invalid_request", parsed.error ?? "invalid Environment definition");
    }
    const path = definitionPath(ref)!;
    const write = (): EnvironmentDefinitionView =>
      underDefinitionLease({ ref, origin: ref.scope }, () => {
        const current = readBounded(path, `Environment '${environmentId(ref)}'`);
        if (expectedRevision === undefined) {
          if (current.missing !== true) {
            if (current.revision !== undefined) {
              throw kernelError("conflict", `Environment '${environmentId(ref)}' already exists`);
            }
            throw kernelError(
              "unavailable",
              current.error ?? `Environment '${environmentId(ref)}' could not be inspected`,
            );
          }
          const catalog = definitionNames(definitionDir(ref.scope));
          if (catalog.error !== undefined) {
            throw kernelError(
              catalog.resourceExhausted === true ? "resource_exhausted" : "unavailable",
              catalog.error,
            );
          }
          if (
            (catalog.names?.length ?? 0) >= MAX_ENVIRONMENTS_PER_SCOPE ||
            (catalog.entries ?? 0) >= MAX_ENVIRONMENT_DIRECTORY_ENTRIES
          ) {
            throw kernelError(
              "resource_exhausted",
              `Environment catalog '${ref.scope}' has reached its definition or entry limit`,
              {
                definitions: catalog.names?.length ?? 0,
                definition_limit: MAX_ENVIRONMENTS_PER_SCOPE,
                entries: catalog.entries ?? 0,
                entry_limit: MAX_ENVIRONMENT_DIRECTORY_ENTRIES,
              },
            );
          }
        } else if (current.revision !== expectedRevision) {
          throw kernelError("conflict", "Environment changed since it was read", {
            expected_revision: expectedRevision,
            actual_revision: current.revision ?? null,
          });
        }
        writeFileAtomicSync(path, serialized);
        return readDefinition(ref);
      });
    return expectedRevision === undefined
      ? underLease(definitionDir(ref.scope), `${ref.scope} Environment catalog`, write)
      : write();
  };

  const restoreSelection = (scope: EnvironmentSelectionScope, before: ReadDocument): void => {
    if (before.missing === true) {
      rmSync(selectionPath(scope), { force: true });
      return;
    }
    if (before.raw === undefined) {
      throw kernelError("unavailable", "the previous Environment selection cannot be restored");
    }
    writeFileAtomicSync(selectionPath(scope), before.raw);
  };

  const service: EnvironmentService = {
    list,
    async current() {
      if (pinned === undefined)
        throw kernelError("unavailable", "Environment has not been resolved");
      return pinned;
    },
    async get(ref) {
      return freshTarget(environmentRef(ref));
    },
    preview,
    previewClear,
    async select(inputRef, inputOptions) {
      const ref = environmentRef(inputRef);
      const selectOptions = parsedInput(
        selectOptionsSchema,
        inputOptions,
        "invalid Environment selection options",
      );
      const entry = previews.get(selectOptions.preview_token);
      previews.delete(selectOptions.preview_token);
      if (
        entry === undefined ||
        entry.expiresAt <= Date.now() ||
        entry.mutation.kind !== "select" ||
        !sameRef(entry.mutation.ref, ref) ||
        entry.mutation.scope !== selectOptions.selection_scope
      ) {
        throw kernelError(
          "conflict",
          "Environment preview is missing, expired, or names another target",
        );
      }
      const selectionMutation = entry.mutation;
      const targetSelection: SelectedEnvironment = {
        ref,
        origin: selectOptions.selection_scope,
      };
      return underDefinitionLease(targetSelection, () =>
        underSelectionLeases([selectOptions.selection_scope], () => {
          if (
            selectionRevision(selectOptions.selection_scope) !== selectionMutation.selectionRevision
          ) {
            throw kernelError(
              "conflict",
              "Environment selection changed since the preview was created",
            );
          }
          const definition = readDefinition(ref).definition;
          const requiresTrust = workspaceTargetNeedsApproval(
            ref,
            definition,
            runtime?.readWorkspaceTrust() ?? pinnedTrust,
          );
          const target = freshSelection(targetSelection, requiresTrust);
          if (target.fingerprint !== entry.fingerprint) {
            throw kernelError("conflict", "Environment changed since the preview was created");
          }
          if (selectOptions.approve_workspace === true && requiresTrust) {
            if (runtime === undefined)
              throw kernelError("unavailable", "workspace trust is unavailable");
            const before = readBounded(
              selectionPath(selectOptions.selection_scope),
              `${selectOptions.selection_scope} Environment selection`,
            );
            if (before.error !== undefined) {
              throw kernelError(
                "unavailable",
                "the previous Environment selection cannot be snapshotted before approval",
              );
            }
            const result = writeSelection(ref, selectOptions.selection_scope);
            try {
              runtime.approveWorkspace();
            } catch (error) {
              restoreSelection(selectOptions.selection_scope, before);
              throw error;
            }
            return result;
          }
          return writeSelection(ref, selectOptions.selection_scope);
        }),
      );
    },
    async clearSelection(inputScope, inputOptions) {
      const scope = parsedInput(
        z.enum(["global", "workspace"]),
        inputScope,
        "invalid Environment selection scope",
      );
      const clearOptions = parsedInput(
        clearOptionsSchema,
        inputOptions,
        "invalid Environment clear options",
      );
      if (options.cliSelection !== undefined) {
        throw kernelError(
          "conflict",
          "the active --env override cannot be changed by this process",
        );
      }
      const entry = previews.get(clearOptions.preview_token);
      previews.delete(clearOptions.preview_token);
      if (
        entry === undefined ||
        entry.expiresAt <= Date.now() ||
        entry.mutation.kind !== "clear" ||
        entry.mutation.scope !== scope
      ) {
        throw kernelError(
          "conflict",
          "Environment clear preview is missing, expired, or names another selection scope",
        );
      }
      const clearMutation = entry.mutation;
      const expectedFallback = selectedNow(scope);
      return underDefinitionLease(expectedFallback, () =>
        underSelectionLeases(["global", "workspace"], () => {
          const revisions = selectionRevisions();
          if (
            revisions.global !== clearMutation.selectionRevisions.global ||
            revisions.workspace !== clearMutation.selectionRevisions.workspace
          ) {
            throw kernelError(
              "conflict",
              "Environment selections changed since the clear preview was created",
            );
          }
          const target = freshSelection(selectedNow(scope));
          if (target.fingerprint !== entry.fingerprint) {
            throw kernelError(
              "conflict",
              "Environment fallback changed since the preview was created",
            );
          }
          rmSync(selectionPath(scope), { force: true });
          return { selected: target.ref, reconnect_required: true };
        }),
      );
    },
    async create(input) {
      return writeDefinition(
        parsedInput(definitionInputSchema, input, "invalid Environment definition input"),
      );
    },
    async update(input) {
      const update = parsedInput(
        definitionUpdateInputSchema,
        input,
        "invalid Environment definition update",
      );
      return writeDefinition(update, update.expected_revision);
    },
    async clone(inputSource, inputTarget) {
      const source = environmentRef(inputSource);
      const target = parsedInput(
        authoredRefSchema,
        inputTarget,
        "invalid Environment clone target",
      );
      const sourceView = readDefinition(source);
      if (source.scope === "builtin") {
        if (pinned === undefined)
          throw kernelError("unavailable", "Environment has not been resolved");
        const builtin = freshTarget(BUILTIN_REF);
        const definition: EnvironmentDefinition = {
          schema_version: 1,
          description: "Clone of builtin:default",
          plugins: builtin.plugins.filter((plugin) => plugin.active).map((plugin) => plugin.ref),
          skills: builtin.standalone_skills
            .filter((skill) => skill.active)
            .map((skill) => skill.ref),
        };
        return writeDefinition({ ref: target, definition });
      }
      if (sourceView.definition === undefined) {
        throw kernelError("invalid_request", sourceView.error ?? "source Environment is invalid");
      }
      return writeDefinition({ ref: target, definition: sourceView.definition });
    },
  };

  return {
    service,
    bindRuntime(binding) {
      runtime = binding;
    },
    resolveActive(enabledPlugins, workspaceTrust) {
      if (pinned !== undefined) return pinned;
      pinnedEnabled = [...enabledPlugins];
      pinnedTrust = workspaceTrust;
      pinned = resolved(selectedNow(), pinnedEnabled, pinnedTrust);
      logger.info(
        {
          event: "kernel.environment.resolved",
          environment_id: pinned.id,
          fingerprint: pinned.fingerprint,
          status: pinned.status,
          plugins: pinned.counts.plugins_active,
          skills: pinned.counts.standalone_skills_active + pinned.counts.plugin_skills_active,
        },
        "the kernel extension Environment is pinned for this process",
      );
      return pinned;
    },
    activePlugins,
    skillRoots,
    runRef() {
      if (pinned === undefined)
        throw kernelError("unavailable", "Environment has not been resolved");
      return { id: pinned.id, fingerprint: pinned.fingerprint };
    },
    workspaceTrustSurface,
  };
}
