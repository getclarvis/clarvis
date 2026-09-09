import { type ExecuteRunDeps, type SkillsProvider } from "@clarvis/loop";
import type { MemoryFactory } from "@clarvis/memory/capability";
import { BUILTIN_GRANT_NAMES, readCapabilitySettings } from "@clarvis/loop/host";
import {
  createCapabilityRegistry,
  detachObserved,
  suppressSecondaryRejection,
  levelEnabled,
  NOOP_LOGGER,
  type Logger,
} from "@clarvis/capability";
import { ownerFromWorkspace, workspaceScopeKey } from "@clarvis/paths";
import { kernelCapabilityRegistry } from "./config/capability-registry.ts";
import type { NativeConfigurationRuns } from "./configuration/native-configuration.ts";
import { WORKFLOW_GRANT, WORKFLOWS_DEFAULTS, workflowsSettingsSpec } from "@clarvis/workflows";
import type {
  AgentSummary,
  ConfigService,
  KernelCapabilities,
  KernelClient,
  ProjectRef,
  ModelCatalogService,
  PluginService,
  ProviderAuthService,
  RunEvent,
  SecretService,
  SkillsService,
  StorageService,
  ExtensionProfileService,
  ExtensionProfilePluginRef,
  ResolvedExtensionProfile,
  TasksService,
  SandboxInspection,
  WorkspaceService,
  WorkspaceRef,
  StartRunParams,
} from "@clarvis/protocol";
import type { PlanFactory } from "@clarvis/plan";
import type { EventStreamOptions } from "./core/event-stream.ts";
import {
  createRunService,
  type RunExecutor,
  type RunRequestAssembler,
  type KernelRunService,
  type PreparedRunExecution,
} from "./runs/run-service.ts";
import { prepareKernelRun, type PreparedKernelRun } from "./runs/prepare-run.ts";
import { createMemoryService } from "./memory/memory-service.ts";
import { createPlansService } from "./plans/plans-service.ts";
import { createSkillsService } from "./skills/skills-service.ts";
import { createModelCatalogService } from "./models/model-catalog.ts";
import { createWorkspaceService } from "./workspace/workspace-service.ts";
import { createSessionService } from "./sessions/session-service.ts";
import { createPluginService } from "./plugins/plugin-service.ts";
import {
  createFileSecretStore,
  createSecretService,
  type SecretStore,
} from "./secrets/secret-store.ts";
import { createConfigService } from "./config/config-service.ts";
import type { ConfigStore } from "./config/config-store.ts";
import {
  createSettingsRunAssembler,
  type SettingsAssemblerOptions,
} from "./runs/settings-assembler.ts";
import {
  createWorkflowsService,
  type WorkflowsRuntimeSettings,
} from "./workflows/workflows-service.ts";
import { createWorkflowStore } from "./workflows/workflow-store.ts";
import { createKernelLifecycle, type KernelLifecycle } from "./application/lifecycle.ts";
import {
  createKernelScopePolicy,
  type KernelOwnershipMode,
  type KernelScopePolicy,
  type OperatorServices,
  type OwnerServices,
  type OwnerScope,
} from "./application/scope-policy.ts";
import { createAgentWorkflowPolicy } from "./application/workflow-policy.ts";
import { globalRoot } from "@clarvis/paths";
import { createTasksService } from "./tasks/task-service.ts";
import type { TaskProviderFactory } from "./tasks/task-provider-factory.ts";
import { kernelError } from "./core/errors.ts";
import { createUnavailableProviderAuthService } from "./subscriptions/unavailable.ts";
import { createStorageService } from "./storage/storage-service.ts";

/**
 * The kernel services whose data belongs to one owner.
 *
 * @remarks Every other service on {@link InProcessKernel} reads operator-owned
 * configuration that all owners share — settings, agents, secrets, the model
 * catalogue, plugins. These five are the ones a multi-owner host must separate,
 * which is why they are named as a group and reached through
 * {@link InProcessKernel.forOwner}.
 */
export type OwnerScopedKernel = OwnerServices & { readonly runs: KernelRunService };

/** Reference-counted lease over one owner-scoped service bundle. */
export interface OwnerLease<T> {
  readonly value: T;
  release(): void;
}

/**
 * Fully wired in-process kernel: the concrete assembly of protocol services a
 * client programs against.
 *
 * @remarks
 * The service fields are exactly the `KernelClient` surface (`runs`, `config`,
 * `memory`, `plans`, `skills`, `secrets`, `models`, `files`, `sessions`,
 * `plugins`), so a client written against this object is remote-ready: swapping
 * in a transport-backed kernel needs no client change. The owner-scoped five are
 * inherited from {@link OwnerScopedKernel} and bound to the kernel's default
 * owner; a multi-owner host reaches the others through
 * {@link InProcessKernel.forOwner}.
 */
