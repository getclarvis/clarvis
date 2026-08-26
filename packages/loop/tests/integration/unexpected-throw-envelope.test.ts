import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

describe("terminal envelope for an unexpected (non-ProviderError) mid-run throw", () => {
  let harness: TestHarness | null = null;
  afterEach(async () => {
    await harness?.close();
    harness = null;
  });

  it("surfaces a structured error envelope (subagent-only)", async () => {
    harness = await makeHarness({
      llm: new MockLLM({ script: [{ throw: new Error("unexpected kernel failure") }] }),
      mcpFactory: mockMCPFactory({}),
    });
    const res = await harness.run({
      messages: [{ role: "user", content: "hi" }],
      servers: [],
      profiles: [{ name: "solo", model: "anthropic/claude-x", tools: [], iteration_limit: 3 }],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 1000 },
    });
    expect(res.status).toBe("error");
    if (res.status !== "error") throw new Error("unreachable");
    expect(res.error.code).toBe("internal_error");
    expect(typeof res.error.message).toBe("string");
  });

  it("surfaces a structured error envelope (lead+subagent)", async () => {
    harness = await makeHarness({
      llm: new MockLLM({ script: [{ throw: new Error("unexpected lead failure") }] }),
      mcpFactory: mockMCPFactory({}),
    });
    const res = await harness.run({
      messages: [{ role: "user", content: "hi" }],
      servers: [],
      entry: "lead",
      profiles: [
        {
          name: "lead",
          model: "anthropic/claude-x",
          tools: [],
          can_spawn: ["subagent"],
          iteration_limit: 3,
        },
        { name: "subagent", model: "anthropic/claude-x", tools: [], iteration_limit: 3 },
      ],
      budget: { on_exceed: "stop", total_token_limit: 1000 },
    });
    expect(res.status).toBe("error");
    if (res.status !== "error") throw new Error("unreachable");
    expect(res.error.code).toBe("internal_error");
  });
});
