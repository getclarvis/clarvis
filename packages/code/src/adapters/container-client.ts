import { kernelError } from "@clarvis/kernel";
import type { KernelCapabilities, KernelClient, RuntimeStatus } from "@clarvis/protocol";

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
    config: operator.config,
    secrets: operator.secrets,
    models: operator.models,
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
