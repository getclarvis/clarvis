import { randomUUID } from "node:crypto";
import { detachObserved, NOOP_LOGGER, type Logger } from "@clarvis/capability";
import { observationSink } from "../core/observed.ts";
import type {
  AgentSummary,
  ConfigChange,
  ConfigService,
  ElicitationRequest,
  KernelClient,
  KernelError,
  KernelTransport,
  MemoryService,
  ModelCatalogService,
  ProviderAuthService,
  PlansService,
  PluginService,
  RunEvent,
  RunHandle,
  RunResult,
  RunService,
  SecretService,
  SessionService,
  TasksService,
  SkillsService,
  StorageService,
  WorkflowsService,
  WorkspaceService,
  ExtensionProfileService,
} from "@clarvis/protocol";
import { createEventStream, type EventStream } from "../core/event-stream.ts";
import {
  M,
  N,
  type ConfigChangeNote,
  type HelloParams,
  type HelloResult,
  type RunElicitationNote,
  type RunEventNote,
  type RunResultNote,
  type RunStreamEndNote,
} from "./wire.ts";
import { createServiceProxy, OPERATIONS } from "./operations.ts";
import {
  coalesceRunEvents,
  DEFAULT_RUN_EVENT_BUFFER,
  DEFAULT_RUN_EVENT_BUFFER_BYTES,
  isDroppableRunEvent,
  sizeOfCoalescedRunEvent,
  sizeOfRunEvent,
} from "../runs/coalesce-events.ts";
import { CLARVIS_WIRE_VERSION } from "./wire.ts";
import { decodeRunEvent } from "./run-event-codec.ts";

/**
 * A client-side kernel façade over a {@link KernelTransport} — the remote-ready
 * twin of the in-process kernel.
 *
 * @remarks Each service method turns into a wire request ({@link M}), and
 *   server→client notifications ({@link N}) are demultiplexed back onto local
 *   run event streams, elicitation handlers, and config listeners. Programming
 *   against this is identical to programming against the in-process kernel, so a
 *   client swapping a loopback transport for a stdio/HTTP one needs no change.
 *   {@link capabilities}, {@link workspace}, and {@link principal} are the values
 *   the kernel returned from `hello`.
 */
export interface RemoteKernel extends KernelClient {
  /** List the agents available in the bound workspace (a convenience alias for `config.listAgents`). */
  listAgents(): Promise<AgentSummary[]>;
  /**
   * Close the connection: settle every in-flight run as `unavailable`, detach the
   * close listener, and close the transport. Idempotent.
   */
  close(): Promise<void>;
}

/** Options for the `hello` handshake performed by {@link connectKernelClient}. */
export interface ConnectKernelClientOptions {
  /** Client name and optional version, echoed to the kernel for its bookkeeping. */
  clientInfo?: { name: string; version?: string };
  /** Workspace to bind to; the kernel decides how to resolve it. */
  workspace?: string;
  /** Opaque auth token, when the transport requires one. */
  auth?: string;
  /**
   * Where a detached wire operation's failure is reported.
   *
   * @remarks Seven call sites in this file used to reach `process.emitWarning`,
   * which no package handles: an unsubscribe that never landed or a cancel that
   * never reached the kernel wrote to the host's raw stderr instead of the log.
   */
  logger?: Logger;
}

/** A promise paired with its resolver, so a run's `done` can be settled out of band. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
/** Build a {@link Deferred} whose `resolve` is captured for later settlement. */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Per-run client state that a run's notifications drive.
 *
 * @remarks {@link pendingElicits} buffers elicitation requests that arrive before
 *   the caller has registered any handler via `onElicit`; they are flushed the
 *   moment the first handler attaches.
 */
interface ClientRun {
  stream: EventStream<RunEvent>;
  resolveDone: (result: RunResult) => void;
  resolveClosed: () => void;
  elicitHandlers: ((req: ElicitationRequest) => void)[];
  pendingElicits: ElicitationRequest[];
  resultReceived: boolean;
  streamEnded: boolean;
}

