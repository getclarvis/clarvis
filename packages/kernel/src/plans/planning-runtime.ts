import {
  NOOP_LOGGER,
  sharedFallback,
  type Capability,
  type CapabilityExecutablePort,
  type EnvConfig,
  type Logger,
} from "@clarvis/capability";
import {
  createFilePlanRepository,
  createPlanFactory,
  createPlanStore,
  type PlanFactory,
  type PlanPluginPort,
  type PlanProviderConfig,
  type PlanStore,
} from "@clarvis/plan";
import { createPlansCapability } from "@clarvis/plan/capability";

/** The two consumers of planning assembled from one owner-scoped data plane. */
export interface PlanningRuntime {
  /** Process-lifetime capability registered on the kernel's execution deps. */
  capability: Capability;
  /** Settings-sensitive factory shared with the plans control-plane service. */
  planFactory: PlanFactory;
}

/**
 * Build the kernel-owned planning runtime over an injected or Markdown store.
 *
 * @param options - workspace, loop defaults, an optional host store factory and
 *   the `plan` component logger.
 * @returns one capability and the exact provider factory it closes over.
 * @remarks The default store is shared across owners because a single-owner file
 * kernel has one workspace repository. An explicit factory remains owner-aware,
 * while {@link createPlanFactory} guarantees one authoritative store per signature and owner.
 */
export function createPlanningRuntime(options: {
  workspaceRoot: string;
  env: EnvConfig;
  storeFor?: (owner: string) => PlanStore;
  loadProvider: () => PlanProviderConfig | undefined;
  pluginPort?: PlanPluginPort;
  executablePort?: CapabilityExecutablePort;
  logger?: Logger;
}): PlanningRuntime {
  const logger = options.logger ?? NOOP_LOGGER;
  const markdownStoreFor =
    options.storeFor ??
    sharedFallback(() =>
      createPlanStore({
        repository: createFilePlanRepository({ workspaceRoot: options.workspaceRoot, logger }),
        logger,
      }),
    );
  const planFactory = createPlanFactory({
    workspaceRoot: options.workspaceRoot,
    loadProvider: options.loadProvider,
    markdownStoreFor,
    ...(options.pluginPort === undefined ? {} : { pluginPort: options.pluginPort }),
    ...(options.executablePort === undefined ? {} : { executablePort: options.executablePort }),
  });
  return {
    planFactory,
    capability: createPlansCapability({
      factory: planFactory,
      logger,
      defaultPendingTaskNudges: options.env.CLARVIS_DEFAULT_PENDING_TASK_NUDGES,
      defaultElicitWaitMs: options.env.CLARVIS_DEFAULT_ELICIT_WAIT_MS,
    }),
  };
}
