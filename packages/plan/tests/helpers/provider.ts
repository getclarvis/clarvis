import { createPlanStore, type PlanStore } from "../../src/index.ts";
import { createInMemoryPlanRepository } from "../../src/testing.ts";

export function markdownStore(): PlanStore {
  return createPlanStore({ repository: createInMemoryPlanRepository() });
}
