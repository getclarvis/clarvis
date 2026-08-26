import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("a long Lead orchestration does not overflow", () => {
  /**
   * `prompt_mode: "none"` is the documented way back to mechanical eviction now
   * that every run summarizes by default, so this test doubles as the proof that
   * the opt-out restores exactly the old behaviour: every assertion below is
   * unchanged from before the rolling summary existed.
   */
  it("evicts the oldest Subagent results oldest-first, preserves recent ones, and completes", async () => {
    const A = "A".repeat(700);
    const B = "B".repeat(700);
    const C = "C".repeat(700);
    const llm = new MockLLM({
      script: [
        { toolCalls: [{ name: "spawn_subagent", arguments: { title: "w", task: "extract A" } }] },
        { text: A },
        { toolCalls: [{ name: "spawn_subagent", arguments: { title: "w", task: "extract B" } }] },
        { text: B },
        { toolCalls: [{ name: "spawn_subagent", arguments: { title: "w", task: "extract C" } }] },
        { text: C },
        { text: "final synthesis" },
      ],
    });

    harness = await makeHarness({
      llm,
      mcpFactory: mockMCPFactory({}),
      env: {
        CLARVIS_DEFAULT_CONTEXT_WINDOW_TOKENS: "200",
        CLARVIS_DEFAULT_COMPACTION_MAX_RESULT_CHARS: "100000",
      },
    });

    const res = await harness.run({
      messages: [{ role: "user", content: "extract everything" }],
      servers: [],
      entry: "lead",
      profiles: [
        {
          name: "lead",
          model: "anthropic/claude-opus-4-5",
          tools: [],
          iteration_limit: 10,
          can_spawn: ["subagent"],
          compaction: { prompt_mode: "none" },
        },
        {
          name: "subagent",
          model: "anthropic/claude-haiku-4-5",
          tools: [],
          iteration_limit: 3,
          compaction: { prompt_mode: "none" },
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 100000 },
    });

    const body = res as unknown as { status: string; result: string; execution_id: string };
    expect(body.status).toBe("completed");
    expect(body.result).toBe("final synthesis");

    const stored = harness.traceStore.getById("test", body.execution_id);
    const evictions = stored!.trace.events.filter(
      (e) => e.type === "compaction" && (e as { operation: string }).operation === "eviction",
    );
    expect(evictions.length).toBeGreaterThanOrEqual(1);
    const ev = evictions[0] as { agent: string; evicted_count: number; freed_chars: number };
    expect(ev.agent).toBe("lead");
    expect(ev.evicted_count).toBeGreaterThanOrEqual(1);
    expect(ev.freed_chars).toBeGreaterThan(0);

    const leadCalls = llm.calls.filter((c) => c.model === "claude-opus-4-5");
    const finalLeadCtx = JSON.stringify(leadCalls[leadCalls.length - 1]!.messages);
    expect(finalLeadCtx).toMatch(/earlier tool result.* evicted to fit context/);
    expect(finalLeadCtx).not.toContain(A);
    expect(finalLeadCtx).toContain(C);
  });
});
