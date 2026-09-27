import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { relative, sep } from "node:path";
import { z } from "zod";
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
import { SYSTEM_DOCS_NAME } from "../skills/system-docs.ts";
import type {
  ExtensionProfileCompositionApplyResult,
  ExtensionProfileCompositionInput,
  ExtensionProfileCompositionPreview,
  ExtensionProfileDefinition,
  ExtensionProfileDefinitionInput,
  ExtensionProfileDefinitionView,
  ExtensionProfileInventory,
  ExtensionProfilePluginRef,
  ExtensionProfilePreview,
  ExtensionProfileRef,
  ExtensionProfileRunRef,
  ExtensionProfileSelectionScope,
  ExtensionProfileService,
  ExtensionProfileSkillRef,
  ResolvedExtensionProfile,
  ResolvedExtensionProfilePlugin,
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
import {
  createProfileRepository,
  documentRevision,
  assertSelectionTarget,
  PROFILE_NAME_RE,
} from "./profile-repository.ts";
import {
  extensionProfileId,
  pluginRefId,
  fingerprintOf,
  deltaOf,
  defaultStandaloneSelection,
  prepareProfileResolution,
  resolveProfileData,
  type SelectedExtensionProfile,
} from "./profile-resolution.ts";
export { extensionProfileId } from "./profile-resolution.ts";
import {
  createSkillCatalogMonitor,
  watchSkillPath as defaultWatchSkillPath,
  type SkillPathWatcher,
} from "./skill-catalog-monitor.ts";

const BUILTIN_REF: ExtensionProfileRef = { scope: "builtin", name: "default" };
const PREVIEW_TTL_MS = 5 * 60_000;
const MAX_PREVIEWS = 32;
const CLI_SELECTION_MUTATION_ERROR =
  "the active --extension-profile override cannot be changed by this process";

const nameSchema = z.string().regex(PROFILE_NAME_RE, "must be a safe Extension Profile identifier");
const pluginRefSchema = z
  .object({
    scope: z.enum(["global", "workspace"]),
    source: z.literal("agents"),
    name: nameSchema,
  })
  .strict();
const skillRefSchema = z
  .object({
    scope: z.enum(["user", "workspace"]),
    source: z.literal("agents"),
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
  /** Test seam for failures between definition, selection and rollback writes. */
  profileWriteDocument?: (path: string, data: string) => void;
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

/** Compare two qualified references without relying on object identity. */
function sameRef(left: ExtensionProfileRef, right: ExtensionProfileRef): boolean {
  return left.scope === right.scope && left.name === right.name;
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
  onSkillRootsChanged(listener: (retainOnFailure?: boolean) => void): () => void;
  requestSkillRefresh(): void;
  flushSkillRefresh(): void;
  runRef(): ExtensionProfileRunRef;
  workspaceTrustSurface(options?: { refresh?: boolean }): unknown;
  assertWorkspaceTrustTransitionAllowed(): void;
  close(): void;
} {
  const logger = options.logger ?? NOOP_LOGGER;
  const standardRoots = clarvisSkillRoots({
    workspace: options.workspaceRoot,
    ...(options.home === undefined ? {} : { home: options.home }),
    env: { CLARVIS_HOME: options.globalDir },
  });
  const repository = createProfileRepository({
    globalDir: options.globalDir,
    workspaceRoot: options.workspaceRoot,
    validateRef: extensionProfileRef,
    parseDefinition,
    profileId: extensionProfileId,
    ...(options.profileWriteDocument === undefined
      ? {}
      : { writeDocument: options.profileWriteDocument }),
  });
  const previews = new Map<string, PreviewEntry>();
  let runtime: ExtensionProfileRuntimeBinding | undefined;
  let pinned: ResolvedExtensionProfile | undefined;
  let authoredProfile: ResolvedExtensionProfile | undefined;
  let pinnedEnabled: readonly ExtensionProfilePluginRef[] = [];
  let pinnedTrust: WorkspaceTrustVerdict = { state: "inert" };
  let workspaceTrustSurfaceCaptured = false;
  let capturedWorkspaceTrustSurface: unknown;
  const monitor = createSkillCatalogMonitor({
    roots: standardRoots,
    logger,
    watchSkillPath: options.watchSkillPath ?? defaultWatchSkillPath,
    onRefresh: () => flushSkillRefresh(),
    ...(options.onSkillDrift === undefined ? {} : { onPluginDrift: options.onSkillDrift }),
  });

  const assertSelectionMutationAllowed = (): void => {
    if (options.cliSelection !== undefined) {
      throw kernelError("conflict", CLI_SELECTION_MUTATION_ERROR);
    }
  };
  const {
    readDefinition,
    selectionFromFile,
    selectionRevisions,
    definitionDocument,
    assertExpectedDefinition,
    assertCatalogCapacity,
  } = repository;

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
    if (!PROFILE_NAME_RE.test(trimmed))
      throw kernelError("invalid_request", "invalid --extension-profile value");
    const workspaceRef: ExtensionProfileRef = { scope: "workspace", name: trimmed };
    if (repository.definitionExists(workspaceRef)) return workspaceRef;
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
          const parts = relative(root.path, info.dir).split(sep);
          if (info.name === SYSTEM_DOCS_NAME || parts.includes(".system")) continue;
          const ref: ExtensionProfileSkillRef = {
            scope: root.scope ?? "workspace",
            source: "agents",
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
    const discovered = standaloneCatalog(
      selection.ref.scope === "builtin" ? undefined : (definitionView?.definition?.skills ?? []),
    );
    const prepared = prepareProfileResolution({
      selection,
      ...(definitionView === undefined ? {} : { definitionView }),
      enabledPlugins,
      workspaceTrust,
      assumeWorkspaceTrusted,
      discovered,
    });
    const contributionSnapshots: readonly PluginContributionSnapshot[] = prepared.validDefinition
      ? pinContributions
        ? prepared.trusted
          ? options.pluginContributions.pin(prepared.selectedPlugins)
          : (() => {
              const snapshots = options.pluginContributions.snapshot(prepared.selectedPlugins);
              options.pluginContributions.pin(prepared.admittedPlugins);
              return snapshots;
            })()
        : options.pluginContributions.snapshot(prepared.selectedPlugins)
      : pinContributions
        ? options.pluginContributions.pin([])
        : [];
    const capturedRefs = new Set(contributionSnapshots.map((entry) => pluginRefId(entry.ref)));
    const unresolvedRefs = prepared.validDefinition
      ? prepared.selectedPlugins.filter((ref) => !capturedRefs.has(pluginRefId(ref)))
      : [];
    const installedPlugins = pluginInventory(unresolvedRefs).map((entry) => entry.view);
    const discoveredByRef = new Map(
      discovered.map((entry) => [
        `${entry.ref.scope}\0${entry.ref.source}\0${entry.ref.name}`,
        entry,
      ]),
    );
    const capturedSkills = prepared.validDefinition
      ? prepared.selectedSkills.flatMap((ref) => {
          const entry = discoveredByRef.get(`${ref.scope}\0${ref.source}\0${ref.name}`);
          if (entry === undefined) return [];
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
          return [{ ref, rootOrder: entry.rootOrder, description: entry.description, digest }];
        })
      : [];
    return resolveProfileData({
      prepared,
      contributionSnapshots,
      installedPlugins,
      capturedSkills,
    });
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
  /** Coalesce authoring changes and publish only when all captured resource users have settled. */
  const flushSkillRefresh = (): void => {
    if (pinned === undefined || runtime?.hasActiveRuns?.()) return;
    if (!monitor.consumeRefresh()) return;
    monitor.observeRoots();
    const candidate = authoredProfile ?? pinned;
    if (
      authoredProfile !== undefined &&
      readDefinition(candidate.ref).revision !== candidate.definition_revision
    )
      return;
    const selected =
      candidate.ref.scope === "builtin" ? undefined : (candidate.definition?.skills ?? []);
    const inventory = standaloneInventory(selected);
    const refs = selected ?? defaultStandaloneSelection(inventory);
    const skills = refs.flatMap((ref) => {
      const entry = inventory.find(
        (item) =>
          item.ref.scope === ref.scope &&
          item.ref.source === ref.source &&
          item.ref.name === ref.name,
      );
      return entry === undefined
        ? []
        : [
            {
              ref,
              active: true,
              found: true,
              description: entry.description,
              digest: entry.digest,
            },
          ];
    });
    if (
      pinned.standalone_skills.some(
        (previous) =>
          previous.active &&
          !skills.some(
            (next) =>
              next.ref.scope === previous.ref.scope &&
              next.ref.source === previous.ref.source &&
              next.ref.name === previous.ref.name,
          ) &&
          existsSync(
            monitor.capturedPath(
              `${previous.ref.scope}/${previous.ref.source}/${previous.ref.name}`,
            ) ?? "",
          ),
      )
    )
      return;
    if (
      authoredProfile === undefined &&
      skills.length === pinned.standalone_skills.length &&
      skills.every((next) =>
        pinned!.standalone_skills.some(
          (prior) =>
            prior.active &&
            prior.ref.scope === next.ref.scope &&
            prior.ref.source === next.ref.source &&
            prior.ref.name === next.ref.name &&
            prior.digest === next.digest,
        ),
      )
    )
      return;
    const previous = pinned;
    const { fingerprint: _previousFingerprint, ...identity } = candidate;
    const next = {
      ...identity,
      standalone_skills: skills,
      counts: { ...candidate.counts, standalone_skills_active: skills.length },
    };
    pinned = { ...next, fingerprint: fingerprintOf(next) };
    if (!monitor.publishRootsChanged(true)) pinned = previous;
    else authoredProfile = undefined;
  };

  /** Re-read admitted skill identities after watchers are armed and compare them with the pin. */
  const verifySkillCatalog = (skills: readonly SkillContent[]): void => {
    if (pinned === undefined)
      throw kernelError("unavailable", "Extension Profile has not been resolved");
    for (const skill of options.pluginContributions.verifyPinnedSkillCatalog(skills)) {
      monitor.withdrawSkill(skill);
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
      if (pinnedDigest === undefined || current.get(key) !== pinnedDigest) {
        monitor.markStandaloneDrift(skill);
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

  const list = async (): Promise<ExtensionProfileDefinitionView[]> => repository.listDefinitions();

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
    const before = definitionDocument(input.ref);
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

  const writeDefinition = (
    input: ExtensionProfileDefinitionInput,
    expectedRevision?: string,
  ): ExtensionProfileDefinitionView => {
    const composition = compositionDefinition({
      ...input,
      expected_revision: expectedRevision ?? null,
      selection_scope: input.ref.scope,
    });
    return repository.withDefinitionMutation(
      input.ref,
      expectedRevision ?? null,
      (_current, tx) => {
        tx.writeDefinition(input.ref, composition.serialized);
        return tx.readDefinition(input.ref);
      },
    );
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
    return repository.withDefinitionMutation(
      input.ref,
      input.expected_revision,
      (beforeDefinition, tx) =>
        tx.withSelectionLeases(["global", "workspace"], () => {
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
          const beforeSelection = tx.selectionDocument(input.selection_scope);
          if (beforeSelection.error !== undefined) {
            throw kernelError(
              "unavailable",
              "the previous Extension Profile selection cannot be snapshotted before composition",
            );
          }
          let definitionWritten = false;
          let selectionWritten = false;
          try {
            tx.writeDefinition(input.ref, proposed.serialized);
            definitionWritten = true;
            tx.writeSelection(input.ref, input.selection_scope);
            selectionWritten = true;
            if (requiresWorkspaceTrust) runtime!.approveWorkspace();
          } catch (error) {
            const rollbackErrors: string[] = [];
            if (selectionWritten) {
              try {
                tx.restoreSelection(input.selection_scope, beforeSelection);
              } catch (rollbackError) {
                rollbackErrors.push(`selection: ${(rollbackError as Error).message}`);
              }
            }
            if (definitionWritten) {
              try {
                tx.restoreDefinition(input.ref, beforeDefinition);
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
            definition: tx.readDefinition(input.ref),
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
      return repository.withSelectedMutation(targetSelection, (tx) => {
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
          throw kernelError("conflict", "Extension Profile changed since the preview was created");
        }
        if (selectOptions.approve_workspace === true && requiresTrust) {
          if (runtime === undefined)
            throw kernelError("unavailable", "workspace trust is unavailable");
          const before = tx.selectionDocument(selectOptions.selection_scope);
          if (before.error !== undefined) {
            throw kernelError(
              "unavailable",
              "the previous Extension Profile selection cannot be snapshotted before approval",
            );
          }
          const result = tx.writeSelection(ref, selectOptions.selection_scope);
          try {
            runtime.approveWorkspace();
          } catch (error) {
            tx.restoreSelection(selectOptions.selection_scope, before);
            throw error;
          }
          return result;
        }
        return tx.writeSelection(ref, selectOptions.selection_scope);
      });
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
      return repository.withSelectedMutation(expectedFallback, (tx) => {
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
        tx.removeSelection(scope);
        return { selected: target.ref, reconnect_required: true };
      });
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
      return repository.withDefinitionMutation(
        ref,
        deleteOptions.expected_revision,
        (_current, tx) =>
          tx.withSelectionLeases(["global", "workspace"], () => {
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
            tx.removeDefinition(ref);
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
        monitor.publishRootsChanged();
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
    observeSkillCatalog: monitor.observeCatalog,
    verifySkillCatalog,
    skillAvailable: monitor.skillAvailable,
    onSkillRootsChanged: (listener) => monitor.onRootsChanged(listener),
    requestSkillRefresh: monitor.requestRefresh,
    flushSkillRefresh: monitor.flushRefresh,
    runRef() {
      if (pinned === undefined)
        throw kernelError("unavailable", "Extension Profile has not been resolved");
      return { id: pinned.id, fingerprint: pinned.fingerprint };
    },
    workspaceTrustSurface,
    assertWorkspaceTrustTransitionAllowed,
    close: () => monitor.close(),
  };
}
