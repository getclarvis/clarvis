import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import { withTransportRetry } from "@clarvis/llm";
import { ProviderError } from "@clarvis/capability";
import type { TraceEvent } from "@clarvis/capability";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const BODY = {
  messages: [{ role: "user", content: "hi" }],
  servers: [],
  profiles: [{ name: "solo", model: "anthropic/claude-sonnet-4-5", tools: [], iteration_limit: 5 }],
  entry: "solo",
  budget: { on_exceed: "stop", total_token_limit: 10000, timeout_ms: 30000 },
};

const overloaded = (retryAfterMs?: number): ProviderError =>
  new ProviderError("overloaded", {
    kind: "transient",
    status: 529,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });

const retrying = (inner: MockLLM) =>
  withTransportRetry(inner, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5, maxRetryAfterMs: 50 });

describe("provider retries are visible in the trace", () => {
  it("records one model_call_retry per retry and no model_call_error on success", async () => {
    const events: TraceEvent[] = [];
    const llm = new MockLLM({
      script: [
        { throw: overloaded() },
        { throw: overloaded() },
        { text: "done", usage: { input_tokens: 10, output_tokens: 4 } },
      ],
    });
    harness = await makeHarness({
      llm: retrying(llm),
      mcpFactory: mockMCPFactory({}),
      onEvent: (e) => events.push(e),
    });

    const res = await harness.run(BODY);
    expect(res.status).toBe("completed");

    const retries = events.filter((e) => e.type === "model_call_retry");
    expect(retries.map((r) => (r as { attempt: number }).attempt)).toEqual([1, 2]);
    expect(events.filter((e) => e.type === "model_call_error")).toHaveLength(0);

    const first = retries[0] as Extract<TraceEvent, { type: "model_call_retry" }>;
    expect(first.max_retries).toBe(3);
    expect(first.status).toBe(529);
    expect(first.kind).toBe("transient");
    expect(first.model).toBe("claude-sonnet-4-5");
    expect(first.delay_ms).toBeGreaterThan(0);
  });

  it("persists the retry events into the run's record", async () => {
    const llm = new MockLLM({
      script: [{ throw: overloaded() }, { text: "done", usage: { input_tokens: 10 } }],
    });
    harness = await makeHarness({ llm: retrying(llm), mcpFactory: mockMCPFactory({}) });

    const res = await harness.run(BODY);
    const detail = await harness.getRun(res.execution_id);
    const retries = (detail?.trace.events ?? []).filter((e) => e.type === "model_call_retry");

    expect(retries).toHaveLength(1);
  });

  it("carries a server-advised Retry-After through to the recorded delay", async () => {
    const events: TraceEvent[] = [];
    const llm = new MockLLM({
      script: [{ throw: overloaded(40) }, { text: "done", usage: { input_tokens: 1 } }],
    });
    harness = await makeHarness({
      llm: retrying(llm),
      mcpFactory: mockMCPFactory({}),
      onEvent: (e) => events.push(e),
    });

    await harness.run(BODY);
    const retry = events.find((e) => e.type === "model_call_retry") as Extract<
      TraceEvent,
      { type: "model_call_retry" }
    >;
    expect(retry.retry_after_ms).toBe(40);
    expect(retry.delay_ms).toBe(40);
  });

  it("records the retries that preceded a failure that never recovered", async () => {
    const events: TraceEvent[] = [];
    const llm = new MockLLM({
      script: [
        { throw: overloaded() },
        { throw: overloaded() },
        { throw: overloaded() },
        { throw: overloaded() },
      ],
    });
    harness = await makeHarness({
      llm: retrying(llm),
      mcpFactory: mockMCPFactory({}),
      onEvent: (e) => events.push(e),
    });

    const res = await harness.run(BODY);
    expect(res.status).toBe("error");
    expect(events.filter((e) => e.type === "model_call_retry")).toHaveLength(3);
    expect(events.filter((e) => e.type === "model_call_error")).toHaveLength(1);
  });
});

describe("retried attempts are charged to the run's budget", () => {
  const billed = (input: number): ProviderError =>
    new ProviderError("overloaded", {
      kind: "transient",
      status: 529,
      partialUsage: {
        input_tokens: input,
        output_tokens: 0,
        cached_tokens: 0,
        cache_write_tokens: 0,
      },
    });

  it("includes the failed attempts' input tokens in the run's reported usage", async () => {
    const llm = new MockLLM({
      script: [
        { throw: billed(1000) },
        { throw: billed(1000) },
        { text: "done", usage: { input_tokens: 50, output_tokens: 5 } },
      ],
    });
    harness = await makeHarness({ llm: retrying(llm), mcpFactory: mockMCPFactory({}) });

    const res = await harness.run(BODY);
    expect(res.status).toBe("completed");

    const input = res.usage.by_agent.reduce((n, a) => n + a.input_tokens, 0);
    expect(input).toBe(2050);
  });

  it("charges what a never-recovered call burned before it gave up", async () => {
    const llm = new MockLLM({
      script: [billed(700), billed(700), billed(700), billed(700)].map((e) => ({ throw: e })),
    });
    harness = await makeHarness({ llm: retrying(llm), mcpFactory: mockMCPFactory({}) });

    const res = await harness.run(BODY);
    expect(res.status).toBe("error");

    const input = res.usage.by_agent.reduce((n, a) => n + a.input_tokens, 0);
    expect(input).toBe(2800);
  });
});
