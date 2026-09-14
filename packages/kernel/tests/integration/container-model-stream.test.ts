import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { LLMCallParams, LLMCallResult, ModelExecutionInfo } from "@clarvis/capability";
import { ProviderError } from "@clarvis/capability";
import { createContainerChannel } from "../../src/hosting/container-channel.ts";
import { createStdioTransport, serveKernelOverStdio } from "../../src/transport/stdio.ts";
import { createContainerModelBroker } from "../../src/runtime/model-broker-host.ts";
import { createContainerModelProvider } from "../../src/runtime/model-broker-client.ts";

test("client fences wrong call IDs, gaps, duplicate deltas, terminal mismatch and late deltas", async () => {
  for (const fault of ["callId", "gap", "duplicate", "terminal", "late"] as const) {
    const a = new PassThrough();
    const b = new PassThrough();
    let late: (() => Promise<void>) | undefined;
    const server = serveKernelOverStdio(
      {
        connect(send) {
          return {
            async handle(_method, params) {
              const { callId } = params as { callId: string };
              const delta = {
                callId,
                sequence: 1,
                event: {
                  type: "stream",
                  delta: { channel: "text", text: "original", reset: true },
                },
              };
              late = async () => {
                await send("model.delta", delta);
              };
              if (fault === "callId")
                await send("model.delta", {
                  ...delta,
                  callId: "00000000-0000-4000-8000-000000000000",
                });
              if (fault === "gap") await send("model.delta", { ...delta, sequence: 2 });
              if (fault === "duplicate") {
                await send("model.delta", delta);
                await send("model.delta", delta);
              }
              return { callId, lastSequence: fault === "terminal" ? 1 : 0, result };
            },
            close() {},
          };
        },
      },
      { input: a, output: b },
    );
    const transport = createStdioTransport({ input: b, output: a });
    const provider = createContainerModelProvider({
      transport,
      leaseId: "0".repeat(64),
      generation: "00000000-0000-4000-8000-000000000000",
      context: { current: () => ({ runId: "native-run", purpose: "generation" }) },
    });
    const params = { provider: "host", model: "model", messages: [], tools: [] };
    try {
      if (fault === "late") {
        expect(await provider.call(params)).toEqual(result);
        await late!();
        await expect(provider.call(params)).rejects.toMatchObject({ code: "unavailable" });
      } else await expect(provider.call(params)).rejects.toMatchObject({ code: "unavailable" });
    } finally {
      server.close();
      await transport.close();
      a.destroy();
      b.destroy();
    }
  }
});

const target: ModelExecutionInfo = {
  provider: "subscription-alias",
  model: "entitled-model",
  kind: "openai-codex",
  contextWindowTokens: 1_000,
  capabilities: [],
  reasoningEfforts: [],
  promptCache: "implicit",
};
const result: LLMCallResult = {
  text: "text\u001b secret=opaque-replay",
  reasoning: "reason",
  finishReason: "stop",
  billing_source: "subscription",
  cacheUsageKnown: true,
  usage: { input_tokens: 20, output_tokens: 4, cached_tokens: 18, cache_write_tokens: 2 },
  retriedUsage: { input_tokens: 20, output_tokens: 1, cached_tokens: 18, cache_write_tokens: 0 },
  requestPrefix: { previousItems: 1, currentItems: 2, divergence: { surface: "history", item: 1 } },
  reasoningParts: [
    { text: "reason", providerOptions: { anthropic: { signature: "secret=opaque\u001b" } } },
  ],
  textParts: [
    { text: "text", phase: "final_answer", providerOptions: { openai: { itemId: "opaque" } } },
  ],
  toolCalls: [
    {
      id: "tool",
      name: "lookup",
      arguments: { path: "ordinary-model-data" },
      providerOptions: { openai: { itemId: "item" } },
      malformedArguments: "raw",
      rewrittenFrom: { before: true },
    },
  ],
};

