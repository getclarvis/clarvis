import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import type { LLMCallParams, LLMCallResult } from "@clarvis/loop";
import {
  createModelBroker,
  type GuestModelRequest,
  type HostModelResult,
} from "../../src/runtime/authority-brokers.ts";
import { createExecutionPeer } from "../../src/runtime/execution-rpc.ts";
import { streamHostModelCall } from "../../src/runtime/model-stream.ts";
import { runtimeModelPairs } from "../../src/runtime/local-container-runtime.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("runtime model stream", () => {
  it.each(["success", "failure"])(
    "delivers partial deltas before provider %s and keeps the terminal result separate",
    async (outcome) => {
      const gate = deferred();
      const received = deferred();
      const events: unknown[] = [];
      const result = { text: "complete" } as unknown as LLMCallResult;
      const broker = createModelBroker(
        {
          id: "lease",
          generation: "gen",
          runId: "run",
          provider: "openai",
          model: "model",
          destination: new URL("https://api.openai.com"),
          expiresAt: Date.now() + 60_000,
          maxConcurrent: 1,
          maxInputBytes: 4096,
          maxOutputBytes: 4096,
        },
        (_request, authority) =>
          streamHostModelCall(
            {
              async call(params) {
                params.onStreamDelta?.({ channel: "reasoning", text: "thinking", reset: false });
                params.onStreamDelta?.({ channel: "text", text: "partial", reset: false });
                await gate.promise;
                if (outcome === "failure") throw new Error("provider failed after output");
                return result;
              },
            },
            { signal: authority.signal } as LLMCallParams,
            4096,
          ),
      );
      const toHost = new PassThrough();
      const toGuest = new PassThrough();
      const host = createExecutionPeer({
        role: "host",
        generation: "gen",
        input: toHost,
        output: toGuest,
        handlers: {
          "host.model": (request) =>
            broker.execute(
              { generation: request.generation, runId: request.runId!, callId: request.callId! },
              request.payload as GuestModelRequest,
              request.signal,
              request.emit,
            ),
        },
      });
      const guest = createExecutionPeer({
        role: "guest",
        generation: "gen",
        input: toGuest,
        output: toHost,
        handlers: {},
      });
      let settled = false;
      const call = guest.request<HostModelResult>(
        "host.model",
        { generation: "gen", runId: "run", callId: "call" },
        {
          leaseId: "lease",
          provider: "openai",
          model: "model",
          requestId: "call",
          body: {},
        },
        {
          onEvent(event) {
            events.push(event);
            if (events.length === 2) received.resolve();
          },
        },
      );
      void call.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        await received.promise;
        expect(settled).toBe(false);
        expect(events).toEqual([
          { type: "stream", channel: "reasoning", text: "thinking", reset: false },
          { type: "stream", channel: "text", text: "partial", reset: false },
        ]);
        gate.resolve();
        if (outcome === "failure")
          await expect(call).rejects.toThrow("provider failed after output");
        else expect((await call).events).toEqual([{ type: "result", result }]);
        expect(events).toHaveLength(2);
        expect(guest.closed).toBe(false);
      } finally {
        gate.resolve();
        broker.revoke();
        guest.close();
        host.close();
      }
    },
  );

  it("bounds a synchronous producer and aborts it without unbounded buffering", async () => {
    let producerSignal: AbortSignal | undefined;
    const stream = streamHostModelCall(
      {
        async call(params) {
          producerSignal = params.signal;
          for (let i = 0; i < 1000; i++)
            params.onStreamDelta?.({ channel: "text", text: "x".repeat(128), reset: false });
          return {} as LLMCallResult;
        },
      },
      {} as LLMCallParams,
      256,
    );
    const events: unknown[] = [];
    await expect(
      (async () => {
        for await (const event of stream) events.push(event);
      })(),
    ).rejects.toMatchObject({ code: "resource_exhausted" });
    expect(events.length).toBeLessThan(2);
    expect(producerSignal?.aborted).toBe(true);
  });

  it("cancels a stalled provider even when it ignores abort", async () => {
    const controller = new AbortController();
    const started = deferred();
    const gate = deferred();
    const stream = streamHostModelCall(
      {
        async call() {
          started.resolve();
          await gate.promise;
          return {} as LLMCallResult;
        },
      },
      { signal: controller.signal } as LLMCallParams,
      256,
    );
    const result = (async () => {
      for await (const _event of stream) {
        expect.unreachable("the cancelled provider emits no deltas");
      }
    })();
    void result.catch(() => undefined);
    await started.promise;
    controller.abort(new Error("cancelled"));
    await expect(result).rejects.toThrow("cancelled");
    gate.resolve();
  });

  it("admits only the exact profile, vision and resolved auto-judge models", () => {
    const body = {
      profiles: [{ model: "chat/main" }],
      vision_model: "vision/image/model",
      guard_mode: "auto",
      guard_judge: { prompt: "review" },
    };
    expect([...runtimeModelPairs(body, { defaultModel: "judge/default" })]).toEqual([
      "chat\0main",
      "vision\0image/model",
      "judge\0default",
    ]);
    expect([
      ...runtimeModelPairs(
        { ...body, guard_judge: { model: "judge/override" } },
        { defaultModel: "judge/default" },
      ),
    ]).toEqual(["chat\0main", "vision\0image/model", "judge\0override"]);
    expect([
      ...runtimeModelPairs({ ...body, guard_mode: "on" }, { defaultModel: "judge/default" }),
    ]).toEqual(["chat\0main", "vision\0image/model"]);
    expect([...runtimeModelPairs({ profiles: [{ model: "invalid" }, {}] }, {})]).toEqual([]);
    expect([
      ...runtimeModelPairs(
        { profiles: [], guard_mode: "auto" },
        {
          defaultModel: "judge/default",
          effect_review: { model: "reviewer/configured" },
        },
      ),
    ]).toEqual(["reviewer\0configured"]);
    expect([
      ...runtimeModelPairs(
        { profiles: [], guard_mode: "auto" },
        {
          defaultModel: "judge/default",
        },
      ),
    ]).toEqual(["judge\0default"]);
  });
});
