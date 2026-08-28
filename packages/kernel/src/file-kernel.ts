import { extractEnvRefs, loadEnv, type EnvConfig } from "@clarvis/capability";
import type { ConnectionEventSink } from "./connection-health.ts";
import type { MemoryStore } from "@clarvis/memory";
import {
  createMemoryCapability,
  createMemoryFactory,
  loadMemoryPolicy,
  MEMORY_CAPABILITY_NAME,
  type MemoryFactory,
  type MemoryFactorySettings,
  type MemoryPluginPort,
} from "@clarvis/memory/capability";
import { createMemoryServerPort } from "./memory/memory-server-port.ts";
import { composeIndexPassDeps } from "./memory/pass-deps.ts";
import { componentFloor, createAuditLogger, createComponentLoggers } from "./component-loggers.ts";
import { createTasksCapability } from "@clarvis/tasks/capability";
import { createTaskServerPort } from "./tasks/task-server-port.ts";
import { TaskProviderFactory } from "./tasks/task-provider-factory.ts";
import { effectiveMcpServers } from "./mcp/effective-servers.ts";
import { createCapabilityExecutableSessionManager } from "./capability-executables/session-manager.ts";
import {
  PLANS_CAPABILITY_NAME,
  type PlanPluginPort,
  type PlanProviderConfig,
  type PlanStore,
} from "@clarvis/plan";
import { createPlanningRuntime } from "./plans/planning-runtime.ts";
import type { EnvironmentPluginRef, RunEvent } from "@clarvis/protocol";
import {
  buildExecuteRunDeps,
  hooksEffective,
  type HostExtensionAdmission,
  type HostModelCallAdmission,
  createLogger,
  type ExecuteRunDeps,
  type HookConfig,
  type Logger,
  type ProviderConfig,
  type PluginBootstrapSkill,
  type SkillRootInput,
} from "@clarvis/loop";
import { TraceCleanup, type TraceStore } from "@clarvis/trace";
import type { GuardConfig } from "@clarvis/loop/host";
import type { EventStreamOptions } from "./core/event-stream.ts";
import { createFileConfigStore } from "./config/file-config-store.ts";
import { DEFAULT_ENTRY_AGENT } from "./config/builtin-agents/index.ts";
import type { SettingsSnapshot } from "./config/config-store.ts";
import {
  createPluginContributions,
  type PluginContributions,
} from "./plugins/plugin-contributions.ts";
import { createFileSecretStore } from "./secrets/secret-store.ts";
import type { SettingsAssemblerOptions } from "./runs/settings-assembler.ts";
/**
 * The trust verdict for what this workspace's own `.clarvis/` declares.
 *
 * @remarks A discriminated union so a caller that has narrowed to `changed` gets
 *   `approved` without re-checking. It kept its hooks-shaped name because that
 *   is what callers already hold, but the verdict now covers every risky
 *   workspace field, not only `hooks`.
 */
export type WorkspaceHooksTrust =
  | { state: "inert" }
  | { state: "trusted"; fingerprint: string }
  | { state: "unapproved"; fingerprint: string }
  | { state: "changed"; fingerprint: string; approved: string };
import { createGuardResolver, type GuardSettings } from "./guard/resolver.ts";
import { createInProcessKernel, type InProcessKernel } from "./kernel.ts";
import { createSandboxPolicyResolver } from "./sandbox/policy.ts";
import type { KernelOwnershipMode } from "./application/scope-policy.ts";
import {
  createKernelEnvironment,
  resolveSecretEnvironment,
  type KernelEnvironment,
  type SecretEnvironmentSource,
} from "./ports/environment.ts";
import {
  globalPaths,
  globalRoot,
  ownerFromWorkspace,
  sweepGlobalStateArtifacts,
  sweepSpillDir,
  workspacePaths,
} from "@clarvis/paths";
import { sweepMonitors } from "@clarvis/tools";
import { WorkspaceHousekeeping } from "./application/workspace-housekeeping.ts";
import { referencedSessionExecutionIds } from "./sessions/session-service.ts";
import { discoverGitWorkspace } from "./git-workspace.ts";
import { SubscriptionManager } from "./subscriptions/manager.ts";
import { createFileSubscriptionStore } from "./subscriptions/store.ts";
import { createModelCatalogService } from "./models/model-catalog.ts";
import { createEnvironmentManager } from "./environments/environment-manager.ts";

/**
 * Options for {@link createFileKernel}: workspace root plus optional env, logging, paths, and key resolution.
 */
