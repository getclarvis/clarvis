import { NOOP_LOGGER, type Capability, type LLMProvider, type Logger } from "@clarvis/capability";
import { executeRun } from "@clarvis/loop";
import { createFileMemoryStore } from "@clarvis/memory";
import { createFilePlanRepository, createPlanStore } from "@clarvis/plan";
import { globalPaths, workspacePaths, workspaceStatePaths } from "@clarvis/paths";
import type { ProjectRef, RuntimeStatus, WorkspaceRef } from "@clarvis/protocol";
import { createNativeKernel } from "../native-kernel.ts";
import { createConfigService } from "../config/config-service.ts";
import {
  createContainerConfigStore,
  parseContainerConfiguration,
  validateContainerProfileSelection,
  type ContainerConfiguration,
} from "../config/container-projection.ts";
import { containerLoopEnvironment } from "../config/container-projection-env.ts";
import { createContainerModelCatalog } from "../config/container-model-catalog.ts";
import { createContainerExtensionProfileService } from "../config/container-extension-profile.ts";
import { createSettingsRunAssembler } from "../runs/settings-assembler.ts";
import { kernelError } from "../core/errors.ts";
import { withRunLease } from "../runs/run-lease.ts";
import type { CreateKernelOptions } from "../kernel.ts";

/** Internal composition inputs; bootstrap supplies fixed guest roots and pipe-bound identity. */
export interface ContainerNativeOptions {
  configuration: ContainerConfiguration;
  llm: LLMProvider;
  globalDir: string;
  project: ProjectRef;
  workspace: WorkspaceRef;
  owner: string;
  runtime: Extract<RuntimeStatus, { kind: "container" }>;
  logger?: Logger;
  operatorAuthorityFor?: CreateKernelOptions["operatorAuthorityFor"];
}

/** Describe the admitted placement through the existing capability system-section seam. */
function createContainerEnvironmentCapability(
  runtime: Extract<RuntimeStatus, { kind: "container" }>,
  workspaceRoot: string,
): Capability {
  const name = "container-environment";
  const section = [
    "# Container environment",
    "",
    "Placement: Container Kernel",
    `Engine: ${runtime.engine}`,
    `Network: ${runtime.network}`,
    `Workspace root inside the Container: ${workspaceRoot}`,
    "Commands and workspace tools execute inside this Container.",
    "The host path backing the workspace bind is intentionally not exposed inside the Container.",
    "Clarvis model requests are brokered by the host and do not grant tools additional network access.",
  ].join("\n");
  return {
    name,
    required: true,
    forRun: () => ({
      name,
      required: true,
      systemSection: () => section,
      forAgent: () => ({ attach: () => ({}) }),
    }),
  };
}

/**
 * Construct the native domain graph over admitted projection and inference ports, never File Kernel.
 * Roots are explicit host-composition inputs, not RPC parameters. Providers of external capabilities,
 * SDK inference, subscription managers, plugin discovery and credential stores are not constructed.
 */