export interface InProcessKernel extends KernelClient, OwnerScopedKernel {
  /** Ordinary service with the trusted prepared-request overload used by this host. */
  readonly runs: KernelRunService;
  /** Absolute workspace root the kernel operates over. */
  readonly workspaceRoot: string;
  /** Stable project shared by every linked workspace. */
  readonly project: ProjectRef;
  /** Central ownership and shutdown registry for kernel resources. */
  readonly lifecycle: KernelLifecycle;
  /** Whether construction guarantees one owner or isolated multi-owner scopes. */
  readonly ownershipMode: KernelOwnershipMode;
  /** Declared data scope of every concrete service. */
  readonly scopePolicy: KernelScopePolicy;
  /** Operator/workspace services instantiated once for this kernel. */
  readonly operatorServices: OperatorServices;
  /** Owner services bound to the configured default owner. */
  readonly defaultOwnerServices: OwnerServices;
  /** Settings, agents, and sandbox inspection. */
  readonly config: ConfigService;
  /** Skills catalog exposed as slash commands. */
  readonly skills: SkillsService;
  /** API keys and other secrets. */
  readonly secrets: SecretService;
  /** Model catalog and pricing. */
  readonly models: ModelCatalogService;
  /** Local subscription authentication control plane. */
  readonly providerAuth: ProviderAuthService;
  /** Workspace file access. */
  readonly files: WorkspaceService;
  /** Installed/enabled plugins. */
  readonly plugins: PluginService;
  /** Resolved Extension Profile and its management control plane. */
  readonly extensionProfiles: ExtensionProfileService;
  /** Operator-owned generated-state inventory and disposable cleanup. */
  readonly storage: StorageService;
  /** Default owner's external task control plane. */
  readonly tasks: TasksService;
  /**
   * The owner-scoped services for `owner`, memoized for the kernel's lifetime.
   *
   * @param owner - the data-isolation key. It **must** derive from a credential
   *   the host has authenticated, never from a caller-supplied field.
   * @returns runs/memory/plans/sessions/workflows filed under `owner`.
   * @remarks The inherited top-level `runs`/`memory`/`plans`/`sessions`/`workflows` are
   *   `forOwner(defaultOwner)`, so a single-owner host never calls this. Entries
   *   stay pinned for compatibility callers. Hosted callers use
   *   {@link acquireOwner}, whose zero-reference entries are retired safely.
   */
  forOwner(owner: string): OwnerScopedKernel;
  /**
   * Acquire a reclaimable owner scope. Hosted/session-oriented callers should
   * prefer this to {@link forOwner}, which deliberately pins compatibility
   * callers until kernel shutdown.
   */
  acquireOwner(owner: string): Promise<OwnerLease<OwnerScopedKernel>>;
  /** Prepare immutable execution inputs without launching; owner must come from host authentication. */
  prepareRun(params: StartRunParams, owner?: string): PreparedKernelRun;
  /** Lists the configured agents, delegating to {@link ConfigService.listAgents}. */
  listAgents(): Promise<AgentSummary[]>;
  /** Begin durable memory-queue recovery after the host's critical boot path. */
  startMemoryRecovery(): void;
  /** Releases resources by invoking the {@link CreateKernelOptions.dispose} hook, if any. */
  close(): Promise<void>;
}

/**
 * Options for {@link createInProcessKernel}.
 *
 * @remarks
 * `deps`, `workspaceRoot`, and `configStore` are the mandatory backing; every
 * other field is an optional override or default-fills from the workspace/global
 * Clarvis dir (see {@link createInProcessKernel}).
 */
