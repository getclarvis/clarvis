import { PassThrough } from "node:stream";
import { describe, expect, it } from "bun:test";
import {
  MAX_EXECUTION_FRAME_BYTES,
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
    const host = createExecutionPeer({
      role: "host",
      generation: "generation-1",
      input: io.hostInput,
      output: io.hostOutput,
      handlers: {
        "host.model": ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              handlerAborted = true;
              reject(Object.assign(new Error("cancelled"), { code: "cancelled" }));
            });
          }),
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

  it("closes on oversized outbound and newline-terminated inbound frames", async () => {
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
        { text: "x".repeat(MAX_EXECUTION_FRAME_BYTES) },
      ),
    ).rejects.toThrow("execution channel bound exceeded");
    expect(peer.closed).toBe(true);

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
    expect(cyclicPeer.closed).toBe(true);

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
