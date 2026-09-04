import { describe, expect, it } from "../helpers/bun-test.ts";
import { recordingLogger } from "../helpers/recording-logger.ts";
import {
  admissionStateLogger,
  createModelCallAdmissionController,
  ModelCallStuckError,
  withModelCallAdmission,
  withTransportRetry,
} from "../../src/index.ts";
import { classifyProviderError } from "../../src/classify-provider-error.ts";
import { toProviderError } from "../../src/ai-sdk/errors.ts";
import { createBoundedFetch } from "../../src/ai-sdk/bounded-fetch.ts";
import { buildRequestOptions } from "../../src/ai-sdk/request-options.ts";
import { ProviderError, type LLMCallParams } from "@clarvis/capability";
import { APICallError, type ModelMessage } from "ai";

function params(over: Partial<LLMCallParams> = {}): LLMCallParams {
  return {
    provider: "acme",
    model: "acme/model",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    ...over,
  };
}

describe("llm.retry.gave_up", () => {
  const transient = (over: Partial<ConstructorParameters<typeof ProviderError>[1]> = {}) =>
    new ProviderError("boom", { kind: "transient", ...over });

  const retry = (
    inner: () => Promise<never>,
    log: ReturnType<typeof recordingLogger>,
    over: Partial<LLMCallParams> = {},
    maxRetries = 2,
  ) =>
    withTransportRetry(
      { call: inner },
      { maxRetries, baseDelayMs: 0, maxDelayMs: 0, maxRetryAfterMs: 10, logger: log.logger },
    ).call(params(over));

  it("reports a non-transient failure as never having been retryable", async () => {
    const log = recordingLogger();
    await expect(
      retry(() => Promise.reject(new ProviderError("nope", { kind: "auth", status: 401 })), log),
    ).rejects.toThrow("nope");

    expect(log.one("llm.retry.gave_up").fields).toMatchObject({
      reason: "non_transient",
      attempt: 0,
      max_retries: 2,
      kind: "auth",
      status: 401,
      lost_input_tokens: 0,
      lost_output_tokens: 0,
    });
  });

  it("reports an exhausted budget, and the tokens the attempts burned", async () => {
    const log = recordingLogger();
    await expect(
      retry(
        () =>
          Promise.reject(
            transient({
              partialUsage: {
                input_tokens: 10,
                output_tokens: 4,
                cached_tokens: 0,
                cache_write_tokens: 0,
              },
            }),
          ),
        log,
        {},
        2,
      ),
    ).rejects.toThrow("boom");

    expect(log.of("llm.retry.scheduled")).toHaveLength(2);
    expect(log.one("llm.retry.gave_up").fields).toMatchObject({
      reason: "exhausted",
      attempt: 2,
      lost_input_tokens: 30,
      lost_output_tokens: 12,
    });
  });

  it("reports a stream that had already reached a consumer", async () => {
    const log = recordingLogger();
    await expect(
      retry(() => Promise.reject(transient({ streamStarted: true })), log, {
        onStreamDelta: () => {},
      }),
    ).rejects.toThrow("boom");

    expect(log.one("llm.retry.gave_up").fields.reason).toBe("stream_started");
  });

  it("reports a Retry-After the caller refuses to wait out", async () => {
    const log = recordingLogger();
    await expect(
      retry(() => Promise.reject(transient({ retryAfterMs: 90_000 })), log),
    ).rejects.toThrow("boom");

    expect(log.one("llm.retry.gave_up").fields.reason).toBe("retry_after_too_long");
  });

  it("reports an abort that arrived before the first attempt finished", async () => {
    const log = recordingLogger();
    const controller = new AbortController();
    controller.abort();
    await expect(
      retry(() => Promise.reject(transient()), log, { signal: controller.signal }),
    ).rejects.toThrow("boom");

    expect(log.one("llm.retry.gave_up").fields.reason).toBe("aborted");
  });

  it("reports an abort that landed during the backoff sleep", async () => {
    const log = recordingLogger();
    const controller = new AbortController();
    let calls = 0;
    const inner = (): Promise<never> => {
      calls += 1;
      if (calls === 1) setTimeout(() => controller.abort(), 5);
      return Promise.reject(transient());
    };
    const wrapped = withTransportRetry(
      { call: inner },
      { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 500, logger: log.logger },
    );

    await expect(wrapped.call(params({ signal: controller.signal }))).rejects.toThrow("boom");
    expect(calls).toBe(1);
    expect(log.one("llm.retry.gave_up").fields).toMatchObject({ reason: "aborted", attempt: 1 });
  });

  it("says nothing when there is no retry policy at all", async () => {
    const log = recordingLogger();
    const wrapped = withTransportRetry(
      { call: () => Promise.reject(transient()) },
      { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, logger: log.logger },
    );
    await expect(wrapped.call(params())).rejects.toThrow("boom");
    expect(log.events()).toEqual([]);
  });
});

