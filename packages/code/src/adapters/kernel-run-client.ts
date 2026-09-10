import { createHostedObservationLease } from "./hosted-observation.ts";
import { redactPreview } from "./session-store.ts";
import { resolveAgentsByName } from "@clarvis/kernel/config";
import { readHostedSnapshot } from "@clarvis/kernel";
import type {
  ConfigService,
  AttachHostedRunParams,
  HostedRunAttachment,
  HostingService,
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
import type { ReconnectMode } from "./connection-state.ts";
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
 * Drives ordinary or hosted runs through the kernel contract, presenting the
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
  reconnect(mode?: ReconnectMode): Promise<void>;
  /** The kernel-resolved agent catalogue; pass an already-fetched list to skip the round trip. */
  listProfiles(
    prefetched?: Awaited<ReturnType<KernelClient["config"]["listAgents"]>>,
  ): Promise<ProfileInfo[]>;
  /** Launch a run. When the entry profile carries the `workflow` grant the kernel
   * routes it as a workflow (manager fanning out leader runs) transparently,
   * returning the same {@link RunHandle} the run host drives. */
  startRun(input: StartRunInput): RunHandle;
  /** Observe an existing hosted execution without sending another start or prompt. */
  attachRun(input: AttachHostedRunParams): RunHandle;
  /** Present only when the connected host advertises independent execution ownership. */
  readonly hosting?: HostingService;
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
  /** Acquire the current workspace connection after initial discovery or an explicit transition. */
  createKernel: () => Promise<KernelClient>;
  /** Prepare a verified replacement before releasing the current adapter; refusal preserves it. */
  prepareReconnect?: (mode: ReconnectMode) => Promise<void>;
  callbacks: KernelRunClientCallbacks;
}

interface ProtoRunHandle extends ProtocolRunHandle {
  /** Snapshot prefix owned by this attachment, followed by the ordinary event tail. */
  replay?: AsyncIterable<RunEvent>;
  /** Observers do not receive interactive question prompts. */
  interactive?: boolean;
  acquireControl?(control: "acquire" | "takeover"): Promise<void>;
  /** Release this attachment after its pump/closure settles, including projection failure. */
  release?(): Promise<void>;
  /** Complete observation consumption, host settlement and foreground retention ownership. */
  settleObservation?(consumed: Promise<unknown>): Promise<void>;
}

