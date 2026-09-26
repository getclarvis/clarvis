/**
 * Drives the backend-agnostic PlanRepository contract against every adapter.
 * Behaviour specific to the file backend lives in file-repository.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PlanCursorError,
  createFilePlanRepository,
  newPlan,
  renderPlan,
  projectPlan,
  planFilename,
  type PlanRecord,
  type PlanRepository,
} from "@clarvis/plan";
import {
  createInMemoryPlanRepository,
  planRepositoryConformance,
  type PlanRepositoryHarness,
} from "@clarvis/plan/testing";

/** The file-backed adapter over a fresh temp workspace; `poke` rewrites the file. */
export async function fileHarness(): Promise<PlanRepositoryHarness & { dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "clarvis-plan-"));
  const repository = createFilePlanRepository({ workspaceRoot: dir });
  const locators = new Map<string, string>();
  return {
    dir,
    repository: {
      ...repository,
      async create(record) {
        const created = await repository.create(record);
        locators.set(created.id, created.index.path);
        return created;
      },
    },
    async poke(id, source) {
      const relative = locators.get(id);
      if (relative === undefined) throw new Error(`no locator recorded for ${id}`);
      await writeFile(join(dir, relative), source, "utf8");
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** The process-local adapter; `poke` swaps the stored bytes directly. */
function inMemoryHarness(): PlanRepositoryHarness {
  const repository = createInMemoryPlanRepository() as ReturnType<
    typeof createInMemoryPlanRepository
  > & { poke: (id: string, source: string) => void };
  return {
    repository,
    poke: async (id, source) => {
      repository.poke(id, source);
    },
    cleanup: async () => {},
  };
}

const backends: { name: string; make: () => Promise<PlanRepositoryHarness> }[] = [
  { name: "file", make: fileHarness },
  { name: "in-memory", make: async () => inMemoryHarness() },
];

for (const backend of backends) {
  describe(`PlanRepository contract (${backend.name})`, () => {
    for (const scenario of planRepositoryConformance()) {
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

/** A storable record whose creation minute makes the page order deterministic. */
function seed(title: string, minute: number): Omit<PlanRecord, "digest"> {
  const now = new Date(Date.UTC(2026, 6, 27, 10, minute));
  const document = newPlan({
    title,
    objective: `Do ${title}`,
    tasks: [{ title: `Step for ${title}` }],
    createdByRun: "cross-adapter",
    now,
  });
  return {
    id: document.id,
    source: renderPlan(document),
    index: { ...projectPlan(document), path: planFilename(now, title) },
  };
}

/** Fill an adapter and hand back the cursor it mints after a two-plan page. */
async function mintCursor(repository: PlanRepository): Promise<string> {
  for (const [index, title] of ["First", "Second", "Third"].entries()) {
    await repository.create(seed(title, index));
  }
  const page = await repository.list({ limit: 2 });
  expect(page.records.map((r) => r.index.title)).toEqual(["Third", "Second"]);
  expect(page.next_cursor).toBeDefined();
  return page.next_cursor!;
}

describe("a plan cursor names the adapter that minted it", () => {
  test("a file cursor is refused by the in-memory adapter", async () => {
    const file = await fileHarness();
    const memory = inMemoryHarness();
    try {
      const cursor = await mintCursor(file.repository);
      await mintCursor(memory.repository);
      const before = await memory.repository.list({ limit: 2 });
      expect(before.records).toHaveLength(2);
      await expect(memory.repository.list({ limit: 2, cursor })).rejects.toBeInstanceOf(
        PlanCursorError,
      );
    } finally {
      await file.cleanup();
      await memory.cleanup();
    }
  });

  test("an in-memory cursor is refused by the file adapter", async () => {
    const file = await fileHarness();
    const memory = inMemoryHarness();
    try {
      const cursor = await mintCursor(memory.repository);
      await mintCursor(file.repository);
      await expect(file.repository.list({ limit: 2, cursor })).rejects.toBeInstanceOf(
        PlanCursorError,
      );
    } finally {
      await file.cleanup();
      await memory.cleanup();
    }
  });

  test("each adapter still pages with the cursor it minted itself", async () => {
    const file = await fileHarness();
    const memory = inMemoryHarness();
    try {
      for (const repository of [file.repository, memory.repository]) {
        const cursor = await mintCursor(repository);
        const rest = await repository.list({ limit: 2, cursor });
        expect(rest.records.map((r) => r.index.title)).toEqual(["First"]);
        expect(rest.next_cursor).toBeUndefined();
      }
    } finally {
      await file.cleanup();
      await memory.cleanup();
    }
  });
});
