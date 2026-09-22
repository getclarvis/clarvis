import { loadEnv } from "@clarvis/capability";
import type { ExecuteRunDeps } from "@clarvis/loop";
import { createKernelGoalAgentRuntime } from "../../src/goals/agent-runtime.ts";
import { expect, it } from "bun:test";
import type { LLMProvider } from "@clarvis/capability";
import type { SessionTotals } from "@clarvis/protocol";
import { addGoalAuxiliaryUsage, createGoalUsageTracker } from "../../src/goals/usage.ts";

it("retains model attribution and prices retries exactly once in auxiliary settlement", async () => {
  const tracker = createGoalUsageTracker();
  const usage = { input_tokens: 100, output_tokens: 20, cached_tokens: 60, cache_write_tokens: 10 };
  const provider: LLMProvider = {
    call: async () => ({ text: "Done", usage, retriedUsage: usage }),
  };
  await tracker
    .wrap(provider)
    .call({ provider: "fixture", model: "model", messages: [], tools: [] });
  const totals: SessionTotals = { input: 0, output: 0, cached: 0 };
  addGoalAuxiliaryUsage(totals, tracker.measure(), tracker.accounting(), () => ({
    input: 1,
    output: 2,
    cache_read: 0.1,
    cache_write: 1.25,
  }));
  expect(totals).toMatchObject({ input: 200, output: 40, cached: 120 });
  expect(totals.cost_usd).toBeCloseTo(0.000197, 10);
  expect(tracker.accounting().map((row) => row.model)).toEqual(["fixture/model", "fixture/model"]);
});

it("keeps the provider's own figures and carries its uncertainty as a gap", async () => {
  for (const missing of ["usage", "cache"] as const) {
    const tracker = createGoalUsageTracker();
    const provider: LLMProvider = {
      call: async () => ({
        text: "Done",
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cached_tokens: 0,
          cache_write_tokens: 0,
          ...(missing === "usage" ? { usage_unknown: true } : { cache_unknown: true }),
        },
      }),
    };
    await tracker
      .wrap(provider)
      .call({ provider: "fixture", model: "model", messages: [], tools: [] });
    expect(tracker.measure()).toEqual(
      missing === "usage"
        ? {
            kind: "partial",
            input: 100,
            output: 20,
            cached: 0,
            gaps: [expect.objectContaining({ cause: "provider_unknown", calls: 1 })],
          }
        : { kind: "complete", input: 100, output: 20 },
    );
    const totals: SessionTotals = { input: 0, output: 0, cached: 0 };
    addGoalAuxiliaryUsage(totals, tracker.measure(), tracker.accounting(), () => ({
      input: 1,
      output: 2,
    }));
    // A flagged usage still carries the provider's own figures, and a partial one is charged:
    // the gap is what the operator has to accept, not a reason to discard the subtotal.
    expect(totals.input).toBe(100);
    expect(totals.output).toBe(20);
    if (missing === "usage") {
      // The subtotal was credited even though the provider flagged it, and pricing still worked
      // because the cache split was known.
      expect(totals.cost_usd).toBeDefined();
    } else {
      // An unknown cache split leaves the price uncomputable without inventing a cache miss.
      expect(totals.cost_usd).toBeUndefined();
    }
  }
});

it("formulation uses provider uncertainty instead of zero-initialized loop totals", async () => {
  const runtime = createKernelGoalAgentRuntime({
    owner: "fixture",
    model: "fixture/model",
    providers: [],
    deps: {
      env: loadEnv({}),
      capabilities: [
        { name: "tools", forRun: () => null },
        {
          name: "judge",
          required: true,
          forRun: () => {
            throw new Error("Goal formulation must not instantiate Judge");
          },
        },
      ],
      llm: {
        call: async () => ({
          text: "Done",
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cached_tokens: 0,
            cache_write_tokens: 0,
            usage_unknown: true,
          },
        }),
      },
    } as unknown as ExecuteRunDeps,
    executeRun: async (args) => {
      expect(args.deps.capabilities?.map((capability) => capability.name)).toEqual(["tools"]);
      await args.deps.llm.call({ provider: "fixture", model: "model", messages: [], tools: [] });
      return {
        executionId: "formulation",
        response: {
          status: "completed",
          result: {
            status: "insufficient_context",
            question: "Which result?",
            reason: "Need a target",
          },
          usage: { iterations_used: 1, elapsed_ms: 1, by_agent: [] },
        },
      };
    },
  });
  const result = await runtime.run({
    mode: "guided",
    seed: "Investigate",
    execution_id: "formulation",
    agent_instance_id: "agent",
    session_id: "session",
    trajectory: {
      projection: "{}",
      digest: "a".repeat(64),
      truncated: false,
      source_execution_ids: [],
      workspace_read_available: false,
    },
  });
  // The provider never reported a figure, so there is no subtotal to keep: an all-zero flagged
  // object is an absence, not a measurement, and the loop's zero-initialized totals are not used
  // as a substitute for one.
  expect(result.usage).toEqual({ kind: "unknown" });
});
