import { kernelError } from "@clarvis/kernel";
import type {
  ConfigService,
  KernelCapabilities,
  KernelClient,
  ModelCatalogService,
  RuntimeStatus,
} from "@clarvis/protocol";

/** Host-owned administration; composition never constructs another execution kernel. */
export type ContainerOperatorServices = Pick<
  KernelClient,
  "config" | "secrets" | "models" | "providerAuth"
>;

/** Launcher-authenticated identity and policy, not an untrusted guest hello or run parameter. */
export interface ComposeContainerClientOptions {
  execution: KernelClient;
  operator: ContainerOperatorServices;
  principal?: KernelClient["principal"];
  project: KernelClient["project"];
  workspace: KernelClient["workspace"] & { readonly path: "/workspace" };
  capabilities: KernelCapabilities & {
    runtime: Extract<RuntimeStatus, { kind: "container" }>;
  };
  /** Optional launcher resource release, after transport close, even when that close fails. */
  dispose?: () => Promise<void>;
  /** Report a committed host-side change that the immutable guest will receive next generation. */
  onConfigurationSaved?: (kind: "settings" | "agents" | "context" | "models") => void;
}

function operatorConfig(
  service: ConfigService,
  changed: NonNullable<ComposeContainerClientOptions["onConfigurationSaved"]>,
): ConfigService {
  const saved = async <T>(kind: Parameters<typeof changed>[0], operation: () => Promise<T>) => {
    const result = await operation();
    changed(kind);
    return result;
  };
  return {
    getSettings: () => service.getSettings(),
    previewSettingsRepair: (scope) => service.previewSettingsRepair(scope),
    repairSettings: (scope, revision) =>
      saved("settings", () => service.repairSettings(scope, revision)),
    approveWorkspace: () => saved("settings", () => service.approveWorkspace()),
    revokeWorkspace: () => saved("settings", () => service.revokeWorkspace()),
    workspaceTrustError: () => service.workspaceTrustError(),
    updateSettings: (scope, patch, revision) =>
      saved("settings", () => service.updateSettings(scope, patch, revision)),
    inspectSandbox: (inspectOptions) => service.inspectSandbox(inspectOptions),
    listAgents: () => service.listAgents(),
    getAgent: (scope, name) => service.getAgent(scope, name),
    writeAgent: (scope, name, doc) => saved("agents", () => service.writeAgent(scope, name, doc)),
    deleteAgent: (scope, name) => saved("agents", () => service.deleteAgent(scope, name)),
    renameAgent: (scope, oldName, newName) =>
      saved("agents", () => service.renameAgent(scope, oldName, newName)),
    getContext: (scope) => service.getContext(scope),
    getSharedPrompt: () => service.getSharedPrompt(),
    writeSharedPrompt: (scope, doc) =>
      saved("context", () => service.writeSharedPrompt(scope, doc)),
    deleteSharedPrompt: (scope) => saved("context", () => service.deleteSharedPrompt(scope)),
    subscribe: (kinds, listener) => service.subscribe(kinds, listener),
  };
}

function operatorModels(
  service: ModelCatalogService,
  changed: NonNullable<ComposeContainerClientOptions["onConfigurationSaved"]>,
): ModelCatalogService {
  const saved = async <T>(operation: () => Promise<T>) => {
    const result = await operation();
    changed("models");
    return result;
  };
  return {
    get: () => service.get(),
    refresh: () => saved(() => service.refresh()),
    getEntitled: (scheme) => service.getEntitled(scheme),
    refreshEntitled: (scheme) => saved(() => service.refreshEntitled(scheme)),
  };
}

/**
 * Compose one guest execution client with operator-local administration.
 * The launcher authenticates the connection and supplies the immutable guest Extension Profile
 * service. This boundary checks identity/policy consistency, never dispatches administration to
 * the guest, and never owns the operator services. Closing releases only the guest connection
 * and the optional launcher resource, once; a failed close remains observable on repeated calls.
 */
export function composeContainerClient(options: ComposeContainerClientOptions): KernelClient {
  const { execution, operator, project, workspace, principal, capabilities } = options;
  if (
    project.id.trim() === "" ||
    workspace.id.trim() === "" ||
    workspace.path !== "/workspace" ||
    workspace.projectId !== project.id ||
    execution.project.id !== project.id ||
    execution.workspace.id !== workspace.id ||
    execution.workspace.projectId !== project.id ||
    execution.workspace.path !== "/workspace" ||
    execution.principal?.id !== principal?.id
  ) {
    throw kernelError("invalid_request", "Container client identity does not match its launcher");
  }
  const hosting = capabilities.hosting;
  if (
    capabilities.runtime.kind !== "container" ||
    capabilities.skills ||
    capabilities.tasks ||
    capabilities.local_host !== undefined ||
    (capabilities.memory && !execution.capabilities.memory) ||
    (capabilities.agent_tools && !execution.capabilities.agent_tools) ||
    (hosting !== undefined &&
      (hosting.host_generation.trim() === "" ||
        execution.hosting === undefined ||
        hosting.host_generation !== execution.capabilities.hosting?.host_generation ||
        hosting.default_owner !== execution.capabilities.hosting?.default_owner)) ||
    (hosting !== undefined ? capabilities.goals !== true : capabilities.goals === true) ||
    (capabilities.goals === true && execution.capabilities.goals !== true)
  ) {
    throw kernelError("invalid_request", "Container client capabilities exceed validated policy");
  }
  const unsupported = async (): Promise<never> => {
    throw kernelError("unsupported", "This operation is unavailable in Container");
  };
  let closing: Promise<void> | undefined;
  const configurationSaved = options.onConfigurationSaved ?? (() => undefined);
  return {
    project: Object.freeze({ ...project }),
    workspace: Object.freeze({ ...workspace }),
    ...(principal === undefined ? {} : { principal: Object.freeze({ ...principal }) }),
    capabilities: Object.freeze({
      memory: capabilities.memory,
      skills: false,
      agent_tools: capabilities.agent_tools,
      tasks: false,
      goals: capabilities.goals === true,
      runtime: Object.freeze({ ...capabilities.runtime }),
      ...(hosting === undefined ? {} : { hosting: Object.freeze({ ...hosting }) }),
    }),
    runs: execution.runs,
    ...(hosting === undefined ? {} : { hosting: execution.hosting! }),
    sessions: execution.sessions,
    goals: execution.goals,
    plans: execution.plans,
    memory: execution.memory,
    workflows: execution.workflows,
    files: execution.files,
    storage: execution.storage,
    extensionProfiles: execution.extensionProfiles,
    config: operatorConfig(operator.config, configurationSaved),
    secrets: operator.secrets,
    models: operatorModels(operator.models, configurationSaved),
    providerAuth: operator.providerAuth,
    plugins: {
      list: async () => [],
      install: unsupported,
      installSource: unsupported,
      update: unsupported,
      uninstall: unsupported,
    },
    skills: { list: async () => [], getPrompt: unsupported },
    tasks: {
      status: async () => ({
        state: "unavailable",
        writes: "disabled",
        reason: "Tasks are unavailable in Container",
      }),
      capabilities: unsupported,
      listContainers: unsupported,
      search: unsupported,
      get: unsupported,
      searchActors: unsupported,
      create: unsupported,
      assign: unsupported,
      previewTransition: unsupported,
      transition: unsupported,
      comment: unsupported,
      attachArtifact: unsupported,
    },
    close() {
      closing ??= Promise.resolve().then(async () => {
        try {
          await execution.close();
        } finally {
          await options.dispose?.();
        }
      });
      return closing;
    },
  };
}