export interface CreateFileKernelOptions {
  /** Absolute workspace root the kernel operates over. */
  workspaceRoot: string;
  /** Pre-loaded environment config; defaults to {@link loadEnv} over `process.env`. */
  env?: EnvConfig;
  /** Immutable raw environment for credentials, interpolation, and child processes. */
  environment?: KernelEnvironment;
  /** Logger to use; defaults to one built from `CLARVIS_LOG_LEVEL`. */
  logger?: Logger;
  /** Project-host-owned physical model-call gate shared across workspace kernels. */
  modelCallAdmission?: HostModelCallAdmission;
  /** Project-host-owned physical capability/lifecycle gate shared across kernels. */
  extensionAdmission?: HostExtensionAdmission;
  /** Multi-owner cache policy; defaults to 128 resident owners and five minutes idle. */
  ownerCache?: { maxOwners?: number; idleMs?: number };
  /** Release host-owned persistence caches after an owner has fully retired. */
  onOwnerRetired?: (owner: string) => void | Promise<void>;
  /** Directory for run traces; when omitted the loop uses its default. */
  traceDir?: string;
  /** Global Clarvis dir for config/secrets/models/sessions; defaults to the standard global root. */
  globalDir?: string;
  /** Process-local Environment override (`scope:name`); never persisted. */
  environmentSelector?: string;
  /** Default model id; falls back to `CLARVIS_DEFAULT_MODEL` in the environment. */
  defaultModel?: string;
  /** Enables the memory subsystem when `true`; otherwise memory is inert. */
  memory?: boolean;
  /** Enables local-user subscription credentials; remote hosts set this to `false`. */
  subscriptions?: boolean;
  /**
   * Per-owner persistence for plans. Omitted, one workspace-local markdown
   * repository over `<workspaceRoot>/.clarvis/plans` is built and shared by every
   * owner. This is the seam a host uses to put plans somewhere else, or to
   * separate them per owner — it constructs the adapter itself (pulling any
   * credentials from the secret store) and passes it in.
   */
  planStoreFor?: (owner: string) => PlanStore;
  /** Per-owner persistence for the memory tree; same seam as
   * {@link planStoreFor}. */
  memoryStoreFor?: (owner: string) => MemoryStore;
  /** The owner unscoped service calls are filed under; defaults to one derived
   * from the workspace. */
  defaultOwner?: string;
  /**
   * Sink for pooled MCP connection health transitions (unavailable/recovered).
   *
   * @remarks These outlive any single run, so they ride this channel rather than
   * a run's event stream. A host builds a readiness signal from them.
   */
  onConnectionEvent?: ConnectionEventSink;
  /** Opens an MCP OAuth authorization URL; omitted by intentionally headless hosts. */
  openMcpAuthorizationUrl?: (url: string) => Promise<boolean>;
  /**
   * Per-key resolution source: `env` forces the environment value, `keyfile`
   * forces the stored secret, `auto` (the default) prefers env then the keyfile.
   */
  keySources?: Record<string, SecretEnvironmentSource>;
  /** Event-stream backpressure passthrough; see
   * {@link CreateKernelOptions.eventBuffer} — defaults to the managed run's
   * bounded count-and-byte policy. */
  eventBuffer?: EventStreamOptions<RunEvent>;
  /** Explicit owner model; multi-owner mode requires owner-aware data stores. */
  ownershipMode?: KernelOwnershipMode;
  /** Host capabilities are consumed here; loop receives only its own three builtin names. */
  builtins?: {
    tools?: boolean;
    skills?: boolean;
    hooks?: boolean;
    tasks?: boolean;
  };
}

/**
 * An {@link InProcessKernel} plus the file-backed host's own trust surface.
 *
 * @remarks `workspaceHooks` is not on {@link InProcessKernel} because trust here
 * is a property of *files on this machine*, which only a file-backed host has.
 * The same verdict also covers the selected workspace Environment's executable
 * extension surface. Environment selection has an explicit approval flow; this
 * host-only API remains the way to approve or revoke workspace settings hooks.
 */
export interface FileKernel extends InProcessKernel {
  readonly workspaceHooks: {
    /** The current verdict for this workspace's declared hooks. */
    trust(): WorkspaceHooksTrust;
    /** Record approval of the current hooks; a no-op when inert or already trusted. */
    approve(): WorkspaceHooksTrust;
    /** Drop every approval, so the workspace's hooks stop running again. */
    revoke(): void;
  };
}

/**
 * Fold any journals left behind by runs whose process died into `interrupted`
 * execution records, before the kernel serves its first request.
 *
 * @param store - the trace store; one that cannot journal is a no-op.
 * @param logger - optional logger for the outcome.
 * @returns the number of records recovered.
 * @remarks Awaited rather than fired and forgotten, for a correctness reason
 *   rather than a stylistic one: a client lists runs as soon as the kernel is
 *   up, and an unawaited pass would race that listing — so the interrupted run
 *   a user is looking for could simply be missing from it.
 *
 *   A failure here never blocks startup. Recovery is a best-effort improvement
 *   over having lost the run entirely; refusing to boot because it did not work
 *   would turn a degraded outcome into a total one.
 */
/**
 * The `service` tag every record this kernel writes carries.
 *
 * @remarks The factory's default names the package the factory lives in, not
 * the one calling it, so without this every kernel line was labelled
 * `@clarvis/loop` and could not be attributed to the process that wrote it.
 */
const SERVICE = "@clarvis/kernel";

