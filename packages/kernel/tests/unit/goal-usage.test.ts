import { describe, expect, test } from "bun:test";
import { goalNetTokens } from "@clarvis/goal";
import { ProviderError, type LLMCallParams, type LLMCallResult } from "@clarvis/capability";
import type { PerAgentUsage, RunUsage } from "@clarvis/protocol";
import { createGoalUsageTracker, measureGoalRunUsage } from "../../src/goals/usage.ts";

const callParams: LLMCallParams = { model: "model", provider: "fixture", messages: [], tools: [] };
const measured = { input_tokens: 100, output_tokens: 10, cached_tokens: 80, cache_write_tokens: 0 };

describe("host goal inference accounting", () => {
  test("counts observed child, auxiliary and retry usage once and preserves the response and input ports", async () => {
    const tracker = createGoalUsageTracker();
    const response: LLMCallResult = { text: "Done", usage: measured, retriedUsage: measured };
    const wrapped = tracker.wrap({
      async call(params) {
        expect(params).toBe(callParams);
        return response;
      },
    });
    expect(await wrapped.call(callParams)).toBe(response);
    await Promise.all([wrapped.call(callParams), wrapped.call(callParams)]);
    expect(tracker.measure()).toEqual({ kind: "measured", input: 600, output: 60, cached: 480 });
  });

  test("holds pending or rejected calls unknown and accepts a provider's explicit measured zero", async () => {
    const tracker = createGoalUsageTracker();
    const result = Promise.withResolvers<LLMCallResult>();
    const pending = tracker.wrap({ call: () => result.promise }).call(callParams);
    expect(tracker.measure()).toEqual({ kind: "unknown" });
    result.resolve({ usage: { ...measured, input_tokens: 0, output_tokens: 0, cached_tokens: 0 } });
    await pending;
    expect(tracker.measure()).toEqual({ kind: "measured", input: 0, output: 0, cached: 0 });
    const error = new Error("cancelled without provider telemetry");
    await expect(
      tracker
        .wrap({
          async call() {
            throw error;
          },
        })
        .call(callParams),
    ).rejects.toBe(error);
    expect(tracker.measure()).toEqual({ kind: "unknown" });
  });

  test("keeps missing cache conservative and missing total usage unknown through success or failure", async () => {
    const tracker = createGoalUsageTracker();
    await tracker
      .wrap({
        async call() {
          return { usage: { ...measured, cached_tokens: 0, cache_unknown: true } };
        },
      })
      .call(callParams);
    expect(tracker.measure()).toEqual({ kind: "measured", input: 100, output: 10 });
    const error = new ProviderError("interrupted", { partialUsage: measured });
    error.accumulatedUsage = { ...measured, usage_unknown: true };
    await expect(
      tracker
        .wrap({
          async call() {
            throw error;
          },
        })
        .call(callParams),
    ).rejects.toBe(error);
    expect(tracker.measure()).toEqual({ kind: "unknown" });
    const success = createGoalUsageTracker();
    await success
      .wrap({
        async call() {
          return { usage: measured, retriedUsage: { ...measured, usage_unknown: true } };
        },
      })
      .call(callParams);
    expect(success.measure()).toEqual({ kind: "unknown" });
  });
});

const agent = (
  role: PerAgentUsage["role"],
  input: number,
  output: number,
  cached: number,
): PerAgentUsage => ({
  role,
  model: "test/model",
  input_tokens: input,
  output_tokens: output,
  cached_tokens: cached,
  cache_write_tokens: 999,
});
const sample = (partial: Partial<RunUsage>): RunUsage => ({
  iterations: 2,
  elapsed_ms: 10,
  ...partial,
});

describe("goal run usage normalization", () => {
  test("counts the lead, children and attributed auxiliary usage once without adding aggregate duplicates", () => {
    const usage = sample({
      input_tokens: 1600,
      output_tokens: 170,
      cached_tokens: 950,
      by_agent: [
        agent("lead", 1000, 100, 800),
        agent("subagent", 500, 50, 100),
        agent("vision", 100, 20, 50),
      ],
    });
    const measured = measureGoalRunUsage(usage);
    expect(measured).toEqual({ kind: "measured", input: 1600, output: 170, cached: 950 });
    expect(goalNetTokens(measured)).toBe(820);
    expect(measureGoalRunUsage({ ...usage, by_agent: undefined })).toEqual(measured);
  });

  test("preserves unknown cache detail as a conservative estimate", () => {
    const measured = measureGoalRunUsage(sample({ input_tokens: 1000, output_tokens: 100 }));
    expect(measured).toEqual({ kind: "measured", input: 1000, output: 100 });
    expect(goalNetTokens(measured)).toBe(1100);
    const missing = {
      ...agent("subagent", 50, 5, 0),
      cached_tokens: undefined,
    } as unknown as PerAgentUsage;
    expect(
      measureGoalRunUsage(sample({ by_agent: [agent("lead", 100, 10, 90), missing] })),
    ).toEqual({ kind: "measured", input: 150, output: 15 });
    expect(
      measureGoalRunUsage(
        sample({ by_agent: [{ ...missing, input_tokens: 0 }, agent("lead", 100, 10, 90)] }),
      ),
    ).toEqual({ kind: "measured", input: 100, output: 15, cached: 90 });
  });

  test.each([
    undefined,
    sample({}),
    sample({ input_tokens: 100 }),
    sample({ output_tokens: 10 }),
    sample({ by_agent: [] }),
    sample({ input_tokens: 10, output_tokens: 0, cached_tokens: 11 }),
    sample({ input_tokens: -1, output_tokens: 0 }),
    sample({ input_tokens: 10.5, output_tokens: 0 }),
    sample({ input_tokens: Infinity, output_tokens: 0 }),
    sample({ by_agent: [agent("lead", 10, 1, 11)] }),
    sample({
      by_agent: [agent("lead", Number.MAX_SAFE_INTEGER - 1, 1, 0), agent("subagent", 100, 1, 0)],
    }),
  ])("does not turn absent, partial or invalid total usage into measured zero: %j", (usage) => {
    expect(measureGoalRunUsage(usage)).toEqual({ kind: "unknown" });
    expect(goalNetTokens(measureGoalRunUsage(usage))).toBeUndefined();
  });

  test("accepts explicitly measured zero while keeping physical cancellation separate from accounting", () => {
    expect(
      measureGoalRunUsage(sample({ input_tokens: 0, output_tokens: 0, cached_tokens: 0 })),
    ).toEqual({ kind: "measured", input: 0, output: 0, cached: 0 });
    const cancelledUsage = sample({ input_tokens: 400, output_tokens: 12, cached_tokens: 200 });
    expect(goalNetTokens(measureGoalRunUsage(cancelledUsage))).toBe(212);
  });
});
