import type {
  ConfigService,
  KernelClient,
  MemoryService,
  ModelCatalogService,
  PlansService,
  PluginService,
  ProviderAuthService,
  RunService,
  SecretService,
  SessionService,
  SkillsService,
  StorageService,
  TaskCallOptions,
  TasksService,
  WorkspaceService,
  WorkflowsService,
  ExtensionProfileService,
  HostingService,
  LocalHostService,
  GoalService,
} from "@clarvis/protocol";
import type { KernelTransport } from "@clarvis/protocol";
import { kernelError } from "../core/errors.ts";

/** Services addressable through ordinary kernel transport operations. */
export type KernelServices = Pick<
  KernelClient,
  | "runs"
  | "config"
  | "plugins"
  | "extensionProfiles"
  | "secrets"
  | "models"
  | "providerAuth"
  | "files"
  | "memory"
  | "plans"
  | "workflows"
  | "skills"
  | "sessions"
  | "tasks"
  | "storage"
  | "hosting"
  | "localHost"
  | "goals"
>;

function requireLocalHost(services: KernelServices): LocalHostService {
  if (services.localHost === undefined)
    throw kernelError("unsupported", "this connection does not support local process controls");
  return services.localHost;
}

/** A transport cannot acquire hosting authority merely by naming a hosting operation. */
export function requireHosting(services: KernelServices): HostingService {
  if (services.hosting === undefined)
    throw kernelError("unsupported", "this connection does not support hosted runs");
  return services.hosting;
}

/** Authorization hints attached to a transport operation. */
export interface KernelOperationMetadata {
  /** Whether the operation only observes state or may change it. */
  readonly access: "read" | "write";
  /** Security-sensitive service group, when the host may want a stricter policy. */
  readonly sensitivity?: "files" | "plugins" | "secrets" | "provider_auth" | "tasks";
}