/**
 * Report which configuration scopes exist and what they contributed.
 *
 * @param logger - the config component's logger.
 * @param snapshot - the store's first snapshot, read once at boot.
 * @param plugins - the plugin contributions the merge folded in.
 * @remarks The one line an operator needs before anything else: whether the
 *   file they edited was even seen. A scope that failed validation reports
 *   `present` here and its own `kernel.config.rejected` beside it, which is the
 *   pair that distinguishes "not read" from "read and refused".
 */
function reportConfigScopes(
  logger: Logger,
  snapshot: SettingsSnapshot,
  plugins: PluginContributions,
): void {
  const merged = snapshot.merged as Record<string, unknown>;
  const enabled = Array.isArray(merged.enabledPlugins)
    ? (merged.enabledPlugins as EnvironmentPluginRef[])
    : [];
  const active = snapshot.active_plugins ?? enabled;
  const presence = (scope: "global" | "workspace"): boolean =>
    snapshot.sources.find((source) => source.scope === scope)?.exists ?? false;
  logger.info(
    {
      event: "kernel.config.scopes",
      global_present: presence("global"),
      workspace_present: presence("workspace"),
      workspace_trust: snapshot.workspace_trust?.state ?? "inert",
      plugin_scopes: plugins.settingsScopes(active).length,
      enabled_plugins: active.map((ref) => `${ref.scope}/${ref.source}/${ref.name}`).join(","),
    },
    "the kernel read its configuration scopes; only the scopes reported present contribute to the merge",
  );
}

/**
 * Report whether one host capability was composed into every run.
 *
 * @param logger - the kernel's logger.
 * @param capability - the capability's registry name.
 * @param enabled - whether it is active for this kernel.
 * @param reason - what decided it.
 * @remarks Every one of these is registered whether or not it is enabled, so
 *   its seed marker and reservations stay stable. "Registered" and "will do
 *   something" are therefore different facts, and only this line carries the
 *   second.
 */
function reportCapability(
  logger: Logger,
  capability: string,
  enabled: boolean,
  reason: string,
): void {
  logger.info(
    { event: "kernel.capability.composed", capability, enabled, reason },
    "a host capability was composed into this kernel's runs; a disabled one stays registered but contributes no tools",
  );
}

async function recoverInterruptedRuns(store: TraceStore, logger?: Logger): Promise<number> {
  try {
    const report = await store.recoverOrphans?.();
    if (report === undefined) return 0;
    if (report.recovered > 0 || report.exhausted) {
      logger?.info(
        {
          event: "runs.recovered_interrupted",
          recovered: report.recovered,
          examined: report.examined,
          quarantined: report.quarantined,
          degraded: report.degraded,
          exhausted: report.exhausted,
        },
        "recovered interrupted runs from their journals; transcripts and token accounting are restored, but they cannot be continued",
      );
    }
    return report.recovered;
  } catch (err) {
    logger?.warn(
      {
        event: "runs.recovery_failed",
        cause: err instanceof Error ? err.message : String(err),
      },
      "journal recovery pass failed; orphaned journals remain for the next start",
    );
    return 0;
  }
}

/**
 * Builds an {@link InProcessKernel} backed by file config/secrets under the
 * workspace and Clarvis global dir.
 *
 * @param opts - workspace root plus optional env/logging/paths; see {@link CreateFileKernelOptions}.
 * @returns the fully wired file-backed kernel, ready to serve.
 * @remarks Loads an immutable environment snapshot, folds in plugin
 *   contributions, resolves API keys without process-global mutation, wires
 *   guard and sandbox-policy resolution, and enables memory only when
 *   `opts.memory` is set. Building the loop deps is async, so this returns a promise.
 */
