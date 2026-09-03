import { afterEach, beforeEach, describe, expect, it, vi } from "../helpers/bun-test.ts";
import { APICallError } from "ai";
import { AiSdkAdapter } from "@clarvis/llm/adapter";
import {
  createModelCallAdmissionController,
  ModelCallStuckError,
  withModelCallAdmission,
} from "@clarvis/llm";
import {
  ProviderError,
  type LLMCallParams,
  type NamespacedTool,
  type ResolvedProviderConfig,
} from "@clarvis/capability";

const mockGenerate = vi.fn();
const readTool: NamespacedTool = {
  fullName: "fs.read",
  wireName: "fs_read",
  mcpName: "fs",
  toolName: "read",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
};

function rawResult(over: Record<string, unknown> = {}): unknown {
  return {
    text: "answer",
    toolCalls: [],
    reasoningText: undefined,
    usage: {
      inputTokens: 5,
      outputTokens: 3,
      inputTokenDetails: { cacheReadTokens: 1, cacheWriteTokens: 0 },
    },
    ...over,
  };
}

function adapter(
  config: ConstructorParameters<typeof AiSdkAdapter>[0] = {},
  guardrails: ConstructorParameters<typeof AiSdkAdapter>[1] = {},
): InstanceType<typeof AiSdkAdapter> {
  return new AiSdkAdapter({ ...config, generateText: mockGenerate }, guardrails);
}

function params(over: Partial<LLMCallParams> = {}): LLMCallParams {
  return {
    provider: "openai-compatible",
    providerConfig: { kind: "openai-compatible", baseUrl: "https://endpoint.test/v1" },
    model: "acme/model",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    ...over,
  };
}

function lastArgs(): Record<string, unknown> {
  return mockGenerate.mock.calls.at(-1)![0] as Record<string, unknown>;
}

