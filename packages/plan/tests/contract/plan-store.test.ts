/** Drives the complete PlanStore contract against every supported backend. */
import { describe, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFilePlanRepository, createPlanStore } from "@clarvis/plan";
import {
  createInMemoryPlanRepository,
  planStoreConformance,
  type PlanStoreHarness,
} from "@clarvis/plan/testing";

const backends: { name: string; make: () => Promise<PlanStoreHarness> }[] = [
  {
    name: "Markdown",
    async make() {
      const dir = await mkdtemp(join(tmpdir(), "clarvis-plan-store-contract-"));
      return {
        store: createPlanStore({ repository: createFilePlanRepository({ workspaceRoot: dir }) }),
        cleanup: () => rm(dir, { recursive: true, force: true }),
      };
    },
  },
  {
    name: "in-memory",
    async make() {
      return {
        store: createPlanStore({ repository: createInMemoryPlanRepository() }),
        cleanup: async () => {},
      };
    },
  },
];

for (const backend of backends) {
  describe(`PlanStore contract (${backend.name})`, () => {
    for (const scenario of planStoreConformance()) {
      test(scenario.name, async () => {
        const harness = await backend.make();
        try {
          await scenario.run(harness);
        } finally {
          await harness.cleanup();
        }
      });
    }
  });
}
