import { describe, expect, it } from "bun:test";
import {
  ProviderError,
  ModelCallInactivityError,
  type LLMCallParams,
  type LLMCallResult,
} from "@clarvis/capability";
import { createTrace, mapTrace } from "@clarvis/trace";
import {
  callReviewerWithTrace,
  guardReviewerModelCallProjector,
  reviewerFailureKind,
} from "../../src/guard/reviewer-trace.ts";
import { createPersistedTraceProjectorRegistry } from "@clarvis/capability";

const params = (over: Partial<LLMCallParams> = {}): LLMCallParams => ({
  model: "review-model",
  provider: "anthropic",
  providerConfig: { kind: "anthropic" },
  messages: [{ role: "user", content: "secret prompt" }],
  tools: [],
  ...over,
});

const result = (over: Partial<LLMCallResult> = {}): LLMCallResult => ({
  usage: { input_tokens: 10, output_tokens: 2, cached_tokens: 5, cache_write_tokens: 1 },
  ...over,
});

const identity = {
  path: "effect_review" as const,
  consumer: "configure_clarvis" as const,
  stage: "compile" as const,
  authority_revision: 3,
  effect_id: "clarvis.authoring.write",
  failureKind: (error: unknown) => reviewerFailureKind(error),
};

function event(trace: ReturnType<typeof createTrace>) {
  return mapTrace(
    trace.entries(),
    1_000,
    createPersistedTraceProjectorRegistry([guardReviewerModelCallProjector]),
  ).events[0] as Record<string, unknown>;
}

describe("guard reviewer model-call trace", () => {
  it("classifies the shared inactivity error without a Judge-specific abort signal", () => {
    const error = new ModelCallInactivityError(180000, true);
    expect(reviewerFailureKind(error)).toBe("timeout");
    const controller = new AbortController();
    controller.abort();
    expect(reviewerFailureKind(error, controller.signal)).toBe("cancelled");
    expect(reviewerFailureKind(new Error("reviewer call retired"))).toBe("unknown");
  });
  it("projects complete usage, retry charges, cache ratio, and subscription billing", async () => {
    const trace = createTrace(0);
    await callReviewerWithTrace(
      {
        async call(call) {
          call.onRetry?.({
            attempt: 1,
            maxRetries: 1,
            delayMs: 0,
            kind: "transient",
            message: "retry",
          });
          return result({
            billing_source: "subscription",
            retriedUsage: {
              input_tokens: 4,
              output_tokens: 1,
              cached_tokens: 2,
              cache_write_tokens: 0,
            },
          });
        },
      },
      params(),
      { ...identity, trace },
    );
    expect(event(trace)).toMatchObject({
      type: "guard_reviewer_model_call",
      status: "completed",
      attempts: 2,
      input_tokens: 14,
      output_tokens: 3,
      cached_tokens: 7,
      cache_write_tokens: 1,
      cache_read_ratio: 0.5,
      billing_source: "subscription",
    });
  });

  it("keeps cache completeness unknown instead of presenting zero percent", async () => {
    const trace = createTrace(0);
    await callReviewerWithTrace(
      { call: async () => result({ cacheUsageKnown: false }) },
      params(),
      { ...identity, trace },
    );
    expect(event(trace)).toMatchObject({ cache_unknown: true });
    expect(event(trace)).not.toHaveProperty("cache_read_ratio");
  });

  it("uses accumulated provider usage on failure and rethrows the original error", async () => {
    const trace = createTrace(0);
    const error = new ProviderError("private provider error", { kind: "quota" });
    error.accumulatedUsage = {
      input_tokens: 8,
      output_tokens: 1,
      cached_tokens: 3,
      cache_write_tokens: 0,
    };
    await expect(
      callReviewerWithTrace({ call: async () => Promise.reject(error) }, params(), {
        ...identity,
        trace,
      }),
    ).rejects.toBe(error);
    expect(event(trace)).toMatchObject({
      status: "failed",
      failure_kind: "quota",
      input_tokens: 8,
      cached_tokens: 3,
      cache_read_ratio: 3 / 8,
    });
  });

  it("marks unattributed failure usage and cache as unknown", async () => {
    const trace = createTrace(0);
    await expect(
      callReviewerWithTrace({ call: async () => Promise.reject(new Error("secret")) }, params(), {
        ...identity,
        trace,
      }),
    ).rejects.toThrow("secret");
    expect(event(trace)).toMatchObject({
      status: "failed",
      input_tokens: 0,
      output_tokens: 0,
      usage_unknown: true,
      cache_unknown: true,
    });
  });

  it("records cancellation once and ignores late provider settlement", async () => {
    const trace = createTrace(0);
    const controller = new AbortController();
    let settle!: (value: LLMCallResult) => void;
    const pending = new Promise<LLMCallResult>((resolve) => {
      settle = resolve;
    });
    const called = callReviewerWithTrace(
      { call: async () => pending },
      params({ signal: controller.signal }),
      {
        ...identity,
        trace,
        failureKind: (error) => reviewerFailureKind(error, controller.signal),
      },
    );
    controller.abort();
    await expect(called).rejects.toThrow();
    settle(result());
    await Promise.resolve();
    expect(trace.entries()).toHaveLength(1);
    expect(event(trace)).toMatchObject({ status: "failed", failure_kind: "cancelled" });
  });

  it("never persists request or provider payloads", async () => {
    const trace = createTrace(0);
    await callReviewerWithTrace(
      { call: async () => result({ text: "secret response", reasoning: "secret reason" }) },
      params(),
      { ...identity, trace },
    );
    const serialized = JSON.stringify(event(trace));
    for (const forbidden of [
      "secret prompt",
      "secret response",
      "secret reason",
      "messages",
      "tools",
    ])
      expect(serialized).not.toContain(forbidden);
  });
});