/** One stateless request/response operation in the kernel transport catalog. */
export interface KernelOperation<Args extends unknown[], Result> {
  /** Sole declaration of the operation's wire name. */
  readonly method: string;
  /** Authorization metadata evaluated before invocation. */
  readonly metadata: KernelOperationMetadata;
  /** Encodes service arguments into the existing named wire-parameter object. */
  encode(...args: Args): unknown;
  /** Extract transport-only metadata without serializing it into params. */
  requestOptions?(...args: Args): Parameters<KernelTransport["request"]>[2];
  /** Invokes the matching service method from decoded wire parameters. */
  invoke(
    services: KernelServices,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Result>;
}

type AsyncMethodKeys<Service> = {
  [Key in keyof Service]-?: Service[Key] extends (...args: never[]) => Promise<unknown>
    ? Key
    : never;
}[keyof Service];

type OperationFor<Method, Services> = Method extends (...args: infer Args) => Promise<infer Result>
  ? KernelOperation<Args, Result> & {
      invoke(
        services: Services,
        params: Record<string, unknown>,
        signal?: AbortSignal,
      ): Promise<Result>;
    }
  : never;

type ServiceOperations<Service, Services, Excluded extends keyof Service = never> = {
  [Key in Exclude<AsyncMethodKeys<Service>, Excluded>]: OperationFor<Service[Key], Services>;
};

/** Declares an exhaustive ordinary-operation map for one protocol service. */
function serviceOperations<
  Service,
  Excluded extends keyof Service = never,
  Operations extends ServiceOperations<Service, KernelServices, Excluded> = ServiceOperations<
    Service,
    KernelServices,
    Excluded
  >,
>(operations: Operations): Operations {
  return operations;
}

const read = (sensitivity?: KernelOperationMetadata["sensitivity"]): KernelOperationMetadata => ({
  access: "read",
  ...(sensitivity !== undefined ? { sensitivity } : {}),
});

const write = (sensitivity?: KernelOperationMetadata["sensitivity"]): KernelOperationMetadata => ({
  access: "write",
  ...(sensitivity !== undefined ? { sensitivity } : {}),
});

const taskOptions = (signal?: AbortSignal): TaskCallOptions =>
  signal === undefined ? {} : { signal };

const taskRequestOptions = (
  options: TaskCallOptions | undefined,
): Parameters<KernelTransport["request"]>[2] =>
  options?.signal === undefined ? undefined : { signal: options.signal };

/** File-backed sessions consume transport cancellation without widening the wire page DTO. */
type SignalAwareSessionListPage = (
  page: Parameters<SessionService["listPage"]>[0],
  options?: { signal?: AbortSignal },
) => ReturnType<SessionService["listPage"]>;

function listSessionPage(
  service: SessionService,
  page: Parameters<SessionService["listPage"]>[0],
  signal: AbortSignal | undefined,
): ReturnType<SessionService["listPage"]> {
  const listPage: SignalAwareSessionListPage = service.listPage.bind(service);
  return listPage(page, signal === undefined ? undefined : { signal });
}

/** File-backed workflow catalogs consume cancellation without widening their wire page DTO. */
type SignalAwareWorkflowList = (
  page: Parameters<WorkflowsService["list"]>[0],
  options?: { signal?: AbortSignal },
) => ReturnType<WorkflowsService["list"]>;

function listWorkflows(
  service: WorkflowsService,
  page: Parameters<WorkflowsService["list"]>[0],
  signal: AbortSignal | undefined,
): ReturnType<WorkflowsService["list"]> {
  const list: SignalAwareWorkflowList = service.list.bind(service);
  return list(page, signal === undefined ? undefined : { signal });
}

/** Exhaustive stateless operation catalog, grouped by protocol service. */
export const OPERATIONS = {
  goals: serviceOperations<Omit<GoalService, "subscribe">>({
    availability: {
      method: "goals.availability",
      metadata: read(),
      encode: () => ({}),
      invoke: (services) => services.goals.availability(),
    },
    get: {
      method: "goals.get",
      metadata: read(),
      encode: (sessionId) => ({ session_id: sessionId }),
      invoke: (services, params) => services.goals.get(params.session_id as string),
    },
    control: {
      method: "goals.control",
      metadata: write(),
      encode: (request) => ({ request }),
      invoke: (services, params) =>
        services.goals.control(params.request as Parameters<GoalService["control"]>[0]),
    },
    receipt: {
      method: "goals.receipt",
      metadata: read(),
      encode: (sessionId, operationId) => ({ session_id: sessionId, operation_id: operationId }),
      invoke: (services, params) =>
        services.goals.receipt(params.session_id as string, params.operation_id as string),
    },
  }),
  localHost: serviceOperations<LocalHostService>({
    inspect: {
      method: "localHost.inspect",
      metadata: read("plugins"),
      encode: () => ({}),
      invoke: (services) => requireLocalHost(services).inspect(),
    },
    takeBrowserRequest: {
      method: "localHost.takeBrowserRequest",
      metadata: write("provider_auth"),
      encode: () => ({}),
      invoke: (services) => requireLocalHost(services).takeBrowserRequest(),
    },
    respondBrowser: {
      method: "localHost.respondBrowser",
      metadata: write("provider_auth"),
      encode: (requestId, opened) => ({ request_id: requestId, opened }),
      invoke: (services, p) =>
        requireLocalHost(services).respondBrowser(p.request_id as string, p.opened as boolean),
    },
    retryRuntime: {
      method: "localHost.retryRuntime",
      metadata: write(),
      encode: () => ({}),
      invoke: (services) => requireLocalHost(services).retryRuntime(),
    },
    requestRestart: {
      method: "localHost.requestRestart",
      metadata: write(),
      encode: () => ({}),
      invoke: (services) => requireLocalHost(services).requestRestart(),
    },
  }),
  hosting: serviceOperations<HostingService, "start" | "attach">({
    resolveRecovery: {
      method: "hosting.resolveRecovery",
      metadata: write(),
      encode: (input) => ({ input }),
      invoke: (services, p) =>
        requireHosting(services).resolveRecovery(
          p.input as Parameters<HostingService["resolveRecovery"]>[0],
        ),
    },
    controlObservation: {
      method: "hosting.controlObservation",
      metadata: write(),
      encode: (observationId, control) => ({ observation_id: observationId, control }),
      invoke: (services, p) =>
        requireHosting(services).controlObservation(
          p.observation_id as string,
          p.control as "acquire" | "takeover",
        ),
    },
    list: {
      method: "hosting.list",
      metadata: read(),
      encode: () => ({}),
      invoke: (services) => requireHosting(services).list(),
    },
    detach: {
      method: "hosting.detach",
      metadata: write(),
      encode: (input) => ({ input }),
      invoke: (services, p) =>
        requireHosting(services).detach(p.input as Parameters<HostingService["detach"]>[0]),
    },
    receipt: {
      method: "hosting.receipt",
      metadata: read(),
      encode: (operationId) => ({ operation_id: operationId }),
      invoke: (services, p) => requireHosting(services).receipt(p.operation_id as string),
    },
    readSnapshot: {
      method: "hosting.readSnapshot",
      metadata: read(),
      encode: (snapshotId, offset) => ({ snapshot_id: snapshotId, offset }),
      invoke: (services, p) =>
        requireHosting(services).readSnapshot(p.snapshot_id as string, p.offset as number),
    },
    releaseSnapshot: {
      method: "hosting.releaseSnapshot",
      metadata: read(),
      encode: (snapshotId) => ({ snapshot_id: snapshotId }),
      invoke: (services, p) => requireHosting(services).releaseSnapshot(p.snapshot_id as string),
    },
    releaseObservation: {
      method: "hosting.releaseObservation",
      metadata: read(),
      encode: (observationId) => ({ observation_id: observationId }),
      invoke: (services, p) =>
        requireHosting(services).releaseObservation(p.observation_id as string),
    },
    closeSession: {
      method: "hosting.closeSession",
      metadata: write(),
      encode: (sessionId) => ({ session_id: sessionId }),
      invoke: (services, p) => requireHosting(services).closeSession(p.session_id as string),
    },
    acknowledge: {
      method: "hosting.acknowledge",
      metadata: write(),
      encode: (executionId) => ({ execution_id: executionId }),
      invoke: (services, p) => requireHosting(services).acknowledge(p.execution_id as string),
    },
    reserveActivity: {
      method: "hosting.reserveActivity",
      metadata: write(),
      encode: (sessionId, kind) => ({ session_id: sessionId, kind }),
      invoke: (services, p) =>
        requireHosting(services).reserveActivity(
          p.session_id as string,
          p.kind as Parameters<HostingService["reserveActivity"]>[1],
        ),
    },
    releaseActivity: {
      method: "hosting.releaseActivity",
      metadata: write(),
      encode: (leaseId) => ({ lease_id: leaseId }),
      invoke: (services, p) => requireHosting(services).releaseActivity(p.lease_id as string),
    },
  }),
  runs: serviceOperations<RunService, "start" | "compact">({
    get: {
      method: "runs.get",
      metadata: read(),
      encode: (executionId) => ({ execution_id: executionId }),
      invoke: (services, p) => services.runs.get(p.execution_id as string),
    },
    context: {
      method: "runs.context",
      metadata: read(),
      encode: (executionId, targetWindowTokens) => ({
        execution_id: executionId,
        ...(targetWindowTokens !== undefined ? { target_window_tokens: targetWindowTokens } : {}),
      }),
      invoke: (services, p) =>
        services.runs.context(
          p.execution_id as string,
          typeof p.target_window_tokens === "number" ? p.target_window_tokens : undefined,
        ),
    },
    list: {
      method: "runs.list",
      metadata: read(),
      encode: (page) => ({ page }),
      invoke: (services, p) => services.runs.list(p.page as Parameters<RunService["list"]>[0]),
    },
    delete: {
      method: "runs.delete",
      metadata: write(),
      encode: (executionId) => ({ execution_id: executionId }),
      invoke: (services, p) => services.runs.delete(p.execution_id as string),
    },
  }),
  config: serviceOperations<ConfigService>({
    getSettings: {
      method: "config.getSettings",
      metadata: read(),
      encode: () => ({}),
      invoke: (services) => services.config.getSettings(),
    },
    previewSettingsRepair: {
      method: "config.previewSettingsRepair",
      metadata: read(),
      encode: (scope) => ({ scope }),
      invoke: (services, p) =>
        services.config.previewSettingsRepair(
          p.scope as Parameters<ConfigService["previewSettingsRepair"]>[0],
        ),
    },
    repairSettings: {
      method: "config.repairSettings",
      metadata: write(),
      encode: (scope, expectedRevision) => ({ scope, expected_revision: expectedRevision }),
      invoke: (services, p) =>
        services.config.repairSettings(
          p.scope as Parameters<ConfigService["repairSettings"]>[0],
          p.expected_revision as string,
        ),
    },
    updateSettings: {
      method: "config.updateSettings",
      metadata: write(),
      encode: (scope, patch, expectedRevision) => ({
        scope,
        patch,
        expected_revision: expectedRevision,
      }),
      invoke: (services, p) =>
        services.config.updateSettings(
          p.scope as Parameters<ConfigService["updateSettings"]>[0],
          p.patch as Parameters<ConfigService["updateSettings"]>[1],
          p.expected_revision as string | null,
        ),
    },
    inspectSandbox: {
      method: "config.inspectSandbox",
      metadata: read(),
      encode: (options) => ({ options }),
      invoke: (services, p) =>
        services.config.inspectSandbox(p.options as Parameters<ConfigService["inspectSandbox"]>[0]),
    },
    approveWorkspace: {
      method: "config.approveWorkspace",
      metadata: write(),
      encode: () => ({}),
      invoke: (services) => services.config.approveWorkspace(),
    },
    revokeWorkspace: {
      method: "config.revokeWorkspace",
      metadata: write(),
      encode: () => ({}),
      invoke: (services) => services.config.revokeWorkspace(),
    },
    workspaceTrustError: {
      method: "config.workspaceTrustError",
      metadata: read(),
      encode: () => ({}),
      invoke: (services) => services.config.workspaceTrustError(),
    },
    listAgents: {
      method: "config.listAgents",
      metadata: read(),
      encode: () => ({}),
      invoke: (services) => services.config.listAgents(),
    },
    getAgent: {
      method: "config.getAgent",
      metadata: read(),
      encode: (scope, name) => ({ scope, name }),
      invoke: (services, p) =>
        services.config.getAgent(
          p.scope as Parameters<ConfigService["getAgent"]>[0],
          p.name as string,
        ),
    },
    writeAgent: {
      method: "config.writeAgent",
      metadata: write(),
      encode: (scope, name, doc) => ({ scope, name, doc }),
      invoke: (services, p) =>
        services.config.writeAgent(
          p.scope as Parameters<ConfigService["writeAgent"]>[0],
          p.name as string,
          p.doc as Parameters<ConfigService["writeAgent"]>[2],
        ),
    },
    deleteAgent: {
      method: "config.deleteAgent",
      metadata: write(),
      encode: (scope, name) => ({ scope, name }),
      invoke: (services, p) =>
        services.config.deleteAgent(
          p.scope as Parameters<ConfigService["deleteAgent"]>[0],
          p.name as string,
        ),
    },
    renameAgent: {
      method: "config.renameAgent",
      metadata: write(),
      encode: (scope, oldName, newName) => ({ scope, oldName, newName }),
      invoke: (services, p) =>
        services.config.renameAgent(
          p.scope as Parameters<ConfigService["renameAgent"]>[0],
          p.oldName as string,
          p.newName as string,
        ),
    },
    getContext: {
      method: "config.getContext",
      metadata: read(),
      encode: (scope) => ({ scope }),
      invoke: (services, p) =>
        services.config.getContext(p.scope as Parameters<ConfigService["getContext"]>[0]),
    },
  }),
  plugins: serviceOperations<PluginService>({
    list: {
      method: "plugins.list",
      metadata: read("plugins"),
      encode: () => ({}),
      invoke: (services) => services.plugins.list(),
    },
    install: {
      method: "plugins.install",
      metadata: write("plugins"),
      encode: (url, subdir, target) => ({ url, subdir, target }),
      invoke: (services, p) =>
        services.plugins.install(
          p.url as string,
          p.subdir as string | undefined,
          p.target as Parameters<PluginService["install"]>[2],
        ),
    },
    installSource: {
      method: "plugins.installSource",
      metadata: write("plugins"),
      encode: (source, target) => ({ source, target }),
      invoke: (services, p) =>
        services.plugins.installSource(
          p.source as Parameters<PluginService["installSource"]>[0],
          p.target as Parameters<PluginService["installSource"]>[1],
        ),
    },
    update: {
      method: "plugins.update",
      metadata: write("plugins"),
      encode: (ref) => ({ ref }),
      invoke: (services, p) =>
        services.plugins.update(p.ref as Parameters<PluginService["update"]>[0]),
    },
    uninstall: {
      method: "plugins.uninstall",
      metadata: write("plugins"),
      encode: (ref) => ({ ref }),
      invoke: (services, p) =>
        services.plugins.uninstall(p.ref as Parameters<PluginService["uninstall"]>[0]),
    },
  }),
  extensionProfiles: serviceOperations<ExtensionProfileService>({
    list: {
      method: "extensionProfiles.list",
      metadata: read("plugins"),
      encode: () => ({}),
      invoke: (services) => services.extensionProfiles.list(),
    },
    current: {
      method: "extensionProfiles.current",
      metadata: read("plugins"),
      encode: () => ({}),
      invoke: (services) => services.extensionProfiles.current(),
    },
    get: {
      method: "extensionProfiles.get",
      metadata: read("plugins"),
      encode: (ref) => ({ ref }),
      invoke: (services, p) =>
        services.extensionProfiles.get(p.ref as Parameters<ExtensionProfileService["get"]>[0]),
    },
    inventory: {
      method: "extensionProfiles.inventory",
      metadata: read("plugins"),
      encode: () => ({}),
      invoke: (services) => services.extensionProfiles.inventory(),
    },
    preview: {
      method: "extensionProfiles.preview",
      metadata: read("plugins"),
      encode: (ref, options) => ({ ref, options }),
      invoke: (services, p) =>
        services.extensionProfiles.preview(
          p.ref as Parameters<ExtensionProfileService["preview"]>[0],
          p.options as Parameters<ExtensionProfileService["preview"]>[1],
        ),
    },
    previewClear: {
      method: "extensionProfiles.previewClear",
      metadata: read("plugins"),
      encode: (scope) => ({ scope }),
      invoke: (services, p) =>
        services.extensionProfiles.previewClear(
          p.scope as Parameters<ExtensionProfileService["previewClear"]>[0],
        ),
    },
    previewComposition: {
      method: "extensionProfiles.previewComposition",
      metadata: read("plugins"),
      encode: (input) => ({ input }),
      invoke: (services, p) =>
        services.extensionProfiles.previewComposition(
          p.input as Parameters<ExtensionProfileService["previewComposition"]>[0],
        ),
    },
    select: {
      method: "extensionProfiles.select",
      metadata: write("plugins"),
      encode: (ref, options) => ({ ref, options }),
      invoke: (services, p) =>
        services.extensionProfiles.select(
          p.ref as Parameters<ExtensionProfileService["select"]>[0],
          p.options as Parameters<ExtensionProfileService["select"]>[1],
        ),
    },
    clearSelection: {
      method: "extensionProfiles.clearSelection",
      metadata: write("plugins"),
      encode: (scope, options) => ({ scope, options }),
      invoke: (services, p) =>
        services.extensionProfiles.clearSelection(
          p.scope as Parameters<ExtensionProfileService["clearSelection"]>[0],
          p.options as Parameters<ExtensionProfileService["clearSelection"]>[1],
        ),
    },
    applyComposition: {
      method: "extensionProfiles.applyComposition",
      metadata: write("plugins"),
      encode: (input, options) => ({ input, options }),
      invoke: (services, p) =>
        services.extensionProfiles.applyComposition(
          p.input as Parameters<ExtensionProfileService["applyComposition"]>[0],
          p.options as Parameters<ExtensionProfileService["applyComposition"]>[1],
        ),
    },
    create: {
      method: "extensionProfiles.create",
      metadata: write("plugins"),
      encode: (input) => ({ input }),
      invoke: (services, p) =>
        services.extensionProfiles.create(
          p.input as Parameters<ExtensionProfileService["create"]>[0],
        ),
    },
    update: {
      method: "extensionProfiles.update",
      metadata: write("plugins"),
      encode: (input) => ({ input }),
      invoke: (services, p) =>
        services.extensionProfiles.update(
          p.input as Parameters<ExtensionProfileService["update"]>[0],
        ),
    },
    delete: {
      method: "extensionProfiles.delete",
      metadata: write("plugins"),
      encode: (ref, options) => ({ ref, options }),
      invoke: (services, p) =>
        services.extensionProfiles.delete(
          p.ref as Parameters<ExtensionProfileService["delete"]>[0],
          p.options as Parameters<ExtensionProfileService["delete"]>[1],
        ),
    },
    clone: {
      method: "extensionProfiles.clone",
      metadata: write("plugins"),
      encode: (source, target) => ({ source, target }),
      invoke: (services, p) =>
        services.extensionProfiles.clone(
          p.source as Parameters<ExtensionProfileService["clone"]>[0],
          p.target as Parameters<ExtensionProfileService["clone"]>[1],
        ),
    },
  }),
  secrets: serviceOperations<SecretService>({
    listNames: {
      method: "secrets.listNames",
      metadata: read("secrets"),
      encode: () => ({}),
      invoke: (services) => services.secrets.listNames(),
    },
    set: {
      method: "secrets.set",
      metadata: write("secrets"),
      encode: (name, value) => ({ name, value }),
      invoke: (services, p) => services.secrets.set(p.name as string, p.value as string),
    },
    delete: {
      method: "secrets.delete",
      metadata: write("secrets"),
      encode: (name) => ({ name }),
      invoke: (services, p) => services.secrets.delete(p.name as string),
    },
  }),
  models: serviceOperations<ModelCatalogService>({
    get: {
      method: "models.get",
      metadata: read(),
      encode: () => ({}),
      invoke: (services) => services.models.get(),
    },
    refresh: {
      method: "models.refresh",
      metadata: write(),
      encode: () => ({}),
      invoke: (services) => services.models.refresh(),
    },
    getEntitled: {
      method: "models.getEntitled",
      metadata: read("provider_auth"),
      encode: (scheme) => ({ scheme }),
      invoke: (services, p) =>
        services.models.getEntitled(p.scheme as Parameters<ModelCatalogService["getEntitled"]>[0]),
    },
    refreshEntitled: {
      method: "models.refreshEntitled",
      metadata: write("provider_auth"),
      encode: (scheme) => ({ scheme }),
      invoke: (services, p) =>
        services.models.refreshEntitled(
          p.scheme as Parameters<ModelCatalogService["refreshEntitled"]>[0],
        ),
    },
  }),
  providerAuth: serviceOperations<ProviderAuthService>({
    list: {
      method: "providerAuth.list",
      metadata: read("provider_auth"),
      encode: () => ({}),
      invoke: (services) => services.providerAuth.list(),
    },
    startDevice: {
      method: "providerAuth.startDevice",
      metadata: write("provider_auth"),
      encode: (scheme) => ({ scheme }),
      invoke: (services, p) =>
        services.providerAuth.startDevice(
          p.scheme as Parameters<ProviderAuthService["startDevice"]>[0],
        ),
    },
    wait: {
      method: "providerAuth.wait",
      metadata: read("provider_auth"),
      encode: (attemptId) => ({ attempt_id: attemptId }),
      invoke: (services, p) => services.providerAuth.wait(p.attempt_id as string),
    },
    cancel: {
      method: "providerAuth.cancel",
      metadata: write("provider_auth"),
      encode: (attemptId) => ({ attempt_id: attemptId }),
      invoke: (services, p) => services.providerAuth.cancel(p.attempt_id as string),
    },
    disconnect: {
      method: "providerAuth.disconnect",
      metadata: write("provider_auth"),
      encode: (scheme) => ({ scheme }),
      invoke: (services, p) =>
        services.providerAuth.disconnect(
          p.scheme as Parameters<ProviderAuthService["disconnect"]>[0],
        ),
    },
  }),
  files: serviceOperations<WorkspaceService>({
    listFiles: {
      method: "files.listFiles",
      metadata: read("files"),
      encode: (query) => ({ query }),
      invoke: (services, p) =>
        services.files.listFiles(p.query as Parameters<WorkspaceService["listFiles"]>[0]),
    },
    readFile: {
      method: "files.readFile",
      metadata: read("files"),
      encode: (path) => ({ path }),
      invoke: (services, p) => services.files.readFile(p.path as string),
    },
    readImage: {
      method: "files.readImage",
      metadata: read("files"),
      encode: (path) => ({ path }),
      invoke: (services, p) => services.files.readImage(p.path as string),
    },
  }),
  memory: serviceOperations<MemoryService>({
    health: {
      method: "memory.health",
      metadata: read(),
      encode: () => ({}),
      invoke: (services) => services.memory.health(),
    },
    reindex: {
      method: "memory.reindex",
      metadata: write(),
      encode: () => ({}),
      invoke: (services) => services.memory.reindex(),
    },
    jobs: {
      method: "memory.jobs",
      metadata: read(),
      encode: (filter) => ({ filter }),
      invoke: (services, p) =>
        services.memory.jobs(p.filter as Parameters<MemoryService["jobs"]>[0]),
    },
    retryJob: {
      method: "memory.retryJob",
      metadata: write(),
      encode: (runId) => ({ run_id: runId }),
      invoke: (services, p) => services.memory.retryJob(p.run_id as string),
    },
  }),
  plans: serviceOperations<PlansService>({
    list: {
      method: "plans.list",
      metadata: read(),
      encode: (input) => ({ input }),
      invoke: (services, p) => services.plans.list(p.input as Parameters<PlansService["list"]>[0]),
    },
    read: {
      method: "plans.read",
      metadata: read(),
      encode: (id) => ({ id }),
      invoke: (services, p) => services.plans.read(p.id as string),
    },
    setRetention: {
      method: "plans.setRetention",
      metadata: write(),
      encode: (id, retention) => ({ id, retention }),
      invoke: (services, p) =>
        services.plans.setRetention(
          p.id as string,
          p.retention as Parameters<PlansService["setRetention"]>[1],
        ),
    },
    delete: {
      method: "plans.delete",
      metadata: write(),
      encode: (id) => ({ id }),
      invoke: (services, p) => services.plans.delete(p.id as string),
    },
  }),
  workflows: serviceOperations<WorkflowsService>({
    get: {
      method: "workflows.get",
      metadata: read(),
      encode: (id) => ({ id }),
      invoke: (services, p) => services.workflows.get(p.id as string),
    },
    list: {
      method: "workflows.list",
      metadata: read(),
      encode: (page) => ({ page }),
      invoke: (services, p, signal) =>
        listWorkflows(
          services.workflows,
          p.page as Parameters<WorkflowsService["list"]>[0],
          signal,
        ),
    },
    delete: {
      method: "workflows.delete",
      metadata: write(),
      encode: (id) => ({ id }),
      invoke: (services, p) => services.workflows.delete(p.id as string),
    },
  }),
  skills: serviceOperations<SkillsService>({
    list: {
      method: "skills.list",
      metadata: read(),
      encode: () => ({}),
      invoke: (services) => services.skills.list(),
    },
    getPrompt: {
      method: "skills.getPrompt",
      metadata: read(),
      encode: (name, args) => ({ name, args }),
      invoke: (services, p) =>
        services.skills.getPrompt(
          p.name as string,
          p.args as Parameters<SkillsService["getPrompt"]>[1],
        ),
    },
  }),
  sessions: serviceOperations<SessionService>({
    listPage: {
      method: "sessions.listPage",
      metadata: read(),
      encode: (page) => ({ page }),
      invoke: (services, params, signal) =>
        listSessionPage(
          services.sessions,
          params.page as Parameters<SessionService["listPage"]>[0],
          signal,
        ),
    },
    list: {
      method: "sessions.list",
      metadata: read(),
      encode: () => ({}),
      invoke: (services) => services.sessions.list(),
    },
    get: {
      method: "sessions.get",
      metadata: read(),
      encode: (id) => ({ id }),
      invoke: (services, p) => services.sessions.get(p.id as string),
    },
    save: {
      method: "sessions.save",
      metadata: write(),
      encode: (session) => ({ session }),
      invoke: (services, p) =>
        services.sessions.save(p.session as Parameters<SessionService["save"]>[0]),
    },
    delete: {
      method: "sessions.delete",
      metadata: write(),
      encode: (id) => ({ id }),
      invoke: (services, p) => services.sessions.delete(p.id as string),
    },
  }),
  tasks: serviceOperations<TasksService>({
    status: {
      method: "tasks.status",
      metadata: read("tasks"),
      encode: () => ({}),
      requestOptions: (options) => taskRequestOptions(options),
      invoke: (services, _p, signal) => services.tasks.status(taskOptions(signal)),
    },
    capabilities: {
      method: "tasks.capabilities",
      metadata: read("tasks"),
      encode: () => ({}),
      requestOptions: (options) => taskRequestOptions(options),
      invoke: (services, _p, signal) => services.tasks.capabilities(taskOptions(signal)),
    },
    listContainers: {
      method: "tasks.listContainers",
      metadata: read("tasks"),
      encode: (input) => ({ input }),
      requestOptions: (_input, options) => taskRequestOptions(options),
      invoke: (services, p, signal) =>
        services.tasks.listContainers(
          p.input as Parameters<TasksService["listContainers"]>[0],
          taskOptions(signal),
        ),
    },
    search: {
      method: "tasks.search",
      metadata: read("tasks"),
      encode: (input) => ({ input }),
      requestOptions: (_input, options) => taskRequestOptions(options),
      invoke: (services, p, signal) =>
        services.tasks.search(
          p.input as Parameters<TasksService["search"]>[0],
          taskOptions(signal),
        ),
    },
    get: {
      method: "tasks.get",
      metadata: read("tasks"),
      encode: (ref) => ({ ref }),
      requestOptions: (_ref, options) => taskRequestOptions(options),
      invoke: (services, p, signal) =>
        services.tasks.get(p.ref as Parameters<TasksService["get"]>[0], taskOptions(signal)),
    },
    searchActors: {
      method: "tasks.searchActors",
      metadata: read("tasks"),
      encode: (input) => ({ input }),
      requestOptions: (_input, options) => taskRequestOptions(options),
      invoke: (services, p, signal) =>
        services.tasks.searchActors(
          p.input as Parameters<TasksService["searchActors"]>[0],
          taskOptions(signal),
        ),
    },
    create: {
      method: "tasks.create",
      metadata: write("tasks"),
      encode: (input) => ({ input }),
      requestOptions: (_input, options) => taskRequestOptions(options),
      invoke: (services, p, signal) =>
        services.tasks.create(
          p.input as Parameters<TasksService["create"]>[0],
          taskOptions(signal),
        ),
    },
    assign: {
      method: "tasks.assign",
      metadata: write("tasks"),
      encode: (input) => ({ input }),
      requestOptions: (_input, options) => taskRequestOptions(options),
      invoke: (services, p, signal) =>
        services.tasks.assign(
          p.input as Parameters<TasksService["assign"]>[0],
          taskOptions(signal),
        ),
    },
    previewTransition: {
      method: "tasks.previewTransition",
      metadata: read("tasks"),
      encode: (input) => ({ input }),
      requestOptions: (_input, options) => taskRequestOptions(options),
      invoke: (services, p, signal) =>
        services.tasks.previewTransition(
          p.input as Parameters<TasksService["previewTransition"]>[0],
          taskOptions(signal),
        ),
    },
    transition: {
      method: "tasks.transition",
      metadata: write("tasks"),
      encode: (input) => ({ input }),
      requestOptions: (_input, options) => taskRequestOptions(options),
      invoke: (services, p, signal) =>
        services.tasks.transition(
          p.input as Parameters<TasksService["transition"]>[0],
          taskOptions(signal),
        ),
    },
    comment: {
      method: "tasks.comment",
      metadata: write("tasks"),
      encode: (input) => ({ input }),
      requestOptions: (_input, options) => taskRequestOptions(options),
      invoke: (services, p, signal) =>
        services.tasks.comment(
          p.input as Parameters<TasksService["comment"]>[0],
          taskOptions(signal),
        ),
    },
    attachArtifact: {
      method: "tasks.attachArtifact",
      metadata: write("tasks"),
      encode: (input) => ({ input }),
      requestOptions: (_input, options) => taskRequestOptions(options),
      invoke: (services, p, signal) =>
        services.tasks.attachArtifact(
          p.input as Parameters<TasksService["attachArtifact"]>[0],
          taskOptions(signal),
        ),
    },
  }),
  storage: serviceOperations<StorageService>({
    inspect: {
      method: "storage.inspect",
      metadata: read(),
      encode: () => ({}),
      invoke: (services) => services.storage.inspect(),
    },
    cleanup: {
      method: "storage.cleanup",
      metadata: write(),
      encode: (request) => ({ request }),
      invoke: (services, p) =>
        services.storage.cleanup(p.request as Parameters<StorageService["cleanup"]>[0]),
    },
  }),
} as const;

/** Specialized connection-stateful operations registered beside ordinary CRUD. */
export const SPECIAL_OPERATIONS = {
  hello: { method: "hello", metadata: read() },
  hostingStart: { method: "hosting.start", metadata: write() },
  hostingAttach: { method: "hosting.attach", metadata: read() },
  hostingSteer: { method: "hosting.steer", metadata: write() },
  hostingCompact: { method: "hosting.compact", metadata: write() },
  hostingCancel: { method: "hosting.cancel", metadata: write() },
  hostingRespond: { method: "hosting.respond", metadata: write() },
  runsStart: { method: "runs.start", metadata: write() },
  runsSteer: { method: "runs.steer", metadata: write() },
  runsCompact: { method: "runs.compact", metadata: write() },
  runsCancel: { method: "runs.cancel", metadata: write() },
  runsRespond: { method: "runs.respond", metadata: write() },
  configSubscribe: { method: "config.subscribe", metadata: read() },
  configUnsubscribe: { method: "config.unsubscribe", metadata: read() },
  goalsSubscribe: { method: "goals.subscribe", metadata: read() },
  goalsUnsubscribe: { method: "goals.unsubscribe", metadata: read() },
} as const;

type AnyOperation = KernelOperation<never[], unknown>;

/** Flat ordinary-operation list used to build server dispatch and completeness tests. */
export const ORDINARY_OPERATIONS: readonly AnyOperation[] = [
  ...Object.values(OPERATIONS.goals),
  ...Object.values(OPERATIONS.localHost),
  ...Object.values(OPERATIONS.hosting),
  ...Object.values(OPERATIONS.runs),
  ...Object.values(OPERATIONS.config),
  ...Object.values(OPERATIONS.plugins),
  ...Object.values(OPERATIONS.extensionProfiles),
  ...Object.values(OPERATIONS.secrets),
  ...Object.values(OPERATIONS.models),
  ...Object.values(OPERATIONS.providerAuth),
  ...Object.values(OPERATIONS.files),
  ...Object.values(OPERATIONS.memory),
  ...Object.values(OPERATIONS.plans),
  ...Object.values(OPERATIONS.workflows),
  ...Object.values(OPERATIONS.skills),
  ...Object.values(OPERATIONS.sessions),
  ...Object.values(OPERATIONS.tasks),
  ...Object.values(OPERATIONS.storage),
];

/** Every request method understood by the kernel transport. */
export const KNOWN_METHODS = [
  ...Object.values(SPECIAL_OPERATIONS).map((operation) => operation.method),
  ...ORDINARY_OPERATIONS.map((operation) => operation.method),
] as const;

const PARAM_KEYS = new WeakMap<object, ReadonlySet<string>>();

/**
 * Validate the closed top-level parameter envelope produced by an operation's
 * canonical encoder. Domain services remain responsible for their nested DTOs.
 */
export function decodeOperationParams(
  operation: KernelOperation<never[], unknown>,
  value: unknown,
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  let allowed = PARAM_KEYS.get(operation);
  if (allowed === undefined) {
    const placeholderArgs = Array.from({ length: operation.encode.length }, () => undefined);
    const encoded = (operation.encode as (...args: unknown[]) => unknown)(...placeholderArgs);
    allowed = new Set(
      typeof encoded === "object" && encoded !== null && !Array.isArray(encoded)
        ? Object.keys(encoded)
        : [],
    );
    PARAM_KEYS.set(operation, allowed);
  }
  const params = value as Record<string, unknown>;
  return Object.keys(params).every((key) => allowed.has(key)) ? params : null;
}

/** Build a typed remote proxy for all ordinary methods in a service operation map. */
export function createServiceProxy<Service>(
  transport: KernelTransport,
  operations: Record<string, KernelOperation<never[], unknown>>,
): Service {
  const proxy: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const [name, operation] of Object.entries(operations)) {
    /** The catalog proves each proxy's argument tuple statically; this is the sole dynamic call boundary. */
    const encode = (...args: unknown[]): unknown =>
      (operation.encode as (...values: unknown[]) => unknown)(...args);
    proxy[name] = (...args) => {
      return transport.request(
        operation.method,
        encode(...args),
        operation.requestOptions?.(...(args as never[])),
      );
    };
  }
  return proxy as Service;
}
