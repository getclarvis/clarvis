import { describe, expect, test } from "bun:test";
import type { streamText } from "ai";
import { NOOP_LOGGER, ProviderError, type LLMCallParams } from "@clarvis/capability";
import { runStreamCall } from "#src/ai-sdk/stream-call.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const usage = {
  inputTokens: 9,
  outputTokens: 2,
  inputTokenDetails: { cacheReadTokens: 1, cacheWriteTokens: 0 },
};

function params(onStreamDelta?: LLMCallParams["onStreamDelta"]): LLMCallParams {
  return {
    provider: "openai-compatible",
    providerConfig: { kind: "openai-compatible", baseUrl: "https://example.test/v1" },
    model: "model",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    ...(onStreamDelta === undefined ? {} : { onStreamDelta }),
  };
}

type Callbacks = {
  onStepEnd?(event: unknown): void;
  onEnd?(event: unknown): void;
};

function synthetic(
  parts: readonly object[],
  options: { gate?: Promise<void>; aggregate?: boolean; text?: string } = {},
): typeof streamText {
  return ((raw: unknown) => {
    const callbacks = raw as Callbacks;
    async function* events() {
      callbacks.onStepEnd?.({ usage });
      for (const part of parts) {
        yield part;
        if (options.gate !== undefined) await options.gate;
      }
      if (options.aggregate !== false)
        callbacks.onEnd?.({
          text: options.text ?? "answer",
          toolCalls: [],
          usage,
          finishReason: "stop",
        });
    }
    return { stream: events() };
  }) as unknown as typeof streamText;
}

function call(
  stream: typeof streamText,
  over: {
    onStreamDelta?: LLMCallParams["onStreamDelta"];
    metrics?: { count(name: string): void };
    timedOut?: () => boolean;
    timeoutMs?: number;
  } = {},
) {
  return runStreamCall({
    params: params(over.onStreamDelta),
    callArgs: {} as Parameters<typeof streamText>[0],
    stream,
    markActivity: () => {},
    timedOut: over.timedOut ?? (() => false),
    logger: NOOP_LOGGER,
    ...(over.metrics === undefined ? {} : { metrics: over.metrics }),
    ...(over.timeoutMs === undefined ? {} : { timeoutMs: over.timeoutMs }),
  });
}

describe("one AI SDK stream call", () => {
  test("overlapping streams retain separate text, deltas and counters", async () => {
    const gate = deferred();
    const firstDeltas: string[] = [];
    const secondDeltas: string[] = [];
    const firstMetrics: string[] = [];
    const secondMetrics: string[] = [];
    const first = call(
      synthetic(
        [
          { type: "text-start", id: "a" },
          { type: "text-delta", id: "a", text: "alpha" },
          { type: "reasoning-delta", id: "a", text: "think" },
        ],
        { gate: gate.promise, text: "alpha" },
      ),
      {
        onStreamDelta: (delta) => firstDeltas.push(`${delta.channel}:${delta.text}`),
        metrics: { count: (name) => void firstMetrics.push(name) },
      },
    );
    const second = call(
      synthetic([{ type: "text-delta", id: "b", text: "beta" }], { text: "beta" }),
      {
        onStreamDelta: (delta) => secondDeltas.push(`${delta.channel}:${delta.text}`),
        metrics: { count: (name) => void secondMetrics.push(name) },
      },
    );
    expect((await second).text).toBe("beta");
    gate.resolve();
    expect((await first).text).toBe("alpha");
    expect(firstDeltas).toEqual(["text:alpha", "reasoning:think"]);
    expect(secondDeltas).toEqual(["text:beta"]);
    expect(firstMetrics).toContain("stream_drained");
    expect(secondMetrics).toContain("stream_drained");
  });

  test("partial usage survives an error and missing aggregate remains a failure", async () => {
    await expect(
      call(
        synthetic(
          [
            { type: "text-delta", id: "a", text: "partial" },
            { type: "error", error: new Error("transport failed") },
          ],
          { aggregate: false },
        ),
      ),
    ).rejects.toMatchObject({
      streamStarted: true,
      partialUsage: { input_tokens: 9, output_tokens: 2 },
    });
    await expect(call(synthetic([], { aggregate: false }))).rejects.toBeInstanceOf(ProviderError);
  });

  test("a streamed provider error retains inactivity classification and partial usage", async () => {
    await expect(
      call(
        synthetic([{ type: "error", error: new Error("socket stalled") }], { aggregate: false }),
        {
          timedOut: () => true,
          timeoutMs: 1_000,
        },
      ),
    ).rejects.toMatchObject({
      name: "ModelCallInactivityError",
      partialUsage: { input_tokens: 9, output_tokens: 2 },
    });
  });

  test("a throwing delta sink and an iterator abort release the call", async () => {
    await expect(
      call(synthetic([{ type: "text-delta", id: "a", text: "hello" }]), {
        onStreamDelta: () => {
          throw new Error("sink failed");
        },
      }),
    ).rejects.toMatchObject({ streamStarted: true });
    const aborted = ((_: unknown) => ({
      stream: (async function* () {
        yield { type: "text-delta", id: "a", text: "hello" };
        throw new DOMException("aborted", "AbortError");
      })(),
    })) as unknown as typeof streamText;
    await expect(call(aborted)).rejects.toBeInstanceOf(ProviderError);
  });
});
