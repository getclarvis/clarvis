import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, makeExecutionRecord, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("cross-owner delete returns false and removes nothing", () => {
  it("a non-owning owner cannot delete; the row remains", async () => {
    harness = await makeHarness({
      llm: new MockLLM({ script: [] }),
      mcpFactory: mockMCPFactory({}),
      owner: "alice",
    });
    await harness.traceStore.insert(makeExecutionRecord({ id: "owned", owner_key_name: "alice" }));

    expect(await harness.deleteRun("owned", { owner: "bob" })).toBe(false);

    expect(harness.traceStore.getById("alice", "owned")).not.toBeNull();
    expect(await harness.getRun("owned")).not.toBeNull();
  });
});
