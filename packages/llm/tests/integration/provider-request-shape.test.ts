import { afterEach, beforeEach, describe, expect, it, vi } from "../helpers/bun-test.ts";
import { generateText as realGenerateText } from "ai";
import { AiSdkAdapter } from "@clarvis/llm/adapter";
import {
  ProviderError,
  type LiveMessage,
  type LLMCallParams,
  type NamespacedTool,
  type ResolvedProviderConfig,
} from "@clarvis/capability";

const mockGenerate = vi.fn();
const BASE = "http://endpoint.local/v1";
const readTool: NamespacedTool = {
  fullName: "fs.read",
  wireName: "fs_read",
  mcpName: "fs",
  toolName: "read",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
};

interface Captured {
  url: string;
  method?: string;
  headers: Record<string, string>;
  raw: string;
  body: {
    model?: string;
    messages?: Array<{ role: string; content?: unknown; [key: string]: unknown }>;
    [key: string]: unknown;
  };
}

function stubFetch(
  response: unknown = { choices: [{ message: { content: "ok" } }], usage: {} },
  status = 200,
  responseHeaders: Record<string, string> = { "content-type": "application/json" },
): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (
        url: unknown,
        init: { method?: string; body?: string; headers?: Record<string, string> },
      ) => {
        const raw = init?.body ?? "{}";
        calls.push({
          url: String(url),
          method: init?.method,
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          raw,
          body: JSON.parse(raw),
        });
        return new Response(typeof response === "string" ? response : JSON.stringify(response), {
          status,
          headers: responseHeaders,
        });
      },
    ),
  );
  return calls;
}

function adapter(
  config: ConstructorParameters<typeof AiSdkAdapter>[0] = {},
): InstanceType<typeof AiSdkAdapter> {
  return new AiSdkAdapter({ ...config, generateText: mockGenerate });
}

function call(
  providerConfig: ResolvedProviderConfig,
  over: Partial<LLMCallParams> = {},
): LLMCallParams {
  return {
    provider: providerConfig.kind,
    providerConfig,
    model: "some-org/model-v99",
    messages: [
      { role: "system", content: "you are the lead" },
      { role: "user", content: "hello" },
    ],
    tools: [],
    ...over,
  };
}

function markedIndices(body: Captured["body"]): number[] {
  return (body.messages ?? []).flatMap((message, index) =>
    Array.isArray(message.content) &&
    (message.content as Array<{ cache_control?: unknown }>).some(
      (part) => part.cache_control !== undefined,
    )
      ? [index]
      : [],
  );
}

