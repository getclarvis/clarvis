import { describe, expect, it } from "../helpers/bun-test.ts";
import { APICallError, type ModelMessage } from "ai";
import { ProviderError, type LLMCallParams } from "@clarvis/capability";
import { buildRequestOptions } from "../../src/ai-sdk/request-options.ts";
import { buildCallResult, normalizeModelText, normalizeUsage } from "../../src/ai-sdk/result.ts";
import { toProviderError } from "../../src/ai-sdk/errors.ts";
import {
  applyBodyExtras,
  applyCacheControlMarkers,
  CACHE_MARKER_KEY,
  openAICompatibleSettings,
  resolveConfiguredHeaders,
} from "../../src/openai-compatible-request.ts";

/** The request half of {@link buildRequestOptions}, which is what these assert on. */
const buildRequest = (
  callParams: LLMCallParams,
  modelMessages: ModelMessage[],
): ReturnType<typeof buildRequestOptions>["request"] =>
  buildRequestOptions(callParams, modelMessages).request;

const messages: ModelMessage[] = [
  { role: "system", content: "system" },
  { role: "user", content: "hello" },
];

function params(over: Partial<LLMCallParams> = {}): LLMCallParams {
  return {
    provider: "test",
    providerConfig: { kind: "openai-compatible", baseUrl: "https://example.test/v1" },
    model: "model",
    messages: [],
    tools: [],
    ...over,
  };
}

