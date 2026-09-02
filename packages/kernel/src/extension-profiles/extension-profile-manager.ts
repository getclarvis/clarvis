import {
  constants,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  rmSync,
  unwatchFile,
  watchFile,
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
  type SkillContent,
  type SkillInfo,
  type SkillRootInput,
} from "@clarvis/skills";
import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import type {
  ExtensionProfileApplyResult,
  ExtensionProfileCompositionApplyResult,
  ExtensionProfileCompositionInput,
  ExtensionProfileCompositionPreview,
  ExtensionProfileDefinition,
  ExtensionProfileDefinitionInput,
  ExtensionProfileDefinitionView,
  ExtensionProfileDelta,
  ExtensionProfileIssue,
  ExtensionProfileInventory,
  ExtensionProfilePluginRef,
  ExtensionProfilePreview,
  ExtensionProfileRef,
  ExtensionProfileRunRef,
  ExtensionProfileSelectionOrigin,
  ExtensionProfileSelectionScope,
  ExtensionProfileService,
  ExtensionProfileSkillRef,
  ResolvedExtensionProfile,
  ResolvedExtensionProfilePlugin,
  ResolvedExtensionProfileSkill,
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

const BUILTIN_REF: ExtensionProfileRef = { scope: "builtin", name: "default" };
const MAX_EXTENSION_PROFILE_BYTES = 1024 * 1024;
const MAX_EXTENSION_PROFILES_PER_SCOPE = 128;
const MAX_EXTENSION_PROFILE_DIRECTORY_ENTRIES = 256;
const PREVIEW_TTL_MS = 5 * 60_000;
const MAX_PREVIEWS = 32;
const EXTENSION_PROFILE_LOCK_STALE_MS = 30_000;
const NAME_RE = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;
const GLOBAL_SELECTION_WORKSPACE_ERROR =
  "a global selection cannot point at a workspace Extension Profile";
const CLI_SELECTION_MUTATION_ERROR =
  "the active --extension-profile override cannot be changed by this process";

const nameSchema = z.string().regex(NAME_RE, "must be a safe Extension Profile identifier");
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
const extensionProfileRefSchema = z
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
    extension_profile: extensionProfileRefSchema,
  })
  .strict();

interface ReadDocument {
  raw?: string;
  revision?: string;
  missing?: boolean;
  error?: string;
}

interface SelectedExtensionProfile {
  ref: ExtensionProfileRef;
  origin: ExtensionProfileSelectionOrigin;
  error?: string;
}

interface StandaloneInventoryEntry {
  ref: ExtensionProfileSkillRef;
  root: SkillRootInput;
  rootOrder: number;
  description: string;
  loadDigest(): string | undefined;
}

interface PluginInventoryEntry {
  view: ResolvedExtensionProfilePlugin;
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
        ref: ExtensionProfileRef;
        scope: ExtensionProfileSelectionScope;
        effective: SelectedExtensionProfile;
        selectionRevisions: Record<ExtensionProfileSelectionScope, string | null>;
      }
    | {
        kind: "clear";
        scope: ExtensionProfileSelectionScope;
        selectionRevisions: Record<ExtensionProfileSelectionScope, string | null>;
      }
    | {
        kind: "compose";
        ref: { scope: Scope; name: string };
        scope: ExtensionProfileSelectionScope;
        expectedRevision: string | null;
        definitionRevision: string;
        authoredFingerprint: string;
        effective: SelectedExtensionProfile;
        selectionRevisions: Record<ExtensionProfileSelectionScope, string | null>;
      };
  fingerprint: string;
  expiresAt: number;
}

/** Runtime hooks supplied after config composition has been constructed. */
export interface ExtensionProfileRuntimeBinding {
  readWorkspaceTrust(): WorkspaceTrustVerdict;
  approveWorkspace(): void;
  /** Whether changing executable trust would mutate an in-flight run snapshot. */
  hasActiveRuns?(): boolean;
}

/** One pinned skill withdrawn after its directory changes on disk. */
export interface ExtensionProfileSkillDriftNotice {
  name: string;
  scope: SkillInfo["scope"];
  source: SkillInfo["source"];
  path: string;
}

/** Minimal watcher handle used by the Extension Profile's asynchronous drift monitor. */
interface SkillPathWatcher {
  close(): void;
}

/** File-backed Extension Profile manager options. */
export interface ExtensionProfileManagerOptions {
  globalDir: string;
  workspaceRoot: string;
  pluginContributions: PluginContributions;
  /** Home directory owning user-scoped `.agents/skills` and `.agents/plugins`. */
  home?: string;
  cliSelection?: string;
  logger?: Logger;
  /** Inform a host that one skill was withdrawn from the pinned runtime catalog. */
  onSkillDrift?: (notice: ExtensionProfileSkillDriftNotice) => void;
  /** Injectable watcher seam for deterministic tests. */
  watchSkillPath?: (path: string, onChange: () => void) => SkillPathWatcher;
}

