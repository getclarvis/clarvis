import { describe, it, expect } from "../bun-test.ts";
import {
  cacheReadRatio,
  recordIterationMetrics,
} from "../../src/runtime/loop/iteration-metrics.ts";
import { createTrace } from "@clarvis/trace";
import { createTokenLedger } from "../../src/runtime/budget/index.ts";
import type { LeadIterationDetail, SubagentIterationDetail } from "@clarvis/capability";

describe("cacheReadRatio", () => {
  // The denominator is input_tokens alone because every @ai-sdk/* adapter
  // normalizes it to the FULL prompt size (see the Anthropic 3 + 5 + 7 = 15
  // assertion in ai-sdk-adapter.test.ts). Dividing by cached + input instead
  // would report 0.25 here and could never exceed 0.5.
  it("divides cache reads by the full prompt size", () => {
    expect(
      cacheReadRatio({
        input_tokens: 100,
        output_tokens: 4,
        cached_tokens: 80,
        cache_write_tokens: 0,
      }),
    ).toBe(0.8);
  });

  it("reports a fully cached prompt as 1, not 0.5", () => {
    expect(
      cacheReadRatio({
        input_tokens: 40,
        output_tokens: 1,
        cached_tokens: 40,
        cache_write_tokens: 0,
      }),
    ).toBe(1);
  });

  it("is 0 when the call reported no input tokens", () => {
    expect(
      cacheReadRatio({
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        cache_write_tokens: 0,
      }),
    ).toBe(0);
  });
});

describe("recordIterationMetrics cache health", () => {
  it("emits cache_read_ratio and cache_write_tokens on a lead iteration", () => {
    const trace = createTrace();
    recordIterationMetrics({
      llmResult: {
        text: "hi",
        textParts: [{ text: "hi", phase: "commentary" }],
        usage: {
          input_tokens: 200,
          output_tokens: 10,
          cached_tokens: 150,
          cache_write_tokens: 30,
        },
      },
      ledger: createTokenLedger(1_000_000),
      usage: { input: 0, output: 0, cached: 0, cache_write: 0 },
      trace,
      agent: "lead",
      iteration: 1,
      iterStart: 0,
      model: "m",
    });
    const detail = trace.entries().find((e) => e.kind === "lead_iteration")!
      .detail as LeadIterationDetail;
    expect(detail.cache_write_tokens).toBe(30);
    expect(detail.cache_read_ratio).toBe(0.75);
    expect(detail.response_phase).toBe("commentary");
  });

  it("emits both on a subagent iteration", () => {
    const trace = createTrace();
    recordIterationMetrics({
      llmResult: {
        text: "hi",
        usage: { input_tokens: 50, output_tokens: 5, cached_tokens: 0, cache_write_tokens: 50 },
      },
      ledger: createTokenLedger(1_000_000),
      usage: { input: 0, output: 0, cached: 0, cache_write: 0 },
      trace,
      agent: "subagent",
      subagentInstanceId: "w1",
      iteration: 1,
      iterStart: 0,
      model: "m",
    });
    const detail = trace.entries().find((e) => e.kind === "subagent_iteration")!
      .detail as SubagentIterationDetail;
    expect(detail.cache_write_tokens).toBe(50);
    expect(detail.cache_read_ratio).toBe(0);
  });
});

describe("recordIterationMetrics reasoning", () => {
  it("records model_reasoning with a subagent_instance_id when reasoning is present", () => {
    const trace = createTrace();
    recordIterationMetrics({
      llmResult: {
        text: "hi",
        usage: { input_tokens: 3, output_tokens: 2, cached_tokens: 1, cache_write_tokens: 0 },
        reasoning: "thinking",
      },
      ledger: createTokenLedger(1_000_000),
      usage: { input: 0, output: 0, cached: 0, cache_write: 0 },
      trace,
      agent: "subagent",
      subagentInstanceId: "w1",
      iteration: 1,
      iterStart: 0,
      model: "m",
    });
    const entry = trace.entries().find((e) => e.kind === "model_reasoning");
    expect(entry).toBeDefined();
    expect((entry!.detail as { subagent_instance_id?: string }).subagent_instance_id).toBe("w1");
  });

  it("records model_reasoning without a subagent_instance_id for the lead", () => {
    const trace = createTrace();
    recordIterationMetrics({
      llmResult: {
        text: "hi",
        usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cache_write_tokens: 0 },
        reasoning: "thinking",
      },
      ledger: createTokenLedger(1_000_000),
      usage: { input: 0, output: 0, cached: 0, cache_write: 0 },
      trace,
      agent: "lead",
      iteration: 2,
      iterStart: 0,
      model: "m",
    });
    const entry = trace.entries().find((e) => e.kind === "model_reasoning");
    expect(
      (entry!.detail as { subagent_instance_id?: string }).subagent_instance_id,
    ).toBeUndefined();
  });
});

describe("recordIterationMetrics — retried attempts reach the ledger", () => {
  const usageOf = (input: number, output: number) => ({
    input_tokens: input,
    output_tokens: output,
    cached_tokens: 0,
    cache_write_tokens: 0,
  });

  it("charges the failed attempts alongside the winning one", () => {
    const ledger = createTokenLedger(1_000_000);
    const acc = { input: 0, output: 0, cached: 0, cache_write: 0 };
    recordIterationMetrics({
      llmResult: { text: "hi", usage: usageOf(100, 10), retriedUsage: usageOf(200, 5) },
      ledger,
      usage: acc,
      trace: createTrace(),
      agent: "lead",
      iteration: 1,
      iterStart: 0,
      model: "m",
    });

    expect(ledger.consumed()).toBe(315);
    expect(acc.input).toBe(300);
    expect(acc.output).toBe(15);
  });

  /**
   * The iteration event reports what the model produced. Folding a call that
   * produced nothing into its `input_tokens` would make the per-iteration trace
   * lie about the turn; the spend belongs in the ledger and the run totals.
   */
  it("leaves the recorded iteration event describing the winning attempt only", () => {
    const trace = createTrace();
    recordIterationMetrics({
      llmResult: { text: "hi", usage: usageOf(100, 10), retriedUsage: usageOf(200, 5) },
      ledger: createTokenLedger(1_000_000),
      usage: { input: 0, output: 0, cached: 0, cache_write: 0 },
      trace,
      agent: "lead",
      iteration: 1,
      iterStart: 0,
      model: "m",
    });

    const detail = trace.entries().find((e) => e.kind === "lead_iteration")!
      .detail as LeadIterationDetail;
    expect(detail.input_tokens).toBe(100);
    expect(detail.output_tokens).toBe(10);
  });

  it("is unchanged when no attempt was retried", () => {
    const ledger = createTokenLedger(1_000_000);
    recordIterationMetrics({
      llmResult: { text: "hi", usage: usageOf(100, 10) },
      ledger,
      usage: { input: 0, output: 0, cached: 0, cache_write: 0 },
      trace: createTrace(),
      agent: "lead",
      iteration: 1,
      iterStart: 0,
      model: "m",
    });
    expect(ledger.consumed()).toBe(110);
  });
});
