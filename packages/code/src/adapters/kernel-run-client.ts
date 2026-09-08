import { resolveAgentsByName } from "@clarvis/kernel/config";
import type {
  ConfigService,
  ElicitationRequest,
  ElicitationResponse,
  ExtensionProfileRunRef,
  ExtensionProfileService,
  KernelClient,
  KernelCapabilities,
  Message as ProtoMessage,
  MessageContent,
  ModelCatalogService,
  PlansService,
  PluginService,
  ProviderAuthService,
  RunDetail,
  RunEvent,
  RunHandle as ProtocolRunHandle,
  RunResult,
  RunService,
  SecretService,
  SessionService,
  SkillsService,
  StartRunParams,
  StorageService,
  TasksService,
  WorkflowsService,
  WorkspaceService,
  ProjectRef,
  WorkspaceRef,
} from "@clarvis/protocol";
import type { ElicitRequestParams, ElicitResult } from "./elicit-types.ts";
import type { EventSource } from "./event-span.ts";
import { hasKernelErrorCode } from "./kernel-errors.ts";
import { detachObserved } from "../core/tasks.ts";
import { diagnosticEvent } from "../core/diagnostic-events.ts";
import type {
  MemoryIngestNotice,
  ProfileInfo,
  RunHandle,
  RunProgress,
  StartRunInput,
  SteerResult,
  CompactResult,
} from "./run-types.ts";

/**
 * The in-process run backend: drives runs through @clarvis/kernel, presenting the
 * run-slice surface the UI's run host consumes (startRun → RunHandle, steer,
 * getRun, listProfiles, deleteRun).
 *
 * The kernel's protocol RunHandle streams RunEvents on an async iterable and
 * answers elicitations via request/respond; this client pumps that stream into
 * `onEvent`, derives a progress line from it, and bridges elicitation to the UI's
 * request/response callback. Memory-ingest notices are post-run: the kernel holds
 * the stream open for the index pass's terminal notice, and the pump routes
 * `memory_ingest` events to `onMemoryIngest` — status-line material, never the
 * transcript.
 */
export interface KernelRunClientCallbacks {
  onEvent(event: RunEvent, source: EventSource, executionId: string): void;
  onProgress?(progress: RunProgress, executionId: string): void;
  onMemoryIngest?(notice: MemoryIngestNotice): void;
  onElicit?(params: ElicitRequestParams): Promise<ElicitResult>;
}

/** The run-slice surface a {@link createKernelRunClient} exposes to the UI's run host. */
export interface KernelRunClient {
  readonly project: ProjectRef;
  readonly workspace: WorkspaceRef;
  readonly capabilities: KernelCapabilities;
  connect(): Promise<void>;
  reconnect(): Promise<void>;
  /** The kernel-resolved agent catalogue; pass an already-fetched list to skip the round trip. */
  listProfiles(
    prefetched?: Awaited<ReturnType<KernelClient["config"]["listAgents"]>>,
  ): Promise<ProfileInfo[]>;
  /** Launch a run. When the entry profile carries the `workflow` grant the kernel
   * routes it as a workflow (manager fanning out leader runs) transparently,
   * returning the same {@link RunHandle} the run host drives. */
  startRun(input: StartRunInput): RunHandle;
  /** The workflow tree control plane (kernel.workflows): get/list/delete. */
  readonly workflows: WorkflowsService;
  steer(input: {
    executionId: string;
    message: MessageContent;
    profile?: string;
  }): Promise<SteerResult>;
  compact(input: {
    executionId: string;
    request?: string;
    mechanicalTargetTokens?: number;
  }): Promise<CompactResult>;
  context(executionId: string, targetWindowTokens?: number): ReturnType<RunService["context"]>;
  getRun(executionId: string): Promise<RunDetail | null>;
  deleteRun(executionId: string): Promise<boolean>;
  /** Current-plan document reader; retained-plan administration is not a TUI surface. */
  readonly plans: Pick<PlansService, "read">;
  /** The workspace's user-invocable skills (kernel.skills), for slash-commands. */
  readonly skills: SkillsService;
  /** Workspace configuration (settings + agents + context). */
  readonly config: ConfigService;
  /** Provider secrets (API keys) — names-only + set/delete. */
  readonly secrets: SecretService;
  /** The model/pricing catalog. */
  readonly models: ModelCatalogService;
  /** Local subscription login/status control plane. */
  readonly providerAuth: ProviderAuthService;
  /** Read-only workspace files for the @-picker + image references. */
  readonly files: WorkspaceService;
  /** The client's session index (persisted server-side, workspace-scoped). */
  readonly sessions: SessionService;
  /** Install/manage plugins and exact hook reviews (server-side). */
  readonly plugins: PluginService;
  /** Extension Profile definitions, resolution diagnostics, previews, and selection. */
  readonly extensionProfiles: ExtensionProfileService;
  /** Process-pinned Extension Profile identity used to stamp newly started session turns. */
  currentExtensionProfile(): ExtensionProfileRunRef | undefined;
  /** Provider-neutral external task control plane. */
  readonly tasks: TasksService;
  readonly storage: StorageService;
  dispose(): Promise<void>;
}

