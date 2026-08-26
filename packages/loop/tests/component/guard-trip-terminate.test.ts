/**
 * Only a genuine guard termination records `terminate`.
 *
 * @remarks When a guard escalation hands back a result of its own, the run did
 * not end because the guard said so — it ended because cancellation was observed
 * while the prompt was open. Recording `terminate` there would put a reason in
 * the persisted trace that never happened, and the trace is the only account of
 * why a run stopped: a reader would see a doom-loop termination for a run the
 * user simply cancelled, and go looking for the loop.
 *
 * The distinction is one `if` on an `undefined`, with a control case that shares
 * every other line, so each test here is paired with its opposite.
 */
import { describe, expect, it } from "../bun-test.ts";
import type { AgentResult } from "@clarvis/capability";
import { createTrace } from "@clarvis/trace";
import { createIterationCounter, createTokenLedger } from "../../src/runtime/budget/index.ts";
import { DISABLED_COMPACTION } from "../../src/runtime/context/index.ts";
import { runAgent, type RunAgentInput } from "../../src/runtime/loop/run-agent.ts";
import { buildRegistry } from "../../src/runtime/tools/mcp-registry.ts";
import { MockLLM } from "../helpers/fixtures.ts";

/** Repeating one unknown tool call keeps the signature identical, so the doom guard trips. */
const failing = (): MockLLM =>
  new MockLLM({
    script: Array.from({ length: 12 }, () => ({
      toolCalls: [{ name: "not_a_tool", arguments: {} }],
      usage: { input_tokens: 10, output_tokens: 2 },
    })),
  });

function input(options: {
  llm: MockLLM;
  trace: ReturnType<typeof createTrace>;
  ask?: RunAgentInput["guardEscalationAsk"];
  signal?: AbortSignal;
}): RunAgentInput {
  return {
    agent: "subagent",
    subagentInstanceId: "worker-1",
    messages: [{ role: "user", content: "go" }],
    target: {
      llm: options.llm,
      model: "model",
      provider: "anthropic",
      capabilities: new Set(["tool_calling"]),
    },
    budget: {
      ledger: createTokenLedger(1_000_000),
      counter: createIterationCounter(50),
      usage: { input: 0, output: 0, cached: 0, cache_write: 0 },
    },
    runtime: {
      trace: options.trace,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
    compaction: DISABLED_COMPACTION,
    registry: buildRegistry([], []),
    mcpProgress: (result) => result.errText === null,
    allToolsUnavailable: () => false,
    noProgressLimit: 99,
    noProgressMessage: (streak) => `no progress for ${String(streak)}.`,
    emptyResponseAgent: "LLM",
    guardMaxEscalations: 2,
    ...(options.ask !== undefined ? { guardEscalationAsk: options.ask } : {}),
  };
}

const kinds = (trace: ReturnType<typeof createTrace>): string[] =>
  trace.entries().map((entry) => entry.kind);

describe("a guard trip records terminate only when the guard is what ended the run", () => {
  it("records it when the escalation declines and the guard's own result stands", async () => {
    const trace = createTrace();

    const result: AgentResult = await runAgent(
      input({ llm: failing(), trace, ask: async () => "decline" }),
    );

    expect(result.status).toBe("error");
    expect(kinds(trace)).toContain("terminate");
    const terminate = trace.entries().find((entry) => entry.kind === "terminate")!;
    expect((terminate.detail as { reason: string }).reason).toBe("tool_failure_loop");
  });

  it("records it with no escalation configured at all", async () => {
    const trace = createTrace();

    await runAgent(input({ llm: failing(), trace }));

    expect(kinds(trace)).toContain("terminate");
  });

  it("does not record it when the escalation is cancelled mid-prompt", async () => {
    const trace = createTrace();
    const controller = new AbortController();

    const result = await runAgent(
      input({
        llm: failing(),
        trace,
        signal: controller.signal,
        ask: () => {
          controller.abort();
          return Promise.reject(new Error("the prompt was closed under us"));
        },
      }),
    );

    expect(result.status).toBe("cancelled");
    expect(kinds(trace)).not.toContain("terminate");
  });

  it("still records the escalation itself, so the cancellation is not invisible", async () => {
    const trace = createTrace();

    await runAgent(input({ llm: failing(), trace, ask: async () => "decline" }));

    expect(kinds(trace)).toContain("guard_escalation");
  });
});
