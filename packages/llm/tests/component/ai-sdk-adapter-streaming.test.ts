import { afterEach, describe, it, expect, beforeEach, vi } from "../helpers/bun-test.ts";
import { streamText as realStreamText } from "ai";
import { AiSdkAdapter } from "@clarvis/llm/adapter";
import { ProviderError, type LLMCallParams } from "@clarvis/capability";
import { bridgeModelCallTimeout } from "../../src/model-call-timeout-bridge.ts";

const mockStream = vi.fn();
const mockGenerate = vi.fn();

type Part =
  | { type: "text-start"; id: string; providerMetadata?: Record<string, Record<string, unknown>> }
  | {
      type: "text-delta";
      id: string;
      text: string;
      providerMetadata?: Record<string, Record<string, unknown>>;
    }
  | { type: "text-end"; id: string; providerMetadata?: Record<string, Record<string, unknown>> }
  | { type: "reasoning-delta"; id: string; text: string }
  | { type: "tool-input-start"; id: string; toolName: string }
  | { type: "tool-input-delta"; id: string; delta: string }
  | { type: "tool-input-end"; id: string }
  | { type: "error"; error: unknown };

function fakeStream(
  opts: {
    parts: Part[];
    text?: string;
    toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>;
    reasoningText?: string;
    finishReason?: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
  },
  callbacks: {
    onEnd?: (event: unknown) => unknown;
    onStepEnd?: (event: unknown) => unknown;
    onError?: (event: { error: unknown }) => unknown;
  } = {},
): unknown {
  const usage = {
    inputTokens: opts.usage?.inputTokens ?? 0,
    outputTokens: opts.usage?.outputTokens ?? 0,
    inputTokenDetails: {
      cacheReadTokens: opts.usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: opts.usage?.cacheWriteTokens ?? 0,
    },
  };
  async function* gen(): AsyncGenerator<Part> {
    await callbacks.onStepEnd?.({ usage });
    for (const p of opts.parts) yield p;
    if (!opts.parts.some((part) => part.type === "error")) {
      await callbacks.onEnd?.({
        text: opts.text ?? "",
        toolCalls: opts.toolCalls ?? [],
        usage,
        reasoningText: opts.reasoningText,
        finishReason: opts.finishReason,
      });
    }
  }
  return {
    stream: gen(),
    get text(): never {
      throw new Error("aggregate getter must not be consumed");
    },
    get toolCalls(): never {
      throw new Error("aggregate getter must not be consumed");
    },
    get usage(): never {
      throw new Error("aggregate getter must not be consumed");
    },
  };
}

function adapter(
  config: ConstructorParameters<typeof AiSdkAdapter>[0] = {},
): InstanceType<typeof AiSdkAdapter> {
  return new AiSdkAdapter({ ...config, generateText: mockGenerate, streamText: mockStream });
}

type Delta = { channel: "text" | "reasoning"; text: string; reset: boolean };

function params(over: Partial<LLMCallParams> = {}): LLMCallParams {
  return {
    provider: "openai-compatible",
    providerConfig: { kind: "openai-compatible", baseUrl: "http://endpoint.local/v1" },
    model: "acme/test-model",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    ...over,
  };
}

