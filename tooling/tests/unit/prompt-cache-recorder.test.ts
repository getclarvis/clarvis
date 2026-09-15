import { describe, expect, it } from "bun:test";
import { CacheBudget } from "../../cache/limits.ts";
import { createCacheRecorder } from "../../cache/recorder.ts";
import {
  cacheHash,
  capturePrompt,
  firstPromptDivergence,
  cacheIdentityFromKey,
} from "../../cache/wire.ts";

const limits = { calls: 4, input: 100000, output: 1000, durationMs: 1000 };
function recorder(fetcher: typeof fetch) {
  return createCacheRecorder(fetcher, {
    scenario: "C01",
    trial: 1,
    sdkVersion: "fixture",
    requestedModel: "gpt-6-astra",
    effort: "medium",
    leaderId: "agent",
    budget: new CacheBudget(limits),
    globalBudget: new CacheBudget(limits),
    phase: () => "growth",
    base: () => 0,
  });
}
const request = {
  model: "gpt-6-astra",
  instructions: "stable",
  input: [{ role: "user", content: "task" }],
  tools: [],
  prompt_cache_key: "session_agent",
};

describe("physical cache evidence", () => {
  it("compares the first request after a process restart against persisted wire hashes", async () => {
    const completed = {
      status: "completed",
      usage: {
        input_tokens: 20000,
        output_tokens: 20,
        input_tokens_details: { cached_tokens: 19000 },
      },
    };
    const fetcher = Object.assign(() => Promise.resolve(Response.json(completed)), {
      preconnect: fetch.preconnect,
    });
    const before = recorder(fetcher);
    await before.fetch("https://chatgpt.com/backend-api/codex/responses", {
      body: JSON.stringify(request),
    });
    await before.drain();
    const restored = createCacheRecorder(fetcher, {
      scenario: "C07",
      trial: 1,
      sdkVersion: "fixture",
      requestedModel: "gpt-6-astra",
      effort: "medium",
      leaderId: "agent",
      budget: new CacheBudget(limits, before.calls),
      globalBudget: new CacheBudget(limits, before.calls),
      previousCalls: JSON.parse(JSON.stringify(before.calls)),
      phase: () => "growth",
      base: () => 0,
      transition: () => "restart",
    });
    await restored.fetch("https://chatgpt.com/backend-api/codex/responses", {
      body: JSON.stringify({
        ...request,
        input: [...request.input, { role: "user", content: "next" }],
      }),
    });
    await restored.drain();
    expect(restored.calls[1]?.divergence).toBeUndefined();
    expect(restored.calls[1]?.iteration).toBe(2);
    expect(restored.calls[1]?.transition).toBe("restart");
    await restored.fetch("https://chatgpt.com/backend-api/codex/responses", {
      body: JSON.stringify(request),
    });
    await restored.drain();
    expect(restored.calls[2]?.divergence).toEqual({ surface: "history", item: 1 });
  });
  it("retains completed usage and tools when the provider stream is aborted after completion", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    const fetcher = Object.assign(() => Promise.resolve(new Response(stream)), {
      preconnect: fetch.preconnect,
    });
    const capture = recorder(fetcher);
    const response = await capture.fetch("https://chatgpt.com/backend-api/codex/responses", {
      body: JSON.stringify({ ...request, stream: true }),
      headers: { "session-id": cacheHash("session_agent"), authorization: "fixture-private" },
    });
    const completed = {
      type: "response.completed",
      response: {
        status: "completed",
        model: "resolved",
        usage: {
          input_tokens: 20000,
          output_tokens: 20,
          input_tokens_details: { cached_tokens: 19000 },
        },
        output: [{ type: "function_call", name: "read_file", call_id: "call-1", id: "fc-1" }],
      },
    };
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(completed)}\n\n`));
    const reader = response.body.getReader();
    await reader.read();
    await Bun.sleep(5);
    controller.error(new DOMException("ended", "AbortError"));
    await capture.drain();
    expect(capture.calls).toHaveLength(1);
    expect(capture.calls[0]).toMatchObject({
      status: "completed",
      usage: { input: 20000, cached: 19000, output: 20 },
      resolvedModel: "resolved",
      toolCalls: [{ name: "read_file", callId: "call-1", itemId: "fc-1" }],
    });
    expect(JSON.stringify(capture.calls)).not.toContain("fixture-private");
  });

  it("counts repeated physical attempts, preserves unknown usage, and stops at its cap", async () => {
    const capture = recorder(
      Object.assign(() => Promise.resolve(new Response("{}", { status: 429 })), {
        preconnect: fetch.preconnect,
      }),
    );
    for (let index = 0; index < 4; index += 1) {
      await capture.fetch("https://chatgpt.com/backend-api/codex/responses", {
        body: JSON.stringify(request),
      });
      await capture.drain();
    }
    await expect(
      capture.fetch("https://chatgpt.com/backend-api/codex/responses", {
        body: JSON.stringify(request),
      }),
    ).rejects.toThrow("limit");
    expect(capture.calls.map((call) => call.attempt)).toEqual([1, 2, 3, 4]);
    expect(capture.calls.every((call) => call.usage === undefined)).toBe(true);
    const recovered = new CacheBudget({ ...limits, calls: 2 });
    recovered.reconcile(capture.calls.slice(0, 2));
    recovered.reconcile(JSON.parse(JSON.stringify(capture.calls)));
    expect(recovered.calls).toHaveLength(4);
    expect(recovered.calls.every((call) => call.usage === undefined)).toBe(true);
    expect(() => recovered.admit()).toThrow("limit");
  });

  it("detects equal-text header moves, schema order, lost metadata and reconstructed seed order", () => {
    const header = { role: "user", content: "same header" };
    const reasoning = { type: "reasoning", id: "rs-1", encrypted_content: "opaque", summary: [] };
    const before = capturePrompt({
      ...request,
      input: [header, reasoning],
      tools: [{ name: "a" }, { name: "b" }],
    });
    expect(
      firstPromptDivergence(before, {
        ...before,
        items: [...before.items, { role: "user", content: "new" }],
      }),
    ).toBeUndefined();
    expect(firstPromptDivergence(before, { ...before, items: [reasoning, header] })).toEqual({
      surface: "history",
      item: 0,
    });
    expect(
      firstPromptDivergence(before, { ...before, tools: [{ name: "b" }, { name: "a" }] }),
    ).toEqual({ surface: "tools" });
    expect(
      firstPromptDivergence(before, {
        ...before,
        items: [header, { ...reasoning, encrypted_content: undefined }],
      }),
    ).toEqual({ surface: "history", item: 1 });
    expect(firstPromptDivergence(before, { ...before, key: "session_other" })).toEqual({
      surface: "identity",
    });
    expect(cacheIdentityFromKey("my:session%5F1_agent-2")).toEqual({
      sessionId: "my:session_1",
      agentInstanceId: "agent-2",
    });
  });
});