test("public stdio over paired Container lanes preserves all callbacks, cache replay, aliases and subscription results", async () => {
  const a = new PassThrough();
  const b = new PassThrough();
  const host = createContainerChannel({ input: a, output: b });
  const guest = createContainerChannel({ input: b, output: a });
  let seen: LLMCallParams | undefined;
  let calls = 0;
  const broker = createContainerModelBroker({
    owner: "host",
    namespace: "workspace",
    modelCatalog: [target],
    maxConcurrent: 1,
    maxQueued: 1,
    tokenCeiling: 20_000,
    hostMaxRetries: 1,
    maxResponseBytes: 32 * 1024 * 1024,
    maxTimeoutMs: 60_000,
    defaultTimeoutMs: 30_000,
    async resolve(info, attribution) {
      expect(info.provider).toBe("subscription-alias");
      expect(attribution).toMatchObject({
        runId: "native-run",
        sessionId: "session",
        agentInstanceId: "agent",
        purpose: "memory",
      });
      return {
        providerConfig: { kind: "openai-codex", apiKeyEnv: "HOST_ONLY_TEST_KEY" },
        llm: {
          async call(params) {
            calls++;
            seen = params;
            params.onStreamDelta?.({ channel: "text", text: "first", reset: true });
            params.onStreamDelta?.({ channel: "reasoning", text: "thinking", reset: true });
            params.onToolInputDelta?.({
              call_id: "tool",
              tool_name: "lookup",
              chars: 0,
              stream_chars: 13,
            });
            params.onRetry?.({
              attempt: 1,
              maxRetries: 1,
              delayMs: 0,
              kind: "transient",
              message: "retry",
            });
            params.onStreamDelta?.({ channel: "text", text: result.text!, reset: true });
            params.onToolInputDelta?.({
              call_id: "tool",
              tool_name: "lookup",
              chars: 20,
              stream_chars: 33,
              complete: true,
            });
            return result;
          },
        },
      };
    },
  });
  const server = serveKernelOverStdio(broker, host.model, undefined, { strictDirection: true });
  const transport = createStdioTransport(guest.model, undefined, { strictDirection: true });
  const provider = createContainerModelProvider({
    transport,
    leaseId: broker.leaseId,
    generation: broker.generation,
    context: {
      current: () => ({
        runId: "native-run",
        sessionId: "session",
        agentInstanceId: "agent",
        purpose: "memory",
      }),
    },
  });
  const callbacks: unknown[] = [];
  const messages: LLMCallParams["messages"] = [
    {
      role: "assistant",
      content: "prior",
      reasoning: result.reasoningParts!,
      text_parts: result.textParts!,
    },
    { role: "user", content: [{ type: "image", image: "aGVsbG8=", mediaType: "image/png" }] },
  ];
  try {
    await Promise.all([host.ready, guest.ready]);
    const actual = await provider.call({
      provider: target.provider,
      model: target.model,
      messages,
      tools: [],
      providerConfig: { kind: "openai", baseUrl: "https://guest.invalid" },
      promptCacheKey: "secret=stable-cache-key",
      promptCacheTtl: "1h",
      cacheBreakpoints: [0],
      onStreamDelta: (delta) => callbacks.push(delta),
      onToolInputDelta: (delta) => callbacks.push(delta),
      onRetry: (info) => callbacks.push(info),
    });
    expect(actual).toEqual(result);
    expect(callbacks).toHaveLength(6);
    expect(callbacks[4]).toEqual({ channel: "text", text: result.text, reset: true });
    expect(seen?.messages).toEqual(messages);
    expect(seen?.promptCacheKey).toBe("secret=stable-cache-key");
    expect(seen?.cacheBreakpoints).toEqual([0]);
    expect(seen?.providerConfig).toEqual({ kind: "openai-codex", apiKeyEnv: "HOST_ONLY_TEST_KEY" });
    await expect(transport.request("config.get", {})).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(calls).toBe(1);
  } finally {
    server.close();
    await transport.close();
    host.close();
    guest.close();
  }
});

test("provider failures cross stdio as sanitized typed failures without host stack or raw response", async () => {
  const a = new PassThrough();
  const b = new PassThrough();
  const broker = createContainerModelBroker({
    owner: "host",
    namespace: "workspace",
    modelCatalog: [target],
    maxConcurrent: 1,
    maxQueued: 0,
    tokenCeiling: 20_000,
    hostMaxRetries: 0,
    maxResponseBytes: 32 * 1024 * 1024,
    maxTimeoutMs: 60_000,
    defaultTimeoutMs: 30_000,
    async resolve() {
      return {
        providerConfig: { kind: "openai-codex" },
        llm: {
          async call() {
            throw new ProviderError("Authorization: Bearer host-private-token", {
              kind: "auth",
              status: 401,
            });
          },
        },
      };
    },
  });
  const server = serveKernelOverStdio(broker, { input: a, output: b });
  const transport = createStdioTransport({ input: b, output: a });
  const provider = createContainerModelProvider({
    transport,
    leaseId: broker.leaseId,
    generation: broker.generation,
    context: { current: () => ({ runId: "run", purpose: "generation" }) },
  });
  try {
    let error: unknown;
    try {
      await provider.call({
        provider: target.provider,
        model: target.model,
        messages: [],
        tools: [],
      });
    } catch (value) {
      error = value;
    }
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: "auth", status: 401 });
    expect((error as Error).message).not.toContain("host-private-token");
  } finally {
    server.close();
    await transport.close();
    a.destroy();
    b.destroy();
  }
});
