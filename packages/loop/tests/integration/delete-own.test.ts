import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("owner deletes its execution", () => {
  it("removes the record so a subsequent get_run returns null", async () => {
    const llm = new MockLLM({ script: [{ text: "done" }] });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const created = await harness.run({
      messages: [{ role: "user", content: "x" }],
      servers: [],
      profiles: [
        { name: "solo", model: "anthropic/claude-sonnet-4-5", tools: [], iteration_limit: 5 },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 10000 },
    });
    const id = created.execution_id;

    expect(await harness.deleteRun(id)).toBe(true);

    expect(await harness.getRun(id)).toBeNull();
  });

  it("returns false when deleting a non-existent id", async () => {
    harness = await makeHarness({
      llm: new MockLLM({ script: [] }),
      mcpFactory: mockMCPFactory({}),
    });
    expect(await harness.deleteRun("nope")).toBe(false);
  });
});