describe("llm.admission.state", () => {
  const snapshot = (over: Record<string, unknown> = {}) => ({
    state: "open" as const,
    active: 1,
    queued: 0,
    quarantined: 0,
    maxActive: 4,
    maxQueued: 8,
    ...over,
  });

  it("emits once per transition, not once per snapshot", () => {
    const log = recordingLogger();
    const observe = admissionStateLogger(log.logger);

    observe(snapshot());
    observe(snapshot({ active: 2 }));
    observe(snapshot({ active: 3, queued: 1 }));
    observe(snapshot({ state: "quarantined", quarantined: 1 }));
    observe(snapshot({ state: "quarantined", quarantined: 1, active: 0 }));
    observe(snapshot({ state: "open" }));
    observe(snapshot({ state: "closed" }));

    expect(log.of("llm.admission.state").map((r) => r.fields.state)).toEqual([
      "open",
      "quarantined",
      "open",
      "closed",
    ]);
  });

  it("carries the whole snapshot in snake_case, at info", () => {
    const log = recordingLogger();
    admissionStateLogger(log.logger)(snapshot({ state: "quarantined", quarantined: 2, queued: 3 }));

    const record = log.one("llm.admission.state");
    expect(record.level).toBe("info");
    expect(record.fields).toEqual({
      event: "llm.admission.state",
      state: "quarantined",
      active: 1,
      queued: 3,
      quarantined: 2,
      max_active: 4,
      max_queued: 8,
    });
    expect(record.message).toContain("stopped admitting");
  });

  it("says the gate reopened when it goes back to open", () => {
    const log = recordingLogger();
    const observe = admissionStateLogger(log.logger);
    observe(snapshot({ state: "closed" }));
    observe(snapshot({ state: "open" }));
    expect(log.of("llm.admission.state").at(-1)!.message).toContain("admitting work again");
  });

  it("does not dedupe across two independent gates", () => {
    const log = recordingLogger();
    admissionStateLogger(log.logger)(snapshot());
    admissionStateLogger(log.logger)(snapshot());
    expect(log.of("llm.admission.state")).toHaveLength(2);
  });
});

describe("llm.admission.stuck", () => {
  it("warns when a cancelled transport will not settle", async () => {
    const log = recordingLogger();
    const controller = createModelCallAdmissionController({
      abortSettleMs: 0,
      logger: log.logger,
    });
    const abort = new AbortController();
    const provider = withModelCallAdmission({ call: () => new Promise(() => {}) }, controller);

    const pending = provider.call(params({ signal: abort.signal }));
    abort.abort();
    await expect(pending).rejects.toBeInstanceOf(ModelCallStuckError);

    expect(log.one("llm.admission.stuck").fields).toEqual({
      event: "llm.admission.stuck",
      settle_ms: 0,
      quarantined: 1,
    });
  });
});