describe("request options", () => {
  it("combines system splitting, provider tuning, tools and forced choice", () => {
    const request = buildRequest(
      params({
        reasoningEffort: "high",
        promptCacheKey: "run-1",
        maxOutputTokens: 4096,
        tools: [
          {
            fullName: "fs.read",
            wireName: "fs_read",
            mcpName: "fs",
            toolName: "read",
            inputSchema: { type: "object" },
          },
        ],
        toolChoice: { type: "function", function: { name: "fs_read" } },
      }),
      messages,
    );

    expect(request.system).toBe("system");
    expect(request.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(request.toolChoice).toEqual({ type: "tool", toolName: "fs_read" });
    expect(request.maxOutputTokens).toBe(4096);
    expect(request.providerOptions).toEqual({
      openaiCompatible: {
        reasoningEffort: "high",
        usage: { include: true },
        prompt_cache_key: "run-1",
        session_id: "run-1",
      },
    });
    /* Both halves of the backend pin, from the one value. On OpenRouter
       `session_id` is the primary affinity key and `prompt_cache_key` only the
       fallback, and the header is what pins a request that has not yet been
       parsed as a body. */
    expect(request.headers).toEqual({ "x-session-id": "run-1" });
  });

  it("sends no session pin when there is no cache key to pin with", () => {
    const request = buildRequest(params({ reasoningEffort: "high" }), messages);
    expect(request.headers).toBeUndefined();
    expect(
      (request.providerOptions?.openaiCompatible as Record<string, unknown> | undefined)
        ?.session_id,
    ).toBeUndefined();
  });

  it("does not pin a session on a provider that has no backend to pin", () => {
    const request = buildRequest(
      params({ providerConfig: { kind: "anthropic", apiKeyEnv: "KEY" }, promptCacheKey: "run-1" }),
      messages,
    );
    expect(request.headers).toBeUndefined();
  });

  it("keeps Anthropic cache markers and TTL on system and requested messages", () => {
    const request = buildRequest(
      params({
        providerConfig: { kind: "anthropic", apiKeyEnv: "KEY" },
        cacheBreakpoints: [1],
        promptCacheTtl: "1h",
      }),
      messages,
    );
    expect(request.system).toEqual([
      {
        role: "system",
        content: "system",
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
        },
      },
    ]);
    expect(request.messages[0]!.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
    });
  });

  it("marks explicit native OpenAI boundaries without sending request-level cache options", () => {
    const richMessages: ModelMessage[] = [
      messages[0]!,
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "hello",
            providerOptions: {
              openai: { existing: "kept" },
              custom: { existing: "also-kept" },
            },
          },
        ],
      },
    ];
    const request = buildRequest(
      params({
        providerConfig: { kind: "openai", apiKeyEnv: "KEY", promptCache: "explicit" },
        cacheBreakpoints: [1],
        promptCacheKey: "session-1",
      }),
      richMessages,
    );
    const marker = { openai: { promptCacheBreakpoint: { mode: "explicit" } } };
    expect(request.system).toEqual([
      { role: "system", content: "system", providerOptions: marker },
    ]);
    expect(request.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "hello",
          providerOptions: {
            openai: { existing: "kept", promptCacheBreakpoint: { mode: "explicit" } },
            custom: { existing: "also-kept" },
          },
        },
      ],
    });
    expect(request.providerOptions).toEqual({ openai: { promptCacheKey: "session-1" } });
    expect(JSON.stringify(request)).not.toContain("promptCacheOptions");
  });

  it("marks OpenAI tool-result content and leaves every non-OpenAI kind untouched", () => {
    const transcript: ModelMessage[] = [
      { role: "user", content: "read it" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "read", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "read",
            output: { type: "text", value: "contents" },
          },
        ],
      },
    ];
    const explicit = (kind: "openai" | "openai-codex" | "xai-grok" | "google") =>
      buildRequest(
        params({ providerConfig: { kind, promptCache: "explicit" }, cacheBreakpoints: [2] }),
        transcript,
      );

    for (const kind of ["openai", "openai-codex"] as const) {
      const request = explicit(kind);
      expect(JSON.stringify(request.messages[2])).toContain("promptCacheBreakpoint");
    }
    for (const kind of ["xai-grok", "google"] as const) {
      expect(JSON.stringify(explicit(kind))).not.toContain("promptCacheBreakpoint");
    }

    const advanced = buildRequest(
      params({
        providerConfig: { kind: "openai", promptCache: "explicit" },
        cacheBreakpoints: [0],
      }),
      transcript,
    );
    expect(JSON.stringify(advanced.messages[2])).toContain('"type":"content"');
    expect(JSON.stringify(advanced.messages[2])).not.toContain("promptCacheBreakpoint");
  });

  it("marks the final eligible OpenAI block and walks back from an unsupported tool output", () => {
    const userParts = buildRequest(
      params({
        providerConfig: { kind: "openai", promptCache: "explicit" },
        cacheBreakpoints: [0],
      }),
      [
        {
          role: "user",
          content: [
            { type: "text", text: "context" },
            { type: "file", data: "ZmlsZQ==", mediaType: "text/plain" },
          ],
        },
      ],
    );
    expect(JSON.stringify(userParts.messages[0])).toContain('"type":"file"');
    expect(JSON.stringify(userParts.messages[0])).toContain("promptCacheBreakpoint");

    const toolParts = buildRequest(
      params({
        providerConfig: { kind: "openai", promptCache: "explicit" },
        cacheBreakpoints: [1],
      }),
      [
        { role: "user", content: "read it" },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "c1",
              toolName: "read",
              output: {
                type: "content",
                value: [
                  { type: "text", text: "context" },
                  { type: "file", data: "ZmlsZQ==", mediaType: "text/plain" },
                ],
              },
            },
          ],
        } as ModelMessage,
      ],
    );
    expect(JSON.stringify(toolParts.messages[1])).toContain('"type":"file"');
    expect(JSON.stringify(toolParts.messages[1])).toContain("promptCacheBreakpoint");

    const walkedBack = buildRequest(
      params({
        providerConfig: { kind: "openai", promptCache: "explicit" },
        cacheBreakpoints: [1],
      }),
      [
        { role: "user", content: "fallback" },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "c2",
              toolName: "read",
              output: { type: "content", value: [{ type: "unsupported" }] },
            },
          ],
        } as unknown as ModelMessage,
      ],
    );
    expect(JSON.stringify(walkedBack.messages[0])).toContain("promptCacheBreakpoint");
    expect(JSON.stringify(walkedBack.messages[1])).not.toContain("promptCacheBreakpoint");
  });

  it("joins system messages and omits system when none exists", () => {
    const joined = buildRequest(params(), [
      { role: "system", content: "a" },
      { role: "system", content: "b" },
      { role: "user", content: "hello" },
    ]);
    expect(joined.system).toBe("a\n\nb");
    expect(joined.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(buildRequest(params(), [{ role: "user", content: "hello" }]).system).toBeUndefined();
  });

  it("owns the complete reasoning mapping by provider family", () => {
    const options = (
      kind: "openai" | "openai-compatible" | "anthropic" | "google",
      effort: NonNullable<LLMCallParams["reasoningEffort"]>,
    ) =>
      buildRequest(
        params({
          providerConfig:
            kind === "openai-compatible"
              ? { kind, baseUrl: "https://example.test/v1" }
              : { kind, apiKeyEnv: "KEY" },
          reasoningEffort: effort,
        }),
        [{ role: "user", content: "hello" }],
      );

    expect(options("openai", "off").providerOptions).toEqual({
      openai: { reasoningEffort: "none" },
    });
    expect(options("openai", "max").providerOptions).toEqual({
      openai: { reasoningEffort: "max" },
    });
    expect(options("openai-compatible", "xhigh").providerOptions).toEqual({
      openaiCompatible: { reasoningEffort: "xhigh", usage: { include: true } },
    });
    expect(options("anthropic", "low")).toMatchObject({
      reasoning: "low",
      maxOutputTokens: 10_240,
    });
    expect(options("anthropic", "xhigh")).toMatchObject({
      reasoning: "xhigh",
      maxOutputTokens: 24_576,
    });
    expect(options("anthropic", "max")).toMatchObject({
      providerOptions: { anthropic: { effort: "max" } },
      maxOutputTokens: 40_960,
    });
    expect(options("anthropic", "off")).toMatchObject({ reasoning: "none" });
    expect(options("anthropic", "off").maxOutputTokens).toBeUndefined();
    expect(options("google", "off").reasoning).toBe("none");
    expect(options("google", "max").reasoning).toBe("xhigh");
  });

  it("combines OpenAI summary/cache tuning and omits it from other families", () => {
    const openai = buildRequest(
      params({
        providerConfig: { kind: "openai", apiKeyEnv: "KEY" },
        reasoningSummary: "auto",
        reasoningEffort: "low",
        promptCacheKey: "run-1",
      }),
      [{ role: "user", content: "hello" }],
    );
    expect(openai.providerOptions).toEqual({
      openai: {
        reasoningSummary: "auto",
        reasoningEffort: "low",
        promptCacheKey: "run-1",
      },
    });

    const grok = buildRequest(
      params({
        providerConfig: { kind: "xai-grok" },
        promptCacheKey: "run-1",
      }),
      [{ role: "user", content: "hello" }],
    );
    expect(grok.providerOptions).toEqual({
      openai: { store: false, forceReasoning: true, promptCacheKey: "run-1" },
    });

    const anthropic = buildRequest(
      params({
        providerConfig: { kind: "anthropic", apiKeyEnv: "KEY" },
        reasoningSummary: "auto",
      }),
      [{ role: "user", content: "hello" }],
    );
    expect(anthropic.providerOptions).toBeUndefined();
  });

  it("applies configured output bounds around the Anthropic reasoning floor", () => {
    const output = (maxOutputTokens: number | undefined) =>
      buildRequest(
        params({
          providerConfig: { kind: "anthropic", apiKeyEnv: "KEY" },
          reasoningEffort: "low",
          ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        }),
        [{ role: "user", content: "hello" }],
      ).maxOutputTokens;
    expect(output(1_000)).toBe(10_240);
    expect(output(64_000)).toBe(64_000);
    expect(buildRequest(params({ maxOutputTokens: 4096 }), []).maxOutputTokens).toBe(4096);
    expect(buildRequest(params(), []).maxOutputTokens).toBeUndefined();
  });

  it("owns every tool-choice form and omits a choice when there are no tools", () => {
    const tool = {
      fullName: "fs.read",
      wireName: "fs_read",
      mcpName: "fs",
      toolName: "read",
      inputSchema: { type: "object" },
    };
    const choice = (toolChoice: LLMCallParams["toolChoice"], tools = [tool]) =>
      buildRequest(params({ tools, toolChoice }), []).toolChoice;
    expect(choice("auto")).toBe("auto");
    expect(choice("required")).toBe("required");
    expect(choice({ type: "function", function: { name: "fs_read" } })).toEqual({
      type: "tool",
      toolName: "fs_read",
    });
    expect(choice("required", [])).toBeUndefined();
    expect(buildRequest(params({ tools: [] }), []).tools).toBeUndefined();
  });

  it("owns Anthropic cache target filtering, rolling defaults and marker budget", () => {
    const transcript: ModelMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ];
    const request = (cacheBreakpoints?: number[]) =>
      buildRequest(
        params({
          providerConfig: { kind: "anthropic", apiKeyEnv: "KEY" },
          ...(cacheBreakpoints !== undefined ? { cacheBreakpoints } : {}),
        }),
        transcript,
      );
    expect(request([1, 2, 3]).messages.map((m) => m.providerOptions !== undefined)).toEqual([
      false,
      true,
      true,
    ]);
    expect(request([0, -1, 99]).messages.every((m) => m.providerOptions === undefined)).toBe(true);
    expect(request().messages.at(-1)!.providerOptions).toBeDefined();
  });

  it("gates openai-compatible markers on explicit mode and requested breakpoints", () => {
    const request = (
      promptCache: "off" | "implicit" | "explicit" | undefined,
      cacheBreakpoints?: number[],
    ) =>
      buildRequest(
        params({
          providerConfig: {
            kind: "openai-compatible",
            baseUrl: "https://example.test/v1",
            ...(promptCache !== undefined ? { promptCache } : {}),
          },
          ...(cacheBreakpoints !== undefined ? { cacheBreakpoints } : {}),
        }),
        messages,
      );
    expect(JSON.stringify(request("explicit", [1]))).toContain(CACHE_MARKER_KEY);
    expect(JSON.stringify(request("explicit"))).not.toContain(CACHE_MARKER_KEY);
    expect(JSON.stringify(request("implicit", [1]))).not.toContain(CACHE_MARKER_KEY);
    expect(JSON.stringify(request("off", [1]))).not.toContain(CACHE_MARKER_KEY);

    const multipart: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    ];
    const multipartRequest = buildRequest(
      params({
        providerConfig: {
          kind: "openai-compatible",
          baseUrl: "https://example.test/v1",
          promptCache: "explicit",
        },
        cacheBreakpoints: [0],
      }),
      multipart,
    );
    expect(multipartRequest.messages[0]!.providerOptions).toBeDefined();

    const singlePartRequest = buildRequest(
      params({
        providerConfig: {
          kind: "openai-compatible",
          baseUrl: "https://example.test/v1",
          promptCache: "explicit",
        },
        cacheBreakpoints: [0],
      }),
      [{ role: "user", content: [{ type: "text", text: "only" }] }],
    );
    expect(JSON.stringify(singlePartRequest.messages[0]!.content)).toContain(CACHE_MARKER_KEY);
  });

  it("leaves Anthropic without a rolling marker when no non-system message exists", () => {
    const request = buildRequest(
      params({ providerConfig: { kind: "anthropic", apiKeyEnv: "KEY" } }),
      [{ role: "system", content: "system only" }],
    );
    expect(request.messages).toEqual([]);
  });
});

