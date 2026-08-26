/** Drives the complete PlanStore contract against every supported backend. */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PlanCursorError,
  createFilePlanRepository,
  createPlanStore,
  type PlanStore,
} from "@clarvis/plan";
import {
  createInMemoryPlanRepository,
  planStoreConformance,
  type PlanStoreHarness,
} from "@clarvis/plan/testing";

import { executableFactory } from "../helpers/provider.ts";

const backends: { name: string; make: () => Promise<PlanStoreHarness> }[] = [
  {
    name: "executable",
    async make() {
      return {
        store: (await executableFactory().storeFor("alice")).store,
        cleanup: async () => {},
      };
    },
  },
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

/**
 * The one cross-dialect confusion a deployment can actually reach: a client
 * paging a workspace whose `PlanFactory` selection changed between two pages.
 */
describe("a plan cursor names the store that minted it", () => {
  function backendNamed(name: string): (typeof backends)[number] {
    const found = backends.find((backend) => backend.name === name);
    if (found === undefined) throw new Error(`no ${name} backend`);
    return found;
  }

  async function fill(store: PlanStore): Promise<string> {
    for (let index = 0; index < 3; index += 1) {
      await store.create({
        title: `Crossing ${index}`,
        objective: "page across a provider change",
        tasks: [{ title: "step" }],
        validation: ["stays consistent"],
        createdByRun: "cross-store",
        now: new Date(Date.UTC(2026, 7, 6, 12, index)),
      });
    }
    const page = await store.list({ limit: 2 });
    expect(page.plans).toHaveLength(2);
    expect(page.next_cursor).toBeDefined();
    return page.next_cursor!;
  }

  test("a Markdown cursor is refused by a provider store, and the reverse", async () => {
    const markdown = await backendNamed("Markdown").make();
    const provider = await backendNamed("executable").make();
    try {
      const markdownCursor = await fill(markdown.store);
      const providerCursor = await fill(provider.store);
      await expect(
        provider.store.list({ limit: 2, cursor: markdownCursor }),
      ).rejects.toBeInstanceOf(PlanCursorError);
      await expect(
        markdown.store.list({ limit: 2, cursor: providerCursor }),
      ).rejects.toBeInstanceOf(PlanCursorError);
      const markdownRest = await markdown.store.list({ limit: 2, cursor: markdownCursor });
      expect(markdownRest.plans).toHaveLength(1);
      const providerRest = await provider.store.list({ limit: 2, cursor: providerCursor });
      expect(providerRest.plans).toHaveLength(1);
    } finally {
      await markdown.cleanup();
      await provider.cleanup();
    }
  });
});
