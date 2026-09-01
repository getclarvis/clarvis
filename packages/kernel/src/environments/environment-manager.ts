import {
  constants,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  rmSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  acquireLocalLeaseSync,
  DIR_MODE,
  globalPaths,
  workspacePaths,
  workspaceStatePaths,
  writeFileAtomicSync,
} from "@clarvis/paths";
import {
  clarvisSkillRoots,
  createAgentSkills,
  hashBoundedFile,
  MAX_SKILL_RESOURCE_FILE_BYTES,
  MAX_SKILL_RESOURCE_SNAPSHOT_BYTES,
  type SkillRootInput,
} from "@clarvis/skills";
import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import type {
  EnvironmentApplyResult,
  EnvironmentCompositionApplyResult,
  EnvironmentCompositionInput,
  EnvironmentCompositionPreview,
  EnvironmentDefinition,
  EnvironmentDefinitionInput,
  EnvironmentDefinitionView,
  EnvironmentDelta,
  EnvironmentIssue,
  EnvironmentInventory,
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
import {
  getInstalledPlugin,
  listInstalledPlugins,
} from "../adapters/filesystem/plugin-repository.ts";
import type { InstalledPlugin } from "../ports/plugin-repository.ts";
import type {
  PluginContributions,
  PluginContributionSnapshot,
} from "../plugins/plugin-contributions.ts";
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
const definitionRevisionSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const definitionDeleteOptionsSchema = z
  .object({ expected_revision: definitionRevisionSchema })
  .strict();
const compositionInputSchema = definitionInputSchema
  .extend({
    expected_revision: definitionRevisionSchema.nullable(),
    selection_scope: z.enum(["global", "workspace"]),
  })
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
const compositionApplyOptionsSchema = z
  .object({ preview_token: z.uuid(), approve_workspace: z.boolean().optional() })
  .strict();
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
  loadDigest(): string | undefined;
}

interface PluginInventoryEntry {
  view: ResolvedEnvironmentPlugin;
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
        effective: SelectedEnvironment;
        selectionRevisions: Record<EnvironmentSelectionScope, string | null>;
      }
    | {
        kind: "clear";
        scope: EnvironmentSelectionScope;
        selectionRevisions: Record<EnvironmentSelectionScope, string | null>;
      }
    | {
        kind: "compose";
        ref: { scope: Scope; name: string };
        scope: EnvironmentSelectionScope;
        expectedRevision: string | null;
        definitionRevision: string;
        authoredFingerprint: string;
        effective: SelectedEnvironment;
        selectionRevisions: Record<EnvironmentSelectionScope, string | null>;
      };
  fingerprint: string;
  expiresAt: number;
}

