import { sanitizeErrorMessage } from "@clarvis/capability";
import type { SkillContent, SkillInfo, SkillRootInput } from "@clarvis/skills";

export type { SkillRootInput };
import type { EnvConfig, ExtensionAdmissionController, HookConfig } from "@clarvis/capability";
import { createCapabilityRegistry, createExtensionAdmissionController } from "@clarvis/capability";
import {
  createConnectionManager,
  createMCPAuthorizationCoordinator,
  createMCPClientFactory,
  type ConnectionEventSink,
  type MCPAuthorizationOptions,
  type RuntimeEnvironment,
} from "@clarvis/mcp-client";
import { setPathsLogger } from "@clarvis/paths";
import { resolveTraceStore, type ResolvedTraceStore } from "@clarvis/trace";
import {
  admissionStateLogger,
  createAiSdkProvider,
  createModelCallAdmissionController,
  withCallLogging,
  withModelCallAdmission,
  withTransportRetry,
  type ModelCallAdmissionController,
} from "@clarvis/llm";
import {
  activeLevelOf,
  componentLogger,
  levelFor,
  NOOP_LOGGER,
  parseLogScopes,
} from "@clarvis/capability";
import type { Logger } from "@clarvis/capability";
import type { ExecuteRunDeps } from "./execute-run.ts";
import type { SkillsProvider } from "@clarvis/skills/capability";
import type { Capability, RunCapabilityContext } from "@clarvis/capability";
import type { GuardResolver, SandboxResolver, SecretNamesResolver } from "./capabilities/tools.ts";
import type { PluginBootstrapSkill } from "./capabilities/skills-settings.ts";
import { createAskUserCapability } from "./capabilities/ask-user.ts";

/** Host-facing name for the shared physical model-call gate. */
export type HostModelCallAdmission = ModelCallAdmissionController;
/** Host-facing name for the shared physical extension-call gate. */
export type HostExtensionAdmission = ExtensionAdmissionController;

/**
 * Construct the host-owned model-call gate from the validated environment.
 * File/project hosts should create one and inject it into every kernel they own.
 */
export function createHostModelCallAdmission(
  env: Pick<
    EnvConfig,
    | "CLARVIS_MAX_CONCURRENT_MODEL_CALLS"
    | "CLARVIS_MAX_QUEUED_MODEL_CALLS"
    | "CLARVIS_MODEL_ABORT_SETTLE_MS"
  >,
  logger: Logger = NOOP_LOGGER,
): HostModelCallAdmission {
  return createModelCallAdmissionController({
    maxActive: env.CLARVIS_MAX_CONCURRENT_MODEL_CALLS,
    maxQueued: env.CLARVIS_MAX_QUEUED_MODEL_CALLS,
    abortSettleMs: env.CLARVIS_MODEL_ABORT_SETTLE_MS,
    onStateChange: admissionStateLogger(logger),
    logger,
  });
}

/** Construct the host-owned capability/lifecycle gate from validated env. */
export function createHostExtensionAdmission(
  env: Pick<
    EnvConfig,
    | "CLARVIS_MAX_CONCURRENT_EXTENSION_CALLS"
    | "CLARVIS_MAX_CONCURRENT_EXTENSION_RUN_END_CALLS"
    | "CLARVIS_MAX_CONCURRENT_EXTENSION_CALLS_PER_OPERATION"
    | "CLARVIS_LOG"
    | "CLARVIS_LOG_LEVEL"
  >,
  logger: Logger = NOOP_LOGGER,
): HostExtensionAdmission {
  return createExtensionAdmissionController({
    maxActiveNormal: env.CLARVIS_MAX_CONCURRENT_EXTENSION_CALLS,
    maxActiveRunEnd: env.CLARVIS_MAX_CONCURRENT_EXTENSION_RUN_END_CALLS,
    maxActivePerOperation: env.CLARVIS_MAX_CONCURRENT_EXTENSION_CALLS_PER_OPERATION,
    logger: componentLogger(
      logger,
      "admission",
      levelFor(
        parseLogScopes(env.CLARVIS_LOG),
        "admission",
        activeLevelOf(logger) ?? env.CLARVIS_LOG_LEVEL,
      ),
    ),
  });
}