describe("result normalization", () => {
  it("normalizes partial usage and malformed tool arguments", () => {
    expect(normalizeUsage({ inputTokens: 7, outputTokens: 2 } as never)).toEqual({
      input_tokens: 7,
      output_tokens: 2,
      cached_tokens: 0,
      cache_write_tokens: 0,
    });
    const result = buildCallResult({
      text: "ok\0",
      toolCalls: [{ toolCallId: "c1", toolName: "shell", input: '{"command":' }],
      usage: { inputTokens: 0, outputTokens: 0 } as never,
      reasoningText: "",
    });
    expect(result.text).toBe("ok");
    expect(result.toolCalls).toEqual([
      { id: "c1", name: "shell", arguments: {}, malformedArguments: '{"command":' },
    ]);
  });

  it("owns text control-byte normalization", () => {
    const nul = String.fromCharCode(0);
    const del = String.fromCharCode(0x7f);
    expect(normalizeModelText(nul)).toBeUndefined();
    expect(normalizeModelText(` ${nul}\n`)).toBeUndefined();
    expect(normalizeModelText(`a${nul}b${del}c`)).toBe("abc");
    expect(normalizeModelText("  line 1\n\tline 2  ")).toBe("  line 1\n\tline 2  ");
    const large = "x".repeat(1024 * 1024);
    expect(normalizeModelText(large)).toBe(large);
  });

  it("owns tool-argument normalization for decoded, serialized, absent and malformed inputs", () => {
    const call = (input: unknown) =>
      buildCallResult({
        text: "",
        toolCalls: [{ toolCallId: "c1", toolName: "tool", input }],
        usage: { inputTokens: 0, outputTokens: 0 } as never,
        reasoningText: undefined,
      }).toolCalls![0]!;
    expect(call({ path: "/x" })).toMatchObject({ arguments: { path: "/x" } });
    expect(call('{"path":"/x"}')).toMatchObject({ arguments: { path: "/x" } });
    for (const input of [undefined, "", "  "]) {
      expect(call(input)).toEqual({ id: "c1", name: "tool", arguments: {} });
    }
    for (const input of ['{"path":', '"scalar"', "[1,2]", "42", "not json"]) {
      expect(call(input)).toMatchObject({ arguments: {}, malformedArguments: expect.any(String) });
    }
  });

  it("owns optional result fields and complete usage projection", () => {
    const result = buildCallResult({
      text: "answer",
      toolCalls: [],
      usage: {
        inputTokens: 9,
        outputTokens: 4,
        inputTokenDetails: { cacheReadTokens: 2, cacheWriteTokens: 3 },
      } as never,
      reasoningText: "because",
      finishReason: "stop",
    });
    expect(result).toMatchObject({
      text: "answer",
      reasoning: "because",
      finishReason: "stop",
      usage: {
        input_tokens: 9,
        output_tokens: 4,
        cached_tokens: 2,
        cache_write_tokens: 3,
      },
    });
    expect(result.toolCalls).toBeUndefined();
  });

  it("retains provider-neutral reasoning parts and their opaque continuation metadata", () => {
    const result = buildCallResult({
      text: "answer",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 2 } as never,
      reasoningText: "visible summary",
      responseMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "provider state",
              providerOptions: {
                anthropic: { signature: "signed-thinking" },
              },
            },
            { type: "text", text: "answer" },
          ],
        },
      ],
    });

    expect(result.reasoning).toBe("visible summary");
    expect(result.reasoningParts).toEqual([
      {
        text: "provider state",
        providerOptions: { anthropic: { signature: "signed-thinking" } },
      },
    ]);
  });

  it("retains assistant text phase and opaque OpenAI replay metadata", () => {
    const result = buildCallResult({
      text: "Checking the request now.",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 2 } as never,
      reasoningText: undefined,
      responseMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Checking the request now.",
              providerOptions: {
                openai: { itemId: "msg_update", phase: "commentary", annotations: [] },
              },
            },
          ],
        },
      ],
    });

    expect(result.textParts).toEqual([
      {
        text: "Checking the request now.",
        phase: "commentary",
        providerOptions: {
          openai: { itemId: "msg_update", phase: "commentary", annotations: [] },
        },
      },
    ]);
  });

  it("falls back to aggregate text parts when response messages are unavailable", () => {
    const result = buildCallResult({
      text: "Done.",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 } as never,
      reasoningText: undefined,
      content: [
        {
          type: "text",
          text: "Done.",
          providerMetadata: {
            openai: { itemId: "msg_final", phase: "final_answer" },
          },
        },
        { type: "reasoning", text: "internal" },
      ],
    });

    expect(result.textParts).toEqual([
      {
        text: "Done.",
        phase: "final_answer",
        providerOptions: {
          openai: { itemId: "msg_final", phase: "final_answer" },
        },
      },
    ]);
  });
});

