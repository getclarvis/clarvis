import { describe, it, expect, afterEach } from "../bun-test.ts";
import { makeConcurrencyLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const profiles = [
  {
    name: "lead",
    model: "anthropic/claude-opus-4-5",
    iteration_limit: 10,
    tools: [] as string[],
    can_spawn: ["subagent"],
  },
  {
    name: "subagent",
    model: "anthropic/claude-haiku-4-5",
    tools: [] as string[],
    iteration_limit: 5,
  },
];

interface Body {
  status: string;
  usage: { by_agent: Array<{ type: string; instances?: number }> };
}

describe("multiple spawn_subagent calls in one response run concurrently, bounded by MAX_PARALLEL_SUBAGENTS", () => {
  it("with no cap, all spawned Subagents run at once: peak concurrency equals the spawn count", async () => {
    const llm = makeConcurrencyLLM(3, 30);
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const res = await harness.run({
      messages: [{ role: "user", content: "extract three fields" }],
      servers: [],
      entry: "lead",
      profiles,
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    });

    const body = res as unknown as Body;
    expect(body.status).toBe("completed");
    expect(llm.peak).toBe(3);
    const subagent = body.usage.by_agent.find((a) => a.type === "subagent")!;
    expect(subagent.instances).toBe(3);
  });

  it("with MAX_PARALLEL_SUBAGENTS=2 and 5 spawns, at most 2 Subagents run at once", async () => {
    const llm = makeConcurrencyLLM(5, 25);
    harness = await makeHarness({
      llm,
      mcpFactory: mockMCPFactory({}),
      env: { CLARVIS_MAX_PARALLEL_SUBAGENTS: "2" },
    });

    const res = await harness.run({
      messages: [{ role: "user", content: "extract five fields" }],
      servers: [],
      profiles,
      entry: "lead",
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
    });

    const body = res as unknown as Body;
    expect(body.status).toBe("completed");
    expect(llm.peak).toBe(2);
    const subagent = body.usage.by_agent.find((a) => a.type === "subagent")!;
    expect(subagent.instances).toBe(5);
  });
});