beforeEach(() => {
  mockGenerate.mockReset();
  mockGenerate.mockResolvedValue({
    text: "x",
    toolCalls: [],
    reasoningText: undefined,
    finishReason: "stop",
    usage: { inputTokens: 0, outputTokens: 0, inputTokenDetails: {} },
  } as never);
  mockStream.mockReset();
  mockStream.mockImplementation(realStreamText as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AiSdkAdapter — streaming path", () => {
  it("streams ChatGPT subscription calls even without a delta consumer", async () => {
    mockStream.mockImplementation(
      (callbacks) =>
        fakeStream(
          {
            parts: [
              {
                type: "text-start",
                id: "review",
                providerMetadata: {
                  openai: { itemId: "msg_review", phase: "commentary" },
                },
              },
              { type: "text-delta", id: "review", text: "reviewing" },
              { type: "text-end", id: "review" },
            ],
            text: "reviewing",
            toolCalls: [
              { toolCallId: "decision-1", toolName: "decide", input: { decision: "allow" } },
            ],
            finishReason: "tool-calls",
            usage: { inputTokens: 12, outputTokens: 4 },
          },
          callbacks,
        ) as never,
    );
    const subject = adapter({
      resolveSubscription: async (scheme) => ({
        scheme,
        apply: async () => new Response(null, { status: 200 }),
      }),
    });

    const result = await subject.call(
      params({
        provider: "chatgpt",
        providerConfig: { kind: "openai-codex" },
        model: "gpt-codex",
      }),
    );

    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockStream).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      billing_source: "subscription",
      toolCalls: [{ id: "decision-1", name: "decide", arguments: { decision: "allow" } }],
      textParts: [
        {
          text: "reviewing",
          phase: "commentary",
          providerOptions: {
            openai: { itemId: "msg_review", phase: "commentary" },
          },
        },
      ],
    });
  });

  it("forwards text, reasoning and tool-input activity while returning one aggregate result", async () => {
    mockStream.mockImplementation(
      (callbacks) =>
        fakeStream(
          {
            parts: [
              { type: "reasoning-delta", id: "r", text: "think" },
              { type: "text-delta", id: "t", text: "Hello " },
              { type: "text-delta", id: "t", text: "world" },
              { type: "tool-input-start", id: "c1", toolName: "write_file" },
              { type: "tool-input-delta", id: "c1", delta: "abc" },
              { type: "tool-input-end", id: "c1" },
            ],
            text: "Hello world",
            reasoningText: "think",
            finishReason: "tool-calls",
            usage: { inputTokens: 9, outputTokens: 4, cacheReadTokens: 2 },
          },
          callbacks,
        ) as never,
    );

    const deltas: Delta[] = [];
    const toolInput: Array<{
      call_id: string;
      tool_name: string;
      chars: number;
      complete?: true;
    }> = [];
    const res = await adapter().call(
      params({
        onStreamDelta: (d) => deltas.push(d),
        onToolInputDelta: (d) => toolInput.push(d),
      }),
    );

    expect(res.text).toBe("Hello world");
    expect(res.reasoning).toBe("think");
    expect(res.usage).toEqual({
      input_tokens: 9,
      output_tokens: 4,
      cached_tokens: 2,
      cache_write_tokens: 0,
    });
    expect(res.finishReason).toBe("tool-calls");
    expect(toolInput).toEqual([
      { call_id: "c1", tool_name: "write_file", chars: 0 },
      { call_id: "c1", tool_name: "write_file", chars: 3, complete: true },
    ]);

    const joined = (ch: Delta["channel"]): string =>
      deltas
        .filter((d) => d.channel === ch)
        .map((d) => d.text)
        .join("");
    expect(joined("reasoning")).toBe("think");
    expect(joined("text")).toBe("Hello world");

    expect(deltas.filter((d) => d.channel === "text" && d.reset)).toHaveLength(1);
    expect(deltas.filter((d) => d.channel === "reasoning" && d.reset)).toHaveLength(1);
    expect(deltas.find((d) => d.channel === "text")!.reset).toBe(true);
  });

  it("maps a mid-stream error with attempt usage and stream-start state", async () => {
    mockStream.mockImplementation(
      (callbacks) =>
        fakeStream(
          {
            parts: [
              { type: "text-delta", id: "t", text: "partial" },
              { type: "error", error: new Error("stream boom") },
            ],
            usage: { inputTokens: 9, outputTokens: 2 },
          },
          callbacks,
        ) as never,
    );
    await expect(adapter().call(params({ onStreamDelta: () => {} }))).rejects.toMatchObject({
      streamStarted: true,
      partialUsage: { input_tokens: 9, output_tokens: 2 },
    });
  });

  it("maps an SDK onError callback to a ProviderError", async () => {
    mockStream.mockImplementation((options: { onError: (event: { error: unknown }) => void }) => {
      options.onError({ error: new Error("callback boom") });
      return fakeStream({ parts: [] }, options);
    });
    await expect(adapter().call(params({ onStreamDelta: () => {} }))).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it("takes the streaming path only when a delta sink is supplied", async () => {
    mockStream.mockImplementation(
      (callbacks) => fakeStream({ parts: [], text: "x" }, callbacks) as never,
    );
    await adapter().call(params());
    expect(mockStream).not.toHaveBeenCalled();
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it("classifies a streamed timeout without waiting for wall clock", async () => {
    vi.useFakeTimers({ now: 1_000 });
    mockStream.mockImplementation((options: { abortSignal?: AbortSignal }) => {
      async function* parts(): AsyncGenerator<Part> {
        yield await new Promise<Part>((_resolve, reject) => {
          options.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      }
      return {
        stream: parts(),
      } as never;
    });

    const pending = adapter().call(params({ onStreamDelta: () => {}, timeoutMs: 25 }));
    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).rejects.toMatchObject({
      kind: "transient",
      message: expect.stringContaining("per-call timeout"),
    });
  });

  it("lets an active stream outlive the timeout while every inter-part gap stays below it", async () => {
    vi.useFakeTimers({ now: 1_000 });
    mockStream.mockImplementation(
      (callbacks: { onEnd?: (event: unknown) => unknown; abortSignal?: AbortSignal }) => {
        async function* parts(): AsyncGenerator<Part> {
          yield { type: "tool-input-start", id: "c1", toolName: "write_file" };
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
          yield { type: "tool-input-delta", id: "c1", delta: "still streaming" };
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
          yield { type: "tool-input-end", id: "c1" };
          await callbacks.onEnd?.({
            text: "",
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1, inputTokenDetails: {} },
            finishReason: "tool-calls",
          });
        }
        return { stream: parts() } as never;
      },
    );

    const pending = adapter().call(
      params({ timeoutMs: 25, onStreamDelta: () => {}, onToolInputDelta: () => {} }),
    );
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toMatchObject({
      finishReason: "tool-calls",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });

  it("lets admission cleanup disarm a pending stream inactivity timer", async () => {
    vi.useFakeTimers({ now: 1_000 });
    let releaseStream: () => void = () => {};
    let receivedSignal: AbortSignal | undefined;
    mockStream.mockImplementation(
      (callbacks: { onEnd?: (event: unknown) => unknown; abortSignal?: AbortSignal }) => {
        receivedSignal = callbacks.abortSignal;
        async function* parts(): AsyncGenerator<Part> {
          await new Promise<void>((resolve) => {
            releaseStream = resolve;
          });
          yield { type: "text-start", id: "answer" };
          await callbacks.onEnd?.({
            text: "done",
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1, inputTokenDetails: {} },
            finishReason: "stop",
          });
        }
        return { stream: parts() } as never;
      },
    );
    const bridged = bridgeModelCallTimeout(params({ timeoutMs: 25, onStreamDelta: () => {} }));

    const pending = adapter().call(bridged.params);
    expect(receivedSignal).toBeDefined();
    bridged.bridge.cleanup();
    await vi.advanceTimersByTimeAsync(100);

    expect(receivedSignal?.aborted).toBe(false);
    releaseStream();
    await expect(pending).resolves.toMatchObject({
      text: "done",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });

  it("uses a non-cumulative partial output and never reads aggregate getters", async () => {
    mockStream.mockImplementation(
      (callbacks) =>
        fakeStream(
          { parts: [{ type: "text-delta", id: "t", text: "abc" }], text: "abc" },
          callbacks,
        ) as never,
    );
    await expect(adapter().call(params({ onStreamDelta: () => {} }))).resolves.toMatchObject({
      text: "abc",
    });
    const output = (
      mockStream.mock.calls[0]![0] as {
        output: { parsePartialOutput: (v: { text: string }) => Promise<{ partial: number }> };
      }
    ).output;
    await expect(
      output.parsePartialOutput({ text: "a very long cumulative prefix" }),
    ).resolves.toEqual({
      partial: 29,
    });
  });

  it("counts tool-input output as a started stream even before prose arrives", async () => {
    mockStream.mockImplementation(
      (callbacks) =>
        fakeStream(
          {
            parts: [
              { type: "tool-input-start", id: "c", toolName: "write_file" },
              { type: "error", error: new Error("broken") },
            ],
          },
          callbacks,
        ) as never,
    );
    await expect(adapter().call(params({ onStreamDelta: () => {} }))).rejects.toMatchObject({
      streamStarted: true,
    });
  });

  it("marks the admission timeout bridge after tool-input output starts", async () => {
    mockStream.mockImplementation(
      (callbacks) =>
        fakeStream(
          {
            parts: [
              { type: "tool-input-start", id: "c", toolName: "write_file" },
              { type: "tool-input-end", id: "c" },
            ],
            finishReason: "tool-calls",
          },
          callbacks,
        ) as never,
    );
    const bridged = bridgeModelCallTimeout(
      params({ onStreamDelta: () => {}, onToolInputDelta: () => {} }),
    );

    await adapter().call(bridged.params);

    expect(bridged.bridge.markTimedOut(25)).toMatchObject({ streamStarted: true });
    bridged.bridge.cleanup();
  });
});