/** Runtime hooks supplied after config composition has been constructed. */
export interface EnvironmentRuntimeBinding {
  readWorkspaceTrust(): WorkspaceTrustVerdict;
  approveWorkspace(): void;
  /** Whether changing executable trust would mutate an in-flight run snapshot. */
  hasActiveRuns?(): boolean;
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

/** Plugins inherited from the workspace rather than installed in an operator-owned inventory. */
function workspacePluginRefs(
  definition: EnvironmentDefinition | undefined,
): EnvironmentPluginRef[] {
  return definition?.plugins.filter((ref) => ref.scope === "workspace") ?? [];
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

/** Resolve an absent definition catalog, optionally materializing its authored global container. */
function missingDefinitionCatalog(dir: string, materialize: boolean): DefinitionCatalog {
  if (!materialize) return { names: [], entries: 0 };
  try {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  } catch (error) {
    return { error: `Environment directory could not be created: ${(error as Error).message}` };
  }
  return definitionNames(dir);
}

/** List bounded JSON definition names without following entries as directories. */
function definitionNames(dir: string, materializeMissing = false): DefinitionCatalog {
  let opened: ReturnType<typeof opendirSync>;
  try {
    opened = opendirSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return missingDefinitionCatalog(dir, materializeMissing);
    if (code === "ENOTDIR") return { names: [], entries: 0 };
    return { error: `Environment directory could not be opened: ${(error as Error).message}` };
  }
  const names: string[] = [];
  let entries = 0;
  let scanFailed = false;
  let scanFailure: unknown;
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
  } catch (error) {
    scanFailed = true;
    scanFailure = error;
  } finally {
    opened.closeSync();
  }
  if (scanFailed) {
    const code = (scanFailure as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return missingDefinitionCatalog(dir, materializeMissing);
    if (code === "ENOTDIR") return { names: [], entries: 0 };
    return { error: `Environment directory could not be read: ${(scanFailure as Error).message}` };
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
  assertRunSnapshot(): void;
  runRef(): EnvironmentRunRef;
  workspaceTrustSurface(): unknown;
  assertWorkspaceTrustTransitionAllowed(): void;
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

  const selectedAfterWrite = (
    ref: EnvironmentRef,
    scope: EnvironmentSelectionScope,
  ): SelectedEnvironment => {
    if (scope === "workspace") return { ref, origin: "workspace" };
    const local = selectionFromFile("workspace");
    if (local.error !== undefined) {
      return {
        ref: { scope: "workspace", name: "invalid-selection" },
        origin: "workspace",
        error: local.error,
      };
    }
    return local.ref === undefined
      ? { ref, origin: "global" }
      : { ref: local.ref, origin: "workspace" };
  };

  const standaloneCatalog = (
    selected?: readonly EnvironmentSkillRef[],
  ): StandaloneInventoryEntry[] => {
    const out: StandaloneInventoryEntry[] = [];
    for (const [rootOrder, root] of standardRoots.entries()) {
      const include = selected
        ?.filter((ref) => ref.scope === root.scope && ref.source === root.source)
        .map((ref) => ref.name)
        .sort();
      if (selected !== undefined && include?.length === 0) continue;
      try {
        const skills = createAgentSkills({
          workspace: options.workspaceRoot,
          roots: [{ ...root, ...(include === undefined ? {} : { include }) }],
          warningSink: (message) =>
            logger.warn(
              { event: "kernel.environment.skill_warning", warning: message.trimEnd() },
              "a standalone skill was skipped while resolving the Environment inventory",
            ),
          logger,
        });
        for (const info of skills.listSkills()) {
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
            loadDigest: () => {
              const content = skills.loadSkill(info.name);
              if (content === undefined) return undefined;
              let aggregateResourceBytes = 0;
              return fingerprintOf({
                catalog: {
                  description: info.description,
                  metadata: info.metadata,
                  allowed_tools: info.allowedTools,
                  user_invocable: info.userInvocable,
                  catalog_suppressed: info.catalogSuppressed,
                  presentation: info.presentation,
                  defaulted: info.defaulted,
                },
                body: content.body,
                resources: content.resources
                  .map((resource) => {
                    const snapshot = hashBoundedFile(resource.path, {
                      maxBytes: MAX_SKILL_RESOURCE_FILE_BYTES,
                      code: "invalid_skill",
                      label: "standalone skill resource",
                      logger,
                    });
                    aggregateResourceBytes += snapshot.bytes;
                    if (aggregateResourceBytes > MAX_SKILL_RESOURCE_SNAPSHOT_BYTES) {
                      throw new Error(
                        `standalone skill resources exceed the ${String(
                          MAX_SKILL_RESOURCE_SNAPSHOT_BYTES,
                        )}-byte aggregate limit`,
                      );
                    }
                    return {
                      rel: resource.rel,
                      digest: snapshot.digest,
                      bytes: snapshot.bytes,
                      mode: snapshot.mode,
                    };
                  })
                  .sort((left, right) => left.rel.localeCompare(right.rel)),
              });
            },
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

  const standaloneInventory = (
    selected?: readonly EnvironmentSkillRef[],
  ): (StandaloneInventoryEntry & { digest: string })[] => {
    const out: (StandaloneInventoryEntry & { digest: string })[] = [];
    for (const entry of standaloneCatalog(selected)) {
      try {
        const digest = entry.loadDigest();
        if (digest !== undefined) out.push({ ...entry, digest });
      } catch (error) {
        logger.warn(
          {
            event: "kernel.environment.skill_read_failed",
            path: entry.root.path,
            skill: entry.ref.name,
            cause: error instanceof Error ? error.message : String(error),
          },
          "a standalone skill failed while its inventory snapshot was captured",
        );
      }
    }
    return out;
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

  const pluginSkillInventory = (
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
      const skills = createAgentSkills({
        workspace: plugin.dir,
        roots,
        warningSink: () => undefined,
        logger,
      });
      return skills
        .listSkills()
        .map((skill) => skill.name)
        .sort();
    } catch {
      return [];
    }
  };

  const pluginInventory = (selected?: readonly EnvironmentPluginRef[]): PluginInventoryEntry[] => {
    const repositoryOptions = {
      globalDir: options.globalDir,
      ...(options.home === undefined ? {} : { home: options.home }),
      workspaceRoot: options.workspaceRoot,
    };
    const installed =
      selected === undefined
        ? listInstalledPlugins(repositoryOptions)
        : selected.flatMap((ref) => {
            const plugin = getInstalledPlugin(repositoryOptions, ref);
            return plugin === undefined ? [] : [plugin];
          });
    return installed.map((plugin) => {
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
      const hooks = manifest?.hooks ?? [];
      const skills =
        manifest === undefined ? [] : pluginSkillInventory(plugin, manifest, resolved.format);
      const view: ResolvedEnvironmentPlugin = {
        ref,
        active: false,
        installed: true,
        valid: manifest !== undefined,
        ...(manifest?.version === undefined ? {} : { version: manifest.version }),
        ...(plugin.revision === undefined ? {} : { revision: plugin.revision }),
        agents: plugin.agentFiles.map((file) => file.name.replace(/\.md$/i, "")).sort(),
        skills,
        mcp_servers:
          manifest === undefined
            ? []
            : Object.keys(manifest.mcpServers ?? {})
                .map((name) => `${plugin.name}:${name}`)
                .sort(),
        hooks: { total: hooks.length },
        capability_executables: Object.keys(manifest?.capabilityExecutables ?? {}).sort(),
        ...(resolved.error === undefined ? {} : { error: resolved.error }),
      };
      return { view };
    });
  };

  const resolved = (
    selection: SelectedEnvironment,
    enabledPlugins: readonly EnvironmentPluginRef[],
    workspaceTrust: WorkspaceTrustVerdict,
    assumeWorkspaceTrusted = false,
    pinContributions = false,
    definitionOverride?: EnvironmentDefinitionView,
  ): ResolvedEnvironment => {
    const definitionView =
      selection.error === undefined
        ? definitionOverride !== undefined && sameRef(definitionOverride.ref, selection.ref)
          ? definitionOverride
          : readDefinition(selection.ref)
        : undefined;
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
    const discovered = standaloneCatalog(
      selection.ref.scope === "builtin" ? undefined : (definition?.skills ?? []),
    );
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
    const requiresTrust =
      selection.ref.scope === "workspace" &&
      selectedPlugins.some((ref) => ref.scope === "workspace");
    const trusted =
      assumeWorkspaceTrusted ||
      !requiresTrust ||
      workspaceTrust.state === "trusted" ||
      workspaceTrust.state === "inert";
    if (validDefinition && !trusted) {
      issues.push({
        code: "workspace_untrusted",
        message:
          "the workspace Environment selects workspace-owned executable plugins but its current fingerprint is not approved",
      });
    }
    const admittedPlugins = trusted
      ? selectedPlugins
      : selectedPlugins.filter((ref) => ref.scope !== "workspace");
    const contributionSnapshots: readonly PluginContributionSnapshot[] = validDefinition
      ? pinContributions
        ? trusted
          ? options.pluginContributions.pin(selectedPlugins)
          : (() => {
              const snapshots = options.pluginContributions.snapshot(selectedPlugins);
              options.pluginContributions.pin(admittedPlugins);
              return snapshots;
            })()
        : options.pluginContributions.snapshot(selectedPlugins)
      : pinContributions
        ? options.pluginContributions.pin([])
        : [];
    const contributionByRef = new Map(
      contributionSnapshots.map((snapshot) => [pluginRefId(snapshot.ref), snapshot] as const),
    );
    const unresolvedRefs = validDefinition
      ? selectedPlugins.filter((ref) => !contributionByRef.has(pluginRefId(ref)))
      : [];
    const unresolvedInstalled = new Map(
      pluginInventory(unresolvedRefs).map(
        (entry) => [pluginRefId(entry.view.ref), entry.view] as const,
      ),
    );
    const pluginViews: ResolvedEnvironmentPlugin[] = validDefinition
      ? selectedPlugins.map((ref) => {
          const snapshot = contributionByRef.get(pluginRefId(ref));
          if (snapshot !== undefined) {
            return {
              ref,
              active: trusted || ref.scope !== "workspace",
              installed: true,
              valid: true,
              ...(snapshot.version === undefined ? {} : { version: snapshot.version }),
              ...(snapshot.revision === undefined ? {} : { revision: snapshot.revision }),
              agents: snapshot.agents,
              skills: snapshot.skills,
              mcp_servers: snapshot.mcpServers,
              hooks: snapshot.hooks,
              capability_executables: snapshot.capabilityExecutables,
            };
          }
          const installed = unresolvedInstalled.get(pluginRefId(ref));
          if (installed === undefined) {
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
              hooks: { total: 0 },
              capability_executables: [],
              error: "not installed",
            };
          }
          const error =
            installed.error ?? `plugin '${pluginRefLabel(ref)}' could not be captured atomically`;
          issues.push({ code: "invalid_plugin", plugin: ref, message: error });
          return {
            ...installed,
            active: false,
            valid: false,
            error,
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
          let digest: string | undefined;
          try {
            digest = entry.loadDigest();
          } catch (error) {
            logger.warn(
              {
                event: "kernel.environment.skill_read_failed",
                path: entry.root.path,
                skill: ref.name,
                cause: error instanceof Error ? error.message : String(error),
              },
              "a selected standalone skill failed while its snapshot was captured",
            );
          }
          if (digest === undefined) {
            issues.push({
              code: "missing_skill",
              skill: ref,
              message: `skill '${ref.scope}/${ref.source}/${ref.name}' could not be captured`,
            });
            return { ref, active: false, found: false, error: "could not be captured" };
          }
          return {
            ref,
            active: true,
            found: true,
            description: entry.description,
            digest,
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
        digest: contributionByRef.get(pluginRefId(plugin.ref))?.digest,
      })),
      skills: activeSkills.map((skill) => ({ ref: skill.ref, digest: skill.digest })),
      issues,
      workspace_trust: requiresTrust
        ? { state: workspaceTrust.state, fingerprint: workspaceTrust.fingerprint }
        : undefined,
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
        standalone_skills_active: activeSkills.length,
        plugin_skills_active: activePlugins.reduce(
          (count, plugin) => count + plugin.skills.length,
          0,
        ),
        mcp_servers_active: activePlugins.reduce(
          (count, plugin) => count + plugin.mcp_servers.length,
          0,
        ),
        hooks_declared: activePlugins.reduce((count, plugin) => count + plugin.hooks.total, 0),
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

  /** Resolve one transient authored definition through the same inventory and trust rules. */
  const freshCompositionTarget = (
    selection: SelectedEnvironment,
    definition: EnvironmentDefinitionView,
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
    return resolved(selection, pinnedEnabled, effectiveTrust, assumeTrusted, false, definition);
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

  /** Refuse selected standalone-skill drift before returning filesystem-backed roots. */
  const assertPinnedStandaloneSkills = (): void => {
    if (pinned === undefined) return;
    const expected = pinned.standalone_skills
      .filter((skill) => skill.active)
      .map((skill) => ({ ref: skill.ref, digest: skill.digest }));
    const inventory = standaloneInventory(
      pinned.ref.scope === "builtin" ? undefined : expected.map((skill) => skill.ref),
    );
    const currentByRef = new Map(
      inventory.map((entry) => [
        `${entry.ref.scope}\0${entry.ref.source}\0${entry.ref.name}`,
        entry,
      ]),
    );
    const selected =
      pinned.ref.scope === "builtin"
        ? defaultStandaloneSelection(inventory)
        : expected.map((skill) => skill.ref);
    const current = selected.map((ref) => {
      const entry = currentByRef.get(`${ref.scope}\0${ref.source}\0${ref.name}`);
      return { ref, digest: entry?.digest };
    });
    if (fingerprintOf(current) !== fingerprintOf(expected)) {
      throw kernelError(
        "unavailable",
        "selected standalone skill content changed after the Environment snapshot was pinned; reconnect the kernel",
      );
    }
  };

  const skillRoots = (): SkillRootInput[] => {
    if (pinned === undefined) throw kernelError("unavailable", "Environment has not been resolved");
    assertPinnedStandaloneSkills();
    const pluginRoots = options.pluginContributions.skillRoots(activePlugins());
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

  /** Revalidate every selected filesystem contribution before admitting a new run. */
  const assertRunSnapshot = (): void => {
    if (pinned === undefined) throw kernelError("unavailable", "Environment has not been resolved");
    options.pluginContributions.assertUnchanged(activePlugins());
    assertPinnedStandaloneSkills();
  };

  /**
   * Capture the complete bounded repository-plugin inventory for workspace trust.
   *
   * This is resolved by the kernel after Code's lightweight startup composer has
   * painted. Invalid checkouts remain represented with a null digest so repairing,
   * adding, removing, or changing any repository plugin invalidates the one
   * workspace-wide verdict before that plugin can be selected.
   */
  const workspaceTrustSurface = (): unknown => {
    const plugins = pluginInventory()
      .map((entry) => entry.view)
      .filter((plugin) => plugin.ref.scope === "workspace")
      .sort((left, right) => pluginRefId(left.ref).localeCompare(pluginRefId(right.ref)));
    if (plugins.length === 0) return undefined;
    const snapshots = new Map(
      options.pluginContributions
        .snapshot(plugins.map((plugin) => plugin.ref))
        .map((snapshot) => [pluginRefId(snapshot.ref), snapshot] as const),
    );
    return {
      plugins: plugins.map((plugin) => {
        const snapshot = snapshots.get(pluginRefId(plugin.ref));
        return {
          ref: plugin.ref,
          digest: snapshot?.digest ?? null,
        };
      }),
    };
  };

  const assertWorkspaceTrustTransitionAllowed = (): void => {
    if (runtime?.hasActiveRuns?.() === true) {
      throw kernelError(
        "conflict",
        "finish active runs before changing trust for the selected workspace Environment",
      );
    }
  };

  const list = async (): Promise<EnvironmentDefinitionView[]> => {
    const out: EnvironmentDefinitionView[] = [{ ref: BUILTIN_REF, immutable: true }];
    for (const scope of ["global", "workspace"] as const) {
      const listed = definitionNames(definitionDir(scope), scope === "global");
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

  const inventory = async (): Promise<EnvironmentInventory> => ({
    plugins: pluginInventory().map((entry) => ({ ...entry.view, active: false })),
    standalone_skills: standaloneInventory().map((entry) => ({
      ref: entry.ref,
      active: false,
      found: true,
      description: entry.description,
      digest: entry.digest,
    })),
  });

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
    if (ref.scope !== "workspace" || workspacePluginRefs(definition).length === 0) return false;
    return trust.state !== "trusted";
  };

  const compositionDefinition = (
    input: EnvironmentCompositionInput,
  ): {
    serialized: string;
    view: EnvironmentDefinitionView & {
      revision: string;
      definition: EnvironmentDefinition;
    };
  } => {
    const serialized = `${JSON.stringify(input.definition, null, 2)}\n`;
    const parsed = parseDefinition(input.ref, serialized);
    if (parsed.definition === undefined) {
      throw kernelError("invalid_request", parsed.error ?? "invalid Environment definition");
    }
    return {
      serialized,
      view: {
        ref: input.ref,
        immutable: false,
        revision: documentRevision(Buffer.from(serialized)),
        definition: parsed.definition,
      },
    };
  };

  const assertExpectedDefinition = (
    ref: { scope: Scope; name: string },
    expectedRevision: string | null,
    current: ReadDocument,
  ): void => {
    if (expectedRevision === null) {
      if (current.missing === true) return;
      if (current.revision !== undefined) {
        throw kernelError("conflict", `Environment '${environmentId(ref)}' already exists`);
      }
      throw kernelError(
        "unavailable",
        current.error ?? `Environment '${environmentId(ref)}' could not be inspected`,
      );
    }
    if (current.revision !== expectedRevision) {
      throw kernelError("conflict", "Environment changed since it was read", {
        expected_revision: expectedRevision,
        actual_revision: current.revision ?? null,
      });
    }
  };

  const assertCatalogCapacity = (scope: Scope): void => {
    const catalog = definitionNames(definitionDir(scope));
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
        `Environment catalog '${scope}' has reached its definition or entry limit`,
        {
          definitions: catalog.names?.length ?? 0,
          definition_limit: MAX_ENVIRONMENTS_PER_SCOPE,
          entries: catalog.entries ?? 0,
          entry_limit: MAX_ENVIRONMENT_DIRECTORY_ENTRIES,
        },
      );
    }
  };

  const compositionNeedsWorkspaceTrust = (
    input: EnvironmentCompositionInput,
    effective: SelectedEnvironment,
    definition: EnvironmentDefinitionView,
    trust: WorkspaceTrustVerdict,
  ): boolean => {
    const effectiveDefinition = sameRef(effective.ref, input.ref)
      ? definition.definition
      : readDefinition(effective.ref).definition;
    if (
      effective.ref.scope !== "workspace" ||
      workspacePluginRefs(effectiveDefinition).length === 0
    ) {
      return false;
    }
    const before = selectedNow();
    if (sameRef(before.ref, effective.ref) && before.origin === effective.origin) return false;
    return workspaceTargetNeedsApproval(effective.ref, effectiveDefinition, trust);
  };

  const previewComposition = async (
    raw: EnvironmentCompositionInput,
  ): Promise<EnvironmentCompositionPreview> => {
    const input = parsedInput(compositionInputSchema, raw, "invalid Environment composition input");
    if (input.selection_scope === "global" && input.ref.scope === "workspace") {
      throw kernelError(
        "invalid_request",
        "a global selection cannot point at a workspace Environment",
      );
    }
    if (options.cliSelection !== undefined) {
      throw kernelError("conflict", "the active --env override cannot be changed by this process");
    }
    if (pinned === undefined) throw kernelError("unavailable", "Environment has not been resolved");
    const before = readBounded(
      definitionPath(input.ref)!,
      `Environment '${environmentId(input.ref)}'`,
    );
    assertExpectedDefinition(input.ref, input.expected_revision, before);
    if (input.expected_revision === null) assertCatalogCapacity(input.ref.scope);
    const proposed = compositionDefinition(input);
    const actualTrust = runtime?.readWorkspaceTrust() ?? pinnedTrust;
    const effective = selectedAfterWrite(input.ref, input.selection_scope);
    const requiresWorkspaceTrust = compositionNeedsWorkspaceTrust(
      input,
      effective,
      proposed.view,
      actualTrust,
    );
    const authoredAssumesTrust =
      input.ref.scope === "workspace" && input.definition.plugins.length > 0;
    const authored = freshCompositionTarget(
      { ref: input.ref, origin: input.ref.scope },
      proposed.view,
      authoredAssumesTrust,
    );
    const target = freshCompositionTarget(effective, proposed.view, requiresWorkspaceTrust);
    return {
      current: pinned,
      authored,
      target,
      delta: deltaOf(pinned, target),
      token: rememberPreview(
        {
          kind: "compose",
          ref: input.ref,
          scope: input.selection_scope,
          expectedRevision: input.expected_revision,
          definitionRevision: proposed.view.revision,
          authoredFingerprint: authored.fingerprint,
          effective,
          selectionRevisions: selectionRevisions(),
        },
        target,
      ),
      requires_workspace_trust: requiresWorkspaceTrust,
    };
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
    if (options.cliSelection !== undefined) {
      throw kernelError("conflict", "the active --env override cannot be changed by this process");
    }
    if (pinned === undefined) throw kernelError("unavailable", "Environment has not been resolved");
    const actualTrust = runtime?.readWorkspaceTrust() ?? pinnedTrust;
    const effective = selectedAfterWrite(ref, previewOptions.selection_scope);
    const view = readDefinition(effective.ref);
    const requiresWorkspaceTrust =
      previewOptions.selection_scope === "workspace" &&
      workspaceTargetNeedsApproval(effective.ref, view.definition, actualTrust);
    const target = freshSelection(effective, requiresWorkspaceTrust);
    return {
      current: pinned,
      target,
      delta: deltaOf(pinned, target),
      token: rememberPreview(
        {
          kind: "select",
          ref,
          scope: previewOptions.selection_scope,
          effective,
          selectionRevisions: selectionRevisions(),
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

  const withDefinitionMutation = <T>(
    ref: { scope: Scope; name: string },
    expectedRevision: string | null,
    operation: (current: ReadDocument, path: string) => T,
  ): T => {
    const path = definitionPath(ref)!;
    const mutate = (): T =>
      underDefinitionLease({ ref, origin: ref.scope }, () => {
        const current = readBounded(path, `Environment '${environmentId(ref)}'`);
        assertExpectedDefinition(ref, expectedRevision, current);
        if (expectedRevision === null) assertCatalogCapacity(ref.scope);
        return operation(current, path);
      });
    return expectedRevision === null
      ? underLease(definitionDir(ref.scope), `${ref.scope} Environment catalog`, mutate)
      : mutate();
  };

  const writeDefinition = (
    input: EnvironmentDefinitionInput,
    expectedRevision?: string,
  ): EnvironmentDefinitionView => {
    const composition = compositionDefinition({
      ...input,
      expected_revision: expectedRevision ?? null,
      selection_scope: input.ref.scope,
    });
    return withDefinitionMutation(input.ref, expectedRevision ?? null, (_current, path) => {
      writeFileAtomicSync(path, composition.serialized);
      return readDefinition(input.ref);
    });
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

  const restoreDefinition = (ref: { scope: Scope; name: string }, before: ReadDocument): void => {
    const path = definitionPath(ref)!;
    if (before.missing === true) {
      rmSync(path, { force: true });
      return;
    }
    if (before.raw === undefined) {
      throw kernelError("unavailable", "the previous Environment definition cannot be restored");
    }
    writeFileAtomicSync(path, before.raw);
  };

  const applyComposition = async (
    raw: EnvironmentCompositionInput,
    rawOptions: { preview_token: string; approve_workspace?: boolean },
  ): Promise<EnvironmentCompositionApplyResult> => {
    const input = parsedInput(compositionInputSchema, raw, "invalid Environment composition input");
    const applyOptions = parsedInput(
      compositionApplyOptionsSchema,
      rawOptions,
      "invalid Environment composition apply options",
    );
    const proposed = compositionDefinition(input);
    const entry = previews.get(applyOptions.preview_token);
    previews.delete(applyOptions.preview_token);
    if (
      entry === undefined ||
      entry.expiresAt <= Date.now() ||
      entry.mutation.kind !== "compose" ||
      !sameRef(entry.mutation.ref, input.ref) ||
      entry.mutation.scope !== input.selection_scope ||
      entry.mutation.expectedRevision !== input.expected_revision ||
      entry.mutation.definitionRevision !== proposed.view.revision
    ) {
      throw kernelError(
        "conflict",
        "Environment composition preview is missing, expired, or names another draft",
      );
    }
    if (input.selection_scope === "global" && input.ref.scope === "workspace") {
      throw kernelError(
        "invalid_request",
        "a global selection cannot point at a workspace Environment",
      );
    }
    if (options.cliSelection !== undefined) {
      throw kernelError("conflict", "the active --env override cannot be changed by this process");
    }
    if (pinned === undefined) throw kernelError("unavailable", "Environment has not been resolved");
    const mutation = entry.mutation;
    return withDefinitionMutation(input.ref, input.expected_revision, (beforeDefinition, path) =>
      underSelectionLeases(["global", "workspace"], () => {
        const revisions = selectionRevisions();
        if (
          revisions.global !== mutation.selectionRevisions.global ||
          revisions.workspace !== mutation.selectionRevisions.workspace
        ) {
          throw kernelError(
            "conflict",
            "Environment selections changed since the composition preview was created",
          );
        }
        const actualTrust = runtime?.readWorkspaceTrust() ?? pinnedTrust;
        const effective = selectedAfterWrite(input.ref, input.selection_scope);
        if (
          !sameRef(effective.ref, mutation.effective.ref) ||
          effective.origin !== mutation.effective.origin ||
          effective.error !== mutation.effective.error
        ) {
          throw kernelError(
            "conflict",
            "the effective Environment changed since the composition preview was created",
          );
        }
        const requiresWorkspaceTrust = compositionNeedsWorkspaceTrust(
          input,
          effective,
          proposed.view,
          actualTrust,
        );
        const authored = freshCompositionTarget(
          { ref: input.ref, origin: input.ref.scope },
          proposed.view,
          input.ref.scope === "workspace" && input.definition.plugins.length > 0,
        );
        const target = freshCompositionTarget(effective, proposed.view, requiresWorkspaceTrust);
        if (
          authored.fingerprint !== mutation.authoredFingerprint ||
          target.fingerprint !== entry.fingerprint
        ) {
          throw kernelError(
            "conflict",
            "Environment inventory or definition changed since the composition preview",
          );
        }
        if (requiresWorkspaceTrust && applyOptions.approve_workspace !== true) {
          throw kernelError(
            "conflict",
            "the previewed workspace Environment requires explicit trust approval",
          );
        }
        if (requiresWorkspaceTrust && runtime === undefined) {
          throw kernelError("unavailable", "workspace trust is unavailable");
        }
        const beforeSelection = readBounded(
          selectionPath(input.selection_scope),
          `${input.selection_scope} Environment selection`,
        );
        if (beforeSelection.error !== undefined) {
          throw kernelError(
            "unavailable",
            "the previous Environment selection cannot be snapshotted before composition",
          );
        }
        let definitionWritten = false;
        let selectionWritten = false;
        try {
          writeFileAtomicSync(path, proposed.serialized);
          definitionWritten = true;
          writeSelection(input.ref, input.selection_scope);
          selectionWritten = true;
          if (requiresWorkspaceTrust) runtime!.approveWorkspace();
        } catch (error) {
          const rollbackErrors: string[] = [];
          if (selectionWritten) {
            try {
              restoreSelection(input.selection_scope, beforeSelection);
            } catch (rollbackError) {
              rollbackErrors.push(`selection: ${(rollbackError as Error).message}`);
            }
          }
          if (definitionWritten) {
            try {
              restoreDefinition(input.ref, beforeDefinition);
            } catch (rollbackError) {
              rollbackErrors.push(`definition: ${(rollbackError as Error).message}`);
            }
          }
          if (rollbackErrors.length > 0) {
            throw kernelError(
              "unavailable",
              "Environment composition failed and its prior state could not be fully restored",
              { cause: (error as Error).message, rollback: rollbackErrors },
            );
          }
          throw error;
        }
        return {
          definition: readDefinition(input.ref),
          selected: input.ref,
          effective: target.ref,
          reconnect_required: true,
        };
      }),
    );
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
    inventory,
    preview,
    previewClear,
    previewComposition,
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
      const targetSelection = selectionMutation.effective;
      return underDefinitionLease(targetSelection, () =>
        underSelectionLeases(["global", "workspace"], () => {
          const revisions = selectionRevisions();
          if (
            revisions.global !== selectionMutation.selectionRevisions.global ||
            revisions.workspace !== selectionMutation.selectionRevisions.workspace
          ) {
            throw kernelError(
              "conflict",
              "Environment selection changed since the preview was created",
            );
          }
          const definition = readDefinition(targetSelection.ref).definition;
          const requiresTrust =
            selectionMutation.scope === "workspace" &&
            workspaceTargetNeedsApproval(
              targetSelection.ref,
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
    applyComposition,
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
    async delete(inputRef, inputOptions) {
      const ref = parsedInput(
        authoredRefSchema,
        inputRef,
        "invalid Environment definition reference",
      );
      const deleteOptions = parsedInput(
        definitionDeleteOptionsSchema,
        inputOptions,
        "invalid Environment deletion options",
      );
      return withDefinitionMutation(ref, deleteOptions.expected_revision, (_current, path) =>
        underSelectionLeases(["global", "workspace"], () => {
          if (pinned !== undefined && sameRef(pinned.ref, ref)) {
            throw kernelError(
              "conflict",
              `Environment '${environmentId(ref)}' is active; select another Environment and reconnect before deleting it`,
            );
          }
          for (const scope of ["global", "workspace"] as const) {
            const selection = selectionFromFile(scope);
            if (selection.error !== undefined) {
              throw kernelError(
                "unavailable",
                `the ${scope} Environment selection must be repaired before deleting a definition`,
              );
            }
            if (selection.ref !== undefined && sameRef(selection.ref, ref)) {
              throw kernelError(
                "conflict",
                `Environment '${environmentId(ref)}' is selected for ${scope}; clear that selection before deleting it`,
              );
            }
          }
          rmSync(path);
        }),
      );
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
      if (pinned !== undefined) {
        const trustChanged =
          pinnedTrust.state !== workspaceTrust.state ||
          pinnedTrust.fingerprint !== workspaceTrust.fingerprint;
        if (!trustChanged || (pinned.ref.scope !== "workspace" && pinned.ref.scope !== "builtin")) {
          return pinned;
        }
        assertWorkspaceTrustTransitionAllowed();
        pinnedEnabled = [...enabledPlugins];
        pinnedTrust = workspaceTrust;
        pinned = resolved(
          { ref: pinned.ref, origin: pinned.selection_origin },
          pinnedEnabled,
          pinnedTrust,
          false,
          true,
        );
        return pinned;
      }
      const startedAt = Date.now();
      pinnedEnabled = [...enabledPlugins];
      pinnedTrust = workspaceTrust;
      pinned = resolved(selectedNow(), pinnedEnabled, pinnedTrust, false, true);
      logger.info(
        {
          event: "kernel.environment.resolved",
          environment_id: pinned.id,
          fingerprint: pinned.fingerprint,
          status: pinned.status,
          plugins: pinned.counts.plugins_active,
          skills: pinned.counts.standalone_skills_active + pinned.counts.plugin_skills_active,
          duration_ms: Date.now() - startedAt,
        },
        "the kernel extension Environment is pinned for this process",
      );
      return pinned;
    },
    activePlugins,
    skillRoots,
    assertRunSnapshot,
    runRef() {
      if (pinned === undefined)
        throw kernelError("unavailable", "Environment has not been resolved");
      return { id: pinned.id, fingerprint: pinned.fingerprint };
    },
    workspaceTrustSurface,
    assertWorkspaceTrustTransitionAllowed,
  };
}
