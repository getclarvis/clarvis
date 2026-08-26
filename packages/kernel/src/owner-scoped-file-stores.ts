import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import { createFileMemoryStore, type MemoryStore } from "@clarvis/memory";
import { workspacePaths, workspaceStatePaths } from "@clarvis/paths";
import { createFilePlanRepository, createPlanStore, type PlanStore } from "@clarvis/plan";

/** Options for {@link createOwnerScopedFileStores}. */
export interface CreateOwnerScopedFileStoresOptions {
  /** The operator-owned workspace whose per-owner data trees are used. */
  workspaceRoot: string;
  /**
   * The `plan` component logger, so a per-owner store reports a losing
   * compare-and-swap and an unparsable document exactly as the single-owner one
   * does.
   */
  logger?: Logger;
}

/** File-backed persistence factories suitable for a multi-owner file kernel. */
export interface OwnerScopedFileStores {
  planStoreFor: (owner: string) => PlanStore;
  memoryStoreFor: (owner: string) => MemoryStore;
  /** Forget both stores after the kernel has stopped every service using them. */
  evictOwner(owner: string): void;
}

/**
 * Build memoized, structurally isolated plan and memory stores for each owner.
 *
 * @param options - workspace root used for both human-readable and machinery paths.
 * @returns the explicit owner-aware stores accepted by {@link createFileKernel}.
 * @remarks Configuration remains shared and operator-owned. Owner ids are encoded
 * before they become path segments. Stores stay stable while an owner is resident,
 * then {@link OwnerScopedFileStores.evictOwner} releases the references after the
 * kernel has stopped that owner's workers and services.
 */
export function createOwnerScopedFileStores(
  options: CreateOwnerScopedFileStoresOptions,
): OwnerScopedFileStores {
  const { workspaceRoot } = options;
  const logger = options.logger ?? NOOP_LOGGER;
  const paths = workspacePaths(workspaceRoot);
  const state = workspaceStatePaths(workspaceRoot);
  const planStores = new Map<string, PlanStore>();
  const memoryStores = new Map<string, MemoryStore>();

  const planStoreFor = (owner: string): PlanStore => {
    const cached = planStores.get(owner);
    if (cached !== undefined) return cached;
    const store = createPlanStore({
      repository: createFilePlanRepository({
        workspaceRoot,
        root: paths.plansRootForOwner(owner),
        lockDir: state.plansLockDirForOwner(owner),
        logger,
      }),
      logger,
    });
    planStores.set(owner, store);
    return store;
  };

  const memoryStoreFor = (owner: string): MemoryStore => {
    const cached = memoryStores.get(owner);
    if (cached !== undefined) return cached;
    const store = createFileMemoryStore({
      root: paths.memoryRootForOwner(owner),
      machineryRoot: state.memoryMachineryRootForOwner(owner),
      workspaceRoot,
    });
    memoryStores.set(owner, store);
    return store;
  };

  return {
    planStoreFor,
    memoryStoreFor,
    evictOwner(owner): void {
      planStores.delete(owner);
      memoryStores.delete(owner);
    },
  };
}