/** Which built-in capabilities to construct. Each defaults to on
 * (batteries-included). Setting one to `false` skips constructing it — its
 * feature package (tools/skills) is then never
 * imported and may be absent. A registered capability still applies its own
 * per-run gate (env flag, provider/factory presence, request opt-out). */
export interface BuiltinCapabilityToggles {
  tools?: boolean;
  skills?: boolean;
  /** Enables workspace hooks (@clarvis/hooks). */
  hooks?: boolean;
}

/**
 * Host-owned immutable skill-root snapshot used by long-lived run dependencies.
 *
 * @remarks `roots` is consumed while run dependencies are constructed and again
 * only when the host publishes an idle trust recomposition. `observe` arms
 * non-blocking monitoring before `verify` compares the captured bytes with the
 * host pin. `available` then withdraws drift without rescanning or rejecting a run.
 */
export interface SkillRootSnapshotProvider {
  roots(): SkillRootInput[];
  observe(skills: readonly SkillContent[]): void;
  verify(skills: readonly SkillContent[]): void;
  available(skill: SkillInfo): boolean;
  onRootsChanged?(listener: () => void): () => void;
}

/**
 * The host-supplied options for {@link buildExecuteRunDeps}: the environment and
 * logger, the workspace root, and the optional ports that wire up the tools
 * guard/sandbox, extra skill roots, built-in toggles, embedder capabilities
 * and connection-health observation.
 */