describe("a provider error body that degrades the classification", () => {
  it("says so when the body is not JSON and is used whole instead", () => {
    const log = recordingLogger();
    const err = new APICallError({
      message: "request failed",
      url: "https://example.test/v1",
      requestBodyValues: {},
      statusCode: 400,
      responseBody: "not json at all",
    });
    toProviderError(err, {}, log.logger);
    expect(log.one("llm.error.body_unparsed").fields.body_chars).toBe("not json at all".length);
  });

  it("says so when the body cannot be stringified at all", () => {
    const log = recordingLogger();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const result = classifyProviderError({
      body: cyclic,
      cause: new Error("econnreset"),
      logger: log.logger,
    });

    expect(result.kind).toBe("transient");
    expect(log.one("llm.error.body_unstringifiable").message).toContain("classified without it");
  });

  it("stays silent, and does not throw, when no logger is supplied", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(classifyProviderError({ body: cyclic }).kind).toBe("client");
  });
});

describe("llm.transport.limit_exceeded", () => {
  const fetchOf = (response: Response): typeof globalThis.fetch =>
    (async () => response) as unknown as typeof globalThis.fetch;

  it("warns on a body whose declared length already exceeds the bound", async () => {
    const log = recordingLogger();
    const fetch = createBoundedFetch({
      fetch: fetchOf(new Response("x", { headers: { "content-length": "11" } })),
      maxResponseBytes: 10,
      logger: log.logger,
    });

    await expect(fetch("https://example.test")).rejects.toThrow();
    expect(log.one("llm.transport.limit_exceeded").fields).toMatchObject({
      limit: "response",
      max_bytes: 10,
      bytes_read: 0,
      declared_bytes: 11,
    });
  });

  it("warns on a streamed body that grows past the bound", async () => {
    const log = recordingLogger();
    const fetch = createBoundedFetch({
      fetch: fetchOf(new Response("12345678901")),
      maxResponseBytes: 10,
      logger: log.logger,
    });

    const response = await fetch("https://example.test");
    await expect(response.text()).rejects.toThrow();
    const record = log.one("llm.transport.limit_exceeded");
    expect(record.level).toBe("warn");
    expect(record.fields).toMatchObject({ limit: "response", max_bytes: 10, bytes_read: 11 });
  });

  it("warns on an SSE event that never reaches a delimiter", async () => {
    const log = recordingLogger();
    const fetch = createBoundedFetch({
      fetch: fetchOf(
        new Response("data: aaaaaaaaaaaaaaaa", {
          headers: { "content-type": "text/event-stream" },
        }),
      ),
      maxResponseBytes: 1_000,
      maxSseEventBytes: 4,
      logger: log.logger,
    });

    const response = await fetch("https://example.test");
    await expect(response.text()).rejects.toThrow();
    expect(log.one("llm.transport.limit_exceeded").fields).toMatchObject({
      limit: "sse_event",
      max_bytes: 4,
    });
  });
});

