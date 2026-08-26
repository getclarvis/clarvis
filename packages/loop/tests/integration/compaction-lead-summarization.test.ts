import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import type { LLMCallParams } from "@clarvis/capability";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const GIST = "GIST OF EARLIER WORK";

/**
 * A summarization call is the one with no tools whose user turn is the rendered
 * span. It needs its own cursor because `MockLLM`'s bare `script` is a single
 * global one: every summarization would otherwise consume a step meant for an
 * agent turn and desynchronize the rest of the run.
 */
const isCompactionCall = (p: LLMCallParams): boolean =>
  p.tools.length === 0 &&
  typeof p.messages[1]?.content === "string" &&
  p.messages[1].content.startsWith("Transcript to compact:");

describe("a Lead over its window summarizes by default", () => {
  /**
   * The defect this pins: no shipped agent template declares a `compaction`
   * block, so `compactionPrompt` was always undefined and `runCompaction` fell
   * through to blind eviction. The whole LLM-summarization path was unreachable
   * in the product. Note that nothing below configures a compaction prompt.
   */
  it("rolls earlier results into a summary anchor instead of evicting them", async () => {
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
      routes: [
        {
          name: "compaction",
          when: isCompactionCall,
          script: Array.from({ length: 12 }, () => ({ text: GIST })),
        },
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
        },
        { name: "subagent", model: "anthropic/claude-haiku-4-5", tools: [], iteration_limit: 3 },
      ],
      budget: { on_exceed: "stop", total_token_limit: 100000 },
    });

    const body = res as unknown as { status: string; result: string; execution_id: string };
    expect(body.status).toBe("completed");
    expect(body.result).toBe("final synthesis");

    expect(llm.calls.some(isCompactionCall)).toBe(true);

    const stored = harness.traceStore.getById("test", body.execution_id);
    const summarizations = stored!.trace.events.filter(
      (e) => e.type === "compaction" && (e as { operation: string }).operation === "summarization",
    ) as unknown as { agent: string; anchor_chars: number; anchor_updated: boolean }[];
    expect(summarizations.length).toBeGreaterThanOrEqual(1);
    expect(summarizations[0]!.agent).toBe("lead");
    expect(summarizations[0]!.anchor_chars).toBeGreaterThan(GIST.length);
    expect(summarizations[0]!.anchor_updated).toBe(false);

    const leadCalls = llm.calls.filter((c) => c.model === "claude-opus-4-5");
    const finalLeadCtx = JSON.stringify(leadCalls[leadCalls.length - 1]!.messages);
    expect(finalLeadCtx).toContain(GIST);
    expect(finalLeadCtx).toContain("rolling summary of earlier context");
    expect(finalLeadCtx).not.toContain(A);
  });
});
