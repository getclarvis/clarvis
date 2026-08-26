import { createPlanStore, type PlanRepository, type PlanStore } from "../../src/index.ts";
import { createInMemoryPlanRepository } from "../../src/testing.ts";

/** An in-memory repository whose source can be changed as an out-of-band edit. */
export interface EditablePlanRepository extends PlanRepository {
  poke(id: string, source: string): void;
  source(id: string): string | undefined;
}

/** Build the package's in-memory test repository with its explicit edit seam. */
export function createEditablePlanRepository(): EditablePlanRepository {
  const repository = createInMemoryPlanRepository() as PlanRepository & {
    poke(id: string, source: string): void;
  };
  const sources = new Map<string, string>();
  return {
    ...repository,
    async create(record) {
      const created = await repository.create({
        ...record,
        index: {
          ...record.index,
          path: record.index.path.startsWith(".clarvis/")
            ? record.index.path
            : `.clarvis/plans/${record.index.path}`,
        },
      });
      sources.set(record.id, record.source);
      return created;
    },
    async write(input) {
      const written = await repository.write(input);
      sources.set(input.id, input.source);
      return written;
    },
    async delete(id, expectedDigest) {
      const deleted = await repository.delete(id, expectedDigest);
      if (deleted) sources.delete(id);
      return deleted;
    },
    poke(id, source) {
      repository.poke(id, source);
      sources.set(id, source);
    },
    source: (id) => sources.get(id),
  };
}

/** Build a real plan aggregate over an effect-free in-memory repository. */
export function createMemoryPlanStore(
  repository: PlanRepository = createInMemoryPlanRepository(),
): PlanStore {
  return createPlanStore({ repository });
}
