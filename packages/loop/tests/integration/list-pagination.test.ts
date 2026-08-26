import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, makeExecutionRecord, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("pagination slice with page-independent total", () => {
  it("returns items 21–30 newest-first for limit=10&offset=20 with total=50", async () => {
    harness = await makeHarness({
      llm: new MockLLM({ script: [] }),
      mcpFactory: mockMCPFactory({}),
    });
    for (let i = 0; i < 50; i++) {
      await harness.traceStore.insert(
        makeExecutionRecord({ id: `e${i}`, owner_key_name: "test", started_at: 10_000 + i }),
      );
    }

    const res = await harness.listRuns({ limit: 10, offset: 20 });
    const body = res as {
      items: { execution_id: string }[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(body.total).toBe(50);
    expect(body.limit).toBe(10);
    expect(body.offset).toBe(20);
    expect(body.items).toHaveLength(10);
    const expected = Array.from({ length: 10 }, (_, k) => `e${29 - k}`);
    expect(body.items.map((i) => i.execution_id)).toEqual(expected);
  });

  it("rejects out-of-bounds pagination with invalid_pagination", async () => {
    harness = await makeHarness({
      llm: new MockLLM({ script: [] }),
      mcpFactory: mockMCPFactory({}),
    });
    await expect(harness.listRuns({ limit: 500 })).rejects.toMatchObject({
      code: "invalid_pagination",
    });

    await expect(harness.listRuns({ offset: -5 })).rejects.toMatchObject({
      code: "invalid_pagination",
    });
  });
});
