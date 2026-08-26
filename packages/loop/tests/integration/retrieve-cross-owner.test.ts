import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("cross-owner retrieval returns null, not an error", () => {
  it("returns null when a different owner requests the record", async () => {
    const llm = new MockLLM({ script: [{ text: "secret result" }] });
    harness = await makeHarness({
      llm,
      mcpFactory: mockMCPFactory({}),
      owner: "alice",
    });

    const created = await harness.run({
      messages: [{ role: "user", content: "alice's run" }],
      servers: [],
      profiles: [
        { name: "solo", model: "anthropic/claude-sonnet-4-5", tools: [], iteration_limit: 5 },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 10000 },
    });
    const id = created.execution_id;

    expect(await harness.getRun(id, { owner: "bob" })).toBeNull();

    const asAlice = await harness.getRun(id);
    expect(asAlice).not.toBeNull();
  });

  it("returns null for an id that does not exist at all", async () => {
    const llm = new MockLLM({ script: [{ text: "x" }] });
    harness = await makeHarness({
      llm,
      mcpFactory: mockMCPFactory({}),
      owner: "alice",
    });

    expect(await harness.getRun(`exec_does-not-exist`)).toBeNull();
  });
});
