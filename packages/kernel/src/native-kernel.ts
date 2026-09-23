import type { ExecuteRunDeps } from "@clarvis/loop";
import { buildExecuteRunDeps } from "@clarvis/loop/host";
import {
  createMemoryCapability,
  createMemoryFactory,
  type MemoryFactory,
} from "@clarvis/memory/capability";
import { TraceCleanup, type TraceStore } from "@clarvis/trace";
import type { Logger } from "@clarvis/capability";
import { sweepGlobalStateArtifacts, sweepSpillDir, workspaceStatePaths } from "@clarvis/paths";
import { WorkspaceHousekeeping } from "./application/workspace-housekeeping.ts";
import { createKernelLifecycle } from "./application/lifecycle.ts";
import { referencedSessionExecutionIds } from "./sessions/session-service.ts";
import { composeIndexPassDeps } from "./memory/pass-deps.ts";
import { composeKernelCapabilityRegistry } from "./config/capability-registry.ts";
import { createPlanningRuntime, type PlanningRuntime } from "./plans/planning-runtime.ts";
import { createInProcessKernel, type CreateKernelOptions, type InProcessKernel } from "./kernel.ts";

type Built = Awaited<ReturnType<typeof buildExecuteRunDeps>>;
type MemoryOptions = Omit<
  Parameters<typeof createMemoryFactory>[0],
  "llm" | "runDeps" | "passRunDeps"
>;

/** Explicit host ports around the shared native execution and owner-service lifetime. */
export interface NativeKernelComposition {
  memory?: MemoryOptions;
  /** File-only authority and capabilities may be appended here; Container supplies no such ports. */
  decorateDeps?(deps: ExecuteRunDeps): ExecuteRunDeps;
  kernel(
    deps: ExecuteRunDeps,
    memory: MemoryFactory | undefined,
    planning: PlanningRuntime,
  ): Omit<CreateKernelOptions, "deps" | "memoryFactory" | "planFactory">;
}

/** Common native construction. No configuration, credential, plugin, guard or subscription discovery occurs here. */
export interface CreateNativeKernelOptions {
  globalDir: string;
  loop: Parameters<typeof buildExecuteRunDeps>[0];
  planning: Parameters<typeof createPlanningRuntime>[0];
  compose(built: Built): NativeKernelComposition;
}

/** Recover interrupted traces before serving; failure leaves journals for a later startup. */
async function recoverInterruptedRuns(store: TraceStore, logger: Logger): Promise<number> {
  try {
    const report = await store.recoverOrphans?.();
    if (report === undefined) return 0;
    if (report.recovered > 0 || report.exhausted) {
      logger.info(
        { event: "runs.recovered_interrupted", ...report },
        "recovered interrupted runs from their journals",
      );
    }
    return report.recovered;
  } catch (error) {
    logger.warn(
      {
        event: "runs.recovery_failed",
        cause: error instanceof Error ? error.message : String(error),
      },
      "journal recovery failed; journals remain for the next start",
    );
    return 0;
  }
}

/**
 * Construct one Loop, native Plans/Memory and in-process owner-service graph.
 * Host-specific adapters enter only through explicit ports. Memory recovery is never started here;
 * the process bootstrap releases it after readiness. Failed construction closes native resources.
 */
export async function createNativeKernel(options: CreateNativeKernelOptions): Promise<{
  kernel: InProcessKernel;
  deps: ExecuteRunDeps;
  recoveredRuns: number;
}> {
  const planning = createPlanningRuntime(options.planning);
  const statePaths =
    options.loop.statePaths ??
    workspaceStatePaths(options.loop.workspaceRoot, { env: { CLARVIS_HOME: options.globalDir } });
  const built = await buildExecuteRunDeps({
    ...options.loop,
    statePaths,
    capabilities: [...(options.loop.capabilities ?? []), planning.capability],
  });
  let memoryFactory: MemoryFactory | undefined;
  let cleanup: TraceCleanup | undefined;
  let housekeeping: WorkspaceHousekeeping | undefined;
  const resources = createKernelLifecycle(options.loop.logger);
  resources.register({ close: built.dispose });
  let releaseMemory: (() => void) | undefined;
  try {
    const composition = options.compose(built);
    const deferred: { deps?: ExecuteRunDeps; passDeps?: ExecuteRunDeps } = {};
    memoryFactory =
      composition.memory === undefined
        ? undefined
        : createMemoryFactory({
            ...composition.memory,
            llm: built.deps.llm,
            runDeps: () => deferred.deps,
            passRunDeps: () => deferred.passDeps,
          });
    if (memoryFactory !== undefined) {
      const memory = memoryFactory;
      releaseMemory = resources.register({ close: () => memory.stop() });
    }
    const base: ExecuteRunDeps = {
      ...built.deps,
      capabilityRegistry: composeKernelCapabilityRegistry(built.deps.capabilityRegistry),
      capabilities: [...(built.deps.capabilities ?? []), createMemoryCapability(memoryFactory)],
    };
    const deps = composition.decorateDeps?.(base) ?? base;
    deferred.deps = deps;
    deferred.passDeps = composeIndexPassDeps(deps, memoryFactory);
    const { env, logger } = options.loop;
    const recoveredRuns = await recoverInterruptedRuns(built.resolved.store, logger);
    cleanup = new TraceCleanup({
      store: built.resolved.store,
      ttlDays: env.CLARVIS_TRACE_TTL_DAYS,
      batchSize: env.CLARVIS_TRACE_CLEANUP_BATCH_SIZE,
      logger,
      protectedExecutionIds: () => referencedSessionExecutionIds(options.globalDir),
    });
    resources.register({ close: () => cleanup?.stop() });
    housekeeping = new WorkspaceHousekeeping({
      sweepSpills: () => sweepSpillDir(statePaths),
      sweepGlobalArtifacts: async () => {
        await sweepGlobalStateArtifacts(options.globalDir);
      },
      logger,
    });
    resources.register({ close: () => housekeeping?.stop() });
    const kernelOptions = composition.kernel(deps, memoryFactory, planning);
    if (kernelOptions.dispose !== undefined) resources.register({ close: kernelOptions.dispose });
    const kernel = createInProcessKernel({
      ...kernelOptions,
      deps,
      planFactory: planning.planFactory,
      ...(memoryFactory === undefined ? {} : { memoryFactory }),
      dispose: () => resources.close(),
    });
    cleanup.start(env.CLARVIS_TRACE_CLEANUP_INTERVAL_MS);
    housekeeping.start();
    releaseMemory?.();
    return { kernel, deps, recoveredRuns };
  } catch (error) {
    try {
      await resources.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Native Kernel construction and cleanup failed",
        { cause: cleanupError },
      );
    }
    throw error;
  }
}