export interface BuildRunDepsOptions {
  env: EnvConfig;
  /** Raw values used for provider credentials, MCP interpolation, and child processes. */
  environment?: RuntimeEnvironment;
  logger: Logger;
  workspaceRoot: string;
  traceDir?: string;
  /** Exact host-resolved roots. When supplied, the four standard roots are not appended. */
  skillRoots?: SkillRootInput[] | (() => SkillRootInput[]) | SkillRootSnapshotProvider;
  /** Additional roots appended ahead of the four standard Clarvis roots. */
  extraSkillRoots?: SkillRootInput[] | (() => SkillRootInput[]);
  /** Compose host-owned in-memory skills with the discovered provider, once at construction.
   * Not called when skills are disabled. The returned provider backs both runs and host listings. */
  composeSkills?: (discovered: SkillsProvider | undefined) => SkillsProvider;
  /** Plugin-declared bootstrap skills, in `enabledPlugins` order. Function-only
   * (unlike `extraSkillRoots`, which also accepts an array) because the set must
   * be re-read per run: an array form would pin the answer at deps-construction
   * and a plugin enabled later would not take effect until a restart. */
  skillBootstraps?: () => readonly PluginBootstrapSkill[];
  /** Reads the run's merged `hooks` block (@clarvis/hooks). Called per run so
   * a settings edit takes effect live; return undefined or an empty array to
   * keep workspace hooks off. Omitted entirely, no hook ever executes — which
   * is the state this option exists to end. */
  resolveHooks?: (ctx: RunCapabilityContext) => readonly HookConfig[] | undefined;
  /**
   * Every environment variable name the host holds a credential in.
   *
   * @remarks Forwarded to the hooks capability so its env denylist covers keys
   * this run's request never mentions — see `WorkspaceHooksOptions.credentialNames`.
   */
  hookCredentialNames?: () => readonly string[];
  /** Host port for the tools guard: resolves the run's guard from the
   * request (guard_mode/guard_judge), host settings, and the elicit channel. */
  resolveGuard?: GuardResolver;
  resolveSandbox?: SandboxResolver;
  /** Host port naming the environment variables that hold credentials, so the
   * tools capability can withhold them from every command it spawns. */
  resolveSecretNames?: SecretNamesResolver;
  /** Isolated container guests set this to false so `require_escalated` fails closed. */
  allowHostEscalation?: boolean;
  /** Opt out of built-in capabilities to run leaner (and to allow the
   * corresponding optional package to be absent). Omitted = all on. */
  builtins?: BuiltinCapabilityToggles;
  /** Embedder capabilities, registered after the built-ins. */
  capabilities?: Capability[];
  /** Host sink for pooled-connection health transitions (unavailable/recovered).
   * These outlive any single run, so they ride this channel rather than a run's
   * trace — a host can render a live connection-health view from them. */
  onConnectionEvent?: ConnectionEventSink;
  /** Persistent browser authorization for remote MCP servers. */
  mcpAuthorization?: MCPAuthorizationOptions;
  /** Host-owned physical model-call gate. Inject one to share the cap across kernels. */
  modelCallAdmission?: HostModelCallAdmission;
  /** Host-owned physical capability/lifecycle gate shared across kernels. */
  extensionAdmission?: HostExtensionAdmission;
  /** Kernel-owned subscription authority resolved only at physical network I/O. */
  resolveSubscription?: (
    scheme: "openai-codex" | "xai-grok",
    signal?: AbortSignal,
    context?: { conversationKey?: string },
  ) => Promise<{
    readonly scheme: "openai-codex" | "xai-grok";
    apply(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  }>;
}

type SkillsSeam = SkillsProvider & {
  readResourceChunk: NonNullable<SkillsProvider["readResourceChunk"]>;
};

type SnapshotSkillsSeam = SkillsSeam & { close(): void };

/** Empty exact skill catalogue used when a host intentionally selects no roots. */
function emptySkillsProvider(): SkillsSeam {
  return {
    listSkills: () => [],
    loadSkill: () => undefined,
    readResource: () => {
      throw new Error("skills are unavailable");
    },
    readResourceChunk: () => {
      throw new Error("skills are unavailable");
    },
  };
}

/**
 * Build one immutable skill registry and filter it through a host-owned drift latch.
 *
 * @remarks Catalog metadata and bodies are materialized during dependency construction,
 * never from run admission. A later watcher event only changes the process-local predicate:
 * the affected skill disappears from listings and body/resource reads are refused,
 * while unrelated skills and the run itself continue.
 */
function snapshotSkills(
  build: (roots: SkillRootInput[]) => SkillsSeam,
  provider: SkillRootSnapshotProvider,
  logger: Logger,
): SnapshotSkillsSeam {
  const capture = (): SkillsSeam => {
    const inner = build(provider.roots());
    const discovered = inner.listSkills();
    const catalog: SkillInfo[] = [];
    const content = new Map<string, SkillContent>();
    for (const info of discovered) {
      try {
        const loaded = inner.loadSkill(info.name);
        if (loaded === undefined) continue;
        catalog.push(info);
        content.set(info.name, loaded);
      } catch (err) {
        logger.warn(
          {
            event: "skills.snapshot_body_unavailable",
            skill: info.name,
            cause: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
          },
          "a skill body could not enter the process snapshot and was withheld",
        );
      }
    }
    const captured = [...content.values()];
    provider.observe(captured);
    provider.verify(captured);
    const infoByName = new Map(catalog.map((info) => [info.name, info] as const));
    const resourcesByName = new Map(
      [...content].map(([name, loaded]) => [
        name,
        new Set(loaded.resources.map((resource) => resource.rel)),
      ]),
    );
    const requireAvailable = (name: string): SkillInfo => {
      const info = infoByName.get(name);
      if (info === undefined || !provider.available(info)) {
        throw new Error(
          `skill '${name}' is unavailable because its process snapshot changed; reconnect to load the new version`,
        );
      }
      return info;
    };
    return {
      listSkills: () => catalog.filter((info) => provider.available(info)),
      loadSkill: (name) => {
        const info = infoByName.get(name);
        if (info === undefined || !provider.available(info)) return undefined;
        return content.get(name);
      },
      readResource: (name, rel) => {
        requireAvailable(name);
        if (resourcesByName.get(name)?.has(rel) !== true) {
          throw new Error(`skill resource '${rel}' is not part of the process snapshot`);
        }
        return inner.readResource(name, rel);
      },
      readResourceChunk: (name, rel, offset, maxChars) => {
        requireAvailable(name);
        if (resourcesByName.get(name)?.has(rel) !== true) {
          throw new Error(`skill resource '${rel}' is not part of the process snapshot`);
        }
        return inner.readResourceChunk(name, rel, offset, maxChars);
      },
    };
  };

  let current = capture();
  let closed = false;
  const unsubscribe =
    provider.onRootsChanged?.(() => {
      if (closed) return;
      try {
        current = capture();
      } catch (err) {
        current = emptySkillsProvider();
        logger.warn(
          {
            event: "skills.snapshot_recomposition_failed",
            cause: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
          },
          "the idle trust recomposition could not capture skills; the catalog was withheld",
        );
      }
    }) ?? (() => undefined);
  return {
    listSkills: () => current.listSkills(),
    loadSkill: (name) => current.loadSkill(name),
    readResource: (name, rel) => current.readResource(name, rel),
    readResourceChunk: (name, rel, offset, maxChars) =>
      current.readResourceChunk(name, rel, offset, maxChars),
    close: () => {
      if (closed) return;
      closed = true;
      unsubscribe();
    },
  };
}

/**
 * Wrap a skills builder so the skill roots are re-read per call and rescanned only
 * when they change, keeping live edits visible without rescanning every request.
 *
 * @param build - constructs a skills provider from the current resolved roots.
 * @param provider - returns the current extra skill roots (called per access).
 * @param logger - receives a warning when a rescan fails.
 * @returns a {@link SkillsProvider} that serves from a memoized scan, falling back
 *   to the last good scan (or an empty provider) if discovery throws.
 * @remarks The roots' JSON is the cache signature; a matching signature reuses the
 *   prior scan. A `provider()` throw is treated as no new roots; it never rejects
 *   the foreground operation that happened to ask for skills.
 */
function dynamicSkills(
  build: (extra: SkillRootInput[]) => SkillsSeam,
  provider: () => SkillRootInput[],
  logger: Logger,
): SkillsSeam {
  let sig: string | undefined;
  let inner: SkillsSeam | undefined;
  const empty = emptySkillsProvider();
  const ensure = (): SkillsSeam => {
    let roots: SkillRootInput[];
    try {
      roots = provider();
    } catch (err) {
      logger.debug(
        {
          event: "skills.roots_unavailable",
          cause: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
        },
        "the host's skill-root provider threw; serving skills from the last good scan",
      );
      return inner ?? empty;
    }
    const nextSig = JSON.stringify(roots);
    if (inner !== undefined && nextSig === sig) return inner;
    try {
      inner = build(roots);
      sig = nextSig;
    } catch (err) {
      logger.warn(
        {
          event: "skills.discovery_failed",
          scope: "rescan",
          cause: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
        },
        "skill discovery failed; serving skills from the last good scan",
      );
      inner ??= empty;
      sig = nextSig;
    }
    return inner;
  };
  return {
    listSkills: () => ensure().listSkills(),
    loadSkill: (name) => ensure().loadSkill(name),
    readResource: (name, rel) => ensure().readResource(name, rel),
    readResourceChunk: (name, rel, offset, maxChars) =>
      ensure().readResourceChunk(name, rel, offset, maxChars),
  };
}

/** Narrow a configured exact-root source without treating root arrays as providers. */
function isSkillRootSnapshotProvider(
  value: BuildRunDepsOptions["skillRoots"] | undefined,
): value is SkillRootSnapshotProvider {
  return value !== undefined && !Array.isArray(value) && typeof value !== "function";
}

/**
 * The output of {@link buildExecuteRunDeps}: the assembled {@link ExecuteRunDeps},
 * the resolved trace store, the owner-facing skills provider (for
 * management surfaces), and a `dispose` that tears down the connection pool.
 */
export interface BuiltRunDeps {
  deps: ExecuteRunDeps;
  resolved: ResolvedTraceStore;
  /** Owner-facing skills provider (skill prompts/delegation); the loop itself
   * consumes skills through the capability registered on deps.capabilities. */
  skills?: SkillsProvider;
  /** The physical model-call gate used by these deps, for diagnostics and host sharing. */
  modelCallAdmission: HostModelCallAdmission;
  /** The physical extension-call gate used by these deps. */
  extensionAdmission: HostExtensionAdmission;
  /** Tears down the connection pool. */
  dispose: () => Promise<void>;
}

/** Dynamically load an optional feature module; a resolution failure becomes an
 * actionable "install this package (or opt out)" error. The module's namespace
 * type is inferred from `load` — no `import()` type annotations needed. */
async function importOptional<T>(
  pkg: string,
  feature: string,
  logger: Logger,
  load: () => Promise<T>,
): Promise<T> {
  const report = (outcome: "loaded" | "load_failed"): void => {
    logger.debug(
      { event: "optional_package", package: pkg, feature, outcome },
      outcome === "loaded"
        ? "an optional feature package loaded; its built-in is available this process"
        : "an optional feature package could not be loaded; constructing the deps fails",
    );
  };
  try {
    const loaded = await load();
    report("loaded");
    return loaded;
  } catch (err) {
    report("load_failed");
    throw new Error(
      `buildExecuteRunDeps: the '${feature}' built-in is enabled but its optional dependency ` +
        `'${pkg}' could not be loaded. Install '${pkg}', or pass builtins.${feature} = false to ` +
        `run without it. (cause: ${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }
}

/**
 * Record that a built-in was not constructed, and say so in the same vocabulary.
 *
 * @remarks The distinction this closes: `builtins.<feature> = false`, an env
 *   flag turning the feature off, and a missing host port all leave a run with
 *   no trace of that feature at all, and after the fact they are
 *   indistinguishable from the package never having been installed.
 */
function reportBuiltinDisabled(logger: Logger, pkg: string, feature: string): void {
  logger.debug(
    { event: "optional_package", package: pkg, feature, outcome: "disabled" },
    "a built-in is switched off; its package is never imported and may be absent",
  );
}

/**
 * Whether workspace hooks will actually run.
 *
 * @param builtinsHooks - the host's `builtins.hooks` opt-out, if it set one.
 * @param envEnabled - `CLARVIS_HOOKS_ENABLED`.
 * @param resolveHooks - the resolver the host supplies, or `undefined`.
 * @returns `true` only when all three agree, narrowing `resolveHooks` as it does.
 * @remarks Exported because a host that *reports* its composed capabilities has
 *   to report this, not `builtins.hooks !== false` on its own: computed from
 *   that conjunct alone, the kernel's diagnostic announced `hooks enabled:true`
 *   for a kernel whose runs would load no hook at all. A type predicate rather
 *   than a plain boolean so the caller keeps the narrowing the inline
 *   conjunction used to give it.
 */
export function hooksEffective<T>(
  builtinsHooks: boolean | undefined,
  envEnabled: boolean,
  resolveHooks: T | undefined,
): resolveHooks is T {
  return builtinsHooks !== false && envEnabled && resolveHooks !== undefined;
}

/**
 * Assemble the long-lived {@link ExecuteRunDeps} a host reuses across runs:
 * connection pool, retrying/logging LLM provider, trace store, and the ordered
 * capability list (tools, ask-user, skills, then the embedder's).
 *
 * @param options - host ports and toggles; see {@link BuildRunDepsOptions}.
 * @returns the {@link BuiltRunDeps} — the deps, resolved store, owner-facing
 *   skills provider, and a `dispose`.
 * @throws if `workspaceRoot` is blank, or if an enabled built-in's optional
 *   package (`@clarvis/tools`/`skills`) cannot be loaded — pass
 *   `builtins.<feature> = false` to run without it.
 * @remarks Each built-in defaults on and applies its own per-run gate (env flag,
 *   provider/factory presence, request opt-out); a disabled built-in is never
 *   imported, so its optional package may be absent. Skill discovery failures
 *   degrade to the last good scan (or no skills) rather than throwing.
 */
export async function buildExecuteRunDeps({
  env,
  logger,
  workspaceRoot,
  traceDir,
  skillRoots,
  extraSkillRoots,
  composeSkills,
  skillBootstraps,
  resolveGuard,
  resolveSandbox,
  resolveSecretNames,
  allowHostEscalation,
  resolveHooks,
  hookCredentialNames,
  builtins,
  capabilities: extraCapabilities,
  onConnectionEvent,
  mcpAuthorization,
  modelCallAdmission: suppliedModelCallAdmission,
  extensionAdmission: suppliedExtensionAdmission,
  resolveSubscription,
  environment = process.env,
}: BuildRunDepsOptions): Promise<BuiltRunDeps> {
  if (workspaceRoot.trim() === "") {
    throw new Error("buildExecuteRunDeps: 'workspaceRoot' must be a non-empty path.");
  }
  if (skillRoots !== undefined && extraSkillRoots !== undefined) {
    throw new Error(
      "buildExecuteRunDeps: supply either 'skillRoots' or 'extraSkillRoots', not both.",
    );
  }
  const logScopes = parseLogScopes(env.CLARVIS_LOG);
  const logFloor =
    logger === undefined ? undefined : (activeLevelOf(logger) ?? env.CLARVIS_LOG_LEVEL);
  const forComponent = (component: string): Logger | undefined =>
    logger === undefined || logFloor === undefined
      ? undefined
      : componentLogger(logger, component, levelFor(logScopes, component, logFloor));
  const pathsLoggerForHost = forComponent("paths");
  if (pathsLoggerForHost !== undefined) setPathsLogger(pathsLoggerForHost);
  const useTools = builtins?.tools !== false;
  const useSkills = builtins?.skills !== false;
  const useHooks = hooksEffective(builtins?.hooks, env.CLARVIS_HOOKS_ENABLED, resolveHooks);

  const resolved = resolveTraceStore({
    ...(traceDir !== undefined ? { dir: traceDir } : {}),
    ...(forComponent("trace") === undefined ? {} : { logger: forComponent("trace")! }),
  });

  const mcpLogger = forComponent("mcp");
  const authorization =
    mcpAuthorization === undefined
      ? undefined
      : createMCPAuthorizationCoordinator(mcpAuthorization);
  const connections = createConnectionManager({
    workspace: workspaceRoot,
    factory: createMCPClientFactory(environment, {
      defaultCwd: workspaceRoot,
      ...(mcpLogger === undefined ? {} : { logger: mcpLogger }),
      ...(authorization === undefined ? {} : { authorization }),
      maxStdioFrameBytes: env.CLARVIS_MCP_STDIO_MAX_FRAME_BYTES,
      maxHttpResponseBytes: env.CLARVIS_MCP_HTTP_MAX_RESPONSE_BYTES,
      maxHttpSseEventBytes: env.CLARVIS_MCP_HTTP_MAX_SSE_EVENT_BYTES,
      ...(env.CLARVIS_MCP_SERVER_STDERR === "inherit"
        ? {}
        : {
            maxServerStderrBytes: env.CLARVIS_MCP_SERVER_STDERR_MAX_BYTES,
            onServerStderr:
              env.CLARVIS_MCP_SERVER_STDERR === "off"
                ? () => {}
                : (mcp: string, line: string) => {
                    mcpLogger?.debug(
                      { event: "mcp.server.stderr", mcp, server_output: line },
                      "MCP server wrote to its own stderr",
                    );
                  },
          }),
    }),
    connectTimeoutMs: env.CLARVIS_MCP_CONNECT_TIMEOUT_MS,
    callTimeoutMs: env.CLARVIS_MCP_TOOL_CALL_TIMEOUT_MS,
    idleTtlMs: env.CLARVIS_MCP_POOL_IDLE_TTL_MS,
    maxConnections: env.CLARVIS_MCP_MAX_CONNECTIONS,
    maxParallelConnects: env.CLARVIS_MCP_MAX_PARALLEL_CONNECTS,
    maxIdleConnections: env.CLARVIS_MCP_MAX_IDLE_CONNECTIONS,
    poolSharing: env.CLARVIS_MCP_POOL_SHARING,
    resourcesEnabled: env.CLARVIS_MCP_RESOURCES,
    timeoutStreakThreshold: env.CLARVIS_MCP_TIMEOUT_STREAK_THRESHOLD,
    healthPingIntervalMs: env.CLARVIS_MCP_HEALTH_PING_INTERVAL_MS,
    ...(onConnectionEvent !== undefined ? { onConnectionEvent } : {}),
    ...(mcpLogger === undefined ? {} : { logger: mcpLogger }),
  });

  const provider = createAiSdkProvider({
    resolveRegistryKey: (name: string): string | undefined => environment[name],
    timeoutMs: env.CLARVIS_DEFAULT_CALL_TIMEOUT_MS,
    maxResponseBytes: env.CLARVIS_PROVIDER_MAX_RESPONSE_BYTES,
    maxSseEventBytes: env.CLARVIS_PROVIDER_MAX_SSE_EVENT_BYTES,
    logger,
    ...(resolveSubscription === undefined ? {} : { resolveSubscription }),
  });
  const modelCallAdmission =
    suppliedModelCallAdmission ?? createHostModelCallAdmission(env, logger);
  const extensionAdmission =
    suppliedExtensionAdmission ?? createHostExtensionAdmission(env, logger);
  const llm = withTransportRetry(
    withCallLogging(withModelCallAdmission(provider, modelCallAdmission), logger),
    {
      maxRetries: env.CLARVIS_DEFAULT_MAX_RETRIES,
      baseDelayMs: env.CLARVIS_PROVIDER_RETRY_BASE_MS,
      maxDelayMs: env.CLARVIS_PROVIDER_RETRY_MAX_MS,
      maxRetryAfterMs: env.CLARVIS_DEFAULT_MAX_RETRY_AFTER_MS,
      logger,
    },
  );

  let skills: SkillsProvider | undefined;
  let closeSkillSnapshot = (): void => undefined;
  if (!(useSkills && env.CLARVIS_SKILLS_ENABLED)) {
    reportBuiltinDisabled(logger, "@clarvis/skills", "skills");
  }
  if (useSkills && env.CLARVIS_SKILLS_ENABLED) {
    const { createAgentSkills, clarvisSkillRoots } = await importOptional(
      "@clarvis/skills",
      "skills",
      logger,
      () => import("@clarvis/skills"),
    );
    const exactRoots = skillRoots !== undefined;
    const build = (roots: SkillRootInput[]): SkillsSeam =>
      exactRoots && roots.length === 0
        ? emptySkillsProvider()
        : createAgentSkills({
            workspace: workspaceRoot,
            roots: exactRoots
              ? roots
              : [...roots, ...clarvisSkillRoots({ workspace: workspaceRoot })],
            warningSink: (message) =>
              logger.warn(
                { event: "skills.discovery_warning", warning: message.trimEnd() },
                "a skill root produced a warning; that skill is skipped",
              ),
            logger,
          });
    const configuredRoots = skillRoots ?? extraSkillRoots;
    if (isSkillRootSnapshotProvider(configuredRoots)) {
      try {
        const snapshot = snapshotSkills(build, configuredRoots, logger);
        skills = snapshot;
        closeSkillSnapshot = () => snapshot.close();
      } catch (err) {
        logger.warn(
          {
            event: "skills.discovery_failed",
            scope: "snapshot",
            cause: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
          },
          "skill snapshot construction failed; skills are disabled for these deps",
        );
      }
    } else if (typeof configuredRoots === "function") {
      skills = dynamicSkills(build, configuredRoots, logger);
    } else {
      try {
        skills = build(configuredRoots ?? []);
      } catch (err) {
        logger.warn(
          {
            event: "skills.discovery_failed",
            scope: "initial",
            cause: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
          },
          "skill discovery failed; skills are disabled for these deps",
        );
      }
    }
  }

  if (useSkills && env.CLARVIS_SKILLS_ENABLED && composeSkills !== undefined) {
    skills = composeSkills(skills);
  }

  const capabilities: Capability[] = [];
  const capabilityRegistry = createCapabilityRegistry();
  if (!useHooks) reportBuiltinDisabled(logger, "@clarvis/hooks", "hooks");
  if (!useTools) reportBuiltinDisabled(logger, "@clarvis/tools", "tools");
  if (useHooks) {
    const { createWorkspaceHooksCapability } = await importOptional(
      "@clarvis/hooks",
      "hooks",
      logger,
      () => import("@clarvis/hooks/capability"),
    );
    capabilities.push(
      createWorkspaceHooksCapability({
        resolveHooks,
        environment,
        ...(hookCredentialNames ? { credentialNames: hookCredentialNames } : {}),
      }),
    );
  }
  if (useTools) {
    const selectedSkills = skills;
    const { setWarnSink } = await importOptional(
      "@clarvis/tools",
      "tools",
      logger,
      () => import("@clarvis/tools"),
    );
    setWarnSink((message, warning) => {
      const fields = {
        event: warning?.event ?? "tools.warning",
        ...warning?.fields,
        warning: message.trimEnd(),
      };
      if (warning?.level === "error") {
        logger.error(fields, "a tool hit an internal error; the call is reported as failed");
        return;
      }
      if (warning?.level === "debug") {
        logger.debug(fields, "a tool reported a detail its own result cannot carry to an operator");
        return;
      }
      logger.warn(fields, "a tool reported a non-fatal warning");
    });
    const { createAgentToolsCapability } = await importOptional(
      "@clarvis/tools",
      "tools",
      logger,
      () => import("./capabilities/tools.ts"),
    );
    capabilities.push(
      createAgentToolsCapability({
        ...(resolveGuard !== undefined ? { resolveGuard } : {}),
        ...(resolveSandbox !== undefined ? { resolveSandbox } : {}),
        ...(resolveSecretNames !== undefined ? { resolveSecretNames } : {}),
        ...(allowHostEscalation !== undefined ? { allowHostEscalation } : {}),
        ...(selectedSkills === undefined
          ? {}
          : {
              resolveSkillExecutionRoots: () => [
                ...new Set(
                  selectedSkills
                    .listSkills()
                    .flatMap((skill) =>
                      skill.executionRoot === undefined ? [] : [skill.executionRoot],
                    ),
                ),
              ],
            }),
      }),
    );
  }
  capabilities.push(createAskUserCapability());
  if (useSkills) {
    const { createSkillsCapability } = await importOptional(
      "@clarvis/skills",
      "skills",
      logger,
      () => import("@clarvis/skills/capability"),
    );
    capabilities.push(
      createSkillsCapability(
        skills,
        skillBootstraps !== undefined ? { bootstraps: skillBootstraps } : {},
      ),
    );
  }
  capabilities.push(...(extraCapabilities ?? []));

  const deps: ExecuteRunDeps = {
    env,
    llm,
    connections,
    traceStore: resolved.store,
    logger,
    workspaceRoot,
    capabilities,
    capabilityRegistry,
    extensionAdmission,
  };

  return {
    deps,
    resolved,
    ...(skills !== undefined ? { skills } : {}),
    modelCallAdmission,
    extensionAdmission,
    dispose: async () => {
      closeSkillSnapshot();
      const closed = await Promise.allSettled([
        connections.closeAll(),
        authorization?.close() ?? Promise.resolve(),
      ]);
      if (suppliedModelCallAdmission === undefined) modelCallAdmission.close();
      if (suppliedExtensionAdmission === undefined) extensionAdmission.close();
      const failure = closed.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failure !== undefined) throw failure.reason;
    },
  };
}