describe("the request diagnostics buildRequestOptions returns", () => {
  const conversation: ModelMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "one" },
    { role: "assistant", content: "two" },
    { role: "user", content: "three" },
  ];

  it("reports the anthropic path, its rolled breakpoint and its ttl", () => {
    const { diagnostics } = buildRequestOptions(
      params({
        providerConfig: { kind: "anthropic", apiKeyEnv: "K" },
        promptCacheTtl: "1h",
      }),
      conversation,
    );

    expect(diagnostics.cache).toEqual({
      kind: "anthropic",
      marked: "anthropic",
      requested_breakpoints: 0,
      applied_breakpoints: 1,
      walked_back: false,
      system_marked: true,
      cache_key_sent: false,
      /* Anthropic keys its cache on the prefix and has no backend to pin. */
      session_pinned: false,
      ttl: "1h",
    });
  });

  it("reports both compatible breakpoints when both land where they were asked for", () => {
    const { diagnostics } = buildRequestOptions(
      params({
        providerConfig: { kind: "openai-compatible", promptCache: "explicit" },
        cacheBreakpoints: [1, 3],
        promptCacheKey: "session-1",
      }),
      conversation,
    );

    expect(diagnostics.cache).toMatchObject({
      kind: "openai-compatible",
      mode: "explicit",
      marked: "compatible",
      requested_breakpoints: 2,
      applied_breakpoints: 2,
      walked_back: false,
      system_marked: true,
      cache_key_sent: true,
    });
  });

  it("reports a breakpoint that walked back to an earlier message", () => {
    const withToolTurn: ModelMessage[] = [
      { role: "user", content: "one" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "1", toolName: "t", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "1",
            toolName: "t",
            output: { type: "text", value: "r" },
          },
        ],
      },
    ];
    const { diagnostics } = buildRequestOptions(
      params({
        providerConfig: { kind: "openai-compatible", promptCache: "explicit" },
        cacheBreakpoints: [2],
      }),
      withToolTurn,
    );

    expect(diagnostics.cache).toMatchObject({
      marked: "compatible",
      requested_breakpoints: 1,
      applied_breakpoints: 1,
      walked_back: true,
      system_marked: false,
    });
  });

  it("reports nothing marked on a provider with no explicit breakpoints", () => {
    const { diagnostics } = buildRequestOptions(
      params({ providerConfig: { kind: "openai" }, cacheBreakpoints: [1], promptCacheKey: "k" }),
      conversation,
    );

    expect(diagnostics.cache).toMatchObject({
      kind: "openai",
      marked: "none",
      requested_breakpoints: 1,
      applied_breakpoints: 0,
      walked_back: false,
      cache_key_sent: true,
    });
  });

  it("reports native OpenAI as provider-managed even when generic settings say explicit", () => {
    const { diagnostics } = buildRequestOptions(
      params({
        providerConfig: { kind: "openai-codex", promptCache: "explicit" },
        cacheBreakpoints: [1, 3],
        promptCacheKey: "k",
      }),
      conversation,
    );

    expect(diagnostics.cache).toMatchObject({
      kind: "openai-codex",
      mode: "explicit",
      marked: "none",
      requested_breakpoints: 2,
      applied_breakpoints: 0,
      walked_back: false,
      system_marked: false,
      cache_key_sent: true,
      session_pinned: false,
    });
  });

  it("reports no kind or mode at all when the call has no resolved provider", () => {
    const { diagnostics } = buildRequestOptions(params({ promptCacheKey: "k" }), conversation);
    expect(diagnostics.cache).toEqual({
      marked: "none",
      requested_breakpoints: 0,
      applied_breakpoints: 0,
      walked_back: false,
      system_marked: false,
      cache_key_sent: false,
      session_pinned: false,
    });
  });

  it("reports zero applied when every requested index is unusable", () => {
    const { diagnostics } = buildRequestOptions(
      params({
        providerConfig: { kind: "anthropic" },
        cacheBreakpoints: [0],
      }),
      [{ role: "system", content: "system" }],
    );

    expect(diagnostics.cache).toMatchObject({
      marked: "anthropic",
      requested_breakpoints: 1,
      applied_breakpoints: 0,
    });
  });

  it("reports each reasoning path the tuning could have taken", () => {
    const pathOf = (over: Partial<LLMCallParams>): unknown =>
      buildRequestOptions(params({ reasoningEffort: "high", ...over }), conversation).diagnostics
        .tuning.reasoning_path;

    expect(pathOf({ providerConfig: { kind: "openai" } })).toBe("openai");
    expect(pathOf({ providerConfig: { kind: "openai-compatible" } })).toBe("compatible");
    expect(pathOf({ providerConfig: { kind: "google" } })).toBe("standard");
    expect(pathOf({ providerConfig: { kind: "anthropic" } })).toBe("standard");
    expect(pathOf({ providerConfig: { kind: "anthropic" }, reasoningEffort: "max" })).toBe(
      "anthropic_max",
    );
    expect(
      buildRequestOptions(params({ providerConfig: { kind: "openai" } }), conversation).diagnostics
        .tuning.reasoning_path,
    ).toBeUndefined();
  });

  it("reports the thinking floor that raised the output cap", () => {
    const { diagnostics, request } = buildRequestOptions(
      params({
        providerConfig: { kind: "anthropic" },
        reasoningEffort: "high",
        maxOutputTokens: 16,
      }),
      conversation,
    );

    expect(diagnostics.tuning.thinking_floor).toBeGreaterThan(16);
    expect(diagnostics.tuning.max_output_tokens).toBe(request.maxOutputTokens);
    expect(diagnostics.tuning.reasoning).toBe("high");
  });
});