export interface CreateKernelOptions {
  /** Host-only native configuration execution, bound to volatile user consent. */
  nativeConfiguration?: NativeConfigurationRuns;
  /** Loop execution deps the run service drives (built by `buildExecuteRunDeps`). */
  deps: ExecuteRunDeps;
  /** Absolute workspace root the kernel operates over. */
  workspaceRoot: string;
  /** Explicit project identity established by the host. */
  project: ProjectRef;
  /** Explicit workspace identity bound to this kernel. */
  workspace: WorkspaceRef;
  /** Settings/agents store the config service and run assembler read from. */
  configStore: ConfigStore;
  /** Overrides how a run request is assembled; defaults to the settings-based assembler. */
  assembleRunRequest?: RunRequestAssembler;
  /** Options passed to the default settings assembler when `assembleRunRequest` is omitted. */
  assemblerOptions?: SettingsAssemblerOptions;
  /** Supplies the memory subsystem; when omitted the memory service is inert. */
  memoryFactory?: MemoryFactory;
  /** Multi-owner cache policy; defaults to 128 resident owners and five minutes idle. */
  ownerCache?: { maxOwners?: number; idleMs?: number };
  /** Release host-owned persistence caches after an owner has fully retired. */
  onOwnerRetired?: (owner: string) => void | Promise<void>;
  /**
   * Settings-sensitive, per-owner plan data plane.
   *
   * @remarks The same factory the planning capability is built with, so the
   * kernel's plans service and a run resolve one store per owner. Absent, the
   * plans service is inert.
   */
  planFactory?: PlanFactory;
  /** The owner every unscoped service call is filed under. Defaults to
   * `ownerFromWorkspace(workspaceRoot)` — the local product's single owner. A
   * multi-owner host leaves this alone and calls
   * {@link InProcessKernel.forOwner} per authenticated connection. */
  defaultOwner?: string;
  /**
   * The logger this kernel and its services write diagnostics through.
   *
   * @remarks Defaults to a no-op. Before this existed `createInProcessKernel`
   * took no logger at all, so all fifteen services, the scope policy and owner
   * retirement were structurally unable to say anything — `createFileKernel`
   * built a logger and kept it to itself.
   *
   * A host normally passes a component child (see `createComponentLoggers`),
   * not its root logger.
   */
  logger?: Logger;
  /** Supplies the skills catalog; when omitted the skills service is empty. */
  skillsProvider?: SkillsProvider;
  /** Backing secret store; defaults to a file-backed store under the global dir. */
  secretStore?: SecretStore;
  /** Subscription-aware model catalog; defaults to the public catalog only. */
  modelCatalogService?: ModelCatalogService;
  /** Local subscription authentication service; defaults to explicit unavailability. */
  providerAuthService?: ProviderAuthService;
  /** Global Clarvis config dir for models/sessions; defaults to the standard global root. */
  globalConfigDir?: string;
  /** Home directory owning the shared `.agents/plugins` inventory; injectable for isolated hosts. */
  home?: string;
  /** Host-owned Extension Profile control plane; defaults to immutable builtin:default. */
  extensionProfileService?: ExtensionProfileService;
  /** Exact active plugin refs from the host's pinned Extension Profile snapshot. */
  activePlugins?: () => readonly ExtensionProfilePluginRef[];
  /** Teardown hook invoked by {@link InProcessKernel.close}. */
  dispose?: () => Promise<void>;
  /** Provides sandbox inspection to the config service; when omitted it is unavailable. */
  inspectSandbox?: (options?: { refresh?: boolean }) => Promise<SandboxInspection>;
  /**
   * Event-stream backpressure for every owner's run service. Defaults to the
   * same bounded count-and-byte policy for local and remote clients.
   */
  eventBuffer?: EventStreamOptions<RunEvent>;
  /** Capability values exposed directly and during transport handshakes. */
  capabilities?: Partial<KernelCapabilities>;
  /** Explicit construction mode; defaults to the local product's single-owner mode. */
  ownershipMode?: KernelOwnershipMode;
  /** Immutable raw environment used by effect adapters such as plugin Git. */
  environment?: Readonly<Record<string, string | undefined>>;
  /** Shared settings-sensitive provider selector used by runs and control plane. */
  taskProviderFactory?: TaskProviderFactory;
  /** Builtin gate for both Tasks run and control-plane surfaces. */
  tasksEnabled?: boolean;
  /** Host lease acquired for each live run in this workspace. */
  acquireRunLease?: () => () => void;
  /** Placement-neutral loop executor shared by ordinary and workflow runs. */
  executeRun?: RunExecutor;
}

/** Capability defaults shared by direct and transport-backed local kernels. */
export const DEFAULT_KERNEL_CAPABILITIES: KernelCapabilities = {
  memory: false,
  skills: false,
  agent_tools: true,
  tasks: false,
  runtime: {
    kind: "native",
    host_platform: process.platform,
    isolation: "host",
    lifecycle: "ready",
  },
};

/** Minimal Extension Profile service for embedders that do not use the file-backed host. */
function createBuiltinExtensionProfileService(): ExtensionProfileService {
  const current: ResolvedExtensionProfile = {
    id: "builtin:default",
    ref: { scope: "builtin", name: "default" },
    immutable: true,
    status: "ready",
    fingerprint: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    selection_origin: "builtin",
    plugins: [],
    standalone_skills: [],
    issues: [],
    counts: {
      plugins_active: 0,
      standalone_skills_active: 0,
      plugin_skills_active: 0,
      mcp_servers_active: 0,
      hooks_declared: 0,
    },
  };
  const unavailable = (): never => {
    throw kernelError(
      "unavailable",
      "Extension Profile definitions require the file-backed kernel",
    );
  };
  return {
    list: async () => [{ ref: current.ref, immutable: true }],
    current: async () => current,
    get: async (ref) => {
      if (ref.scope !== "builtin" || ref.name !== "default") unavailable();
      return current;
    },
    inventory: async () => ({ plugins: [], standalone_skills: [] }),
    preview: async (ref) => {
      if (ref.scope !== "builtin" || ref.name !== "default") unavailable();
      return {
        current,
        target: current,
        delta: {
          plugins_entering: [],
          plugins_leaving: [],
          skills_entering: [],
          skills_leaving: [],
          mcp_servers_entering: [],
          mcp_servers_leaving: [],
          hooks_entering: [],
          hooks_leaving: [],
        },
        token: "builtin",
        requires_workspace_trust: false,
      };
    },
    previewClear: async () => unavailable(),
    previewComposition: async () => unavailable(),
    select: async () => unavailable(),
    clearSelection: async () => unavailable(),
    applyComposition: async () => unavailable(),
    create: async () => unavailable(),
    update: async () => unavailable(),
    delete: async () => unavailable(),
    clone: async () => unavailable(),
  };
}