export async function createFileKernel(opts: CreateFileKernelOptions): Promise<FileKernel> {
  const ownershipMode = opts.ownershipMode ?? "single";
  if (ownershipMode === "multi" && opts.planStoreFor === undefined) {
    throw new Error("createFileKernel: multi-owner mode requires planStoreFor.");
  }
  if (ownershipMode === "multi" && opts.memory === true && opts.memoryStoreFor === undefined) {
    throw new Error(
      "createFileKernel: multi-owner mode with memory enabled requires memoryStoreFor.",
    );
  }
  const baseEnvironment = opts.environment ?? createKernelEnvironment(process.env);
  const env = opts.env ?? loadEnv(baseEnvironment.values);
  const logger: Logger = opts.logger ?? createLogger(env.CLARVIS_LOG_LEVEL, { service: SERVICE });
  const componentLogger = createComponentLoggers(
    logger,
    env.CLARVIS_LOG,
    componentFloor(logger, env.CLARVIS_LOG_LEVEL),
  );
  const auditLogger = createAuditLogger(logger, env.CLARVIS_LOG_AUDIT);
  const globalDir = opts.globalDir ?? globalRoot();
  const bootStartedAt = Date.now();
  logger.info(
    {
      event: "kernel.boot.started",
      workspace_root: opts.workspaceRoot,
      global_dir: globalDir,
      ownership_mode: ownershipMode,
      memory_enabled: opts.memory === true,
      ...((opts.defaultModel ?? baseEnvironment.values.CLARVIS_DEFAULT_MODEL) !== undefined
        ? {
            default_model: (opts.defaultModel ??
              baseEnvironment.values.CLARVIS_DEFAULT_MODEL) as string,
          }
        : {}),
    },
    "the file-backed kernel is starting; nothing serves a request until it reports ready",
  );
  const gitWorkspace = await discoverGitWorkspace(opts.workspaceRoot);
  const kernelDefaultOwner = opts.defaultOwner ?? ownerFromWorkspace(opts.workspaceRoot);
  const pluginContributions = createPluginContributions({
    globalDir,
    workspaceRoot: opts.workspaceRoot,
    logger: componentLogger("plugins"),
  });
  const environmentManager = createEnvironmentManager({
    globalDir,
    workspaceRoot: opts.workspaceRoot,
    pluginContributions,
    ...(opts.environmentSelector === undefined ? {} : { cliSelection: opts.environmentSelector }),
    logger: componentLogger("environment"),
  });
  let environmentRunRefs = 0;
  const configStore = createFileConfigStore({
    workspaceRoot: opts.workspaceRoot,
    globalDir,
    plugins: pluginContributions,
    environment: {
      resolvePlugins: (enabledPlugins, trust) =>
        environmentManager
          .resolveActive(enabledPlugins, trust)
          .plugins.filter((plugin) => plugin.active)
          .map((plugin) => plugin.ref),
      workspaceTrustSurface: () => environmentManager.workspaceTrustSurface(),
      assertWorkspaceTrustTransitionAllowed: () =>
        environmentManager.assertWorkspaceTrustTransitionAllowed(),
    },
    logger: componentLogger("config"),
  });
  environmentManager.bindRuntime({
    readWorkspaceTrust: () => configStore.readSettings().workspace_trust ?? { state: "inert" },
    approveWorkspace: () => {
      configStore.setWorkspaceTrust?.(true);
    },
    hasActiveRuns: () => environmentRunRefs > 0,
  });
  reportConfigScopes(componentLogger("config"), configStore.readSettings(), pluginContributions);
  const secretStore = createFileSecretStore(
    opts.globalDir !== undefined ? { dir: opts.globalDir } : {},
  );
  const environment = resolveSecretEnvironment(
    baseEnvironment,
    secretStore.read().values,
    opts.keySources ?? {},
  );
  const capabilityExecutables = createCapabilityExecutableSessionManager({
    environment: environment.values,
    logger,
  });

  /**
   * Every environment variable name this host manages as a credential.
   *
   * @remarks Read from `keys.json` (and the explicit key sources) rather than
   * derived from a run's request. The request lists only the MCP servers the run
   * was narrowed to, so deriving the hook denylist from it left the token of any
   * configured-but-unused server readable by a hook. Re-read per call so a key
   * added mid-session is denied on the next run.
   */
  const managedSecretNames = (): readonly string[] => [
    ...new Set([...Object.keys(secretStore.read().values), ...Object.keys(opts.keySources ?? {})]),
  ];

  /**
   * The run's merged `memory:` block, re-read per call so a settings edit takes
   * effect live; undefined keeps memory off for that run.
   *
   * @remarks Its providers are passed through exactly as configured. Nothing on
   * this path consults the model catalog: `prompt_cache` is resolved where a
   * model is *configured*, not where a run is assembled, so a continuation pass
   * reads the same value its subject run did no matter what the catalog has done
   * in between — which is what keeps their two prefixes byte-identical.
   */
  const loadMemorySettings = (): MemoryFactorySettings | undefined => {
    const merged = configStore.readSettings().merged as Record<string, unknown>;
    const cfg = merged.memory;
    if (cfg === undefined || cfg === null) return undefined;
    const out: MemoryFactorySettings = { config: cfg as MemoryFactorySettings["config"] };
    if (typeof merged.default_model === "string") out.defaultModel = merged.default_model;
    if (Array.isArray(merged.providers)) {
      out.providers = merged.providers as MemoryFactorySettings["providers"];
    }
    return out;
  };

  const defaultModel = opts.defaultModel ?? environment.values.CLARVIS_DEFAULT_MODEL;
  const sandboxPolicy = createSandboxPolicyResolver(
    configStore,
    opts.workspaceRoot,
    environment.values,
  );

  const loadGuardSettings = (): GuardSettings => {
    const merged = configStore.readSettings().merged as Record<string, unknown>;
    return {
      ...(merged.guard !== undefined ? { guard: merged.guard as GuardConfig } : {}),
      ...(Array.isArray(merged.providers)
        ? { providers: merged.providers as ProviderConfig[] }
        : {}),
      defaultModel: typeof merged.default_model === "string" ? merged.default_model : defaultModel,
    };
  };

  /**
   * The run's hooks, re-read from settings on every run.
   *
   * @remarks
   * The merge has already happened by the time this reads `merged`: the settings
   * spec concatenates every operator hook ahead of every plugin hook, and the
   * plugin fragments only reach the merge for a plugin that is both enabled and
   * trusted.
   *
   * Trust gating covers two of the three sources, and the config store closes
   * the third. Plugin hooks are gated on approval, and global hooks are the
   * machine owner's own. Workspace hooks are neither: they arrive from whatever
   * repository happens to be open, merge under `origin: "operator"` exactly like
   * the owner's own file, and — since the executor was wired — would run a shell
   * command on `session_start` for anyone who cloned the repository. They are
   * withheld from the merge upstream of here; see `stripWorkspaceRiskFields`.
   */
  /** The `hooks` array the workspace's own `settings.json` declares, if any. */
  const declaredWorkspaceHooks = (snapshot = configStore.readSettings()): readonly unknown[] => {
    const scoped = snapshot.scopes.workspace?.hooks;
    return Array.isArray(scoped) ? scoped : [];
  };

  /**
   * The names of every environment variable this host treats as a credential.
   *
   * @remarks
   * The union of two sources, because either alone leaves a hole: `keys.json`
   * holds the keys Clarvis manages, while `providers[].api_key_env` names the
   * ones a user exported in their own shell and merely pointed Clarvis at. A key
   * is no less a secret for having been supplied the second way, and it is the
   * second way that a developer's machine most often uses.
   *
   * A provider's and a model's `headers` are read for the same reason: a partner
   * token interpolated into a header is a credential exactly as much as an API
   * key is. This is the whole-registry half of the pair — the run-scoped half
   * lives in `runCredentialNames`, which only ever sees the providers a given
   * run resolved.
   *
   * Names only — the resolved values never leave the environment snapshot.
   */
  const loadSecretNames = (): readonly string[] => {
    const merged = configStore.readSettings().merged as Record<string, unknown>;
    const providers = Array.isArray(merged.providers) ? (merged.providers as ProviderConfig[]) : [];
    const names = new Set(Object.keys(secretStore.read().values));
    const addHeaderRefs = (headers: Record<string, string> | undefined): void => {
      for (const value of Object.values(headers ?? {})) {
        for (const name of extractEnvRefs(value)) names.add(name);
      }
    };
    for (const provider of providers) {
      const declared = (provider as { api_key_env?: unknown }).api_key_env;
      if (typeof declared === "string" && declared.length > 0) names.add(declared);
      addHeaderRefs(provider.headers);
      for (const model of Object.values(provider.models ?? {})) addHeaderRefs(model.headers);
    }
    return [...names];
  };

  /**
   * The run's hooks, re-read from settings on every run.
   *
   * @remarks
   * No filtering happens here any more. An untrusted workspace's `hooks` never
   * reach `merged` at all — the config store withholds every risky workspace
   * field before the merge runs (see `stripWorkspaceRiskFields`) — so by the
   * time this reads `merged.hooks`, what remains is the operator's own hooks
   * plus those of enabled, trusted plugins.
   *
   * That replaces an earlier post-merge filter which removed workspace-declared
   * hooks from the merged array by canonical value. Gating before the merge is
   * strictly stronger: the filter had to reconstruct which entries came from
   * where, and an earlier revision of it compared by object identity and
   * silently permitted everything it claimed to block. There is nothing to
   * reconstruct if the value never enters.
   *
   * The warning is kept, because a workspace whose hooks are being withheld
   * should say so once per run rather than fail silently.
   */
  const loadHooks = (): readonly HookConfig[] | undefined => {
    const snapshot = configStore.readSettings();
    const merged = snapshot.merged as Record<string, unknown>;
    const declared = declaredWorkspaceHooks(snapshot);
    const state = snapshot.workspace_trust?.state;
    if (declared.length > 0 && (state === "unapproved" || state === "changed")) {
      logger.warn(
        { state, hooks: declared.length },
        "workspace hooks are not approved and will not run; approve them to enable",
      );
    }
    if (!Array.isArray(merged.hooks) || merged.hooks.length === 0) return undefined;
    return merged.hooks as HookConfig[];
  };

  /**
   * Project the config store's workspace verdict onto the hooks-trust shape.
   *
   * @param snapshot - the settings snapshot carrying `workspace_trust`.
   * @returns the verdict; `inert` when the store reports none, which is also
   *   what an in-memory store with no notion of workspace trust yields.
   */
  const asHooksTrust = (snapshot: SettingsSnapshot): WorkspaceHooksTrust => {
    const verdict = snapshot.workspace_trust;
    if (verdict === undefined || verdict.fingerprint === undefined) return { state: "inert" };
    if (verdict.state === "changed") {
      return {
        state: "changed",
        fingerprint: verdict.fingerprint,
        approved: verdict.approved ?? verdict.fingerprint,
      };
    }
    if (verdict.state === "trusted") return { state: "trusted", fingerprint: verdict.fingerprint };
    return { state: "unapproved", fingerprint: verdict.fingerprint };
  };

  /**
   * Approve (or revoke) what this workspace's own `.clarvis/` declares.
   *
   * @remarks
   * A thin delegation to the config store's workspace trust, kept under its
   * original hooks-shaped name because that is what callers already hold.
   *
   * It used to own a `workspace-hooks-trust.json` of its own, covering hooks and
   * nothing else. Two trust stores for one question — "may this repository run
   * code on my machine?" — is a worse answer than either alone: approving in one
   * place would leave the surface withheld by the other, with nothing on screen
   * to explain why. The store's verdict now covers `hooks` together with
   * `mcpServers`, `enabledPlugins`, `marketplaces` and `.clarvis/agents/*.md`,
   * so there is one fingerprint, one file and one approval.
   */
  const workspaceHooks = {
    trust: (): WorkspaceHooksTrust => asHooksTrust(configStore.readSettings()),
    approve: (): WorkspaceHooksTrust =>
      asHooksTrust(configStore.setWorkspaceTrust?.(true) ?? configStore.readSettings()),
    revoke: (): void => {
      configStore.setWorkspaceTrust?.(false);
    },
  };

  /** Exact plugin installations pinned by the process Environment snapshot. */
  const activePluginRefs = () => configStore.readSettings().active_plugins ?? [];

  const pluginSkillRoots = (): SkillRootInput[] => environmentManager.skillRoots();

  const pluginSkillBootstraps = (): PluginBootstrapSkill[] =>
    pluginContributions.skillBootstraps(activePluginRefs());

  /**
   * Bind a packaged skill's Plans override to the plugin the operator selected
   * as the Plans provider. A workspace skill with the same name has source
   * `clarvis`, not `plugin:<name>`, and therefore cannot inherit this authority.
   */
  const skillPlansMode: NonNullable<SettingsAssemblerOptions["skillPlansMode"]> = (skill) => {
    const merged = configStore.readSettings().merged as Record<string, unknown>;
    const plans = merged.plans;
    if (typeof plans !== "object" || plans === null) return undefined;
    const provider = (plans as { provider?: unknown }).provider;
    if (typeof provider !== "object" || provider === null) return undefined;
    const selected = provider as { kind?: unknown; plugin?: unknown };
    if (selected.kind !== "plugin" || typeof selected.plugin !== "string") return undefined;
    if (skill.source !== `plugin:${selected.plugin}`) return undefined;
    return pluginContributions.skillPlansMode(activePluginRefs(), selected.plugin, skill.name);
  };

  /** Provider selection is operator configuration and is re-read per resolution. */
  const loadPlanProvider = (): PlanProviderConfig | undefined => {
    const merged = configStore.readSettings().merged as Record<string, unknown>;
    const plans = merged.plans;
    if (typeof plans !== "object" || plans === null) return undefined;
    const provider = (plans as Record<string, unknown>).provider;
    return provider === undefined ? undefined : (provider as PlanProviderConfig);
  };

  /** Trusted location of the plans module independently selected by settings. */
  const planPluginPort: PlanPluginPort = {
    locate: (plugin) =>
      pluginContributions.locateCapabilityExecutable(
        activePluginRefs(),
        PLANS_CAPABILITY_NAME,
        plugin,
      ),
  };

  /**
   * Planning is host composition: one memoized store factory feeds both the
   * execution capability and the kernel's owner-scoped control plane.
   */
  const planning = createPlanningRuntime({
    workspaceRoot: opts.workspaceRoot,
    env,
    logger: componentLogger("plan"),
    loadProvider: loadPlanProvider,
    pluginPort: planPluginPort,
    executablePort: capabilityExecutables,
    ...(opts.planStoreFor !== undefined ? { storeFor: opts.planStoreFor } : {}),
  });

  const tasksEnabled = opts.builtins?.tasks !== false;
  const hooksEnabled = hooksEffective(opts.builtins?.hooks, env.CLARVIS_HOOKS_ENABLED, loadHooks);
  reportCapability(
    logger,
    "hooks",
    hooksEnabled,
    opts.builtins?.hooks === false
      ? "host_disabled"
      : env.CLARVIS_HOOKS_ENABLED
        ? "host_default"
        : "env_disabled",
  );
  const loopBuiltins =
    opts.builtins === undefined
      ? undefined
      : {
          ...(opts.builtins.tools === undefined ? {} : { tools: opts.builtins.tools }),
          ...(opts.builtins.skills === undefined ? {} : { skills: opts.builtins.skills }),
          ...(opts.builtins.hooks === undefined ? {} : { hooks: opts.builtins.hooks }),
        };

  const subscriptionManager =
    opts.subscriptions === false
      ? undefined
      : new SubscriptionManager({
          store: createFileSubscriptionStore({ dir: globalDir }),
          logger: componentLogger("subscriptions"),
        });
  const built = await buildExecuteRunDeps({
    env,
    environment: environment.values,
    logger,
    workspaceRoot: opts.workspaceRoot,
    skillRoots: pluginSkillRoots,
    skillBootstraps: pluginSkillBootstraps,
    resolveGuard: createGuardResolver({
      loadSettings: loadGuardSettings,
      logger: componentLogger("guard"),
      audit: auditLogger,
    }),
    resolveSandbox: () => sandboxPolicy.resolve(),
    resolveSecretNames: loadSecretNames,
    resolveHooks: loadHooks,
    hookCredentialNames: managedSecretNames,
    mcpAuthorization: {
      storeFile: globalPaths(globalDir).mcpOAuthFile,
      ...(opts.openMcpAuthorizationUrl === undefined
        ? {}
        : { openAuthorizationUrl: opts.openMcpAuthorizationUrl }),
    },
    capabilities: [planning.capability],
    ...(subscriptionManager === undefined
      ? {}
      : {
          resolveSubscription: (scheme, signal, context) =>
            subscriptionManager.resolve(scheme, signal, context),
        }),
    ...(opts.modelCallAdmission === undefined
      ? {}
      : { modelCallAdmission: opts.modelCallAdmission }),
    ...(opts.extensionAdmission === undefined
      ? {}
      : { extensionAdmission: opts.extensionAdmission }),
    ...(loopBuiltins === undefined ? {} : { builtins: loopBuiltins }),
    ...(opts.traceDir !== undefined ? { traceDir: opts.traceDir } : {}),
    ...(opts.onConnectionEvent !== undefined ? { onConnectionEvent: opts.onConnectionEvent } : {}),
  }).catch(async (error: unknown) => {
    await Promise.allSettled([
      capabilityExecutables.close(),
      subscriptionManager?.close() ?? Promise.resolve(),
    ]);
    throw error;
  });

  /**
   * Execution memory, constructed here rather than by the engine.
   *
   * @remarks The factory needs the decorated {@link LLMProvider} that
   * `buildExecuteRunDeps` assembles, so it is built from `built.deps.llm`
   * afterwards and the capability is folded into a re-spread deps object — the
   * same shape `createInProcessKernel` already uses to override
   * `capabilityRegistry`. It has to land on **`deps.capabilities`** and not on a
   * per-call `ExecuteRunArgs.capabilities`: `@clarvis/workflows` runs a leader
   * with `deps: ctx.deps` and nothing else, so a per-call-site injection would
   * silently strip `edit_memory` from every workflow leader.
   *
   * {@link createMemoryCapability} is called unconditionally, even with no
   * factory. The engine collects `seedMarker` from every **registered**
   * capability, active or not, which is what strips a stale `<memory>` block
   * from a continuation whose run has memory switched off; registering it only
   * when memory is on would delete that behaviour without a failing test.
   */
  /** Filled in immediately below; see `runDeps`. */
  const depsRef: { current: ExecuteRunDeps | undefined } = { current: undefined };
  /**
   * How a `memory.provider` of kind `plugin` finds the executable it names.
   *
   * @remarks The operator chooses; the plugin only offers. A plugin cannot
   * contribute a `memory:` block — `memorySettingsSpec` is not
   * `pluginContributable` — so the only way its provider is ever used is an
   * operator naming it here. Installation, explicit enabling and this selection
   * authorize the service; the plugin cannot select itself.
   */
  const memoryPluginPort: MemoryPluginPort = {
    locate: (plugin) =>
      pluginContributions.locateCapabilityExecutable(
        activePluginRefs(),
        MEMORY_CAPABILITY_NAME,
        plugin,
      ),
  };

  const memoryServerPort = createMemoryServerPort({
    servers: () => effectiveMcpServers(configStore),
    connections: built.deps.connections,
  });
  const taskServerPort = createTaskServerPort({
    connections: built.deps.connections,
  });
  reportCapability(logger, "plans", true, loadPlanProvider()?.kind ?? "markdown");
  const tasksLogger = componentLogger("tasks");
  const taskProviderFactory = new TaskProviderFactory({
    configStore,
    serverPort: taskServerPort,
    pluginContributions,
    environment: environment.values,
    enabled: tasksEnabled,
    logger: tasksLogger,
  });

  /** Filled in immediately below; see `passRunDeps`. */
  const passDepsRef: { current: ExecuteRunDeps | undefined } = { current: undefined };
  const memoryFactory: MemoryFactory | undefined = opts.memory
    ? createMemoryFactory({
        llm: built.deps.llm,
        workspaceRoot: opts.workspaceRoot,
        logger: componentLogger("memory"),
        lockWarnMs: env.CLARVIS_MEMORY_LOCK_WARN_MS,
        loadSettings: loadMemorySettings,
        // A thunk, and it must stay one: an indexer pass runs against the very
        // deps object this factory's capability is folded into, so an eager
        // value would be circular. By the time a pass resolves it, `deps` is
        // assigned.
        runDeps: () => depsRef.current,
        passRunDeps: () => passDepsRef.current,
        loadPolicy: () =>
          loadMemoryPolicy({
            global: globalPaths(globalDir).memoryPolicyFile,
            workspace: workspacePaths(opts.workspaceRoot).memoryPolicyFile,
          }),
        ...(opts.memoryStoreFor !== undefined ? { storeFor: opts.memoryStoreFor } : {}),
        serverPort: memoryServerPort,
        pluginPort: memoryPluginPort,
        executablePort: capabilityExecutables,
      })
    : undefined;
  reportCapability(
    logger,
    MEMORY_CAPABILITY_NAME,
    memoryFactory !== undefined,
    opts.memory === true ? "host_enabled" : "host_disabled",
  );
  reportCapability(logger, "tasks", tasksEnabled, tasksEnabled ? "host_default" : "host_disabled");
  const deps: ExecuteRunDeps = {
    ...built.deps,
    hostMetadata: () => ({ environment: environmentManager.runRef() }),
    capabilities: [
      ...(built.deps.capabilities ?? []),
      createMemoryCapability(memoryFactory),
      createTasksCapability({
        resolver: taskProviderFactory,
        enabled: tasksEnabled,
        logger: tasksLogger,
      }),
    ],
  };
  depsRef.current = deps;

  passDepsRef.current = composeIndexPassDeps(deps, memoryFactory);

  const traceLogger = componentLogger("trace");
  const recoveredRuns = await recoverInterruptedRuns(built.resolved.store, traceLogger);

  const cleanup = new TraceCleanup({
    store: built.resolved.store,
    ttlDays: env.CLARVIS_TRACE_TTL_DAYS,
    batchSize: env.CLARVIS_TRACE_CLEANUP_BATCH_SIZE,
    logger: traceLogger,
    protectedExecutionIds: () => referencedSessionExecutionIds(globalDir),
  });
  cleanup.start(env.CLARVIS_TRACE_CLEANUP_INTERVAL_MS);
  const housekeeping = new WorkspaceHousekeeping({
    sweepSpills: () => sweepSpillDir(opts.workspaceRoot),
    sweepMonitors: () => sweepMonitors(opts.workspaceRoot),
    sweepGlobalArtifacts: async () => {
      await sweepGlobalStateArtifacts(globalDir);
    },
    logger,
  });

  let kernel: InProcessKernel;
  try {
    kernel = createInProcessKernel({
      deps,
      logger: componentLogger("kernel"),
      workspaceRoot: opts.workspaceRoot,
      project: gitWorkspace.project,
      workspace: gitWorkspace.workspace,
      configStore,
      environmentService: environmentManager.service,
      activePlugins: () => environmentManager.activePlugins(),
      assemblerOptions: {
        ...(defaultModel !== undefined ? { defaultModel } : {}),
        defaultAgent: DEFAULT_ENTRY_AGENT,
        defaultIterationLimit: env.CLARVIS_DEFAULT_ITERATION_LIMIT,
        fallbackTokenLimit: env.CLARVIS_DEFAULT_TOTAL_TOKEN_LIMIT,
        fallbackOnExceed: env.CLARVIS_DEFAULT_ON_EXCEED,
        skillPlansMode,
        pluginMcpServerNames: () =>
          pluginContributions
            .mcpServers(activePluginRefs())
            .map((contribution) => contribution.effectiveName),
      },
      ...(memoryFactory !== undefined ? { memoryFactory } : {}),
      planFactory: planning.planFactory,
      ...(built.skills !== undefined ? { skillsProvider: built.skills } : {}),
      secretStore,
      modelCatalogService:
        subscriptionManager?.catalogService(
          createModelCatalogService(globalDir, componentLogger("models")),
        ) ?? createModelCatalogService(globalDir, componentLogger("models")),
      ...(subscriptionManager === undefined ? {} : { providerAuthService: subscriptionManager }),
      inspectSandbox: (options) => sandboxPolicy.inspect(options),
      ...(opts.globalDir !== undefined ? { globalConfigDir: opts.globalDir } : {}),
      defaultOwner: kernelDefaultOwner,
      ...(opts.ownerCache !== undefined ? { ownerCache: opts.ownerCache } : {}),
      ...(opts.onOwnerRetired !== undefined ? { onOwnerRetired: opts.onOwnerRetired } : {}),
      ...(opts.eventBuffer !== undefined ? { eventBuffer: opts.eventBuffer } : {}),
      ownershipMode,
      environment: environment.values,
      taskProviderFactory,
      tasksEnabled,
      acquireRunLease: () => {
        environmentRunRefs += 1;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          environmentRunRefs = Math.max(0, environmentRunRefs - 1);
        };
      },
      dispose: async (): Promise<void> => {
        cleanup.stop();
        await housekeeping.stop();
        try {
          await capabilityExecutables.close();
        } finally {
          try {
            await built.dispose();
          } finally {
            await subscriptionManager?.close();
          }
        }
      },
    });
  } catch (error) {
    cleanup.stop();
    await housekeeping.stop();
    await Promise.allSettled([
      capabilityExecutables.close(),
      subscriptionManager?.close() ?? Promise.resolve(),
      built.dispose(),
    ]);
    throw error;
  }
  housekeeping.start();
  logger.info(
    {
      event: "kernel.boot.ready",
      duration_ms: Date.now() - bootStartedAt,
      recovered_runs: recoveredRuns,
      capabilities: deps.capabilities?.map((c) => c.name).join(",") ?? "",
    },
    "the kernel is ready and now serves requests",
  );
  return Object.assign(kernel, { workspaceHooks });
}
