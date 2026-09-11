import { MAX_JSON_MESSAGE_BYTES } from "../../src/core/json-message.ts";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "bun:test";
import { ProviderError, type FailureKind } from "@clarvis/capability";
import {
  createCapabilityBroker,
  type GuestCapabilityRequest,
} from "../../src/runtime/authority-brokers.ts";
import { createElicitBridge } from "../../src/runs/elicit-bridge.ts";
import {
  MAX_EXECUTION_FRAME_BYTES,
  MAX_EXECUTION_QUEUE_FRAMES,
  MAX_EXECUTION_QUEUE_BYTES,
  createExecutionPeer,
  decodeExecutionFrame,
} from "../../src/runtime/execution-rpc.ts";

function pair() {
  const hostInput = new PassThrough();
  const guestInput = new PassThrough();
  return {
    hostInput,
    guestInput,
    hostOutput: guestInput,
    guestOutput: hostInput,
  };
}

describe("private runtime execution RPC", () => {
  it("fragments large model messages and isolates a local refusal from another run", async () => {
    const io = pair();
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const host = createExecutionPeer({
      role: "host",
      generation: "large",
      input: io.hostInput,
      output: io.hostOutput,
      handlers: {
        "host.model": async ({ payload, emit }) => {
          await emit?.(payload);
          return payload;
        },
      },
    });
    const guest = createExecutionPeer({
      role: "guest",
      generation: "large",
      input: io.guestInput,
      output: io.guestOutput,
      handlers: {
        "runtime.start": async () => {
          entered.resolve();
          await gate.promise;
          return "completed";
        },
      },
    });
    try {
      const running = host.request("runtime.start", { generation: "large", runId: "other" });
      await entered.promise;
      const cancellation = new AbortController();
      const refused = host.request(
        "runtime.start",
        { generation: "large", runId: "oversize" },
        "x".repeat(MAX_JSON_MESSAGE_BYTES),
        { signal: cancellation.signal },
      );
      cancellation.abort();
      await expect(refused).rejects.toMatchObject({ code: "resource_exhausted" });
      expect(host.closed).toBe(false);
      expect(guest.closed).toBe(false);
      const body = "context".repeat(1024 * 1024);
      const events: unknown[] = [];
      const result = await guest.request(
        "host.model",
        { generation: "large", runId: "model", callId: "call" },
        { body },
        { onEvent: (value) => events.push(value) },
      );
      expect(result).toEqual({ body });
      expect(events).toEqual([{ body }]);
      gate.resolve();
      expect(await running).toBe("completed");
    } finally {
      gate.resolve();
      host.close();
      guest.close();
    }
  });

  it("returns a bounded error for an excessive handler result and remains reusable", async () => {
    const io = pair();
    const host = createExecutionPeer({
      role: "host",
      generation: "large",
      input: io.hostInput,
      output: io.hostOutput,
      handlers: {},
    });
    const guest = createExecutionPeer({
      role: "guest",
      generation: "large",
      input: io.guestInput,
      output: io.guestOutput,
      handlers: {
        "runtime.bootstrap": async ({ payload }) =>
          payload === "large" ? "x".repeat(MAX_JSON_MESSAGE_BYTES) : "ok",
      },
    });
    try {
      await expect(
        host.request("runtime.bootstrap", { generation: "large" }, "large"),
      ).rejects.toMatchObject({ code: "resource_exhausted" });
      expect(await host.request<string>("runtime.bootstrap", { generation: "large" })).toBe("ok");
    } finally {
      host.close();
      guest.close();
    }
  });

  it("bounds unanswered real host elicitations without aborting admitted requests on saturation", async () => {
    const elicit = createElicitBridge("run");
    let questions = 0;
    elicit.onElicit(() => {
      questions++;
    });
    const broker = createCapabilityBroker({
      generation: "gen",
      runId: "run",
      maxArgumentsBytes: 256 * 1024,
      maxResultBytes: 256 * 1024,
      grants: [
        {
          method: "runtime.elicit",
          revision: "v1",
          idempotent: false,
          validateArguments: () => true,
          invoke: (_input, signal) =>
            elicit.elicit(
              {
                message: "fixture",
                requestedSchema: { type: "object", properties: {}, required: [] },
              },
              { signal, timeoutMs: 60_000 },
            ),
        },
      ],
    });
    const input = new PassThrough();
    const peer = createExecutionPeer({
      role: "host",
      generation: "gen",
      input,
      output: new PassThrough(),
      handlers: {
        "host.capability": (request) =>
          broker.invoke(
            { generation: request.generation, runId: request.runId!, callId: request.callId! },
            request.payload as GuestCapabilityRequest,
            request.signal,
          ),
      },
    });
    try {
      for (let id = 1; id <= MAX_EXECUTION_QUEUE_FRAMES + 10; id++) {
        if (peer.closed) break;
        input.write(
          `${JSON.stringify({
            type: "request",
            id,
            generation: "gen",
            runId: "run",
            callId: `call-${id}`,
            method: "host.capability",
            payload: { method: "runtime.elicit", revision: "v1", arguments: {} },
          })}\n`,
        );
      }
      expect(peer.closed).toBe(false);
      expect(questions).toBe(64);
      let pending = 0;
      elicit.onElicit(() => {
        pending++;
      });
      expect(pending).toBe(64);
      await Bun.sleep(0);
    } finally {
      peer.close();
      broker.revoke();
    }
  });

  it.each(["count", "bytes"])(
    "refuses excess inbound %s before dispatch while preserving admitted handlers",
    async (limit) => {
      const input = new PassThrough();
      const output = new PassThrough();
      const gate = Promise.withResolvers<void>();
      const signals: AbortSignal[] = [];
      const peer = createExecutionPeer({
        role: "host",
        generation: "gen",
        input,
        output,
        handlers: {
          "host.capability": async ({ signal }) => {
            signals.push(signal);
            await gate.promise;
            return null;
          },
        },
      });
      const payload = limit === "bytes" ? "🙂".repeat(512 * 1024) : "";
      const line = (id: number) =>
        `${JSON.stringify({
          type: "request",
          id,
          generation: "gen",
          runId: "run",
          callId: `call-${id}`,
          method: "host.capability",
          payload,
        })}\n`;
      const count = limit === "count" ? MAX_EXECUTION_QUEUE_FRAMES + 10 : 65;
      try {
        output.resume();
        for (let i = 1; i <= count; i++) input.write(line(i));
        await Bun.sleep(0);
        expect(peer.closed).toBe(false);
        expect(signals.length).toBeGreaterThan(0);
        expect(signals.length).toBeLessThan(count);
        if (limit === "count") expect(signals).toHaveLength(MAX_EXECUTION_QUEUE_FRAMES);
        else
          expect(signals.length * Buffer.byteLength(line(1))).toBeLessThanOrEqual(
            MAX_EXECUTION_QUEUE_BYTES,
          );
        expect(signals.every((signal) => !signal.aborted)).toBe(true);
      } finally {
        gate.resolve();
        peer.close();
        await Bun.sleep(0);
      }
    },
  );

  it("releases inbound admission after settlement but retains cancelled handlers that ignore abort", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    let waiting = false;
    let entered = 0;
    const gate = Promise.withResolvers<void>();
    const peer = createExecutionPeer({
      role: "host",
      generation: "gen",
      input,
      output,
      handlers: {
        "host.capability": async () => {
          entered++;
          if (waiting) await gate.promise;
          return null;
        },
      },
    });
    const request = (id: number) =>
      input.write(
        `${JSON.stringify({ type: "request", id, generation: "gen", runId: "run", callId: `call-${id}`, method: "host.capability" })}\n`,
      );
    try {
      for (let id = 1; id <= 300; id++) {
        request(id);
        await Bun.sleep(0);
      }
      expect(peer.closed).toBe(false);
      waiting = true;
      for (let id = 301; id <= 300 + MAX_EXECUTION_QUEUE_FRAMES; id++) {
        request(id);
        input.write(
          `${JSON.stringify({ type: "cancel", id, generation: "gen", runId: "run", callId: `call-${id}` })}\n`,
        );
      }
      expect(peer.closed).toBe(false);
      request(301 + MAX_EXECUTION_QUEUE_FRAMES);
      expect(peer.closed).toBe(false);
      expect(entered).toBe(300 + MAX_EXECUTION_QUEUE_FRAMES);
    } finally {
      gate.resolve();
      peer.close();
      await Bun.sleep(0);
    }
  });

  it.each(["evicted", "mismatched"])(
    "rejects %s completion cancellations after bounded history",
    async (mode) => {
      const input = new PassThrough();
      const output = new PassThrough();
      output.resume();
      const peer = createExecutionPeer({
        role: "host",
        generation: "gen",
        input,
        output,
        handlers: {},
      });
      try {
        for (let id = 1; id <= MAX_EXECUTION_QUEUE_FRAMES + 1; id++) {
          input.write(
            `${JSON.stringify({ type: "request", id, generation: "gen", runId: "run", callId: `call-${id}`, method: "host.capability" })}\n`,
          );
          await Bun.sleep(0);
        }
        expect(peer.closed).toBe(false);
        const id = mode === "evicted" ? 1 : MAX_EXECUTION_QUEUE_FRAMES + 1;
        input.write(
          `${JSON.stringify({ type: "cancel", id, generation: "gen", runId: "run", callId: mode === "evicted" ? "call-1" : "forged" })}\n`,
        );
        expect(peer.closed).toBe(true);
      } finally {
        peer.close();
      }
    },
  );

  it.each(["success", "error", "unavailable"])(
    "tolerates cancellation racing with a written %s response",
    async (mode) => {
      const io = pair();
      const held: string[] = [];
      const second = Promise.withResolvers<void>();
      const host = createExecutionPeer({
        role: "host",
        generation: "gen",
        input: io.hostInput,
        output: new Writable({
          write(chunk, _encoding, done) {
            held.push(chunk.toString());
            done();
          },
        }),
        handlers: {
          ...(mode === "unavailable"
            ? {}
            : {
                "host.capability": async () => {
                  if (mode === "error") throw new Error("completed failure");
                  return { completed: true };
                },
              }),
          "host.event": async () => {
            await second.promise;
            return "unrelated";
          },
        },
      });
      const guest = createExecutionPeer({
        role: "guest",
        generation: "gen",
        input: io.guestInput,
        output: io.guestOutput,
        handlers: {},
      });
      const controller = new AbortController();
      const first = guest.request(
        "host.capability",
        { generation: "gen", runId: "run", callId: "first" },
        {},
        { signal: controller.signal },
      );
      void first.catch(() => undefined);
      const unrelated = guest.request("host.event", { generation: "gen", runId: "run" });
      void unrelated.catch(() => undefined);
      try {
        await Bun.sleep(0);
        expect(held).toHaveLength(1);
        controller.abort();
        await expect(first).rejects.toMatchObject({ code: "cancelled" });
        await Bun.sleep(0);
        expect(host.closed).toBe(false);
        second.resolve();
        await Bun.sleep(0);
        for (const line of held) io.guestInput.write(line);
        await expect(unrelated).resolves.toBe("unrelated");
        expect(guest.closed).toBe(false);
      } finally {
        second.resolve();
        host.close();
        guest.close();
      }
    },
  );

  it.each<FailureKind>([
    "context_overflow",
    "client",
    "transient",
    "auth",
    "quota",
    "content_policy",
  ])("round-trips typed %s failures, recovery fields and failed-attempt usage", async (kind) => {
    const usage = { input_tokens: 13, output_tokens: 2, cached_tokens: 3, cache_write_tokens: 4 };
    const error = new ProviderError("synthetic provider failure", {
      kind,
      status: 400,
      retryAfterMs: 0,
      partialUsage: usage,
      streamStarted: true,
    });
    error.accumulatedUsage = { ...usage, input_tokens: 26 };
    Object.assign(error, {
      headers: { authorization: "private-token" },
      cause: { body: "private-body" },
    });
    const io = pair();
    const wire: string[] = [];
    io.hostOutput.on("data", (chunk: Buffer) => wire.push(chunk.toString()));
    const host = createExecutionPeer({
      role: "host",
      generation: "gen",
      input: io.hostInput,
      output: io.hostOutput,
      handlers: {
        "host.model": async () => {
          throw error;
        },
      },
    });
    const guest = createExecutionPeer({
      role: "guest",
      generation: "gen",
      input: io.guestInput,
      output: io.guestOutput,
      handlers: {},
    });
    try {
      const received = await guest
        .request("host.model", { generation: "gen", runId: "run", callId: "call" })
        .catch((failure: unknown) => failure);
      expect(received).toBeInstanceOf(ProviderError);
      expect(received).toMatchObject({
        kind,
        status: 400,
        retryAfterMs: 0,
        streamStarted: true,
        partialUsage: usage,
        accumulatedUsage: { ...usage, input_tokens: 26 },
      });
      expect(wire.join("")).not.toContain("private-token");
      expect(wire.join("")).not.toContain("private-body");
      expect(wire.join("")).not.toContain("stack");
      expect(guest.closed).toBe(false);
    } finally {
      host.close();
      guest.close();
    }
  });

  it.each([
    { kind: "unknown", streamStarted: false },
    { kind: "client", streamStarted: false, stack: "unexpected" },
    { kind: "client", streamStarted: false, retryAfterMs: -1 },
    { kind: "client", streamStarted: false, partialUsage: { input_tokens: -1 } },
    { kind: "client", streamStarted: false, status: 999 },
  ])("rejects malformed provider failure data %j", (provider) => {
    expect(
      decodeExecutionFrame({
        type: "result",
        id: 1,
        generation: "gen",
        runId: "run",
        callId: "call",
        error: { code: "provider_error", message: "failed", provider },
      }),
    ).toBeNull();
  });

  it.each(["duplicate", "wrong-call", "unknown-field", "non-model"])(
    "refuses %s incremental model frames",
    async (violation) => {
      const input = new PassThrough();
      const output = new PassThrough();
      const guest = createExecutionPeer({
        role: "guest",
        generation: "gen",
        input,
        output,
        handlers: {},
      });
      const events: unknown[] = [];
      const pending = guest.request(
        violation === "non-model" ? "host.capability" : "host.model",
        { generation: "gen", runId: "run", callId: "call" },
        {},
        {
          onEvent: (event) => {
            events.push(event);
          },
        },
      );
      void pending.catch(() => undefined);
      const frame = {
        type: "event",
        id: 1,
        generation: "gen",
        runId: "run",
        callId: "call",
        sequence: 1,
        event: { text: "partial" },
      };
      if (violation === "duplicate") input.write(`${JSON.stringify(frame)}\n`);
      input.write(
        `${JSON.stringify({
          ...frame,
          ...(violation === "wrong-call" ? { callId: "forged" } : {}),
          ...(violation === "unknown-field" ? { surprise: true } : {}),
        })}\n`,
      );
      await expect(pending).rejects.toBeInstanceOf(Error);
      expect(guest.closed).toBe(true);
      expect(events).toHaveLength(violation === "duplicate" ? 1 : 0);
    },
  );

  it("allows only the closed vocabulary in the correct direction", async () => {
    const io = pair();
    const guest = createExecutionPeer({
      role: "guest",
      generation: "generation-1",
      input: io.guestInput,
      output: io.guestOutput,
      handlers: {
        "runtime.start": async ({ runId, payload }) => ({ runId, payload }),
      },
    });
    const host = createExecutionPeer({
      role: "host",
      generation: "generation-1",
      input: io.hostInput,
      output: io.hostOutput,
      handlers: {},
    });

    await expect(
      host.request(
        "runtime.start",
        { generation: "generation-1", runId: "run-1" },
        { prompt: "bounded" },
      ),
    ).resolves.toEqual({ runId: "run-1", payload: { prompt: "bounded" } });
    await expect(
      host.request("host.capability", {
        generation: "generation-1",
        runId: "run-1",
        callId: "call-1",
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    guest.close();
    host.close();
  });

  it("requires method-specific generation, run, and call identities", () => {
    expect(
      decodeExecutionFrame({
        type: "request",
        id: 1,
        method: "host.capability",
        generation: "generation-1",
        runId: "run-1",
        callId: "call-1",
        payload: {},
      }),
    ).not.toBeNull();
    expect(
      decodeExecutionFrame({
        type: "request",
        id: 1,
        method: "host.capability",
        generation: "generation-1",
        runId: "run-1",
      }),
    ).toBeNull();
    expect(
      decodeExecutionFrame({
        type: "request",
        id: 1,
        method: "runtime.bootstrap",
        generation: "generation-1",
        runId: "forged",
      }),
    ).toBeNull();
    expect(
      decodeExecutionFrame({
        type: "request",
        id: 1,
        method: "kernel.files.read",
        generation: "generation-1",
      }),
    ).toBeNull();
  });

  it("cancels the exact correlated request", async () => {
    const io = pair();
    let handlerAborted = false;
    let calls = 0;
    const host = createExecutionPeer({
      role: "host",
      generation: "generation-1",
      input: io.hostInput,
      output: io.hostOutput,
      handlers: {
        "host.model": ({ signal }) => {
          calls += 1;
          if (calls === 2) return Promise.resolve({ recovered: true });
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              handlerAborted = true;
              reject(Object.assign(new Error("cancelled"), { code: "cancelled" }));
            });
          });
        },
      },
    });
    const guest = createExecutionPeer({
      role: "guest",
      generation: "generation-1",
      input: io.guestInput,
      output: io.guestOutput,
      handlers: {},
    });
    const controller = new AbortController();
    const request = guest.request(
      "host.model",
      { generation: "generation-1", runId: "run-1", callId: "call-1" },
      {},
      { signal: controller.signal },
    );
    await Bun.sleep(0);
    controller.abort();
    await expect(request).rejects.toMatchObject({ code: "cancelled" });
    await Bun.sleep(0);
    expect(handlerAborted).toBe(true);
    await expect(
      guest.request(
        "host.model",
        { generation: "generation-1", runId: "run-2", callId: "call-2" },
        {},
      ),
    ).resolves.toEqual({ recovered: true });
    expect(guest.closed).toBe(false);
    expect(host.closed).toBe(false);
    host.close();
    guest.close();
  });

  it("fails closed on malformed, oversized, wrong-generation, and late-result frames", async () => {
    for (const input of [
      "not-json\n",
      `${"x".repeat(MAX_EXECUTION_FRAME_BYTES + 1)}`,
      '{"type":"result","id":1,"generation":"other","result":{}}\n',
      '{"type":"result","id":999,"generation":"generation-1","result":{}}\n',
    ]) {
      const wireInput = new PassThrough();
      const wireOutput = new PassThrough();
      const peer = createExecutionPeer({
        role: "host",
        generation: "generation-1",
        input: wireInput,
        output: wireOutput,
        handlers: {},
      });
      wireInput.write(input);
      await Bun.sleep(0);
      expect(peer.closed).toBe(true);
    }
  });

  it("does not replay an unresolved mutation after disconnect", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk: Buffer) => {
      written += chunk.toString("utf8");
    });
    const peer = createExecutionPeer({
      role: "guest",
      generation: "generation-1",
      input,
      output,
      handlers: {},
    });
    const request = peer.request("host.capability", {
      generation: "generation-1",
      runId: "run-1",
      callId: "mutation-1",
    });
    await Bun.sleep(0);
    input.end();
    await expect(request).rejects.toMatchObject({ code: "unavailable" });
    expect(written.match(/"callId":"mutation-1"/gu)).toHaveLength(1);
  });

  it("rejects every malformed cancel and result variant", () => {
    for (const frame of [
      { type: "cancel", id: 0, generation: "generation-1" },
      { type: "other", id: 1, generation: "generation-1" },
      { type: "result", id: 0, generation: "generation-1", result: {} },
      { type: "result", id: 1, generation: "generation-1", result: {}, error: {} },
      { type: "result", id: 1, generation: "generation-1" },
      { type: "result", id: 1, generation: "generation-1", error: null },
      {
        type: "result",
        id: 1,
        generation: "generation-1",
        error: { code: "bad code", message: "x" },
      },
    ]) {
      expect(decodeExecutionFrame(frame)).toBeNull();
    }
    expect(
      decodeExecutionFrame({ type: "cancel", id: 1, generation: "generation-1" }),
    ).not.toBeNull();
  });

  it("returns method-unavailable and validates local request identity and cancellation", async () => {
    const io = pair();
    const guest = createExecutionPeer({
      role: "guest",
      generation: "generation-1",
      input: io.guestInput,
      output: io.guestOutput,
      handlers: {},
    });
    const host = createExecutionPeer({
      role: "host",
      generation: "generation-1",
      input: io.hostInput,
      output: io.hostOutput,
      handlers: {},
    });
    await expect(
      host.request("runtime.start", { generation: "generation-1", runId: "run-1" }),
    ).rejects.toMatchObject({ code: "method_unavailable" });
    await expect(
      host.request("runtime.start", { generation: "generation-1" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      host.request(
        "runtime.start",
        { generation: "generation-1", runId: "run-2" },
        {},
        { signal: aborted.signal },
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    host.close();
    await expect(
      host.request("runtime.start", { generation: "generation-1", runId: "run-3" }),
    ).rejects.toMatchObject({ code: "unavailable" });
    guest.close();
  });

  it("refuses excessive local messages without closing and closes on oversized physical inbound frames", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const peer = createExecutionPeer({
      role: "host",
      generation: "generation-1",
      input,
      output,
      handlers: {},
    });
    await expect(
      peer.request(
        "runtime.bootstrap",
        { generation: "generation-1" },
        { text: "x".repeat(MAX_JSON_MESSAGE_BYTES) },
      ),
    ).rejects.toThrow("JSON message exceeds");
    expect(peer.closed).toBe(false);
    peer.close();

    const inbound = new PassThrough();
    const inboundPeer = createExecutionPeer({
      role: "host",
      generation: "generation-1",
      input: inbound,
      output: new PassThrough(),
      handlers: {},
    });
    inbound.write(`${"x".repeat(MAX_EXECUTION_FRAME_BYTES + 1)}\n`);
    await Bun.sleep(0);
    expect(inboundPeer.closed).toBe(true);

    const cyclicInput = new PassThrough();
    const cyclicPeer = createExecutionPeer({
      role: "host",
      generation: "generation-1",
      input: cyclicInput,
      output: new PassThrough(),
      handlers: {},
    });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    await expect(
      cyclicPeer.request("runtime.bootstrap", { generation: "generation-1" }, cyclic),
    ).rejects.toThrow();
    expect(cyclicPeer.closed).toBe(false);
    cyclicPeer.close();

    const shapeInput = new PassThrough();
    const shapePeer = createExecutionPeer({
      role: "host",
      generation: "generation-1",
      input: shapeInput,
      output: new PassThrough(),
      handlers: {},
    });
    shapeInput.write("{}\n");
    await Bun.sleep(0);
    expect(shapePeer.closed).toBe(true);
  });

  it("closes on duplicate inbound ids and unexpected cancellation identities", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const peer = createExecutionPeer({
      role: "guest",
      generation: "generation-1",
      input,
      output,
      handlers: { "runtime.start": async () => gate },
    });
    const frame = JSON.stringify({
      type: "request",
      id: 1,
      method: "runtime.start",
      generation: "generation-1",
      runId: "run-1",
      payload: {},
    });
    input.write(`${frame}\n${frame}\n`);
    await Bun.sleep(0);
    expect(peer.closed).toBe(true);
    release();

    const cancelInput = new PassThrough();
    const cancelPeer = createExecutionPeer({
      role: "guest",
      generation: "generation-1",
      input: cancelInput,
      output: new PassThrough(),
      handlers: {},
    });
    cancelInput.write(
      `${JSON.stringify({ type: "cancel", id: 99, generation: "generation-1" })}\n`,
    );
    await Bun.sleep(0);
    expect(cancelPeer.closed).toBe(true);
  });
});