/** Stable qualified string identity used in traces, sessions and diagnostics. */
export function extensionProfileId(ref: ExtensionProfileRef): string {
  return `${ref.scope}:${ref.name}`;
}

/** Canonical key for one exact plugin installation. */
function pluginRefId(ref: ExtensionProfilePluginRef): string {
  return `${ref.scope}:${ref.source}:${ref.name}`;
}

/** Filesystem-shaped plugin identity for operator-facing diagnostics. */
function pluginRefLabel(ref: ExtensionProfilePluginRef): string {
  return `${ref.scope}/${ref.source}/${ref.name}`;
}

/** Plugins inherited from the workspace rather than installed in an operator-owned inventory. */
function workspacePluginRefs(
  definition: ExtensionProfileDefinition | undefined,
): ExtensionProfilePluginRef[] {
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
function extensionProfileRef(value: unknown): ExtensionProfileRef {
  const ref = parsedInput(extensionProfileRefSchema, value, "invalid Extension Profile reference");
  if (ref.scope === "builtin" && ref.name !== BUILTIN_REF.name) {
    throw kernelError("not_found", `unknown builtin Extension Profile '${ref.name}'`);
  }
  return ref;
}

/** Exact-byte revision used by Extension Profile definition CAS. */
function documentRevision(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Compare two qualified references without relying on object identity. */
function sameRef(left: ExtensionProfileRef, right: ExtensionProfileRef): boolean {
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
    if (stat.size > MAX_EXTENSION_PROFILE_BYTES) {
      return {
        error: `${label} exceeds the ${String(MAX_EXTENSION_PROFILE_BYTES)}-byte resource limit`,
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
  ref: ExtensionProfileRef,
  raw: string,
): { definition?: ExtensionProfileDefinition; error?: string } {
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
      error: "a global Extension Profile may reference only global plugins and user-scoped skills",
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
    return {
      error: `Extension Profile directory could not be created: ${(error as Error).message}`,
    };
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
    return {
      error: `Extension Profile directory could not be opened: ${(error as Error).message}`,
    };
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
      if (entries > MAX_EXTENSION_PROFILE_DIRECTORY_ENTRIES) {
        return {
          error:
            `Extension Profile directory exceeds the ` +
            `${String(MAX_EXTENSION_PROFILE_DIRECTORY_ENTRIES)}-entry resource limit`,
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
    return {
      error: `Extension Profile directory could not be read: ${(scanFailure as Error).message}`,
    };
  }
  if (names.length > MAX_EXTENSION_PROFILES_PER_SCOPE) {
    return {
      error:
        `Extension Profile directory contains more than ` +
        `${String(MAX_EXTENSION_PROFILES_PER_SCOPE)} definitions`,
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

/** Exact Extension Profile delta between two resolved snapshots. */
function deltaOf(
  current: ResolvedExtensionProfile,
  target: ResolvedExtensionProfile,
): ExtensionProfileDelta {
  const pluginKey = (plugin: ResolvedExtensionProfilePlugin): string => pluginRefId(plugin.ref);
  const currentPlugins = current.plugins.filter((plugin) => plugin.active);
  const targetPlugins = target.plugins.filter((plugin) => plugin.active);
  const currentPluginKeys = new Set(currentPlugins.map(pluginKey));
  const targetPluginKeys = new Set(targetPlugins.map(pluginKey));
  const currentSkills = [
    ...current.standalone_skills
      .filter((skill) => skill.active)
      .map((skill) =>
        extensionProfileId({
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
        extensionProfileId({
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
 * Create the file-backed Extension Profile resolver and protocol service.
 *
 * The first runtime resolution is pinned for this manager's lifetime. Definition
 * and selection mutations remain visible to management reads and return
 * `reconnect_required`, but cannot mutate an execution already using this kernel.
 */
export function createExtensionProfileManager(options: ExtensionProfileManagerOptions): {
  service: ExtensionProfileService;
  bindRuntime(binding: ExtensionProfileRuntimeBinding): void;
  resolveActive(
    enabledPlugins: readonly ExtensionProfilePluginRef[],
    workspaceTrust: WorkspaceTrustVerdict,
  ): ResolvedExtensionProfile;
  activePlugins(): ExtensionProfilePluginRef[];
  skillRoots(): SkillRootInput[];
  pinnedSkillRoots(): SkillRootInput[];
  observeSkillCatalog(skills: readonly SkillContent[]): void;
  verifySkillCatalog(skills: readonly SkillContent[]): void;
  skillAvailable(skill: SkillInfo): boolean;
  onSkillRootsChanged(listener: () => void): () => void;
  runRef(): ExtensionProfileRunRef;
  workspaceTrustSurface(options?: { refresh?: boolean }): unknown;
  assertWorkspaceTrustTransitionAllowed(): void;
  close(): void;
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
  let runtime: ExtensionProfileRuntimeBinding | undefined;
  let pinned: ResolvedExtensionProfile | undefined;
  let pinnedEnabled: readonly ExtensionProfilePluginRef[] = [];
  let pinnedTrust: WorkspaceTrustVerdict = { state: "inert" };
  const driftedSkillDirs = new Set<string>();
  const skillWatchers = new Map<string, SkillPathWatcher[]>();
  const skillRootListeners = new Set<() => void>();
  let workspaceTrustSurfaceCaptured = false;
  let capturedWorkspaceTrustSurface: unknown;
  let closed = false;
  const watchSkillPath =
    options.watchSkillPath ??
    ((path: string, onChange: () => void): SkillPathWatcher => {
      const listener = (
        current: { mtimeMs: number; ctimeMs: number; size: number; mode: number },
        previous: { mtimeMs: number; ctimeMs: number; size: number; mode: number },
      ): void => {
        if (
          current.mtimeMs === previous.mtimeMs &&
          current.ctimeMs === previous.ctimeMs &&
          current.size === previous.size &&
          current.mode === previous.mode
        )
          return;
        onChange();
      };
      watchFile(path, { persistent: false, interval: 1_000 }, listener);
      return { close: () => unwatchFile(path, listener) };
    });

  const definitionDir = (scope: Scope): string =>
    scope === "global" ? global.extensionProfilesDir : workspace.extensionProfilesDir;
  const definitionPath = (ref: ExtensionProfileRef): string | undefined =>
    ref.scope === "builtin" ? undefined : join(definitionDir(ref.scope), `${ref.name}.json`);
  const selectionPath = (scope: ExtensionProfileSelectionScope): string =>
    scope === "global"
      ? global.extensionProfileSelectionFile
      : workspaceState.extensionProfileSelectionFile;
  const assertSelectionTarget = (
    scope: ExtensionProfileSelectionScope,
    ref: ExtensionProfileRef,
  ): void => {
    if (scope === "global" && ref.scope === "workspace") {
      throw kernelError("invalid_request", GLOBAL_SELECTION_WORKSPACE_ERROR);
    }
  };
  const assertSelectionMutationAllowed = (): void => {
    if (options.cliSelection !== undefined) {
      throw kernelError("conflict", CLI_SELECTION_MUTATION_ERROR);
    }
  };

  /** Run one synchronous filesystem transaction under a crash-recoverable local lease. */
  const underLease = <T>(path: string, label: string, operation: () => T): T => {
    const lease = acquireLocalLeaseSync(`${path}.lock`, {
      staleMs: EXTENSION_PROFILE_LOCK_STALE_MS,
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
    scopes: readonly ExtensionProfileSelectionScope[],
    operation: () => T,
  ): T => {
    const ordered = [...new Set(scopes)].sort((left, right) => left.localeCompare(right));
    const run = (index: number): T => {
      const scope = ordered[index];
      if (scope === undefined) return operation();
      return underLease(selectionPath(scope), `${scope} Extension Profile selection`, () =>
        run(index + 1),
      );
    };
    return run(0);
  };

  /** Lock an authored definition while a mutation validates its exact resolved target. */
  const underDefinitionLease = <T>(selection: SelectedExtensionProfile, operation: () => T): T => {
    if (selection.error !== undefined || selection.ref.scope === "builtin") return operation();
    return underLease(
      definitionPath(selection.ref)!,
      `Extension Profile '${extensionProfileId(selection.ref)}'`,
      operation,
    );
  };

  /** Exact selection-document revision; malformed JSON still has valid compare-and-swap bytes. */
  const selectionRevision = (scope: ExtensionProfileSelectionScope): string | null => {
    const document = readBounded(selectionPath(scope), `${scope} Extension Profile selection`);
    if (document.missing === true) return null;
    if (document.revision !== undefined) return document.revision;
    throw kernelError("unavailable", document.error ?? `${scope} selection could not be read`);
  };

  const selectionRevisions = (): Record<ExtensionProfileSelectionScope, string | null> => ({
    global: selectionRevision("global"),
    workspace: selectionRevision("workspace"),
  });

  const readDefinition = (input: ExtensionProfileRef): ExtensionProfileDefinitionView => {
    const ref = extensionProfileRef(input);
    if (ref.scope === "builtin") return { ref: BUILTIN_REF, immutable: true };
    const path = definitionPath(ref)!;
    const document = readBounded(path, `Extension Profile '${extensionProfileId(ref)}'`);
    if (document.missing === true) {
      return {
        ref,
        immutable: false,
        error: `Extension Profile '${extensionProfileId(ref)}' does not exist`,
      };
    }
    if (document.raw === undefined) {
      return {
        ref,
        immutable: false,
        error: document.error ?? "Extension Profile could not be read",
      };
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
    scope: ExtensionProfileSelectionScope,
  ): { missing?: true; ref?: ExtensionProfileRef; error?: string } => {
    const document = readBounded(selectionPath(scope), `${scope} Extension Profile selection`);
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
    const ref = parsed.data.extension_profile;
    if (ref.scope === "builtin" && ref.name !== BUILTIN_REF.name) {
      return { error: `unknown builtin Extension Profile '${ref.name}'` };
    }
    if (scope === "global" && ref.scope === "workspace") {
      return { error: GLOBAL_SELECTION_WORKSPACE_ERROR };
    }
    return { ref };
  };

  const selectorRef = (selector: string): ExtensionProfileRef => {
    const trimmed = selector.trim();
    const separator = trimmed.indexOf(":");
    if (separator > 0) {
      const scope = trimmed.slice(0, separator);
      const name = trimmed.slice(separator + 1);
      if (!(["builtin", "global", "workspace"] as string[]).includes(scope)) {
        throw kernelError("invalid_request", `unknown Extension Profile scope '${scope}'`);
      }
      return extensionProfileRef({ scope, name });
    }
    if (trimmed === "default") return BUILTIN_REF;
    if (!NAME_RE.test(trimmed))
      throw kernelError("invalid_request", "invalid --extension-profile value");
    const workspaceRef: ExtensionProfileRef = { scope: "workspace", name: trimmed };
    const workspaceDocument = readBounded(
      definitionPath(workspaceRef)!,
      `Extension Profile '${extensionProfileId(workspaceRef)}'`,
    );
    if (workspaceDocument.missing !== true) return workspaceRef;
    return { scope: "global", name: trimmed };
  };

  const selectedNow = (without?: ExtensionProfileSelectionScope): SelectedExtensionProfile => {
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
    ref: ExtensionProfileRef,
    scope: ExtensionProfileSelectionScope,
  ): SelectedExtensionProfile => {
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
    selected?: readonly ExtensionProfileSkillRef[],
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
              { event: "kernel.extension_profile.skill_warning", warning: message.trimEnd() },
              "a standalone skill was skipped while resolving the Extension Profile inventory",
            ),
          logger,
        });
        for (const info of skills.listSkills()) {
          const ref: ExtensionProfileSkillRef = {
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
                  dependencies: info.dependencies,
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
            event: "kernel.extension_profile.skill_root_failed",
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
    selected?: readonly ExtensionProfileSkillRef[],
  ): (StandaloneInventoryEntry & { digest: string })[] => {
    const out: (StandaloneInventoryEntry & { digest: string })[] = [];
    for (const entry of standaloneCatalog(selected)) {
      try {
        const digest = entry.loadDigest();
        if (digest !== undefined) out.push({ ...entry, digest });
      } catch (error) {
        logger.warn(
          {
            event: "kernel.extension_profile.skill_read_failed",
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
  ): ExtensionProfileSkillRef[] => {
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

  const pluginInventory = (
    selected?: readonly ExtensionProfilePluginRef[],
  ): PluginInventoryEntry[] => {
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
      const view: ResolvedExtensionProfilePlugin = {
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
    selection: SelectedExtensionProfile,
    enabledPlugins: readonly ExtensionProfilePluginRef[],
    workspaceTrust: WorkspaceTrustVerdict,
    assumeWorkspaceTrusted = false,
    pinContributions = false,
    definitionOverride?: ExtensionProfileDefinitionView,
  ): ResolvedExtensionProfile => {
    const definitionView =
      selection.error === undefined
        ? definitionOverride !== undefined && sameRef(definitionOverride.ref, selection.ref)
          ? definitionOverride
          : readDefinition(selection.ref)
        : undefined;
    const issues: ExtensionProfileIssue[] = [];
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
          "the workspace Extension Profile selects workspace-owned executable plugins but its current fingerprint is not approved",
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
    const pluginViews: ResolvedExtensionProfilePlugin[] = validDefinition
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
    const skillViews: ResolvedExtensionProfileSkill[] = validDefinition
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
                event: "kernel.extension_profile.skill_read_failed",
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
      id: extensionProfileId(selection.ref),
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
      id: extensionProfileId(selection.ref),
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
    selection: SelectedExtensionProfile,
    assumeTrusted = false,
  ): ResolvedExtensionProfile => {
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
    selection: SelectedExtensionProfile,
    definition: ExtensionProfileDefinitionView,
    assumeTrusted = false,
  ): ResolvedExtensionProfile => {
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

  const freshTarget = (
    input: ExtensionProfileRef,
    assumeTrusted = false,
  ): ResolvedExtensionProfile => {
    const ref = extensionProfileRef(input);
    return freshSelection(
      {
        ref,
        origin:
          ref.scope === "workspace" ? "workspace" : ref.scope === "global" ? "global" : "builtin",
      },
      assumeTrusted,
    );
  };

  const activePlugins = (): ExtensionProfilePluginRef[] =>
    (pinned?.plugins ?? []).filter((plugin) => plugin.active).map((plugin) => plugin.ref);

  /** Project roots from the pinned snapshot without touching filesystem state. */
  const pinnedSkillRoots = (): SkillRootInput[] => {
    if (pinned === undefined)
      throw kernelError("unavailable", "Extension Profile has not been resolved");
    const pluginRoots = options.pluginContributions.pinnedSkillRoots(activePlugins());
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

  const skillRoots = (): SkillRootInput[] => pinnedSkillRoots();

  /** Release monitors for a catalog that is about to be replaced at an idle trust boundary. */
  const resetSkillMonitoring = (): void => {
    for (const watchers of skillWatchers.values()) {
      for (const watcher of watchers) watcher.close();
    }
    skillWatchers.clear();
    driftedSkillDirs.clear();
  };

  /**
   * Watch each admitted skill directory after one exact catalog capture.
   *
   * @remarks Watch callbacks only flip an in-memory latch and publish a notice.
   * They never rescan, hash, or mutate run admission. A changed skill remains
   * withdrawn until an explicit snapshot replacement captures new bytes.
   */
  const withdrawSkill = (skill: SkillInfo): void => {
    if (closed || driftedSkillDirs.has(skill.dir)) return;
    driftedSkillDirs.add(skill.dir);
    for (const watcher of skillWatchers.get(skill.dir) ?? []) watcher.close();
    skillWatchers.delete(skill.dir);
    logger.warn(
      {
        event: "kernel.extension_profile.skill_drift",
        skill: skill.name,
        scope: skill.scope,
        source: skill.source,
        path: skill.path,
      },
      "a changed skill was withdrawn from the process snapshot; runs remain available",
    );
    try {
      options.onSkillDrift?.({
        name: skill.name,
        scope: skill.scope,
        source: skill.source,
        path: skill.path,
      });
    } catch (error) {
      logger.warn(
        {
          event: "kernel.extension_profile.skill_drift_notice_failed",
          skill: skill.name,
          cause: error instanceof Error ? error.message : String(error),
        },
        "the host's skill drift notice callback failed",
      );
    }
  };

  const observeSkillCatalog = (skills: readonly SkillContent[]): void => {
    if (closed) return;
    for (const skill of skills) {
      if (skillWatchers.has(skill.dir)) continue;
      const onChange = (): void => withdrawSkill(skill);
      const paths = new Set<string>(
        skill.identityFiles ?? [skill.path, ...skill.resources.map((resource) => resource.path)],
      );
      const watchers: SkillPathWatcher[] = [];
      let lastError: unknown;
      for (const path of paths) {
        try {
          watchers.push(watchSkillPath(path, onChange));
        } catch (error) {
          lastError = error;
        }
      }
      if (watchers.length > 0) {
        skillWatchers.set(skill.dir, watchers);
      } else {
        logger.warn(
          {
            event: "kernel.extension_profile.skill_watch_unavailable",
            skill: skill.name,
            path: skill.dir,
            cause: lastError instanceof Error ? lastError.message : String(lastError),
          },
          "live skill drift monitoring is unavailable for one pinned skill",
        );
      }
    }
  };

  const skillAvailable = (skill: SkillInfo): boolean => !driftedSkillDirs.has(skill.dir);

  /** Re-read admitted skill identities after watchers are armed and compare them with the pin. */
  const verifySkillCatalog = (skills: readonly SkillContent[]): void => {
    if (pinned === undefined)
      throw kernelError("unavailable", "Extension Profile has not been resolved");
    for (const skill of options.pluginContributions.verifyPinnedSkillCatalog(skills)) {
      withdrawSkill(skill);
    }
    const selected = pinned.standalone_skills
      .filter((skill) => skill.active)
      .map((skill) => skill.ref);
    const expected = new Map(
      pinned.standalone_skills
        .filter((skill) => skill.active && skill.digest !== undefined)
        .map((skill) => [
          `${skill.ref.scope}\0${skill.ref.source}\0${skill.ref.name}`,
          skill.digest!,
        ]),
    );
    const current = new Map(
      standaloneInventory(selected).map((skill) => [
        `${skill.ref.scope}\0${skill.ref.source}\0${skill.ref.name}`,
        skill.digest,
      ]),
    );
    for (const skill of skills) {
      if (skill.source.startsWith("plugin:")) continue;
      const key = `${skill.scope}\0${skill.source}\0${skill.name}`;
      const pinnedDigest = expected.get(key);
      if (pinnedDigest === undefined || current.get(key) !== pinnedDigest) withdrawSkill(skill);
    }
  };

  /** Subscribe to idle trust recompositions that replace the exact skill-root set. */
  const onSkillRootsChanged = (listener: () => void): (() => void) => {
    if (closed) return () => undefined;
    skillRootListeners.add(listener);
    return () => skillRootListeners.delete(listener);
  };

  /** Replace subscribers synchronously while no run can observe the old trust catalog. */
  const publishSkillRootsChanged = (): void => {
    resetSkillMonitoring();
    for (const listener of [...skillRootListeners]) {
      try {
        listener();
      } catch (error) {
        logger.warn(
          {
            event: "kernel.extension_profile.skill_recomposition_failed",
            cause: error instanceof Error ? error.message : String(error),
          },
          "a skill catalog subscriber failed during an idle trust recomposition",
        );
      }
    }
  };

  /**
   * Capture the complete bounded repository-plugin inventory for workspace trust.
   *
   * This is resolved by the kernel after Code's lightweight startup composer has
   * painted, then reused without filesystem work on ordinary settings reads. An
   * explicit approval refreshes it before recording trust; reconnect captures a
   * new process snapshot. Invalid checkouts remain represented with a null digest.
   */
  const workspaceTrustSurface = (request?: { refresh?: boolean }): unknown => {
    if (workspaceTrustSurfaceCaptured && request?.refresh !== true) {
      return capturedWorkspaceTrustSurface;
    }
    const plugins = pluginInventory()
      .map((entry) => entry.view)
      .filter((plugin) => plugin.ref.scope === "workspace")
      .sort((left, right) => pluginRefId(left.ref).localeCompare(pluginRefId(right.ref)));
    capturedWorkspaceTrustSurface =
      plugins.length === 0
        ? undefined
        : (() => {
            const snapshots = new Map(
              options.pluginContributions
                .snapshot(plugins.map((plugin) => plugin.ref))
                .map((snapshot) => [pluginRefId(snapshot.ref), snapshot] as const),
            );
            return Object.freeze({
              plugins: Object.freeze(
                plugins.map((plugin) => {
                  const snapshot = snapshots.get(pluginRefId(plugin.ref));
                  return Object.freeze({
                    ref: Object.freeze({ ...plugin.ref }),
                    digest: snapshot?.digest ?? null,
                  });
                }),
              ),
            });
          })();
    workspaceTrustSurfaceCaptured = true;
    return capturedWorkspaceTrustSurface;
  };

  const assertWorkspaceTrustTransitionAllowed = (): void => {
    if (runtime?.hasActiveRuns?.() === true) {
      throw kernelError(
        "conflict",
        "finish active runs before changing trust for the selected workspace Extension Profile",
      );
    }
  };

  const list = async (): Promise<ExtensionProfileDefinitionView[]> => {
    const out: ExtensionProfileDefinitionView[] = [{ ref: BUILTIN_REF, immutable: true }];
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

  const inventory = async (): Promise<ExtensionProfileInventory> => ({
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
    target: ResolvedExtensionProfile,
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
    ref: ExtensionProfileRef,
    definition: ExtensionProfileDefinition | undefined,
    trust: WorkspaceTrustVerdict,
  ): boolean => {
    if (ref.scope !== "workspace" || workspacePluginRefs(definition).length === 0) return false;
    return trust.state !== "trusted";
  };

  const compositionDefinition = (
    input: ExtensionProfileCompositionInput,
  ): {
    serialized: string;
    view: ExtensionProfileDefinitionView & {
      revision: string;
      definition: ExtensionProfileDefinition;
    };
  } => {
    const serialized = `${JSON.stringify(input.definition, null, 2)}\n`;
    const parsed = parseDefinition(input.ref, serialized);
    if (parsed.definition === undefined) {
      throw kernelError("invalid_request", parsed.error ?? "invalid Extension Profile definition");
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
        throw kernelError(
          "conflict",
          `Extension Profile '${extensionProfileId(ref)}' already exists`,
        );
      }
      throw kernelError(
        "unavailable",
        current.error ?? `Extension Profile '${extensionProfileId(ref)}' could not be inspected`,
      );
    }
    if (current.revision !== expectedRevision) {
      throw kernelError("conflict", "Extension Profile changed since it was read", {
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
      (catalog.names?.length ?? 0) >= MAX_EXTENSION_PROFILES_PER_SCOPE ||
      (catalog.entries ?? 0) >= MAX_EXTENSION_PROFILE_DIRECTORY_ENTRIES
    ) {
      throw kernelError(
        "resource_exhausted",
        `Extension Profile catalog '${scope}' has reached its definition or entry limit`,
        {
          definitions: catalog.names?.length ?? 0,
          definition_limit: MAX_EXTENSION_PROFILES_PER_SCOPE,
          entries: catalog.entries ?? 0,
          entry_limit: MAX_EXTENSION_PROFILE_DIRECTORY_ENTRIES,
        },
      );
    }
  };

  const compositionNeedsWorkspaceTrust = (
    input: ExtensionProfileCompositionInput,
    effective: SelectedExtensionProfile,
    definition: ExtensionProfileDefinitionView,
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
    raw: ExtensionProfileCompositionInput,
  ): Promise<ExtensionProfileCompositionPreview> => {
    const input = parsedInput(
      compositionInputSchema,
      raw,
      "invalid Extension Profile composition input",
    );
    assertSelectionTarget(input.selection_scope, input.ref);
    assertSelectionMutationAllowed();
    if (pinned === undefined)
      throw kernelError("unavailable", "Extension Profile has not been resolved");
    const before = readBounded(
      definitionPath(input.ref)!,
      `Extension Profile '${extensionProfileId(input.ref)}'`,
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
    input: ExtensionProfileRef,
    inputOptions: { selection_scope: ExtensionProfileSelectionScope },
  ): Promise<ExtensionProfilePreview> => {
    const ref = extensionProfileRef(input);
    const previewOptions = parsedInput(
      previewOptionsSchema,
      inputOptions,
      "invalid Extension Profile preview options",
    );
    assertSelectionTarget(previewOptions.selection_scope, ref);
    assertSelectionMutationAllowed();
    if (pinned === undefined)
      throw kernelError("unavailable", "Extension Profile has not been resolved");
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

  const previewClear = async (
    input: ExtensionProfileSelectionScope,
  ): Promise<ExtensionProfilePreview> => {
    const scope = parsedInput(
      z.enum(["global", "workspace"]),
      input,
      "invalid Extension Profile selection scope",
    );
    assertSelectionMutationAllowed();
    if (pinned === undefined)
      throw kernelError("unavailable", "Extension Profile has not been resolved");
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
    ref: ExtensionProfileRef,
    scope: ExtensionProfileSelectionScope,
  ): ExtensionProfileApplyResult => {
    assertSelectionMutationAllowed();
    assertSelectionTarget(scope, ref);
    writeFileAtomicSync(
      selectionPath(scope),
      `${JSON.stringify({ schema_version: 1, extension_profile: ref }, null, 2)}\n`,
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
        const current = readBounded(path, `Extension Profile '${extensionProfileId(ref)}'`);
        assertExpectedDefinition(ref, expectedRevision, current);
        if (expectedRevision === null) assertCatalogCapacity(ref.scope);
        return operation(current, path);
      });
    return expectedRevision === null
      ? underLease(definitionDir(ref.scope), `${ref.scope} Extension Profile catalog`, mutate)
      : mutate();
  };

  const writeDefinition = (
    input: ExtensionProfileDefinitionInput,
    expectedRevision?: string,
  ): ExtensionProfileDefinitionView => {
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

  const restoreSelection = (scope: ExtensionProfileSelectionScope, before: ReadDocument): void => {
    if (before.missing === true) {
      rmSync(selectionPath(scope), { force: true });
      return;
    }
    if (before.raw === undefined) {
      throw kernelError(
        "unavailable",
        "the previous Extension Profile selection cannot be restored",
      );
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
      throw kernelError(
        "unavailable",
        "the previous Extension Profile definition cannot be restored",
      );
    }
    writeFileAtomicSync(path, before.raw);
  };

  const applyComposition = async (
    raw: ExtensionProfileCompositionInput,
    rawOptions: { preview_token: string; approve_workspace?: boolean },
  ): Promise<ExtensionProfileCompositionApplyResult> => {
    const input = parsedInput(
      compositionInputSchema,
      raw,
      "invalid Extension Profile composition input",
    );
    const applyOptions = parsedInput(
      compositionApplyOptionsSchema,
      rawOptions,
      "invalid Extension Profile composition apply options",
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
        "Extension Profile composition preview is missing, expired, or names another draft",
      );
    }
    assertSelectionTarget(input.selection_scope, input.ref);
    assertSelectionMutationAllowed();
    if (pinned === undefined)
      throw kernelError("unavailable", "Extension Profile has not been resolved");
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
            "Extension Profile selections changed since the composition preview was created",
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
            "the effective Extension Profile changed since the composition preview was created",
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
            "Extension Profile inventory or definition changed since the composition preview",
          );
        }
        if (requiresWorkspaceTrust && applyOptions.approve_workspace !== true) {
          throw kernelError(
            "conflict",
            "the previewed workspace Extension Profile requires explicit trust approval",
          );
        }
        if (requiresWorkspaceTrust && runtime === undefined) {
          throw kernelError("unavailable", "workspace trust is unavailable");
        }
        const beforeSelection = readBounded(
          selectionPath(input.selection_scope),
          `${input.selection_scope} Extension Profile selection`,
        );
        if (beforeSelection.error !== undefined) {
          throw kernelError(
            "unavailable",
            "the previous Extension Profile selection cannot be snapshotted before composition",
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
              "Extension Profile composition failed and its prior state could not be fully restored",
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

  const service: ExtensionProfileService = {
    list,
    async current() {
      if (pinned === undefined)
        throw kernelError("unavailable", "Extension Profile has not been resolved");
      return pinned;
    },
    async get(ref) {
      return freshTarget(extensionProfileRef(ref));
    },
    inventory,
    preview,
    previewClear,
    previewComposition,
    async select(inputRef, inputOptions) {
      const ref = extensionProfileRef(inputRef);
      const selectOptions = parsedInput(
        selectOptionsSchema,
        inputOptions,
        "invalid Extension Profile selection options",
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
          "Extension Profile preview is missing, expired, or names another target",
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
              "Extension Profile selection changed since the preview was created",
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
            throw kernelError(
              "conflict",
              "Extension Profile changed since the preview was created",
            );
          }
          if (selectOptions.approve_workspace === true && requiresTrust) {
            if (runtime === undefined)
              throw kernelError("unavailable", "workspace trust is unavailable");
            const before = readBounded(
              selectionPath(selectOptions.selection_scope),
              `${selectOptions.selection_scope} Extension Profile selection`,
            );
            if (before.error !== undefined) {
              throw kernelError(
                "unavailable",
                "the previous Extension Profile selection cannot be snapshotted before approval",
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
        "invalid Extension Profile selection scope",
      );
      const clearOptions = parsedInput(
        clearOptionsSchema,
        inputOptions,
        "invalid Extension Profile clear options",
      );
      assertSelectionMutationAllowed();
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
          "Extension Profile clear preview is missing, expired, or names another selection scope",
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
              "Extension Profile selections changed since the clear preview was created",
            );
          }
          const target = freshSelection(selectedNow(scope));
          if (target.fingerprint !== entry.fingerprint) {
            throw kernelError(
              "conflict",
              "Extension Profile fallback changed since the preview was created",
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
        parsedInput(definitionInputSchema, input, "invalid Extension Profile definition input"),
      );
    },
    async update(input) {
      const update = parsedInput(
        definitionUpdateInputSchema,
        input,
        "invalid Extension Profile definition update",
      );
      return writeDefinition(update, update.expected_revision);
    },
    async delete(inputRef, inputOptions) {
      const ref = parsedInput(
        authoredRefSchema,
        inputRef,
        "invalid Extension Profile definition reference",
      );
      const deleteOptions = parsedInput(
        definitionDeleteOptionsSchema,
        inputOptions,
        "invalid Extension Profile deletion options",
      );
      return withDefinitionMutation(ref, deleteOptions.expected_revision, (_current, path) =>
        underSelectionLeases(["global", "workspace"], () => {
          if (pinned !== undefined && sameRef(pinned.ref, ref)) {
            throw kernelError(
              "conflict",
              `Extension Profile '${extensionProfileId(ref)}' is active; select another Extension Profile and reconnect before deleting it`,
            );
          }
          for (const scope of ["global", "workspace"] as const) {
            const selection = selectionFromFile(scope);
            if (selection.error !== undefined) {
              throw kernelError(
                "unavailable",
                `the ${scope} Extension Profile selection must be repaired before deleting a definition`,
              );
            }
            if (selection.ref !== undefined && sameRef(selection.ref, ref)) {
              throw kernelError(
                "conflict",
                `Extension Profile '${extensionProfileId(ref)}' is selected for ${scope}; clear that selection before deleting it`,
              );
            }
          }
          rmSync(path);
        }),
      );
    },
    async clone(inputSource, inputTarget) {
      const source = extensionProfileRef(inputSource);
      const target = parsedInput(
        authoredRefSchema,
        inputTarget,
        "invalid Extension Profile clone target",
      );
      const sourceView = readDefinition(source);
      if (source.scope === "builtin") {
        if (pinned === undefined)
          throw kernelError("unavailable", "Extension Profile has not been resolved");
        const builtin = freshTarget(BUILTIN_REF);
        const definition: ExtensionProfileDefinition = {
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
        throw kernelError(
          "invalid_request",
          sourceView.error ?? "source Extension Profile is invalid",
        );
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
        publishSkillRootsChanged();
        return pinned;
      }
      const startedAt = Date.now();
      pinnedEnabled = [...enabledPlugins];
      pinnedTrust = workspaceTrust;
      pinned = resolved(selectedNow(), pinnedEnabled, pinnedTrust, false, true);
      logger.info(
        {
          event: "kernel.extension_profile.resolved",
          extension_profile_id: pinned.id,
          fingerprint: pinned.fingerprint,
          status: pinned.status,
          plugins: pinned.counts.plugins_active,
          skills: pinned.counts.standalone_skills_active + pinned.counts.plugin_skills_active,
          duration_ms: Date.now() - startedAt,
        },
        "the kernel Extension Profile is pinned for this process",
      );
      return pinned;
    },
    activePlugins,
    skillRoots,
    pinnedSkillRoots,
    observeSkillCatalog,
    verifySkillCatalog,
    skillAvailable,
    onSkillRootsChanged,
    runRef() {
      if (pinned === undefined)
        throw kernelError("unavailable", "Extension Profile has not been resolved");
      return { id: pinned.id, fingerprint: pinned.fingerprint };
    },
    workspaceTrustSurface,
    assertWorkspaceTrustTransitionAllowed,
    close() {
      if (closed) return;
      closed = true;
      resetSkillMonitoring();
      skillRootListeners.clear();
    },
  };
}