/**
 * Connect to a kernel over `transport`, complete the `hello` handshake, and return
 * a {@link RemoteKernel}.
 *
 * @param transport - the request/notify channel to speak over; ownership passes to
 *   the returned kernel, whose {@link RemoteKernel.close} closes it.
 * @param opts - handshake options (client info, workspace, auth).
 * @returns a connected {@link RemoteKernel} whose services issue wire requests.
 * @remarks Before the handshake, this wires the four notification listeners
 *   ({@link N.runEvent}, {@link N.runElicitation}, {@link N.runResult},
 *   {@link N.configChange}) and, when the transport supports it, an `onClose`
 *   observer that settles every in-flight run as `unavailable`. `runs.start`
 *   assigns an `execution_id` up front (client-supplied or a fresh UUID) so the
 *   handle's event stream is live before the start request resolves; a start that
 *   throws settles the run as `failed` rather than leaving it hanging. A failed
 *   or invalid handshake detaches every observer and closes the transport, but
 *   teardown failure never replaces the primary negotiation error.
 */
export async function connectKernelClient(
  transport: KernelTransport,
  opts: ConnectKernelClientOptions = {},
): Promise<RemoteKernel> {
  const logger = opts.logger ?? NOOP_LOGGER;
  const clientRuns = new Map<string, ClientRun>();
  const configSubs = new Map<string, (change: ConfigChange) => void>();
  const notificationOffs: Array<() => void> = [];
  let closed = false;
  let offClose: (() => void) | undefined;
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const hasOnly = (value: Record<string, unknown>, allowed: readonly string[]): boolean => {
    const keys = new Set(allowed);
    return Object.keys(value).every((key) => keys.has(key));
  };

  const settleRunsUnavailable = (reason?: unknown): void => {
    const message = reason instanceof Error ? reason.message : "kernel transport closed";
    for (const [executionId, run] of clientRuns) {
      if (!run.resultReceived) {
        run.resolveDone({
          execution_id: executionId,
          status: "failed",
          error: { code: "unavailable", message },
          usage: { iterations: 0, elapsed_ms: 0 },
        });
      }
      if (!run.streamEnded) {
        run.stream.close();
        run.resolveClosed();
      }
    }
    clientRuns.clear();
  };

  const detachTransportObservers = (): void => {
    for (const off of notificationOffs.splice(0)) off();
    offClose?.();
    offClose = undefined;
  };
  const clearClientSubscriptions = (): void => {
    configSubs.clear();
  };
  const observe = (method: string, handler: (params: unknown) => void): void => {
    notificationOffs.push(transport.onNotification(method, handler));
  };

  offClose = transport.onClose?.((reason) => {
    closed = true;
    settleRunsUnavailable(reason);
    clearClientSubscriptions();
    detachTransportObservers();
  });

  const protocolViolation = (message: string): void => {
    if (closed) return;
    closed = true;
    const error = new Error(`kernel wire protocol violation: ${message}`);
    settleRunsUnavailable(error);
    clearClientSubscriptions();
    detachTransportObservers();
    detachObserved(() => transport.close(), {
      operation: "kernel_transport_protocol_violation",
      logger: observationSink(logger, "transport.close_failed"),
    });
  };

  observe(N.runEvent, (params) => {
    const event = isRecord(params) ? decodeRunEvent(params.event) : null;
    if (
      !isRecord(params) ||
      !hasOnly(params, ["execution_id", "event"]) ||
      typeof params.execution_id !== "string" ||
      event === null
    ) {
      protocolViolation("invalid run.event notification");
      return;
    }
    const note: RunEventNote = { execution_id: params.execution_id, event };
    clientRuns.get(note.execution_id)?.stream.push(note.event);
  });
  observe(N.runResult, (params) => {
    if (
      !isRecord(params) ||
      !hasOnly(params, ["execution_id", "result"]) ||
      typeof params.execution_id !== "string" ||
      !isRecord(params.result) ||
      params.result.execution_id !== params.execution_id ||
      !["completed", "failed", "cancelled"].includes(params.result.status as string)
    ) {
      protocolViolation("invalid run.result notification");
      return;
    }
    const { execution_id, result } = params as unknown as RunResultNote;
    const run = clientRuns.get(execution_id);
    if (run === undefined) return;
    run.resolveDone(result);
    run.resultReceived = true;
    if (run.streamEnded) clientRuns.delete(execution_id);
  });
  observe(N.runStreamEnd, (params) => {
    if (
      !isRecord(params) ||
      !hasOnly(params, ["execution_id"]) ||
      typeof params.execution_id !== "string"
    ) {
      protocolViolation("invalid run.stream_end notification");
      return;
    }
    const { execution_id } = params as unknown as RunStreamEndNote;
    const run = clientRuns.get(execution_id);
    if (run === undefined || run.streamEnded) return;
    run.streamEnded = true;
    run.stream.close();
    run.resolveClosed();
    if (run.resultReceived) clientRuns.delete(execution_id);
  });
  /**
   * Check an elicitation's `detail` against the closed {@link ElicitationCommandDetail} shape.
   *
   * @remarks
   * The request around it is deliberately left open — `kind` is `(string & {})` so a kernel may add
   * kinds without a protocol bump, and `schema` is passed through opaquely — so neither can be key
   * checked. `detail` shares neither property: it is a fully closed interface, and it is what a
   * human reads when approving a command. A `detail` whose `command` is absent or not a string
   * would reach an approval dialog as `undefined`, and the approval would then be given for a
   * command nobody was shown, which is the one failure this transport must not pass on silently.
   */
  const isCommandDetail = (value: unknown): boolean =>
    isRecord(value) &&
    hasOnly(value, ["command", "cwd", "reason", "warning"]) &&
    typeof value.command === "string" &&
    typeof value.cwd === "string" &&
    typeof value.reason === "string" &&
    (value.warning === undefined || typeof value.warning === "string");
  const isWorkspaceChangeDetail = (value: unknown): boolean =>
    isRecord(value) &&
    hasOnly(value, ["path", "action", "type", "mode", "size", "digest", "target"]) &&
    typeof value.path === "string" &&
    ["add", "modify", "delete"].includes(String(value.action)) &&
    (value.type === "file" || value.type === "symlink") &&
    typeof value.mode === "number" &&
    Number.isSafeInteger(value.mode) &&
    (value.size === undefined ||
      (typeof value.size === "number" && Number.isSafeInteger(value.size))) &&
    (value.digest === undefined || typeof value.digest === "string") &&
    (value.target === undefined || typeof value.target === "string");
  const isWorkspaceMergeDetail = (value: unknown): boolean =>
    isRecord(value) &&
    hasOnly(value, ["change_set_id", "baseline_revision", "content_digest", "changes"]) &&
    typeof value.change_set_id === "string" &&
    typeof value.baseline_revision === "string" &&
    typeof value.content_digest === "string" &&
    Array.isArray(value.changes) &&
    value.changes.length <= 100_000 &&
    value.changes.every(isWorkspaceChangeDetail);
  observe(N.runElicitation, (params) => {
    if (
      !isRecord(params) ||
      !hasOnly(params, ["request"]) ||
      !isRecord(params.request) ||
      typeof params.request.id !== "string" ||
      typeof params.request.execution_id !== "string" ||
      typeof params.request.kind !== "string" ||
      typeof params.request.prompt !== "string" ||
      (params.request.detail !== undefined &&
        !isCommandDetail(params.request.detail) &&
        !isWorkspaceMergeDetail(params.request.detail)) ||
      (params.request.kind === "guard_confirm" && !isCommandDetail(params.request.detail)) ||
      (params.request.kind === "workspace_merge" && !isWorkspaceMergeDetail(params.request.detail))
    ) {
      protocolViolation("invalid run.elicitation notification");
      return;
    }
    const { request } = params as unknown as RunElicitationNote;
    const run = clientRuns.get(request.execution_id);
    if (run === undefined) return;
    if (run.elicitHandlers.length === 0) run.pendingElicits.push(request);
    else for (const handler of run.elicitHandlers) handler(request);
  });
  observe(N.configChange, (params) => {
    if (
      !isRecord(params) ||
      !hasOnly(params, ["subscription_id", "change"]) ||
      typeof params.subscription_id !== "string" ||
      !isRecord(params.change) ||
      !hasOnly(params.change, ["kind", "scope", "at"]) ||
      !["settings", "agents", "context"].includes(params.change.kind as string) ||
      !Number.isFinite(params.change.at) ||
      (params.change.scope !== undefined &&
        params.change.scope !== "global" &&
        params.change.scope !== "workspace")
    ) {
      protocolViolation("invalid config.change notification");
      return;
    }
    const { subscription_id, change } = params as unknown as ConfigChangeNote;
    configSubs.get(subscription_id)?.(change);
  });
  const helloParams: HelloParams = {
    wire_version: CLARVIS_WIRE_VERSION,
    ...(opts.clientInfo !== undefined ? { clientInfo: opts.clientInfo } : {}),
    ...(opts.workspace !== undefined ? { workspace: opts.workspace } : {}),
    ...(opts.auth !== undefined ? { auth: opts.auth } : {}),
  };
  let hello: HelloResult;
  try {
    hello = await transport.request<HelloResult>(M.hello, helloParams);
  } catch (error) {
    closed = true;
    clearClientSubscriptions();
    detachTransportObservers();
    try {
      await transport.close();
    } catch {
      /* Teardown is secondary and no client was returned. */
    }
    throw error;
  }
  const runtime =
    isRecord(hello) && isRecord(hello.capabilities) ? hello.capabilities.runtime : undefined;
  const validRuntime =
    runtime === undefined ||
    (isRecord(runtime) &&
      ((runtime.kind === "native" &&
        hasOnly(runtime, ["kind", "host_platform", "isolation", "lifecycle", "fallback_from"]) &&
        typeof runtime.host_platform === "string" &&
        (runtime.isolation === "host" || runtime.isolation === "sandbox") &&
        (runtime.lifecycle === "ready" || runtime.lifecycle === "fallback") &&
        (runtime.fallback_from === undefined ||
          runtime.fallback_from === "docker" ||
          runtime.fallback_from === "podman")) ||
        (runtime.kind === "container" &&
          hasOnly(runtime, [
            "kind",
            "generation",
            "engine",
            "engine_version",
            "host_platform",
            "guest_platform",
            "image_digest",
            "runtime_protocol_revision",
            "network",
            "lifecycle",
          ]) &&
          (runtime.engine === "podman" || runtime.engine === "docker") &&
          typeof runtime.host_platform === "string" &&
          runtime.guest_platform === "linux" &&
          (runtime.generation === undefined || typeof runtime.generation === "string") &&
          (runtime.engine_version === undefined || typeof runtime.engine_version === "string") &&
          (runtime.image_digest === undefined || typeof runtime.image_digest === "string") &&
          (runtime.runtime_protocol_revision === undefined ||
            typeof runtime.runtime_protocol_revision === "string") &&
          ["none", "internet", "outbound"].includes(String(runtime.network)) &&
          [
            "cold",
            "inspecting",
            "preparing",
            "starting",
            "ready",
            "stopping",
            "stopped",
            "disconnected",
            "failed",
          ].includes(String(runtime.lifecycle)))));
  if (
    !isRecord(hello) ||
    !hasOnly(hello, ["wire_version", "capabilities", "project", "workspace", "principal"]) ||
    hello.wire_version !== CLARVIS_WIRE_VERSION ||
    !isRecord(hello.capabilities) ||
    !validRuntime ||
    !isRecord(hello.project) ||
    !isRecord(hello.workspace) ||
    typeof hello.project.id !== "string" ||
    typeof hello.workspace.id !== "string" ||
    typeof hello.workspace.projectId !== "string" ||
    typeof hello.workspace.label !== "string" ||
    !["primary", "external_worktree"].includes(hello.workspace.kind) ||
    (hello.principal !== undefined &&
      (!isRecord(hello.principal) || typeof hello.principal.id !== "string"))
  ) {
    const selected = isRecord(hello) ? hello.wire_version : undefined;
    closed = true;
    clearClientSubscriptions();
    detachTransportObservers();
    try {
      await transport.close();
    } catch {
      /* The invalid handshake remains the primary failure. */
    }
    throw new Error(
      `kernel selected an invalid or unsupported Clarvis wire contract '${String(selected)}'`,
    );
  }

  /**
   * Build a client-side streaming handle (a {@link RunHandle}) whose
   * `events`/`done`/`onElicit` are driven by the {@link N} run notifications the
   * server pushes for this `execution_id`. Used by `runs.start`; a workflow uses
   * the same path, since the kernel routes a manager run through `runs.start`.
   *
   * @param methods - the wire method names for start/steer/compact/cancel/respond.
   * @param params - the start params; its `execution_id` is honored or a fresh UUID minted.
   * @returns the live handle; a start that throws settles the run as `failed`.
   */
  const streamingStart = async (
    methods: { start: string; steer: string; compact: string; cancel: string; respond: string },
    params: { execution_id?: string },
  ): Promise<RunHandle> => {
    const executionId = params.execution_id ?? randomUUID();
    if (clientRuns.has(executionId)) {
      const error = new Error(`run '${executionId}' is already active on this client`) as Error & {
        code: KernelError["code"];
      };
      error.code = "conflict";
      throw error;
    }
    const stream = createEventStream<RunEvent>({
      maxBuffered: DEFAULT_RUN_EVENT_BUFFER,
      maxBufferedBytes: DEFAULT_RUN_EVENT_BUFFER_BYTES,
      sizeOf: sizeOfRunEvent,
      sizeOfCoalesced: sizeOfCoalescedRunEvent,
      coalesce: coalesceRunEvents,
      droppable: isDroppableRunEvent,
      onSaturated: () => {
        detachObserved(() => transport.request(methods.cancel, { execution_id: executionId }), {
          operation: "kernel_remote_run_saturated_cancel",
          logger: observationSink(logger, "transport.cancel_failed"),
        });
      },
      onAbandoned: () => {
        detachObserved(() => transport.request(methods.cancel, { execution_id: executionId }), {
          operation: "kernel_remote_run_abandoned_cancel",
          logger: observationSink(logger, "transport.cancel_failed"),
        });
      },
    });
    const done = deferred<RunResult>();
    const runClosed = deferred<void>();
    clientRuns.set(executionId, {
      stream,
      resolveDone: done.resolve,
      resolveClosed: runClosed.resolve,
      elicitHandlers: [],
      pendingElicits: [],
      resultReceived: false,
      streamEnded: false,
    });
    try {
      await transport.request(methods.start, { params: { ...params, execution_id: executionId } });
    } catch (err) {
      const kerr = err as Partial<KernelError> & { message?: string };
      done.resolve({
        execution_id: executionId,
        status: "failed",
        error: { code: kerr.code ?? "internal", message: kerr.message ?? "run failed" },
        usage: { iterations: 0, elapsed_ms: 0 },
      });
      stream.close();
      runClosed.resolve();
      clientRuns.delete(executionId);
    }
    return {
      execution_id: executionId,
      events: stream.iterable,
      async steer(message) {
        await transport.request(methods.steer, { execution_id: executionId, message });
      },
      async compact(request) {
        await transport.request(methods.compact, {
          execution_id: executionId,
          ...(request !== undefined ? { request } : {}),
        });
      },
      async cancel() {
        await transport.request(methods.cancel, { execution_id: executionId });
      },
      async respond(response) {
        await transport.request(methods.respond, { execution_id: executionId, response });
      },
      onElicit(handler) {
        const run = clientRuns.get(executionId);
        if (run === undefined) return;
        run.elicitHandlers.push(handler);
        const queued = run.pendingElicits.splice(0);
        for (const request of queued) handler(request);
      },
      buffered: () => {
        const stats = stream.stats();
        return {
          buffered_items: stats.bufferedItems,
          buffered_bytes: stats.bufferedBytes,
          dropped: stats.dropped,
        };
      },
      done: done.promise,
      closed: runClosed.promise,
    };
  };

  const runRequests = createServiceProxy<Omit<RunService, "start" | "compact">>(
    transport,
    OPERATIONS.runs,
  );
  const runs: RunService = {
    ...runRequests,
    compact(executionId, request, options) {
      return transport.request(M.runsCompact, {
        execution_id: executionId,
        ...(request !== undefined ? { request } : {}),
        ...(options !== undefined ? { options } : {}),
      });
    },
    start(params) {
      return streamingStart(
        {
          start: M.runsStart,
          steer: M.runsSteer,
          compact: M.runsCompact,
          cancel: M.runsCancel,
          respond: M.runsRespond,
        },
        params,
      );
    },
  };

  const configRequests = createServiceProxy<Omit<ConfigService, "subscribe">>(
    transport,
    OPERATIONS.config,
  );
  const config: ConfigService = {
    ...configRequests,
    subscribe(kinds, listener) {
      const id = randomUUID();
      configSubs.set(id, listener);
      const subscribed = transport.request(M.configSubscribe, { kinds, subscription_id: id });
      detachObserved(() => subscribed, {
        operation: "kernel_config_subscribe",
        logger: observationSink(logger, "transport.subscribe_failed"),
      });
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        configSubs.delete(id);
        detachObserved(
          async () => {
            try {
              await subscribed;
            } catch {
              return;
            }
            if (closed) return;
            await transport.request(M.configUnsubscribe, { subscription_id: id });
          },
          {
            operation: "kernel_config_unsubscribe",
            logger: observationSink(logger, "transport.unsubscribe_failed"),
          },
        );
      };
    },
  };
  const plans = createServiceProxy<PlansService>(transport, OPERATIONS.plans);
  const workflows = createServiceProxy<WorkflowsService>(transport, OPERATIONS.workflows);
  const plugins = createServiceProxy<PluginService>(transport, OPERATIONS.plugins);
  const extensionProfiles = createServiceProxy<ExtensionProfileService>(
    transport,
    OPERATIONS.extensionProfiles,
  );
  const secrets = createServiceProxy<SecretService>(transport, OPERATIONS.secrets);
  const models = createServiceProxy<ModelCatalogService>(transport, OPERATIONS.models);
  const providerAuth = createServiceProxy<ProviderAuthService>(transport, OPERATIONS.providerAuth);
  const files = createServiceProxy<WorkspaceService>(transport, OPERATIONS.files);
  const memory = createServiceProxy<MemoryService>(transport, OPERATIONS.memory);
  const skills = createServiceProxy<SkillsService>(transport, OPERATIONS.skills);
  const sessions = createServiceProxy<SessionService>(transport, OPERATIONS.sessions);
  const tasks = createServiceProxy<TasksService>(transport, OPERATIONS.tasks);
  const storage = createServiceProxy<StorageService>(transport, OPERATIONS.storage);

  return {
    capabilities: hello.capabilities,
    project: hello.project,
    workspace: hello.workspace,
    ...(hello.principal !== undefined ? { principal: hello.principal } : {}),
    runs,
    config,
    plugins,
    extensionProfiles,
    secrets,
    models,
    providerAuth,
    files,
    memory,
    plans,
    workflows,
    skills,
    sessions,
    tasks,
    storage,
    listAgents() {
      return transport.request<AgentSummary[]>(M.listAgents, {});
    },
    async close() {
      if (closed) return;
      closed = true;
      settleRunsUnavailable();
      clearClientSubscriptions();
      detachTransportObservers();
      await transport.close();
    },
  };
}
