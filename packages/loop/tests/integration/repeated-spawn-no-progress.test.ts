import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("Lead — repeatedly-failing subagent converges via no_progress", () => {
  it("trips no_progress instead of spawning doomed subagents until the budget is exhausted", async () => {
    const leadSpawn = {
      toolCalls: [
        {
          name: "spawn_subagent",
          arguments: { title: "t", task: "do the thing", profile: "subagent" },
        },
      ],
    };
    const subagentEmpty = {};
    const script = Array.from({ length: 8 }, () => [
      leadSpawn,
      subagentEmpty,
      subagentEmpty,
    ]).flat();
    const llm = new MockLLM({ script });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const res = await harness.run({
      messages: [{ role: "user", content: "keep trying" }],
      servers: [],
      entry: "lead",
      profiles: [
        {
          name: "lead",
          model: "anthropic/claude-opus-4-5",
          tools: [],
          iteration_limit: 40,
          can_spawn: ["subagent"],
        },
        { name: "subagent", model: "anthropic/claude-haiku-4-5", tools: [], iteration_limit: 5 },
      ],
      budget: { on_exceed: "stop", total_token_limit: 10_000_000, timeout_ms: 30_000 },
    });

    expect(res.status).toBe("error");
    expect((res as { error?: { code?: string } }).error?.code).toBe("no_progress");
    expect(llm.calls.length).toBe(18);
  });
});