describe("provider errors", () => {
  it("maps subscription failures without leaking provider details", () => {
    const cases = [
      ["subscription_unavailable", "client"],
      ["subscription_login_required", "auth"],
      ["subscription_login_failed", "auth"],
      ["subscription_reauthentication_required", "auth"],
      ["subscription_entitlement_denied", "auth"],
      ["subscription_quota_exhausted", "quota"],
      ["subscription_transport_refused", "client"],
      ["subscription_in_use", "client"],
    ] as const;

    for (const [code, kind] of cases) {
      const error = Object.assign(new Error("provider secret detail"), { code });
      const mapped = toProviderError(error, { streamStarted: true });
      expect(mapped.kind).toBe(kind);
      expect(mapped.streamStarted).toBe(true);
      expect(mapped.message).not.toContain("provider secret detail");
    }

    const unknown = toProviderError(
      Object.assign(new Error("provider secret detail"), { code: "subscription_unknown" }),
    );
    expect(unknown.kind).toBe("client");
  });

  it("maps HTTP details, redacts secrets, and preserves partial attempt usage", () => {
    const error = new APICallError({
      message: "request failed",
      url: "https://example.test/v1",
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: { "retry-after": "2" },
      responseBody: JSON.stringify({ error: { message: "Bearer sk-secret overloaded" } }),
      isRetryable: true,
    });
    const mapped = toProviderError(error, {
      streamStarted: true,
      partialUsage: {
        input_tokens: 5,
        output_tokens: 1,
        cached_tokens: 0,
        cache_write_tokens: 0,
      },
    });
    expect(mapped).toBeInstanceOf(ProviderError);
    expect(mapped.kind).toBe("transient");
    expect(mapped.retryAfterMs).toBe(2000);
    expect(mapped.message).not.toContain("sk-secret");
    expect(mapped.streamStarted).toBe(true);
    expect(mapped.partialUsage?.input_tokens).toBe(5);
  });

  it("maps a transport failure without leaking its message", () => {
    const mapped = toProviderError(new Error("fetch failed at secret-host.internal"));
    expect(mapped.kind).toBe("transient");
    expect(mapped.message).toBe("Model call failed (transport error).");
  });

  describe("an error the provider delivered inside a 200 stream", () => {
    const rateLimit = {
      code: 429,
      message: "gpt-5.6-luna is temporarily rate-limited upstream. Please retry shortly.",
      metadata: { error_type: "rate_limit_exceeded" },
    };

    it("classifies the payload's own status rather than defaulting to client", () => {
      const mapped = toProviderError(rateLimit);
      expect(mapped.kind).toBe("transient");
      expect(mapped.status).toBe(429);
      expect(mapped.message).toContain("HTTP 429");
      expect(mapped.message).toContain("rate-limited upstream");
    });

    it("reads the payload wrapped under an 'error' key too", () => {
      const mapped = toProviderError({ error: rateLimit });
      expect(mapped.kind).toBe("transient");
      expect(mapped.status).toBe(429);
    });

    it("keeps a permanent status permanent", () => {
      const mapped = toProviderError({ code: 401, message: "Invalid API key" });
      expect(mapped.kind).toBe("auth");
      expect(mapped.status).toBe(401);
      expect(mapped.message).toContain("Invalid API key");
    });

    it("redacts a secret the payload carried", () => {
      const mapped = toProviderError({ code: 400, message: "Bearer sk-secret rejected" });
      expect(mapped.message).not.toContain("sk-secret");
    });

    it("leaves a genuine transport error on the transport path", () => {
      const errno = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
      const mapped = toProviderError(errno);
      expect(mapped.status).toBeUndefined();
      expect(mapped.message).toBe("Model call failed (transport error).");
    });

    it("ignores an object that carries no message to report", () => {
      const mapped = toProviderError({ code: 429 });
      expect(mapped.message).toBe("Model call failed (transport error).");
    });
  });

  it("owns provider explanations, status guidance and secret redaction", () => {
    const apiError = (statusCode: number, responseBody?: string) =>
      new APICallError({
        message: "request failed",
        url: "https://secret-host.test/v1",
        requestBodyValues: {},
        statusCode,
        ...(responseBody !== undefined ? { responseBody } : {}),
        isRetryable: statusCode >= 500,
      });
    expect(toProviderError(apiError(402)).message).toBe(
      "Payment required (HTTP 402) — check your provider credits or billing.",
    );
    expect(
      toProviderError(
        apiError(402, JSON.stringify({ error: { message: "Insufficient credits." } })),
      ).message,
    ).toBe("Payment required (HTTP 402): Insufficient credits.");
    expect(toProviderError(apiError(401))).toMatchObject({
      kind: "auth",
      message:
        "Authentication failed (HTTP 401) — check the API key and that it can access this model.",
    });
    expect(toProviderError(apiError(502)).message).toBe(
      "Provider server error (HTTP 502) — the provider had a server-side error.",
    );
    const redacted = toProviderError(
      apiError(
        400,
        JSON.stringify({ error: { message: "Invalid key sk-abcdef0123456789ABCDEF supplied." } }),
      ),
    );
    expect(redacted.message).toContain("sk-[redacted]");
    expect(redacted.message).not.toContain("sk-abcdef0123456789ABCDEF");

    const expected = new Map<number, string>([
      [403, "Access forbidden (HTTP 403) — check the API key and that it can access this model."],
      [404, "Not found (HTTP 404) — check the model id and provider endpoint."],
      [408, "Request timeout (HTTP 408)."],
      [413, "Request too large (HTTP 413) — the request exceeded the provider's size limit."],
      [429, "Rate limited (HTTP 429) — too many requests; retrying may help."],
    ]);
    for (const [status, message] of expected) {
      expect(toProviderError(apiError(status)).message).toBe(message);
    }
  });

  it("owns body-message extraction variants and reason bounding", () => {
    const mapped = (responseBody: unknown) =>
      toProviderError(
        new APICallError({
          message: "bad request",
          url: "https://example.test/v1",
          requestBodyValues: {},
          statusCode: 400,
          responseBody: responseBody as string,
          isRetryable: false,
        }),
      ).message;
    expect(mapped(JSON.stringify({ message: "top-level" }))).toContain("top-level");
    expect(mapped(JSON.stringify({ error: "plain error" }))).toContain("plain error");
    expect(mapped({ error: { message: "decoded object" } })).toContain("decoded object");
    expect(mapped("plain body")).toContain("plain body");
    const bounded = mapped(
      JSON.stringify({ error: { message: "provider explanation ".repeat(30) } }),
    );
    expect(bounded.length).toBeLessThanOrEqual(224);
    expect(bounded).toEndWith("…");
  });
});

