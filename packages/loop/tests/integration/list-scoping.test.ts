import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, makeExecutionRecord, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("listing is owner-scoped with accurate total", () => {
  it("returns only the requesting owner's items and an owner-scoped total", async () => {
    harness = await makeHarness({
      llm: new MockLLM({ script: [] }),
      mcpFactory: mockMCPFactory({}),
      owner: "alice",
    });
    for (let i = 0; i < 3; i++) {
      await harness.traceStore.insert(
        makeExecutionRecord({ id: `a${i}`, owner_key_name: "alice", started_at: 1000 + i }),
      );
    }
    for (let i = 0; i < 2; i++) {
      await harness.traceStore.insert(makeExecutionRecord({ id: `b${i}`, owner_key_name: "bob" }));
    }

    const res = await harness.listRuns();
    const body = res as {
      items: { execution_id: string }[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(3);
    expect(body.items.every((i) => i.execution_id.startsWith("a"))).toBe(true);
    expect(body.limit).toBe(20);
    expect(body.offset).toBe(0);
  });

  it("returns an empty list (not an error) for an owner with no executions", async () => {
    harness = await makeHarness({
      llm: new MockLLM({ script: [] }),
      mcpFactory: mockMCPFactory({}),
    });
    const res = await harness.listRuns();
    expect(res).toMatchObject({ items: [], total: 0 });
  });

  it("list items carry summary fields only (no trace/request)", async () => {
    harness = await makeHarness({
      llm: new MockLLM({ script: [] }),
      mcpFactory: mockMCPFactory({}),
    });
    await harness.traceStore.insert(
      makeExecutionRecord({
        id: "s1",
        owner_key_name: "test",
        total_input_tokens: 42,
      }),
    );
    const res = await harness.listRuns();
    const item = res.items[0]! as unknown as Record<string, unknown>;
    expect(item).not.toHaveProperty("request");
    expect(item).not.toHaveProperty("response");
    expect(item).not.toHaveProperty("trace");
    expect(item.total_input_tokens).toBe(42);
  });
});