beforeEach(() => {
  mockGenerate.mockReset();
  mockGenerate.mockImplementation(realGenerateText as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("real openai-compatible SDK wire", () => {
  it("serializes URL, headers, model, tools, cache marker and safe body extras", async () => {
    const calls = stubFetch();
    const subject = adapter({
      resolveRegistryKey: (name) =>
        name === "API_KEY" ? "secret" : name === "PARTNER" ? "partner" : undefined,
    });
    await subject
      .call(
        call(
          {
            kind: "openai-compatible",
            baseUrl: `${BASE}/`,
            apiKeyEnv: "API_KEY",
            headers: { "X-Partner": "Bearer ${PARTNER}" },
            promptCache: "explicit",
            body: {
              session_id: "session-1",
              messages: [{ role: "user", content: "hijacked" }],
              model: "hijacked",
              tools: [{ type: "hijacked" }],
            },
          },
          {
            tools: [readTool],
            toolChoice: { type: "function", function: { name: "fs_read" } },
            cacheBreakpoints: [1],
            reasoningEffort: "high",
            promptCacheKey: "run-1",
          },
        ),
      )
      .catch(() => undefined);

    const request = calls[0]!;
    expect(request.url).toBe(`${BASE}/chat/completions`);
    expect(request.method).toBe("POST");
    expect(request.headers.authorization).toBe("Bearer secret");
    expect(request.headers["x-partner"]).toBe("Bearer partner");
    expect(request.body.model).toBe("some-org/model-v99");
    expect(request.body.session_id).toBe("session-1");
    expect(JSON.stringify(request.body.tools)).toContain("fs_read");
    expect(JSON.stringify(request.body.tool_choice)).toContain("fs_read");
    expect(request.body.reasoning_effort).toBe("high");
    expect(request.body.prompt_cache_key).toBe("run-1");
    expect(request.raw).toContain("cache_control");
    expect(request.raw).not.toContain("__clarvis_cache_control");
  });

  it("omits Authorization when no key is configured", async () => {
    const calls = stubFetch();
    await adapter().call(call({ kind: "openai-compatible", baseUrl: BASE }));
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it("keeps tool-role wire content a string and walks its breakpoint backward", async () => {
    const messages: LiveMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "read it" },
      {
        role: "assistant",
        content: "I will read it",
        tool_calls: [{ id: "c1", name: "fs_read", arguments: { path: "/x" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "file contents" },
    ];
    const calls = stubFetch();
    await adapter()
      .call(
        call(
          { kind: "openai-compatible", baseUrl: BASE, promptCache: "explicit" },
          { messages, tools: [readTool], cacheBreakpoints: [2, 3] },
        ),
      )
      .catch(() => undefined);

    const tool = calls[0]!.body.messages!.find((message) => message.role === "tool")!;
    const assistant = calls[0]!.body.messages!.find((message) => message.role === "assistant")!;
    expect(typeof tool.content).toBe("string");
    expect(typeof assistant.content).toBe("string");
    expect(JSON.stringify([tool, assistant])).not.toContain("cache_control");
    expect(markedIndices(calls[0]!.body)).toEqual([0, 1]);
  });

  it("preserves the already-serialized prefix when the rolling marker advances", async () => {
    const transcript = (count: number): LiveMessage[] => {
      const result: LiveMessage[] = [{ role: "system", content: "system" }];
      for (let index = 0; index < count; index += 1) {
        result.push({
          role: index % 2 === 0 ? "user" : "assistant",
          content: `turn ${index} ${"detail ".repeat(20)}`,
        });
      }
      return result;
    };
    const before = transcript(30);
    const after: LiveMessage[] = [
      ...before,
      { role: "assistant", content: "answer" },
      { role: "user", content: "next" },
    ];
    const calls = stubFetch();
    const subject = adapter();
    const cfg = {
      kind: "openai-compatible" as const,
      baseUrl: BASE,
      promptCache: "explicit" as const,
    };
    await subject.call(call(cfg, { messages: before, cacheBreakpoints: [30] }));
    await subject.call(call(cfg, { messages: after, cacheBreakpoints: [32] }));

    const first = JSON.stringify(calls[0]!.body.messages);
    const second = JSON.stringify(calls[1]!.body.messages);
    let common = 0;
    while (common < first.length && first[common] === second[common]) common += 1;
    expect(common / first.length).toBeGreaterThan(0.95);
  });

  it("round-trips reasoning_content from one completion into the next request", async () => {
    const calls = stubFetch({
      id: "chatcmpl_reasoning",
      object: "chat.completion",
      created: 1,
      model: "grok-test",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "answer", reasoning_content: "chain state" },
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    });
    const subject = adapter();
    const cfg = { kind: "openai-compatible" as const, baseUrl: BASE };
    const first = await subject.call(call(cfg));

    expect(first.reasoningParts).toEqual([{ text: "chain state" }]);
    await subject
      .call(
        call(cfg, {
          messages: [
            { role: "user", content: "first" },
            { role: "assistant", content: first.text ?? "", reasoning: first.reasoningParts! },
            { role: "user", content: "continue" },
          ],
        }),
      )
      .catch(() => undefined);

    const assistant = calls[1]!.body.messages!.find((message) => message.role === "assistant")!;
    expect(assistant.reasoning_content).toBe("chain state");
  });

  it("maps a real SDK 429 response and its Retry-After header", async () => {
    stubFetch("rate limited", 429, { "retry-after": "2" });
    await expect(
      adapter().call(call({ kind: "openai-compatible", baseUrl: BASE })),
    ).rejects.toMatchObject({ kind: "transient", status: 429, retryAfterMs: 2_000 });
  });

  it("turns a real SDK parse failure into ProviderError", async () => {
    stubFetch("<html>not json</html>", 200, { "content-type": "text/html" });
    await expect(
      adapter().call(call({ kind: "openai-compatible", baseUrl: BASE })),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("drains one real SDK stream and receives its aggregate through onEnd", async () => {
    const event = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
    const base = {
      id: "chatcmpl_1",
      object: "chat.completion.chunk",
      created: 1,
      model: "some-org/model-v99",
    };
    stubFetch(
      event({
        ...base,
        choices: [{ index: 0, delta: { reasoning_content: "Think" }, finish_reason: null }],
      }) +
        event({
          ...base,
          choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
        }) +
        event({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }) +
        "data: [DONE]\n\n",
      200,
      { "content-type": "text/event-stream" },
    );
    const deltas: Array<{ channel: string; text: string }> = [];
    const result = await adapter()
      .call(
        call(
          { kind: "openai-compatible", baseUrl: BASE },
          { onStreamDelta: (delta) => deltas.push({ channel: delta.channel, text: delta.text }) },
        ),
      )
      .catch(() => undefined);
    expect(deltas).toEqual([
      { channel: "reasoning", text: "Think" },
      { channel: "text", text: "Hello" },
    ]);
    expect(result).toMatchObject({
      text: "Hello",
      reasoning: "Think",
      reasoningParts: [{ text: "Think" }],
      finishReason: "stop",
      usage: { input_tokens: 3, output_tokens: 1 },
    });
  });

  it("maps an oversized real SSE frame to a non-retryable provider error", async () => {
    stubFetch("data: " + "x".repeat(64), 200, { "content-type": "text/event-stream" });
    const subject = new AiSdkAdapter(
      { generateText: mockGenerate },
      { maxResponseBytes: 256, maxSseEventBytes: 32 },
    );
    await expect(
      subject.call(
        call({ kind: "openai-compatible", baseUrl: BASE }, { onStreamDelta: () => undefined }),
      ),
    ).rejects.toMatchObject({
      kind: "client",
      message: expect.stringContaining("SSE event exceeded"),
    });
  });
});

describe("native provider SDK sentinels", () => {
  it("pins ChatGPT subscription Responses, removes the dummy key, stores no response, and omits its rejected output cap", async () => {
    const calls = stubFetch({
      id: "resp_subscription",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "gpt-codex",
      output: [
        {
          type: "message",
          id: "msg_subscription",
          status: "completed",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "ok", annotations: [] }],
        },
      ],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    });
    const subject = adapter({
      resolveSubscription: async (scheme) => ({
        scheme,
        async apply(input, init) {
          const headers = new Headers(input instanceof Request ? input.headers : undefined);
          new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
          headers.set("authorization", "Bearer subscription-token");
          headers.set("chatgpt-account-id", "account-1");
          return fetch(input, { ...init, headers });
        },
      }),
    });

    const result = await subject.call(
      call(
        { kind: "openai-codex", promptCache: "explicit" },
        {
          model: "future-responses-model",
          maxOutputTokens: 4096,
          reasoningEffort: "high",
          promptCacheKey: "conversation-1",
          cacheBreakpoints: [1],
        },
      ),
    );

    expect(calls[0]!.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(calls[0]!.headers.authorization).toBe("Bearer subscription-token");
    expect(calls[0]!.raw).not.toContain("subscription-placeholder-never-sent");
    expect(calls[0]!.body.store).toBe(false);
    expect(calls[0]!.body.max_output_tokens).toBeUndefined();
    expect(calls[0]!.body.reasoning).toMatchObject({ effort: "high" });
    expect(calls[0]!.body.prompt_cache_key).toBe("conversation-1");
    expect(calls[0]!.body.prompt_cache_options).toBeUndefined();
    expect(JSON.stringify(calls[0]!.body.input)).not.toContain("prompt_cache_breakpoint");
    expect(result?.billing_source).toBe("subscription");

    await subject.call(
      call(
        { kind: "openai-codex" },
        {
          model: "gpt-codex",
          messages: [
            { role: "user", content: "first" },
            {
              role: "assistant",
              content: "Checking now.",
              text_parts: [
                {
                  text: "Checking now.",
                  phase: "commentary",
                  providerOptions: {
                    openai: { itemId: "msg_subscription", phase: "commentary" },
                  },
                },
              ],
            },
            { role: "user", content: "continue" },
          ],
        },
      ),
    );
    expect(calls[1]!.body.input).toContainEqual({
      role: "assistant",
      content: [{ type: "output_text", text: "Checking now." }],
      id: "msg_subscription",
      phase: "commentary",
    });
  });

  it("uses Grok's subscription Responses path and retains its supported output cap", async () => {
    const calls = stubFetch();
    const contexts: Array<{ conversationKey?: string } | undefined> = [];
    const subject = adapter({
      resolveSubscription: async (scheme, _signal, context) => {
        contexts.push(context);
        return {
          scheme,
          async apply(input, init) {
            const headers = new Headers(init?.headers);
            headers.set("authorization", "Bearer grok-subscription-token");
            headers.set("x-xai-token-auth", "xai-grok-cli");
            return fetch(input, { ...init, headers });
          },
        };
      },
    });

    await subject
      .call(
        call(
          { kind: "xai-grok", promptCache: "explicit" },
          {
            model: "grok-code",
            maxOutputTokens: 8192,
            promptCacheKey: "conversation-2",
            cacheBreakpoints: [1],
          },
        ),
      )
      .catch(() => undefined);

    expect(calls[0]!.url).toBe("https://cli-chat-proxy.grok.com/v1/responses");
    expect(calls[0]!.headers.authorization).toBe("Bearer grok-subscription-token");
    expect(calls[0]!.body.store).toBe(false);
    expect(calls[0]!.body.max_output_tokens).toBe(8192);
    expect(calls[0]!.body.prompt_cache_key).toBe("conversation-2");
    expect(JSON.stringify(calls[0]!.body.input)).not.toContain("prompt_cache_breakpoint");
    expect(contexts).toEqual([{ conversationKey: "conversation-2" }]);
  });

  it("serializes OpenAI Responses reasoning and cache key without unsupported inline markers", async () => {
    const calls = stubFetch();
    await adapter({ resolveRegistryKey: () => "secret" })
      .call(
        call(
          {
            kind: "openai",
            apiKeyEnv: "OPENAI_KEY",
            headers: { "X-Provider": "openai" },
            promptCache: "explicit",
          },
          {
            model: "gpt-5.6",
            reasoningSummary: "auto",
            promptCacheKey: "run-1",
            cacheBreakpoints: [1],
          },
        ),
      )
      .catch(() => undefined);

    expect(calls[0]!.url).toContain("/responses");
    expect(calls[0]!.headers["x-provider"]).toBe("openai");
    expect(calls[0]!.body.reasoning).toEqual({ summary: "auto" });
    expect(calls[0]!.body.prompt_cache_key).toBe("run-1");
    expect(calls[0]!.body.prompt_cache_options).toBeUndefined();
    expect(JSON.stringify(calls[0]!.body.input)).not.toContain("prompt_cache_breakpoint");
  });

  it("serializes retained native OpenAI reasoning state on a continuation", async () => {
    const calls = stubFetch();
    await adapter({ resolveRegistryKey: () => "secret" })
      .call(
        call(
          { kind: "openai", apiKeyEnv: "OPENAI_KEY" },
          {
            model: "gpt-5.4",
            messages: [
              { role: "user", content: "first" },
              {
                role: "assistant",
                content: "answer",
                reasoning: [
                  {
                    text: "summary",
                    providerOptions: {
                      openai: {
                        itemId: "rs_1",
                        reasoningEncryptedContent: "encrypted-reasoning",
                      },
                    },
                  },
                ],
              },
              { role: "user", content: "continue" },
            ],
          },
        ),
      )
      .catch(() => undefined);

    expect(calls[0]!.body.input).toContainEqual({ type: "item_reference", id: "rs_1" });
  });

  it("retains native Responses commentary metadata from an aggregate response", async () => {
    const calls = stubFetch({
      id: "resp_commentary",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "gpt-5.4",
      output: [
        {
          type: "message",
          id: "msg_commentary",
          status: "completed",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "Checking now.", annotations: [] }],
        },
      ],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    });
    const subject = adapter({ resolveRegistryKey: () => "secret" });
    const cfg = { kind: "openai" as const, apiKeyEnv: "OPENAI_KEY" };
    const first = await subject.call(call(cfg, { model: "gpt-5.4" }));

    expect(first.textParts).toEqual([
      {
        text: "Checking now.",
        phase: "commentary",
        providerOptions: { openai: { itemId: "msg_commentary", phase: "commentary" } },
      },
    ]);
    expect(calls).toHaveLength(1);
  });

  it("serializes Anthropic cache TTL and preserves inclusive usage accounting", async () => {
    const calls = stubFetch({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 3,
        output_tokens: 2,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 7,
      },
    });
    const result = await adapter({ resolveRegistryKey: () => "secret" }).call(
      call(
        { kind: "anthropic", apiKeyEnv: "ANTHROPIC_KEY" },
        { model: "claude-test", promptCacheTtl: "1h", cacheBreakpoints: [1] },
      ),
    );

    expect(calls[0]!.url).toContain("/messages");
    expect(calls[0]!.raw).toContain('"cache_control":{"type":"ephemeral","ttl":"1h"}');
    expect(result.usage).toEqual({
      input_tokens: 15,
      output_tokens: 2,
      cached_tokens: 5,
      cache_write_tokens: 7,
    });
  });

  it("round-trips Anthropic thinking with its signature on a continuation", async () => {
    const calls = stubFetch({
      id: "msg_reasoning",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [
        { type: "thinking", thinking: "chain state", signature: "signed-thinking" },
        { type: "text", text: "answer" },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 2 },
    });
    const subject = adapter({ resolveRegistryKey: () => "secret" });
    const cfg = { kind: "anthropic" as const, apiKeyEnv: "ANTHROPIC_KEY" };
    const first = await subject.call(call(cfg, { model: "claude-test" }));

    expect(first.reasoningParts).toEqual([
      {
        text: "chain state",
        providerOptions: { anthropic: { signature: "signed-thinking" } },
      },
    ]);
    await subject.call(
      call(cfg, {
        model: "claude-test",
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: first.text ?? "", reasoning: first.reasoningParts! },
          { role: "user", content: "continue" },
        ],
      }),
    );

    expect(calls[1]!.raw).toContain('"type":"thinking"');
    expect(calls[1]!.raw).toContain('"signature":"signed-thinking"');
  });

  it("forwards configured headers through every native provider SDK", async () => {
    for (const kind of ["openai", "anthropic", "google"] as const) {
      const calls = stubFetch();
      await adapter({ resolveRegistryKey: () => "secret" })
        .call(call({ kind, apiKeyEnv: "KEY", headers: { "X-Provider": kind } }))
        .catch(() => undefined);
      expect(calls[0]!.headers["x-provider"]).toBe(kind);
      vi.unstubAllGlobals();
    }
  });
});