export async function createContainerNativeKernel(options: ContainerNativeOptions) {
  const configuration = parseContainerConfiguration(options.configuration);
  const logger = options.logger ?? NOOP_LOGGER;
  const workspaceRoot = options.workspace.path;
  if (workspaceRoot === undefined || workspaceRoot.trim() === "" || options.globalDir.trim() === "")
    throw kernelError("invalid_request", "Container requires explicit workspace and state roots");
  const env = containerLoopEnvironment(configuration.loopPolicy, configuration.toolPolicy);
  const configStore = createContainerConfigStore(configuration);
  const models = createContainerModelCatalog(configuration);
  const workspace = workspacePaths(workspaceRoot);
  const state = workspaceStatePaths(workspaceRoot, { env: { CLARVIS_HOME: options.globalDir } });
  const global = globalPaths(options.globalDir);
  const unavailable = async (): Promise<never> => {
    throw kernelError(
      "unsupported",
      "External capabilities and administration are unavailable in Container",
    );
  };
  const assemble = createSettingsRunAssembler(configStore, {
    defaultAgent: configuration.defaults.defaultAgent,
    modelExecutionResolver: models.resolver,
  });
  let planStore: ReturnType<typeof createPlanStore> | undefined;
  let memoryStore: ReturnType<typeof createFileMemoryStore> | undefined;
  let leases = 0;
  const acquireRunLease = () => {
    leases++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        leases--;
      }
    };
  };
  const executeLeased: typeof executeRun = (args) =>
    withRunLease(acquireRunLease, () => executeRun(args));
  const graph = await createNativeKernel({
    globalDir: options.globalDir,
    loop: {
      workspaceRoot,
      logger,
      env,
      traceDir: global.tracesDir,
      llm: options.llm,
      modelExecutionResolver: models.resolver,
      connections: { acquire: unavailable, closeAll: async () => undefined },
      builtins: { tools: true, skills: false, hooks: false },
      allowHostEscalation: false,
      capabilities: [createContainerEnvironmentCapability(options.runtime, workspaceRoot)],
    },
    planning: {
      workspaceRoot,
      logger,
      env,
      loadProvider: () => configuration.plans.provider,
      storeFor: () =>
        (planStore ??= createPlanStore({
          repository: createFilePlanRepository({
            workspaceRoot,
            root: workspace.plansRoot,
            lockDir: state.plansLockDir,
            logger,
          }),
          logger,
        })),
    },
    compose: () => ({
      memory: {
        workspaceRoot,
        logger,
        lockWarnMs: env.CLARVIS_MEMORY_LOCK_WARN_MS,
        modelExecutionResolver: models.resolver,
        executeRun: executeLeased,
        loadPolicy: () => configuration.memoryPolicy,
        loadSettings: () => ({
          config: configuration.memory,
          defaultModel: configuration.defaults.default_model,
        }),
        storeFor: () =>
          (memoryStore ??= createFileMemoryStore({
            workspaceRoot,
            root: workspace.memoryRoot,
            machineryRoot: state.memoryMachineryRoot,
            logger,
          })),
      },
      kernel: () => ({
        workspaceRoot,
        project: options.project,
        workspace: options.workspace,
        defaultOwner: options.owner,
        ownershipMode: "single",
        acquireRunLease,
        executeRun: executeLeased,
        operatorAuthorityFor: options.operatorAuthorityFor,
        globalConfigDir: options.globalDir,
        configStore,
        configService: createConfigService(configStore),
        secretService: { listNames: async () => [], set: unavailable, delete: unavailable },
        pluginService: {
          list: async () => [],
          install: unavailable,
          installSource: unavailable,
          update: unavailable,
          uninstall: unavailable,
        },
        modelCatalogService: models.service,
        extensionProfileService: createContainerExtensionProfileService(),
        logger,
        capabilities: {
          skills: false,
          tasks: false,
          agent_tools: configuration.toolPolicy.enabled,
          memory: configuration.memory.enabled !== false,
          runtime: options.runtime,
        },
        assembleRunRequest: (params) => {
          if (
            params.task !== undefined ||
            params.skill !== undefined ||
            params.guard_judge !== undefined ||
            (params.guard_mode !== undefined && params.guard_mode !== "off")
          )
            throw kernelError(
              "unsupported",
              "Tasks, Skills and Command Review are unavailable in Container",
            );
          validateContainerProfileSelection(
            configuration,
            params.agent ?? configuration.defaults.defaultAgent,
          );
          return assemble(params);
        },
        readWorkflowDefinitions: () =>
          configuration.workflows.definitions.map((definition) => ({
            ...structuredClone(definition),
            dir: "builtin:container",
          })),
      }),
    }),
  });
  const kernel = Object.assign(graph.kernel, {
    runtime: structuredClone(options.runtime),
    activeExecutionLeases: () => leases,
  });
  Object.defineProperty(kernel, "runtime", {
    enumerable: true,
    get: () => kernel.capabilities.runtime,
  });
  return { ...graph, kernel };
}
