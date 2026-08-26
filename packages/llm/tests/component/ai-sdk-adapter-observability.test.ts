import { afterEach, beforeEach, describe, expect, it, vi } from "../helpers/bun-test.ts";
import { recordingLogger } from "../helpers/recording-logger.ts";
import { AiSdkAdapter } from "@clarvis/llm/adapter";
import { ProviderError, type LLMCallParams } from "@clarvis/capability";

const mockGenerate = vi.fn();
const mockStream = vi.fn();

function rawResult(): unknown {
  return {
    text: "answer",
    toolCalls: [],
    reasoningText: undefined,
    usage: {
      inputTokens: 5,
      outputTokens: 3,
      inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  };
}

function params(over: Partial<LLMCallParams> = {}): LLMCallParams {
  return {
    provider: "acme",
    providerConfig: { kind: "openai-compatible", baseUrl: "https://endpoint.test/v1" },
    model: "acme/model",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    ...over,
  };
}

beforeEach(() => {
  mockGenerate.mockReset();
  mockStream.mockReset();
  mockGenerate.mockResolvedValue(rawResult() as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("llm.provider.resolved", () => {
  it("describes the resolved client without leaking a path, a query or a value", async () => {
    const log = recordingLogger();
    const adapter = new AiSdkAdapter({
      generateText: mockGenerate,
      logger: log.logger,
      resolveRegistryKey: (name) =>
        name === "ACME_KEY" ? "sk-real-secret" : name === "TENANT" ? "tenant-value" : undefined,
    });

    await adapter.call(
      params({
        providerConfig: {
          kind: "openai-compatible",
          baseUrl: "https://gw.test:8443/route/v1?token=sk-leak",
          apiKeyEnv: "ACME_KEY",
          headers: { "x-tenant": "${TENANT}" },
          promptCache: "explicit",
        },
      }),
    );

    const record = log.one("llm.provider.resolved");
    expect(record.level).toBe("debug");
    expect(record.fields).toEqual({
      event: "llm.provider.resolved",
      provider: "acme",
      model: "acme/model",
      kind: "openai-compatible",
      base_url: "gw.test:8443",
      api_key_env: "ACME_KEY",
      api_key_present: true,
      header_names: ["x-tenant"],
      prompt_cache: "explicit",
    });
    expect(JSON.stringify(record.fields)).not.toContain("sk-");
    expect(JSON.stringify(record.fields)).not.toContain("tenant-value");
    expect(JSON.stringify(record.fields)).not.toContain("/route/v1");
  });

  it("says so when a configured key variable resolves to nothing", async () => {
    const log = recordingLogger();
    const adapter = new AiSdkAdapter({
      generateText: mockGenerate,
      logger: log.logger,
      resolveRegistryKey: () => undefined,
    });

    await adapter.call(
      params({ providerConfig: { kind: "openai-compatible", baseUrl: "https://x.test" } }),
    );

    expect(log.one("llm.provider.resolved").fields).toMatchObject({
      api_key_present: false,
      header_names: [],
    });
    expect(log.one("llm.provider.resolved").fields).not.toHaveProperty("api_key_env");
    expect(log.one("llm.provider.resolved").fields).not.toHaveProperty("prompt_cache");
  });

  it("omits a base url it cannot parse rather than logging it raw", async () => {
    const log = recordingLogger();
    const adapter = new AiSdkAdapter({
      generateText: mockGenerate,
      logger: log.logger,
      resolveRegistryKey: () => "k",
    });

    await adapter.call(
      params({ providerConfig: { kind: "openai-compatible", baseUrl: "not a url" } }),
    );

    expect(log.one("llm.provider.resolved").fields).not.toHaveProperty("base_url");
  });

  it("omits base_url entirely when the provider configures none", async () => {
    const log = recordingLogger();
    const adapter = new AiSdkAdapter({
      generateText: mockGenerate,
      logger: log.logger,
      resolveRegistryKey: () => "k",
    });

    await adapter.call(params({ providerConfig: { kind: "openai", apiKeyEnv: "K" } }));

    expect(log.one("llm.provider.resolved").fields).not.toHaveProperty("base_url");
  });

  it("says it once per (provider, model), not once per call", async () => {
    const log = recordingLogger();
    const adapter = new AiSdkAdapter({
      generateText: mockGenerate,
      logger: log.logger,
      resolveRegistryKey: () => "k",
    });

    await adapter.call(params());
    await adapter.call(params());
    await adapter.call(params({ model: "acme/other" }));
    await adapter.call(params({ provider: "second" }));

    expect(
      log
        .of("llm.provider.resolved")
        .map((r) => `${String(r.fields.provider)}/${String(r.fields.model)}`),
    ).toEqual(["acme/acme/model", "acme/acme/other", "second/acme/model"]);
  });

  it("says nothing at all when the client could not be built", async () => {
    const log = recordingLogger();
    const adapter = new AiSdkAdapter({
      generateText: mockGenerate,
      logger: log.logger,
      resolveRegistryKey: () => undefined,
    });

    await expect(
      adapter.call(params({ providerConfig: { kind: "openai", apiKeyEnv: "MISSING" } })),
    ).rejects.toBeInstanceOf(ProviderError);

    expect(log.of("llm.provider.resolved")).toEqual([]);
  });
});

describe("llm.cache.request and llm.request.tuning", () => {
  const adapterWith = (log: ReturnType<typeof recordingLogger>): AiSdkAdapter =>
    new AiSdkAdapter({
      generateText: mockGenerate,
      logger: log.logger,
      resolveRegistryKey: () => "k",
    });

  it("reports what the request actually asked the cache for", async () => {
    const log = recordingLogger();
    await adapterWith(log).call(
      params({
        providerConfig: { kind: "anthropic", apiKeyEnv: "K" },
        promptCacheTtl: "1h",
        messages: [
          { role: "system", content: "s" },
          { role: "user", content: "u" },
        ],
      }),
    );

    expect(log.one("llm.cache.request").fields).toMatchObject({
      provider: "acme",
      model: "acme/model",
      kind: "anthropic",
      marked: "anthropic",
      applied_breakpoints: 1,
      system_marked: true,
      ttl: "1h",
    });
  });

  it("reports the tuning the model will answer within", async () => {
    const log = recordingLogger();
    await adapterWith(log).call(
      params({
        providerConfig: { kind: "openai", apiKeyEnv: "K" },
        reasoningEffort: "high",
        maxOutputTokens: 2048,
      }),
    );

    expect(log.one("llm.request.tuning").fields).toEqual({
      event: "llm.request.tuning",
      model: "acme/model",
      reasoning_path: "openai",
      max_output_tokens: 2048,
      images_stripped: false,
    });
  });

  it("reports images stripped when the model cannot see them", async () => {
    const log = recordingLogger();
    await adapterWith(log).call(params({ capabilities: new Set<string>() }));

    expect(log.one("llm.request.tuning").fields.images_stripped).toBe(true);
  });

  it("builds neither record when the logger discards debug", async () => {
    const log = recordingLogger("warn");
    await adapterWith(log).call(params());

    expect(log.of("llm.cache.request")).toEqual([]);
    expect(log.of("llm.request.tuning")).toEqual([]);
    expect(log.of("llm.provider.resolved")).toEqual([]);
  });
});

describe("llm.cache.breakpoint_lost", () => {
  const adapterWith = (log: ReturnType<typeof recordingLogger>): AiSdkAdapter =>
    new AiSdkAdapter({
      generateText: mockGenerate,
      logger: log.logger,
      resolveRegistryKey: () => "k",
    });

  it("warns when every requested breakpoint failed to land", async () => {
    const log = recordingLogger();
    await adapterWith(log).call(
      params({
        providerConfig: { kind: "anthropic", apiKeyEnv: "K" },
        cacheBreakpoints: [0],
        messages: [{ role: "system", content: "s" }],
      }),
    );

    const record = log.one("llm.cache.breakpoint_lost");
    expect(record.level).toBe("warn");
    expect(record.fields).toMatchObject({
      reason: "none_markable",
      requested_breakpoints: 1,
      applied_breakpoints: 0,
    });
    expect(record.message).toContain("uncached");
  });

  it("warns when two requested breakpoints collapsed into one", async () => {
    const log = recordingLogger();
    await adapterWith(log).call(
      params({
        providerConfig: {
          kind: "openai-compatible",
          baseUrl: "https://endpoint.test/v1",
          promptCache: "explicit",
        },
        cacheBreakpoints: [1, 2],
        messages: [
          { role: "user", content: "u" },
          { role: "assistant", content: "", tool_calls: [{ id: "1", name: "t", arguments: {} }] },
          { role: "tool", tool_call_id: "1", content: "r" },
        ],
      }),
    );

    expect(log.one("llm.cache.breakpoint_lost").fields).toMatchObject({
      reason: "collapsed",
      requested_breakpoints: 2,
      applied_breakpoints: 1,
      walked_back: true,
    });
  });

  it("stays quiet when the provider was never going to mark anything", async () => {
    const log = recordingLogger();
    await adapterWith(log).call(
      params({ providerConfig: { kind: "openai", apiKeyEnv: "K" }, cacheBreakpoints: [0] }),
    );

    expect(log.of("llm.cache.breakpoint_lost")).toEqual([]);
  });

  it("warns even when debug is off, because the cost is not this request's", async () => {
    const log = recordingLogger("warn");
    await adapterWith(log).call(
      params({
        providerConfig: { kind: "anthropic", apiKeyEnv: "K" },
        cacheBreakpoints: [0],
        messages: [{ role: "system", content: "s" }],
      }),
    );

    expect(log.of("llm.cache.breakpoint_lost")).toHaveLength(1);
  });
});

describe("streaming diagnostics", () => {
  type Part = Record<string, unknown> & { type: string };

  function fakeStream(parts: Part[], aggregate: unknown): unknown {
    async function* gen(): AsyncGenerator<Part> {
      for (const p of parts) yield p;
    }
    return { stream: gen(), __aggregate: aggregate };
  }

  function streamingAdapter(
    log: ReturnType<typeof recordingLogger>,
    parts: Part[],
    aggregate: unknown,
  ): AiSdkAdapter {
    mockStream.mockImplementation((args: { onEnd?: (e: unknown) => void }) => {
      if (aggregate !== undefined) queueMicrotask(() => args.onEnd?.(aggregate));
      return fakeStream(parts, aggregate);
    });
    return new AiSdkAdapter({
      streamText: mockStream as never,
      logger: log.logger,
      resolveRegistryKey: () => "k",
    });
  }

  const usage = {
    inputTokens: 1,
    outputTokens: 7,
    inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
  const aggregate = { text: "hi", toolCalls: [], usage, reasoningText: undefined };

  it("reports time to first token exactly once, naming the channel", async () => {
    const log = recordingLogger();
    const adapter = streamingAdapter(
      log,
      [
        { type: "text-delta", id: "1", text: "a" },
        { type: "text-delta", id: "1", text: "b" },
        { type: "text-delta", id: "1", text: "c" },
      ],
      aggregate,
    );

    await adapter.call(params({ onStreamDelta: () => {} }));

    const record = log.one("llm.stream.first_token");
    expect(record.fields).toMatchObject({ provider: "acme", model: "acme/model", channel: "text" });
    expect(typeof record.fields.ttft_ms).toBe("number");
  });

  it("names the first channel even when it is reasoning, not text", async () => {
    const log = recordingLogger();
    const adapter = streamingAdapter(
      log,
      [
        { type: "reasoning-delta", id: "1", text: "think" },
        { type: "text-delta", id: "1", text: "a" },
      ],
      aggregate,
    );

    await adapter.call(params({ onStreamDelta: () => {} }));

    expect(log.one("llm.stream.first_token").fields.channel).toBe("reasoning");
  });

  it("names a tool-input channel, and still only says it once", async () => {
    const log = recordingLogger();
    const adapter = streamingAdapter(
      log,
      [
        { type: "tool-input-start", id: "1", toolName: "t" },
        { type: "tool-input-delta", id: "1", delta: "{" },
        { type: "tool-input-end", id: "1" },
      ],
      aggregate,
    );

    await adapter.call(params({ onStreamDelta: () => {}, onToolInputDelta: () => {} }));

    expect(log.one("llm.stream.first_token").fields.channel).toBe("tool_input");
  });

  it("names the non-delta channels that also count as output", async () => {
    const first = async (type: string): Promise<unknown> => {
      const log = recordingLogger();
      const adapter = streamingAdapter(
        log,
        [{ type }, { type: "text-delta", id: "1", text: "a" }],
        aggregate,
      );
      await adapter.call(params({ onStreamDelta: () => {} }));
      return log.one("llm.stream.first_token").fields.channel;
    };

    expect(await first("tool-call")).toBe("tool_call");
    expect(await first("file")).toBe("file");
    expect(await first("source")).toBe("source");
  });

  it("warns, with what it had, when the stream ends without an aggregate", async () => {
    const log = recordingLogger();
    const adapter = streamingAdapter(
      log,
      [
        { type: "text-delta", id: "1", text: "a" },
        { type: "finish", totalUsage: usage },
      ],
      undefined,
    );

    await expect(adapter.call(params({ onStreamDelta: () => {} }))).rejects.toBeInstanceOf(
      ProviderError,
    );

    const record = log.one("llm.stream.no_aggregate");
    expect(record.level).toBe("warn");
    expect(record.fields).toEqual({
      event: "llm.stream.no_aggregate",
      model: "acme/model",
      stream_started: true,
      partial_output_tokens: 7,
    });
  });

  it("reports zero partial tokens when the provider billed none", async () => {
    const log = recordingLogger();
    const adapter = streamingAdapter(log, [], undefined);

    await expect(adapter.call(params({ onStreamDelta: () => {} }))).rejects.toBeInstanceOf(
      ProviderError,
    );

    expect(log.one("llm.stream.no_aggregate").fields).toMatchObject({
      stream_started: false,
      partial_output_tokens: 0,
    });
  });
});