beforeEach(() => {
  mockGenerate.mockReset();
  mockGenerate.mockResolvedValue(rawResult() as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AiSdkAdapter — representative generation composition", () => {
  it("threads one rich request into generateText and normalizes its result", async () => {
    mockGenerate.mockResolvedValue(
      rawResult({
        text: "answer\0",
        reasoningText: "because",
        toolCalls: [{ toolCallId: "c1", toolName: "fs_read", input: { path: "/x" } }],
      }) as never,
    );

    const result = await adapter().call(
      params({
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "hello" },
        ],
        tools: [readTool],
        toolChoice: { type: "function", function: { name: "fs_read" } },
        reasoningEffort: "high",
        promptCacheKey: "run-1",
      }),
    );

    expect(lastArgs()).toMatchObject({
      system: "system",
      toolChoice: { type: "tool", toolName: "fs_read" },
      providerOptions: {
        openaiCompatible: {
          reasoningEffort: "high",
          usage: { include: true },
          prompt_cache_key: "run-1",
        },
      },
      maxRetries: 0,
    });
    expect(result).toMatchObject({
      text: "answer",
      reasoning: "because",
      toolCalls: [{ id: "c1", name: "fs_read", arguments: { path: "/x" } }],
      usage: { input_tokens: 5, output_tokens: 3, cached_tokens: 1 },
    });
  });

  it("selects every provider factory and resolves required keys by configured name", async () => {
    const seen: string[] = [];
    const subject = adapter({
      resolveRegistryKey: (name) => {
        seen.push(name);
        return "secret";
      },
    });
    const configs: ResolvedProviderConfig[] = [
      { kind: "openai", apiKeyEnv: "OPENAI_KEY" },
      { kind: "anthropic", apiKeyEnv: "ANTHROPIC_KEY" },
      { kind: "google", apiKeyEnv: "GOOGLE_KEY" },
      {
        kind: "openai-compatible",
        baseUrl: "https://endpoint.test/v1",
        apiKeyEnv: "COMPAT_KEY",
      },
    ];

    for (const providerConfig of configs) {
      await subject.call(params({ provider: providerConfig.kind, providerConfig }));
    }

    expect(seen).toEqual(["OPENAI_KEY", "ANTHROPIC_KEY", "GOOGLE_KEY", "COMPAT_KEY"]);
    expect(mockGenerate).toHaveBeenCalledTimes(4);
  });

  it("rejects unresolved configuration before generation", async () => {
    await expect(adapter().call(params({ providerConfig: undefined }))).rejects.toMatchObject({
      kind: "client",
    });
    await expect(
      adapter().call(params({ providerConfig: { kind: "anthropic", apiKeyEnv: "MISSING" } })),
    ).rejects.toMatchObject({ kind: "client" });
    await expect(
      adapter().call(params({ providerConfig: { kind: "openai-compatible" } })),
    ).rejects.toMatchObject({ kind: "client" });
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("names the unset variable instead of letting the endpoint answer 401", async () => {
    // `openai-compatible` does not require a key — a local endpoint needs none.
    // But a config that *declares* api_key_env and has it unset used to send an
    // unauthenticated request, and the remote 401 came back as a gateway's
    // cookie-authentication message: neither the variable nor the fact that the
    // cause was local appeared anywhere.
    await expect(
      adapter().call(
        params({
          providerConfig: {
            kind: "openai-compatible",
            baseUrl: "https://endpoint.test/v1",
            apiKeyEnv: "DECLARED_BUT_UNSET",
          },
        }),
      ),
    ).rejects.toThrow(/DECLARED_BUT_UNSET/);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("still allows a keyless openai-compatible endpoint that declares no variable", async () => {
    await expect(
      adapter().call(
        params({
          providerConfig: { kind: "openai-compatible", baseUrl: "https://endpoint.test/v1" },
          model: "local",
        }),
      ),
    ).resolves.toBeDefined();
  });

  it("uses process.env only as the default credential resolver and restores the prior value", async () => {
    const key = "CLARVIS_LLM_COMPONENT_KEY";
    const previous = process.env[key];
    process.env[key] = "from-env";
    try {
      await adapter().call(
        params({ providerConfig: { kind: "anthropic", apiKeyEnv: key }, model: "claude" }),
      );
      expect(mockGenerate).toHaveBeenCalledTimes(1);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  it("strips images only when the resolved model lacks vision", async () => {
    await adapter().call(
      params({
        capabilities: new Set(),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "inspect" },
              { type: "image", image: "data:image/png;base64,AAAA" },
            ],
          },
        ],
      }),
    );
    expect(JSON.stringify(lastArgs().messages)).toContain("active model lacks vision");

    await adapter().call(
      params({
        capabilities: new Set(["vision"]),
        messages: [
          { role: "user", content: [{ type: "image", image: "data:image/png;base64,AAAA" }] },
        ],
      }),
    );
    expect(JSON.stringify(lastArgs().messages)).toContain("data:image/png;base64,AAAA");
  });
});

describe("AiSdkAdapter — timeout, signals and error seam", () => {
  it("passes no signal by default and combines a parent signal with a configured timeout", async () => {
    await adapter().call(params());
    expect(lastArgs().abortSignal).toBeUndefined();

    vi.useFakeTimers({ now: 1_000 });
    const parent = new AbortController().signal;
    await adapter({}, { timeoutMs: 10_000 }).call(params({ signal: parent }));
    expect(lastArgs().abortSignal).toBeDefined();
  });

  it("classifies a generated-call timeout without waiting for wall clock", async () => {
    vi.useFakeTimers({ now: 1_000 });
    mockGenerate.mockImplementation((async (args: { abortSignal?: AbortSignal }) => {
      await new Promise((_resolve, reject) => {
        args.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    }) as never);

    const pending = adapter().call(params({ timeoutMs: 25 }));
    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).rejects.toMatchObject({
      kind: "transient",
      message: expect.stringContaining("per-call timeout"),
    });
  });

  it("keeps a zero timeout disabled when the provider fails", async () => {
    mockGenerate.mockRejectedValueOnce(new Error("transport failed"));

    const failure = (await adapter()
      .call(params({ timeoutMs: 0 }))
      .catch((error: unknown) => error)) as ProviderError;
    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure.message).not.toContain("per-call timeout");
    expect(lastArgs().abortSignal).toBeUndefined();
  });

  it("lets admission observe the adapter's default timeout and release a cooperative permit", async () => {
    vi.useFakeTimers({ now: 1_000 });
    mockGenerate.mockImplementation((async (args: { abortSignal?: AbortSignal }) => {
      await new Promise((_resolve, reject) => {
        args.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    }) as never);
    const admission = createModelCallAdmissionController({
      maxActive: 1,
      maxQueued: 1,
      abortSettleMs: 5,
    });
    const subject = withModelCallAdmission(adapter({}, { timeoutMs: 25 }), admission);

    const pending = subject.call(params());
    await Promise.resolve();
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(25);

    await expect(pending).rejects.toMatchObject({
      kind: "transient",
      message: expect.stringContaining("per-call timeout"),
    });
    expect(admission.snapshot()).toMatchObject({ state: "open", active: 0, quarantined: 0 });
  });

  it("quarantines an adapter transport that ignores its per-call timeout", async () => {
    vi.useFakeTimers({ now: 1_000 });
    let releaseTransport!: (value: unknown) => void;
    mockGenerate.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseTransport = resolve;
        }) as never,
    );
    const admission = createModelCallAdmissionController({
      maxActive: 1,
      maxQueued: 1,
      abortSettleMs: 5,
    });
    const subject = withModelCallAdmission(adapter({}, { timeoutMs: 10_000 }), admission);

    const pending = subject.call(params({ timeoutMs: 25 }));
    await Promise.resolve();
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(25);
    await vi.advanceTimersByTimeAsync(5);

    await expect(pending).rejects.toBeInstanceOf(ModelCallStuckError);
    expect(admission.snapshot()).toMatchObject({
      state: "quarantined",
      active: 1,
      quarantined: 1,
    });

    releaseTransport(rawResult());
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    expect(admission.snapshot()).toMatchObject({ state: "open", active: 0, quarantined: 0 });
  });

  it("rethrows ProviderError and maps one SDK API error plus one transport error", async () => {
    const direct = new ProviderError("bad configuration", { kind: "client" });
    mockGenerate.mockRejectedValueOnce(direct);
    await expect(adapter().call(params())).rejects.toBe(direct);

    mockGenerate.mockRejectedValueOnce(
      new APICallError({
        message: "rate limited",
        url: "https://endpoint.test/v1",
        requestBodyValues: {},
        statusCode: 429,
        responseHeaders: { "retry-after": "2" },
        responseBody: "rate limit",
        isRetryable: true,
      }),
    );
    await expect(adapter().call(params())).rejects.toMatchObject({
      kind: "transient",
      status: 429,
      retryAfterMs: 2_000,
    });

    mockGenerate.mockRejectedValueOnce(new Error("socket hang up at secret-host.test"));
    await expect(adapter().call(params())).rejects.toMatchObject({
      message: "Model call failed (transport error).",
    });
  });
});