/** Constructor inputs for {@link createKernelRunClient}. */
export interface KernelRunClientDeps {
  /** Builds the kernel (production: createFileKernel; tests: a fake). Called on
   * connect and after reconnect so the process can be torn down and rebuilt. */
  createKernel: () => Promise<KernelClient>;
  /** Evict any host-side kernel cache after the old client lease is released. */
  prepareReconnect?: () => Promise<void>;
  callbacks: KernelRunClientCallbacks;
}

type ProtoRunHandle = ProtocolRunHandle;

function toStartParams(input: StartRunInput, executionId: string): StartRunParams {
  return {
    execution_id: executionId,
    ...(input.configurationSessionId
      ? { configuration_session_id: input.configurationSessionId }
      : {}),
    messages: input.messages ?? [],
    ...(input.profile ? { agent: input.profile } : {}),
    ...(input.continueFrom ? { continue_from: input.continueFrom } : {}),
    ...(input.promptCacheKey ? { prompt_cache_key: input.promptCacheKey } : {}),
    ...(input.guardMode ? { guard_mode: input.guardMode } : {}),
    ...(input.guardJudge
      ? {
          guard_judge: {
            prompt: input.guardJudge.prompt,
            ...(input.guardJudge.model ? { model: input.guardJudge.model } : {}),
            ...(input.guardJudge.onUnsure ? { on_unsure: input.guardJudge.onUnsure } : {}),
            ...(input.guardJudge.timeoutMs ? { timeout_ms: input.guardJudge.timeoutMs } : {}),
          },
        }
      : {}),
    ...(input.memory ? { memory: input.memory } : {}),
    ...(input.plans ? { plans: input.plans } : {}),
    ...(input.task ? { task: input.task } : {}),
    ...(input.skill ? { skill: input.skill } : {}),
  };
}