describe("openai-compatible request transforms", () => {
  it("owns body extras, null deletion and the forbidden-key denylist", () => {
    const base = { messages: ["kept"], model: "m", stream_options: { include_usage: true } };
    expect(applyBodyExtras(base, undefined)).toBe(base);
    expect(
      applyBodyExtras(base, {
        messages: ["hijacked"],
        model: "other",
        stream_options: null,
        session_id: "kept",
      }),
    ).toEqual({ messages: ["kept"], model: "m", session_id: "kept" });
  });

  it("owns cache-marker placement and unconditional sentinel stripping", () => {
    const body = {
      messages: [
        {
          role: "user",
          [CACHE_MARKER_KEY]: true,
          content: [
            { type: "text", text: "first" },
            { type: "image_url", image_url: { url: "x" } },
            { type: "text", text: "last", [CACHE_MARKER_KEY]: true },
          ],
        },
      ],
    };
    const out = applyCacheControlMarkers(body);
    expect(JSON.stringify(out)).not.toContain(CACHE_MARKER_KEY);
    const parts = (out.messages as Array<{ content: Array<{ cache_control?: unknown }> }>)[0]!
      .content;
    expect(parts.map((part) => part.cache_control !== undefined)).toEqual([false, false, true]);
  });

  it("never rewrites tool or tool-calling assistant content while stripping markers", () => {
    const messages = [
      {
        role: "tool",
        [CACHE_MARKER_KEY]: true,
        content: "tool result",
      },
      {
        role: "assistant",
        [CACHE_MARKER_KEY]: true,
        content: "I will call it",
        tool_calls: [{ id: "c1" }],
      },
    ];
    const out = applyCacheControlMarkers({ messages }).messages as typeof messages;
    expect(out.map((message) => message.content)).toEqual(["tool result", "I will call it"]);
    expect(JSON.stringify(out)).not.toContain(CACHE_MARKER_KEY);
  });

  it("drops markers from unmarkable content and leaves unmarked bodies by identity", () => {
    const plain = { messages: [{ role: "user", content: "hello" }] };
    expect(applyCacheControlMarkers(plain)).toBe(plain);
    expect(applyCacheControlMarkers({ model: "m" })).toEqual({ model: "m" });
    const out = applyCacheControlMarkers({
      messages: [
        null,
        "odd",
        { role: "assistant", [CACHE_MARKER_KEY]: true, content: null },
        {
          role: "user",
          [CACHE_MARKER_KEY]: true,
          content: [{ type: "image_url", image_url: { url: "x" } }],
        },
      ],
    });
    expect(JSON.stringify(out)).not.toContain(CACHE_MARKER_KEY);
  });

  it("owns settings defaults and missing endpoint classification", () => {
    const cfg = { kind: "openai-compatible" as const, baseUrl: "https://example.test/v1" };
    const settings = openAICompatibleSettings(cfg, undefined, undefined);
    expect(settings).toMatchObject({
      name: "openai-compatible",
      baseURL: "https://example.test/v1",
      includeUsage: true,
    });
    expect("apiKey" in settings).toBe(false);
    expect("headers" in settings).toBe(false);
    expect(() =>
      openAICompatibleSettings({ kind: "openai-compatible" }, undefined, undefined),
    ).toThrow(ProviderError);
  });

  it("owns configured-header resolution and error classification", () => {
    expect(resolveConfiguredHeaders(undefined, () => "value")).toBeUndefined();
    expect(
      resolveConfiguredHeaders({ Authorization: "Bearer ${TOKEN}" }, (name) =>
        name === "TOKEN" ? "secret" : undefined,
      ),
    ).toEqual({ Authorization: "Bearer secret" });
    expect(() =>
      resolveConfiguredHeaders({ Authorization: "${MISSING}" }, () => undefined),
    ).toThrow(
      expect.objectContaining({ kind: "client", message: expect.stringContaining("MISSING") }),
    );
    const boom = new TypeError("vault unavailable");
    expect(() =>
      resolveConfiguredHeaders({ Authorization: "${TOKEN}" }, () => {
        throw boom;
      }),
    ).toThrow(boom);
  });
});