function toStartParams(input: StartRunInput, executionId: string): StartRunParams {
  return {
    execution_id: executionId,
    ...(input.configurationSessionId
      ? { configuration_session_id: input.configurationSessionId }
      : {}),
    messages: input.messages ?? [],
    ...(input.profile ? { agent: input.profile } : {}),
    ...(input.continueFrom ? { continue_from: input.continueFrom } : {}),
    ...(input.sessionId ? { session_id: input.sessionId } : {}),
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

/** Build the TUI run adapter over a protocol client supplied by the application composition. */
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

  async function reconnect(mode: ReconnectMode = "reload"): Promise<void> {
    await deps.prepareReconnect?.(mode);
    await dispose();
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
      if (handle.replay !== undefined) {
        for await (const event of handle.replay) {
          if (event.type !== "memory_ingest") callbacks.onEvent(event, "replay", executionId);
        }
      }
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
      if (handle.replay !== undefined) throw error;
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

  function driveHandle(
    executionId: string,
    handleP: Promise<ProtoRunHandle>,
    hosted = false,
  ): RunHandle {
    live.set(executionId, handleP);
    let protocolHandle: ProtoRunHandle | undefined;
    let elicitationWired = false;

    const started = handleP.then((handle) => {
      protocolHandle = handle;
      if (handle.interactive !== false) {
        wireElicit(handle);
        elicitationWired = true;
      }
      return { handle, pump: pumpEvents(executionId, handle) };
    });
    const done: Promise<RunResult | undefined> = started.then(({ handle }) =>
      hosted ? Promise.all([handle.done, closed]).then(([result]) => result) : handle.done,
    );
    const closed = started
      .then(async ({ handle, pump }) => {
        if (handle.settleObservation !== undefined) await handle.settleObservation(pump);
        else await Promise.all([handle.closed, pump]);
      })
      // A start failure is already reported through `done`; lifecycle closure
      // must remain safe for detached physical-lifecycle observers.
      .catch((error: unknown) => {
        reportCloseFailure(executionId, error);
        if (hosted) throw error;
      })
      .finally(() => {
        if (live.get(executionId) === handleP) live.delete(executionId);
      });
    if (hosted) detachObserved("hosting.observation.closed", () => closed);

    return {
      executionId,
      cancel: () => handleP.then((handle) => handle.cancel()),
      ...(hosted ? { releaseObservation: () => handleP.then((handle) => handle.release?.()) } : {}),
      ...(hosted
        ? {
            acquireControl: async (control: "acquire" | "takeover") => {
              const handle = await handleP;
              if (handle.acquireControl === undefined)
                throw new Error("hosted control is unavailable");
              await handle.acquireControl(control);
              if (!elicitationWired) {
                wireElicit(handle);
                elicitationWired = true;
              }
            },
          }
        : {}),
      done,
      closed,
      buffered: () => protocolHandle?.buffered?.(),
    };
  }

  function startRun(input: StartRunInput): RunHandle {
    const executionId = input.executionId ?? "exec_" + crypto.randomUUID();
    const current = requireKernel();
    const params = toStartParams(input, executionId);
    if (current.hosting === undefined) return driveHandle(executionId, current.runs.start(params));
    const service = current.hosting;
    const handle =
      input.session === undefined
        ? Promise.reject(new Error("hosted turn requires a persisted conversation revision"))
        : service
            .start({
              ...input.session,
              user_preview: redactPreview(input.session.user_preview, { max: 4096 }),
              params: { ...params, execution_id: executionId },
            })
            .then((attachment) => hostedHandle(service, attachment, true));
    return driveHandle(executionId, handle, true);
  }

  function hostedHandle(
    service: HostingService,
    attachment: HostedRunAttachment,
    interactive: boolean,
  ): ProtoRunHandle {
    const { handle } = attachment;
    const lease = createHostedObservationLease(service, attachment, () => interactive);
    return {
      ...handle,
      get interactive() {
        return interactive;
      },
      async acquireControl(control) {
        const ref = await service.controlObservation(attachment.observation_id, control);
        if (
          ref.execution_id !== attachment.run.execution_id ||
          ref.host_generation !== attachment.run.host_generation ||
          ref.control !== "self"
        )
          throw new Error("hosted control acknowledgement does not match this observation");
        interactive = true;
      },
      replay: {
        async *[Symbol.asyncIterator]() {
          for await (const frame of readHostedSnapshot(service, attachment.snapshot))
            yield frame.event;
        },
      },
      events: {
        async *[Symbol.asyncIterator]() {
          for await (const frame of handle.events) yield frame.event;
        },
      },
      settleObservation: lease.settle,
      release: lease.release,
    };
  }

  function attachRun(input: AttachHostedRunParams): RunHandle {
    const service = requireKernel().hosting;
    if (service === undefined) throw new Error("backend does not support hosted runs");
    if (live.has(input.execution_id)) throw new Error("this client already observes the execution");
    return driveHandle(
      input.execution_id,
      service
        .attach(input)
        .then((attachment) => hostedHandle(service, attachment, input.control !== "observe")),
      true,
    );
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
    if (requireKernel().hosting !== undefined) {
      const active = live.get(input.executionId);
      if (active !== undefined) {
        if (input.mechanicalTargetTokens !== undefined)
          throw new Error("mechanical compaction requires an idle hosted run");
        await (await active).compact(input.request);
        return { status: "queued", execution_id: input.executionId };
      }
    }
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
    attachRun,
    get hosting() {
      return kernel?.hosting;
    },
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