/** Builds a {@link KernelRunClient} that drives runs through an in-process kernel built by `deps.createKernel`. */
export function createKernelRunClient(deps: KernelRunClientDeps): KernelRunClient {
  const { createKernel, callbacks } = deps;
  let kernel: KernelClient | undefined;
  let lastCapabilities: KernelCapabilities | undefined;
  let lastExtensionProfile: ExtensionProfileRunRef | undefined;
  const live = new Map<string, Promise<ProtoRunHandle>>();

  function requireKernel(): KernelClient {
    if (!kernel) throw new Error("kernel run client is not connected");
    return kernel;
  }

  /**
   * The kernel's capability descriptor, readable across the window {@link reconnect}
   * leaves between tearing the old kernel down and building the new one.
   *
   * Every other member here is an *operation* and rightly refuses to run
   * unconnected. This one is a static descriptor the UI reads **synchronously**
   * from command `enabled` predicates, which the keymap evaluates on each key
   * dispatch — including one landing mid-reconnect. Throwing there escapes into
   * the renderer's dispatch loop and paints a stack trace over the frame, so a
   * reconnect that actually succeeded still looks like a crash. The rebuilt
   * kernel is the same workspace's, so the last descriptor is what the next one
   * reports; before the first connect there is nothing to report and the
   * canonical refusal stands.
   */
  function currentCapabilities(): KernelCapabilities {
    if (kernel) {
      lastCapabilities = kernel.capabilities;
      return lastCapabilities;
    }
    return lastCapabilities ?? requireKernel().capabilities;
  }

  async function connect(): Promise<void> {
    if (!kernel) kernel = await createKernel();
    lastCapabilities = kernel.capabilities;
    const extensionProfile = await kernel.extensionProfiles.current();
    lastExtensionProfile = { id: extensionProfile.id, fingerprint: extensionProfile.fingerprint };
  }

  async function dispose(): Promise<void> {
    const k = kernel;
    kernel = undefined;
    live.clear();
    await k?.close();
  }

  async function reconnect(): Promise<void> {
    await dispose();
    await deps.prepareReconnect?.();
    await connect();
  }

  /** Apply an idle trust mutation and refresh the process snapshot identity it recomposed. */
  async function mutateTrust<T>(mutation: () => Promise<T>): Promise<T> {
    const result = await mutation();
    const extensionProfile = await requireKernel().extensionProfiles.current();
    lastExtensionProfile = { id: extensionProfile.id, fingerprint: extensionProfile.fingerprint };
    return result;
  }

  async function listProfiles(
    prefetched?: Awaited<ReturnType<KernelClient["config"]["listAgents"]>>,
  ): Promise<ProfileInfo[]> {
    const agents = resolveAgentsByName(prefetched ?? (await requireKernel().config.listAgents()));
    return agents.map((a) => ({
      name: a.name,
      ...(a.description !== undefined ? { description: a.description } : {}),
      ...(a.model !== undefined ? { model: a.model } : {}),
      ...(a.can_spawn !== undefined ? { canSpawn: a.can_spawn } : {}),
      ...(a.budget !== undefined ? { budget: a.budget } : {}),
      ...(a.grants !== undefined ? { grants: a.grants } : {}),
    }));
  }

  function makeProgressEmitter(executionId: string): (event: RunEvent) => void {
    let counter = 0;
    return (event) => {
      if (!callbacks.onProgress) return;
      if (event.type === "iteration_started" && event.agent === "lead") {
        callbacks.onProgress(
          {
            label: `iteration ${event.iteration}`,
            iteration: event.iteration,
            counter: counter++,
          },
          executionId,
        );
      } else if (event.type === "model_retry") {
        callbacks.onProgress(
          {
            label: `retrying in ${Math.max(1, Math.round(event.delay_ms / 1000))}s (${event.attempt}/${event.max_retries})`,
            counter: counter++,
          },
          executionId,
        );
      } else if (event.type === "plan_updated" && event.change === "task") {
        callbacks.onProgress(
          {
            label: `plan r${event.revision}`,
            event: { type: "plan_updated" },
            counter: counter++,
          },
          executionId,
        );
      } else if (event.type === "run_ended" && event.reason && event.reason !== "completed") {
        callbacks.onProgress(
          {
            label: "",
            event: { type: "run_ended", reason: event.reason },
            counter: counter++,
          },
          executionId,
        );
      }
    };
  }

  /**
   * Record an elicitation handler that threw, and answer for it.
   *
   * @param error - what the host's handler threw.
   * @returns the `cancel` the kernel is answered with either way.
   * @remarks Without this the prompt simply cancels, and the run reads as if
   *   the user had dismissed it: the defect and the deliberate refusal are
   *   indistinguishable in the transcript.
   */
  function reportElicitFailure(error: unknown): ElicitResult {
    diagnosticEvent("elicit.handler.failed", { error }, "warn");
    return { action: "cancel" };
  }

  function wireElicit(handle: ProtoRunHandle): void {
    handle.onElicit((req: ElicitationRequest) => {
      const params: ElicitRequestParams = {
        message: req.prompt,
        kind: req.kind,
        ...(req.detail !== undefined ? { detail: req.detail } : {}),
        requestedSchema: req.schema ?? { type: "object", properties: {} },
      };
      detachObserved("kernel_elicitation_response", async () => {
        let result: ElicitResult;
        try {
          result = callbacks.onElicit ? await callbacks.onElicit(params) : { action: "decline" };
        } catch (error) {
          result = reportElicitFailure(error);
        }
        const response: ElicitationResponse = {
          id: req.id,
          action: result.action,
          ...(result.content !== undefined ? { content: result.content } : {}),
        };
        await handle.respond(response);
      });
    });
  }

  async function pumpEvents(executionId: string, handle: ProtoRunHandle): Promise<void> {
    const emitProgress = makeProgressEmitter(executionId);
    try {
      for await (const event of handle.events) {
        if (event.type === "memory_ingest") {
          callbacks.onMemoryIngest?.(event.detail);
          continue;
        }
        callbacks.onEvent(event, "live", executionId);
        emitProgress(event);
      }
    } catch (error) {
      reportStreamInterrupted(executionId, error);
    }
  }

  /**
   * Record an event stream that ended early.
   *
   * @param executionId - the run whose events stopped arriving.
   * @param error - why the iteration threw.
   * @remarks `done` still resolves with a terminal `RunResult`, so the run
   *   itself is accounted for — but every event after this point is missing
   *   from the live transcript with nothing saying so.
   */
  function reportStreamInterrupted(executionId: string, error: unknown): void {
    diagnosticEvent("run.stream.interrupted", { execution_id: executionId, error }, "warn");
  }

  /**
   * Record a run whose lifecycle closure did not complete cleanly.
   *
   * @param executionId - the run being torn down.
   * @param error - the failure, which is deliberately not rethrown because
   *   `closed` is observed only as an independent physical-lifecycle signal.
   */
  function reportCloseFailure(executionId: string, error: unknown): void {
    diagnosticEvent("run.close.failed", { execution_id: executionId, error }, "debug");
  }

  function driveHandle(executionId: string, handleP: Promise<ProtoRunHandle>): RunHandle {
    live.set(executionId, handleP);
    let protocolHandle: ProtoRunHandle | undefined;

    const started = handleP.then((handle) => {
      protocolHandle = handle;
      wireElicit(handle);
      return { handle, pump: pumpEvents(executionId, handle) };
    });
    const done: Promise<RunResult | undefined> = started.then(({ handle }) => handle.done);
    const closed = started
      .then(async ({ handle, pump }) => {
        await handle.closed;
        await pump;
      })
      // A start failure is already reported through `done`; lifecycle closure
      // must remain safe for detached physical-lifecycle observers.
      .catch((error: unknown) => reportCloseFailure(executionId, error))
      .finally(() => {
        if (live.get(executionId) === handleP) live.delete(executionId);
      });

    return {
      executionId,
      cancel: () => handleP.then((handle) => handle.cancel()),
      done,
      closed,
      buffered: () => protocolHandle?.buffered?.(),
    };
  }

  function startRun(input: StartRunInput): RunHandle {
    const executionId = input.executionId ?? "exec_" + crypto.randomUUID();
    return driveHandle(executionId, requireKernel().runs.start(toStartParams(input, executionId)));
  }

  async function steer(input: {
    executionId: string;
    message: MessageContent;
    profile?: string;
  }): Promise<SteerResult> {
    const handleP = live.get(input.executionId);
    if (!handleP) return { status: "unknown", execution_id: input.executionId };
    const handle = await handleP;
    const message: string | ProtoMessage =
      typeof input.message === "string" ? input.message : { role: "user", content: input.message };
    await handle.steer(message);
    return { status: "steered", execution_id: input.executionId, accepted: 1 };
  }

  async function compact(input: {
    executionId: string;
    request?: string;
    mechanicalTargetTokens?: number;
  }): Promise<CompactResult> {
    return requireKernel().runs.compact(
      input.executionId,
      input.request,
      input.mechanicalTargetTokens === undefined
        ? undefined
        : { mechanical_target_tokens: input.mechanicalTargetTokens },
    );
  }

  const context = (executionId: string, targetWindowTokens?: number) =>
    requireKernel().runs.context(executionId, targetWindowTokens);

  async function getRun(executionId: string): Promise<RunDetail | null> {
    try {
      return await requireKernel().runs.get(executionId);
    } catch (e) {
      if (hasKernelErrorCode(e, "not_found")) return null;
      throw e;
    }
  }

  async function deleteRun(executionId: string): Promise<boolean> {
    try {
      await requireKernel().runs.delete(executionId);
      return true;
    } catch (e) {
      if (hasKernelErrorCode(e, "not_found")) return false;
      throw e;
    }
  }

  const plans: Pick<PlansService, "read"> = {
    read: (id) => requireKernel().plans.read(id),
  };
  const workflows: WorkflowsService = {
    get: (id) => requireKernel().workflows.get(id),
    list: (page) => requireKernel().workflows.list(page),
    delete: (id) => requireKernel().workflows.delete(id),
  };

  const skills: SkillsService = {
    list: () => requireKernel().skills.list(),
    getPrompt: (name, args) => requireKernel().skills.getPrompt(name, args),
  };

  const config: ConfigService = {
    getSettings: () => requireKernel().config.getSettings(),
    previewSettingsRepair: (scope) => requireKernel().config.previewSettingsRepair(scope),
    repairSettings: (scope, expectedRevision) =>
      requireKernel().config.repairSettings(scope, expectedRevision),
    updateSettings: (scope, patch, expectedRevision) =>
      requireKernel().config.updateSettings(scope, patch, expectedRevision),
    inspectSandbox: (options) => requireKernel().config.inspectSandbox(options),
    approveWorkspace: () => mutateTrust(() => requireKernel().config.approveWorkspace()),
    revokeWorkspace: () => mutateTrust(() => requireKernel().config.revokeWorkspace()),
    workspaceTrustError: () => requireKernel().config.workspaceTrustError(),
    listAgents: () => requireKernel().config.listAgents(),
    getAgent: (scope, name) => requireKernel().config.getAgent(scope, name),
    writeAgent: (scope, name, doc) => requireKernel().config.writeAgent(scope, name, doc),
    deleteAgent: (scope, name) => requireKernel().config.deleteAgent(scope, name),
    renameAgent: (scope, oldName, newName) =>
      requireKernel().config.renameAgent(scope, oldName, newName),
    getContext: (scope) => requireKernel().config.getContext(scope),
    subscribe: (kinds, listener) => requireKernel().config.subscribe(kinds, listener),
  };
  const secrets: SecretService = {
    listNames: () => requireKernel().secrets.listNames(),
    set: (name, value) => requireKernel().secrets.set(name, value),
    delete: (name) => requireKernel().secrets.delete(name),
  };
  const models: ModelCatalogService = {
    get: () => requireKernel().models.get(),
    refresh: () => requireKernel().models.refresh(),
    getEntitled: (scheme) => requireKernel().models.getEntitled(scheme),
    refreshEntitled: (scheme) => requireKernel().models.refreshEntitled(scheme),
  };
  const providerAuth: ProviderAuthService = {
    list: () => requireKernel().providerAuth.list(),
    startDevice: (scheme) => requireKernel().providerAuth.startDevice(scheme),
    wait: (attemptId) => requireKernel().providerAuth.wait(attemptId),
    cancel: (attemptId) => requireKernel().providerAuth.cancel(attemptId),
    disconnect: (scheme) => requireKernel().providerAuth.disconnect(scheme),
  };
  const files: WorkspaceService = {
    listFiles: (query) => requireKernel().files.listFiles(query),
    readFile: (path) => requireKernel().files.readFile(path),
    readImage: (path) => requireKernel().files.readImage(path),
  };
  const sessions: SessionService = {
    listPage: (page) => requireKernel().sessions.listPage(page),
    list: () => requireKernel().sessions.list(),
    get: (id) => requireKernel().sessions.get(id),
    save: (session) => requireKernel().sessions.save(session),
    delete: (id) => requireKernel().sessions.delete(id),
  };
  const plugins: PluginService = {
    list: () => requireKernel().plugins.list(),
    install: (url, subdir, target) => requireKernel().plugins.install(url, subdir, target),
    installSource: (source, target) => requireKernel().plugins.installSource(source, target),
    update: (name) => requireKernel().plugins.update(name),
    uninstall: (name) => requireKernel().plugins.uninstall(name),
  };
  const extensionProfiles: ExtensionProfileService = {
    list: () => requireKernel().extensionProfiles.list(),
    current: () => requireKernel().extensionProfiles.current(),
    get: (ref) => requireKernel().extensionProfiles.get(ref),
    inventory: () => requireKernel().extensionProfiles.inventory(),
    preview: (ref, options) => requireKernel().extensionProfiles.preview(ref, options),
    previewClear: (scope) => requireKernel().extensionProfiles.previewClear(scope),
    previewComposition: (input) => requireKernel().extensionProfiles.previewComposition(input),
    select: (ref, options) => requireKernel().extensionProfiles.select(ref, options),
    clearSelection: (scope, options) =>
      requireKernel().extensionProfiles.clearSelection(scope, options),
    applyComposition: (input, options) =>
      requireKernel().extensionProfiles.applyComposition(input, options),
    create: (input) => requireKernel().extensionProfiles.create(input),
    update: (input) => requireKernel().extensionProfiles.update(input),
    delete: (ref, options) => requireKernel().extensionProfiles.delete(ref, options),
    clone: (source, target) => requireKernel().extensionProfiles.clone(source, target),
  };
  const tasks: TasksService = {
    status: (options) => requireKernel().tasks.status(options),
    capabilities: (options) => requireKernel().tasks.capabilities(options),
    listContainers: (input, options) => requireKernel().tasks.listContainers(input, options),
    search: (input, options) => requireKernel().tasks.search(input, options),
    get: (ref, options) => requireKernel().tasks.get(ref, options),
    searchActors: (input, options) => requireKernel().tasks.searchActors(input, options),
    create: (input, options) => requireKernel().tasks.create(input, options),
    assign: (input, options) => requireKernel().tasks.assign(input, options),
    previewTransition: (input, options) => requireKernel().tasks.previewTransition(input, options),
    transition: (input, options) => requireKernel().tasks.transition(input, options),
    comment: (input, options) => requireKernel().tasks.comment(input, options),
    attachArtifact: (input, options) => requireKernel().tasks.attachArtifact(input, options),
  };
  const storage: StorageService = {
    inspect: () => requireKernel().storage.inspect(),
    cleanup: (request) => requireKernel().storage.cleanup(request),
  };

  return {
    get capabilities() {
      return currentCapabilities();
    },
    get project() {
      return requireKernel().project;
    },
    get workspace() {
      return requireKernel().workspace;
    },
    connect,
    reconnect,
    listProfiles,
    startRun,
    steer,
    compact,
    context,
    getRun,
    deleteRun,
    plans,
    workflows,
    skills,
    config,
    secrets,
    models,
    providerAuth,
    files,
    sessions,
    plugins,
    extensionProfiles,
    currentExtensionProfile: () => lastExtensionProfile,
    tasks,
    storage,
    dispose,
  };
}