/**
 * Assembles the full set of protocol services around loop execution deps and a
 * {@link ConfigStore}, yielding a ready-to-serve {@link InProcessKernel}.
 *
 * @param opts - backing deps and optional service overrides; see {@link CreateKernelOptions}.
 * @returns the wired kernel exposing the complete `KernelClient` service surface.
 * @remarks Defaults the run `owner` from the workspace, defaults omitted services
 *   from the workspace/global Clarvis dir, and falls back to the settings-based
 *   run assembler when `assembleRunRequest` is not supplied. Construction is
 *   synchronous — no I/O is performed here.
 */
export function createInProcessKernel(opts: CreateKernelOptions): InProcessKernel {
  if (opts.workspace.projectId !== opts.project.id) {
    throw new Error("createInProcessKernel: workspace.projectId must match project.id.");
  }
  const logger: Logger = opts.logger ?? NOOP_LOGGER;
  const lifecycle = createKernelLifecycle(logger);
  if (opts.dispose !== undefined) {
    lifecycle.register({ close: opts.dispose });
  }
  const memoryFactory = opts.memoryFactory;
  if (memoryFactory !== undefined) {
    lifecycle.register({ close: () => memoryFactory.stop() });
  }
  const defaultOwner = opts.defaultOwner ?? ownerFromWorkspace(opts.workspaceRoot);
  const ownershipMode = opts.ownershipMode ?? "single";
  const assembleRunRequest =
    opts.assembleRunRequest ??
    createSettingsRunAssembler(opts.configStore, {
      ...(opts.assemblerOptions ?? {}),
      ...(opts.skillsProvider !== undefined ? { skills: opts.skillsProvider } : {}),
    });
  const planFactory = opts.planFactory;
  if (ownershipMode === "multi" && planFactory === undefined) {
    throw new Error("createInProcessKernel: multi-owner mode requires an owner-aware planFactory.");
  }
  const globalDir = opts.globalConfigDir ?? globalRoot();
  const eventBuffer: EventStreamOptions<RunEvent> = opts.eventBuffer ?? {};
  const workflowPolicy = createAgentWorkflowPolicy(opts.configStore, opts.skillsProvider);

  /**
   * The engine deps every run in this kernel executes against, with this
   * kernel's own capability registry merged into whatever the host supplied.
   *
   * @remarks A **merge**, deliberately, not a fallback. Every per-run param a
   * registered capability declares has to be in the request schema or `strict()`
   * rejects the body — and this kernel emits two of them itself: `plans` from a
   * workspace's settings block on every ordinary run, and `plans: "off"` on
   * every workflow leader. A fallback covered only the case where the host
   * passed no registry at all, and `buildExecuteRunDeps` always passes one; when
   * planning is off that registry is present but *empty*, so the fallback never
   * fired and a host-composed capability registry without this block turned
   * every run into an unrecognized-key `ValidationError`. Merging keeps this kernel's blocks
   * unconditional while still carrying any a host registered on top; on a key
   * collision the kernel wins, because it is the schema authority. Grant
   * declarations are copied too; matching duplicates are harmless and
   * conflicting declarations fail instead of changing a host grant's meaning.
   */
  const mergedRegistry = createCapabilityRegistry();
  const seenSpecKeys = new Set<string>();
  for (const spec of [
    ...kernelCapabilityRegistry.specs(),
    ...(opts.deps.capabilityRegistry?.specs() ?? []),
  ]) {
    if (seenSpecKeys.has(spec.key)) continue;
    seenSpecKeys.add(spec.key);
    mergedRegistry.register(spec);
  }
  for (const grant of [
    ...kernelCapabilityRegistry.grants(),
    ...(opts.deps.capabilityRegistry?.grants() ?? []),
  ]) {
    mergedRegistry.registerGrant(grant);
  }
  const runDeps: ExecuteRunDeps = {
    ...opts.deps,
    capabilityRegistry: mergedRegistry,
  };
  if (levelEnabled(logger, "debug")) {
    logger.debug(
      {
        event: "kernel.capabilities.registered",
        specs: mergedRegistry
          .specs()
          .map((spec) => spec.key)
          .join(","),
        grants: mergedRegistry
          .grants()
          .map((grant) => grant.name)
          .join(","),
      },
      "the settings and grant vocabulary this kernel validates against is fixed; a block registered later reads as an unrecognized key",
    );
  }

  interface OwnerCacheEntry {
    services: OwnerScopedKernel;
    stateOwner: string;
    prepareRun(params: StartRunParams): PreparedKernelRun;
    refs: number;
    runRefs: number;
    runDrained?: Promise<void>;
    resolveRunDrained?: () => void;
    pinned: boolean;
    lastUsedAt: number;
    timer?: ReturnType<typeof setTimeout>;
  }

  /**
   * How many owners' kernels stay resident, and how long an idle one survives.
   *
   * @remarks Neither bounds correctness — an evicted owner is rebuilt on its
   * next call — so both are pure cache tuning, and the cost of being wrong is
   * latency rather than behaviour. `maxOwners` is sized for a multi-tenant
   * server rather than for `code`, which has one owner and never approaches it;
   * `idleMs` is the span over which a returning caller should not pay a rebuild,
   * which is a person's pause between requests rather than a session's length.
   */
  const maxOwners = opts.ownerCache?.maxOwners ?? 128;
  const ownerIdleMs = opts.ownerCache?.idleMs ?? 5 * 60_000;
  if (!Number.isInteger(maxOwners) || maxOwners < 1 || maxOwners > 10_000) {
    throw new Error("createInProcessKernel: ownerCache.maxOwners must be between 1 and 10000.");
  }
  if (!Number.isFinite(ownerIdleMs) || ownerIdleMs < 0) {
    throw new Error("createInProcessKernel: ownerCache.idleMs must be non-negative.");
  }
  const ownerEntries = new Map<string, OwnerCacheEntry>();
  const retiringOwners = new Map<string, Promise<void>>();
  let memoryRecoveryStarted = false;
  let selectedPluginMutation = false;
  let selectedPluginRecompositionRequired = false;

  const ownerOccupancy = (): number => ownerEntries.size + retiringOwners.size;

  const buildOwner = (
    owner: string,
  ): Pick<OwnerCacheEntry, "services" | "stateOwner" | "prepareRun"> => {
    const stateOwner = workspaceScopeKey(owner, opts.project.id, opts.workspace.id);
    const scope: OwnerScope = {
      owner: stateOwner,
      workspace: opts.workspaceRoot,
      projectId: opts.project.id,
      workspaceId: opts.workspace.id,
    };
    if (memoryRecoveryStarted) opts.memoryFactory?.start(scope.owner);
    const runLogger = logger.child?.({ owner: stateOwner }) ?? logger;
    const workflows = createWorkflowsService({
      deps: runDeps,
      owner: scope.owner,
      workspace: scope.workspace,
      globalConfigDir: globalDir,
      assembleRunRequest,
      store: createWorkflowStore({ dir: globalDir, owner: scope.owner }),
      readSettings: () => readWorkflowsSettings(opts.configStore),
      leaderProfiles: () => workflowPolicy.leaderProfiles(),
      resolveLeaderDefault: (managerAgent) => workflowPolicy.resolveLeaderDefault(managerAgent),
      eventBuffer,
      lifecycle,
      ...(opts.executeRun === undefined ? {} : { executeRun: opts.executeRun }),
    });
    const baseRuns = createRunService({
      ...(opts.nativeConfiguration === undefined
        ? {}
        : { nativeConfiguration: opts.nativeConfiguration }),
      deps: runDeps,
      owner: scope.owner,
      assembleRunRequest,
      eventBuffer,
      isManagerRun: (params) => workflowPolicy.isManagerRun(params),
      runManagerWorkflow: (params) => workflows.runManagerWorkflow(params),
      lifecycle,
      logger: runLogger,
      ...(opts.executeRun === undefined ? {} : { executeRun: opts.executeRun }),
    });
    const runs =
      opts.acquireRunLease === undefined
        ? baseRuns
        : {
            ...baseRuns,
            async start(
              params: Parameters<typeof baseRuns.start>[0],
              prepared?: PreparedRunExecution,
            ) {
              if (opts.nativeConfiguration?.requested(params) === true)
                return baseRuns.start(params, prepared);
              const release = opts.acquireRunLease!();
              try {
                const handle = await baseRuns.start(params, prepared);
                // The workspace run lease covers late capability delivery too.
                // Releasing it at `done` could evict the workspace kernel while
                // the managed stream is still inside its bounded ingest grace.
                void handle.closed.then(release, release);
                return handle;
              } catch (error) {
                release();
                throw error;
              }
            },
          };
    const services: OwnerScopedKernel = {
      runs,
      memory: createMemoryService({ factory: opts.memoryFactory, owner: scope.owner }),
      plans: createPlansService({
        ...(planFactory === undefined ? {} : { resolve: () => planFactory.storeFor(scope.owner) }),
      }),
      sessions: createSessionService({
        dir: globalDir,
        owner: scope.owner,
        projectId: scope.projectId,
        workspaceId: scope.workspaceId,
        logger: runLogger,
      }),
      workflows,
      tasks: createTasksService({
        ...(opts.taskProviderFactory === undefined ? {} : { factory: opts.taskProviderFactory }),
        owner: scope.owner,
        enabled: opts.tasksEnabled !== false && opts.taskProviderFactory !== undefined,
      }),
    };
    return {
      services,
      stateOwner,
      prepareRun(params) {
        const entry = ownerEntries.get(owner);
        if (entry === undefined)
          throw kernelError("unavailable", "run owner generation is no longer resident");
        return prepareKernelRun(params, {
          configStore: opts.configStore,
          ...(opts.assemblerOptions === undefined
            ? {}
            : { assemblerOptions: opts.assemblerOptions }),
          ...(opts.assembleRunRequest === undefined
            ? {}
            : { assembleRunRequest: opts.assembleRunRequest }),
          ...(opts.skillsProvider === undefined ? {} : { skills: opts.skillsProvider }),
          nativeConfigurationRequested: (request) =>
            opts.nativeConfiguration?.requested(request) === true,
          workflowSettings: readWorkflowsSettings,
          start: (request, prepared) => {
            if (ownerEntries.get(owner) !== entry)
              throw kernelError("unavailable", "prepared run owner generation was retired");
            return entry.services.runs.start(request, prepared);
          },
          startWorkflow: (request, prepared) => workflows.runManagerWorkflow(request, prepared),
        });
      },
    };
  };

  const retireOwner = (owner: string, entry: OwnerCacheEntry): Promise<void> => {
    if (entry.refs > 0 || entry.runRefs > 0 || entry.pinned) return Promise.resolve();
    if (ownerEntries.get(owner) !== entry) return retiringOwners.get(owner) ?? Promise.resolve();
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    ownerEntries.delete(owner);
    const retiring = Promise.resolve()
      .then(async () => {
        const cleanup = await Promise.allSettled([
          Promise.resolve().then(() => opts.nativeConfiguration?.retireOwner(entry.stateOwner)),
          opts.memoryFactory?.stopOwner?.(entry.stateOwner) ?? Promise.resolve(),
          Promise.resolve().then(() => planFactory?.evictOwner?.(entry.stateOwner)),
          Promise.resolve().then(() => opts.onOwnerRetired?.(entry.stateOwner)),
        ]);
        const failures = cleanup.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failures.length > 0) {
          throw new AggregateError(
            failures.map((failure) => failure.reason as unknown),
            `failed to retire owner '${owner}' cleanly`,
          );
        }
      })
      .finally(() => {
        if (retiringOwners.get(owner) === retiring) retiringOwners.delete(owner);
      });
    retiringOwners.set(owner, retiring);
    // Retirement is commonly timer- or release-triggered. Attach an observer at
    // creation so those detached paths can never surface an unhandled rejection;
    // callers that await the original promise still receive its failure.
    detachObserved(() => retiring, {
      operation: "retire kernel owner",
      workspace: opts.workspaceRoot,
      logger,
    });
    return retiring;
  };

  const validateOwner = (owner: string): void => {
    if (owner.trim() === "") {
      throw new Error("InProcessKernel.forOwner: 'owner' must be a non-empty string.");
    }
  };

  const evictOneIdleOwner = (): boolean => {
    let candidate: [string, OwnerCacheEntry] | undefined;
    for (const value of ownerEntries) {
      const [, entry] = value;
      if (entry.refs > 0 || entry.runRefs > 0 || entry.pinned) continue;
      if (candidate === undefined || entry.lastUsedAt < candidate[1].lastUsedAt) candidate = value;
    }
    if (candidate === undefined) return false;
    suppressSecondaryRejection(
      retireOwner(candidate[0], candidate[1]),
      "kernel owner retirement observer",
    );
    return true;
  };

  const residentOwner = (owner: string, pin: boolean): OwnerCacheEntry => {
    validateOwner(owner);
    if (lifecycle.state !== "open") {
      throw kernelError("unavailable", "kernel is closing");
    }
    if (retiringOwners.has(owner)) {
      throw kernelError("unavailable", `owner '${owner}' is still releasing resources`);
    }
    const hit = ownerEntries.get(owner);
    if (hit !== undefined) {
      hit.lastUsedAt = Date.now();
      if (pin) hit.pinned = true;
      if (hit.timer !== undefined) {
        clearTimeout(hit.timer);
        delete hit.timer;
      }
      return hit;
    }
    if (ownerOccupancy() >= maxOwners) evictOneIdleOwner();
    if (ownerOccupancy() >= maxOwners) {
      throw kernelError(
        "resource_exhausted",
        `kernel owner cache is full (${maxOwners} active, pinned, or retiring owners)`,
      );
    }
    const built = buildOwner(owner);
    const entry: OwnerCacheEntry = {
      services: built.services,
      stateOwner: built.stateOwner,
      prepareRun: built.prepareRun,
      refs: 0,
      runRefs: 0,
      pinned: pin,
      lastUsedAt: Date.now(),
    };
    ownerEntries.set(owner, entry);
    entry.services = withOwnerRunLease(owner, entry);
    return entry;
  };

  const scheduleOwnerRetirement = (owner: string, entry: OwnerCacheEntry): void => {
    if (entry.refs > 0 || entry.runRefs > 0 || entry.pinned || ownerEntries.get(owner) !== entry)
      return;
    if (ownerIdleMs === 0) {
      suppressSecondaryRejection(retireOwner(owner, entry), "kernel owner retirement observer");
      return;
    }
    entry.timer = setTimeout(() => {
      delete entry.timer;
      suppressSecondaryRejection(retireOwner(owner, entry), "kernel owner retirement observer");
    }, ownerIdleMs);
    entry.timer.unref?.();
  };

  /** Keep an owner generation resident for the complete managed-run lifecycle. */
  const withOwnerRunLease = (owner: string, entry: OwnerCacheEntry): OwnerScopedKernel => {
    const services = entry.services;
    const runs = services.runs;
    return {
      ...services,
      runs: {
        ...runs,
        async start(params: Parameters<typeof runs.start>[0], prepared?: PreparedRunExecution) {
          // Preserve RunService's terminal-handle contract after shutdown. The
          // base service turns this into a failed handle instead of rejecting.
          if (lifecycle.state !== "open") return runs.start(params, prepared);
          if (ownerEntries.get(owner) !== entry) {
            throw kernelError("unavailable", `owner '${owner}' is no longer resident`);
          }
          if (selectedPluginRecompositionRequired) {
            throw kernelError(
              "unavailable",
              "a selected plugin changed; reconnect the kernel before starting another run",
            );
          }
          if (selectedPluginMutation) {
            throw kernelError(
              "conflict",
              "a selected plugin is changing; reconnect after the mutation before starting a run",
            );
          }
          if (entry.timer !== undefined) {
            clearTimeout(entry.timer);
            delete entry.timer;
          }
          if (entry.runRefs === 0) {
            let resolveRunDrained!: () => void;
            entry.runDrained = new Promise<void>((resolve) => {
              resolveRunDrained = resolve;
            });
            entry.resolveRunDrained = resolveRunDrained;
          }
          entry.runRefs += 1;
          let released = false;
          const release = (): void => {
            if (released) return;
            released = true;
            entry.runRefs = Math.max(0, entry.runRefs - 1);
            if (entry.runRefs === 0) {
              entry.resolveRunDrained?.();
              delete entry.resolveRunDrained;
              delete entry.runDrained;
            }
            entry.lastUsedAt = Date.now();
            scheduleOwnerRetirement(owner, entry);
          };
          try {
            const handle = await runs.start(params, prepared);
            void handle.closed.then(release, release);
            return handle;
          } catch (error) {
            release();
            throw error;
          }
        },
      },
    };
  };

  /**
   * Owner ids ultimately reach {@link ownerSegment} (via the trace store and
   * session service), which throws on an empty string rather than degrading
   * into a shared path segment. Validating here turns that into one clear
   * kernel-level error instead of an uncaught `TypeError` surfacing from deep
   * inside session-service construction — reachable both from a blank
   * `defaultOwner` and from any live `forOwner` call a host makes on a
   * per-request basis (e.g. an owner id sourced from an upstream auth lookup
   * that missed).
   */
  const forOwner = (owner: string): OwnerScopedKernel => {
    return residentOwner(owner, true).services;
  };
  const acquireOwner = async (owner: string): Promise<OwnerLease<OwnerScopedKernel>> => {
    const pending = retiringOwners.get(owner);
    if (pending !== undefined) await pending;
    const entry = residentOwner(owner, false);
    entry.refs += 1;
    let released = false;
    return {
      value: entry.services,
      release(): void {
        if (released) return;
        released = true;
        entry.refs = Math.max(0, entry.refs - 1);
        entry.lastUsedAt = Date.now();
        scheduleOwnerRetirement(owner, entry);
      },
    };
  };
  const startMemoryRecovery = (): void => {
    if (memoryRecoveryStarted) return;
    memoryRecoveryStarted = true;
    for (const entry of ownerEntries.values()) opts.memoryFactory?.start(entry.stateOwner);
  };
  const scoped = forOwner(defaultOwner);

  lifecycle.register({
    async close(): Promise<void> {
      const retiring: Promise<void>[] = [];
      for (const [owner, entry] of ownerEntries) {
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        entry.refs = 0;
        entry.pinned = false;
        const drained = entry.runDrained;
        retiring.push(
          drained === undefined
            ? retireOwner(owner, entry)
            : drained.then(() => retireOwner(owner, entry)),
        );
      }
      retiring.push(...retiringOwners.values());
      await Promise.allSettled(retiring);
    },
  });

  const config = createConfigService(opts.configStore, {
    ...(opts.inspectSandbox !== undefined ? { inspectSandbox: opts.inspectSandbox } : {}),
    /**
     * Composed exactly as `executeRun` composes the registry it validates
     * against: the engine's built-ins, the host registry's declarations, and
     * every registered capability's own `grants`. A capability declares its
     * grant on itself rather than on the registry — `use_skills`,
     * `workflow` and capability-owned grants arrive that way — so reading the
     * registry alone reported the built-ins only, and every agent carrying one
     * of those grants would have been judged unrunnable.
     */
    knownGrants: () => [
      ...BUILTIN_GRANT_NAMES,
      ...mergedRegistry.grants().map((grant) => grant.name),
      ...(runDeps.capabilities ?? []).flatMap((capability) =>
        (capability.grants ?? []).map((grant) => grant.name),
      ),
      // The workflows capability is injected into a manager's `executeRun`
      // rather than into `runDeps`, deliberately — only an entry agent carrying
      // this grant gets one. It is still a grant this kernel accepts, so a
      // profile naming it is runnable and must not be reported otherwise.
      WORKFLOW_GRANT,
    ],
  });
  const skills = createSkillsService({
    skills: opts.skillsProvider,
    ...(opts.assemblerOptions?.skillPlansMode !== undefined
      ? { skillPlansMode: opts.assemblerOptions.skillPlansMode }
      : {}),
  });
  const secrets = createSecretService(opts.secretStore ?? createFileSecretStore());
  const models = opts.modelCatalogService ?? createModelCatalogService(globalDir, logger);
  const providerAuth = opts.providerAuthService ?? createUnavailableProviderAuthService();
  const files = createWorkspaceService(opts.workspaceRoot);
  const plugins = createPluginService({
    globalDir,
    workspaceRoot: opts.workspaceRoot,
    ...(opts.home === undefined ? {} : { home: opts.home }),
    enabledPlugins:
      opts.activePlugins ??
      (() => {
        const snapshot = opts.configStore.readSettings();
        if (snapshot.active_plugins !== undefined) return [...snapshot.active_plugins];
        const merged = snapshot.merged as Record<string, unknown>;
        return Array.isArray(merged.enabledPlugins)
          ? (merged.enabledPlugins as ExtensionProfilePluginRef[])
          : [];
      }),
    withSelectedMutation: async (_ref, mutation) => {
      if (selectedPluginMutation) {
        throw kernelError("conflict", "another selected plugin mutation is already in progress");
      }
      if ([...ownerEntries.values()].some((entry) => entry.runRefs > 0)) {
        throw kernelError("conflict", "finish active runs before changing a selected plugin");
      }
      selectedPluginMutation = true;
      try {
        if ([...ownerEntries.values()].some((entry) => entry.runRefs > 0)) {
          throw kernelError("conflict", "finish active runs before changing a selected plugin");
        }
        const result = await mutation();
        selectedPluginRecompositionRequired = true;
        return result;
      } finally {
        selectedPluginMutation = false;
      }
    },
    environment: opts.environment ?? process.env,
    lifecycle,
    logger,
  });
  const storage = createStorageService(globalDir);
  const extensionProfiles = opts.extensionProfileService ?? createBuiltinExtensionProfileService();
  /**
   * What this kernel actually advertises over the handshake.
   *
   * @remarks `memory` and `skills` are derived from what was wired rather than
   * left at their `false` defaults, which no code path ever raised: a client
   * gating its UI on the handshake would have been told neither exists on a
   * kernel where both are fully configured. `opts.capabilities` is spread last
   * so a host can still force either value.
   *
   * These say the subsystem is **wired**, not that it will answer. This value
   * is computed once, at construction, while `memory.*` resolves its settings
   * per call — so a workspace whose block is absent or `enabled: false` still
   * reports `memory: true` and rejects every call as `unavailable`. That is not
   * a gap to close here: no value fixed at construction can track a file the
   * user edits afterwards. A client decides *whether to show* memory from this,
   * and *whether it is on* from the settings it already reads.
   */
  const capabilities: KernelCapabilities = {
    ...DEFAULT_KERNEL_CAPABILITIES,
    memory: opts.memoryFactory !== undefined,
    skills: opts.skillsProvider !== undefined,
    tasks: opts.tasksEnabled !== false && opts.taskProviderFactory !== undefined,
    ...opts.capabilities,
  };
  const operatorServices: OperatorServices = {
    config,
    skills,
    secrets,
    models,
    providerAuth,
    files,
    plugins,
    extensionProfiles,
    storage,
  };
  const scopePolicy = createKernelScopePolicy(ownershipMode);
  return {
    workspaceRoot: opts.workspaceRoot,
    project: opts.project,
    lifecycle,
    ownershipMode,
    scopePolicy,
    operatorServices,
    defaultOwnerServices: scoped,
    capabilities,
    workspace: opts.workspace,
    ...scoped,
    config,
    skills,
    secrets,
    models,
    providerAuth,
    files,
    plugins,
    extensionProfiles,
    storage,
    tasks: scoped.tasks,
    forOwner,
    acquireOwner,
    prepareRun: (params, owner = defaultOwner) => residentOwner(owner, false).prepareRun(params),
    listAgents: () => config.listAgents(),
    startMemoryRecovery,
    async close(): Promise<void> {
      await lifecycle.close();
    },
  };
}

/**
 * Read the merged `workflows` settings block, materializing the concurrency and
 * budget defaults. The block is pure fan-out tuning — whether a run is a workflow
 * is decided solely by the `workflow` grant on its entry agent profile.
 *
 * @param store - the config store to read merged settings from.
 * @returns the resolved {@link WorkflowsRuntimeSettings}.
 */
function readWorkflowsSettings(store: Pick<ConfigStore, "readSettings">): WorkflowsRuntimeSettings {
  const merged = store.readSettings().merged as Record<string, unknown>;
  const block = readCapabilitySettings<{
    max_concurrency?: number;
    max_total_leaders?: number;
    budget_tokens?: number | null;
  }>(merged, workflowsSettingsSpec);
  return {
    max_concurrency:
      typeof block?.max_concurrency === "number"
        ? block.max_concurrency
        : WORKFLOWS_DEFAULTS.max_concurrency,
    max_total_leaders:
      typeof block?.max_total_leaders === "number"
        ? block.max_total_leaders
        : WORKFLOWS_DEFAULTS.max_total_leaders,
    budget_tokens:
      block?.budget_tokens === undefined ? WORKFLOWS_DEFAULTS.budget_tokens : block.budget_tokens,
  };
}
