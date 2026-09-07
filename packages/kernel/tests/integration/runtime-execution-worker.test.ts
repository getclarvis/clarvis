import { PassThrough } from "node:stream";
import { describe, expect, it } from "bun:test";
import {
  createExecutionPeer,
  RUNTIME_PROTOCOL_REVISION,
  serveExecutionWorker,
  type GuestCapabilityRequest,
  type GuestModelRequest,
} from "../../src/index.ts";

describe("runtime execution worker", () => {
  it("executes only after bootstrap and routes narrow host authority", async () => {
    const hostInput = new PassThrough();
    const guestInput = new PassThrough();
    const calls: string[] = [];
    const worker = serveExecutionWorker({
      generation: "generation-1",
      imageDigest: `sha256:${"a".repeat(64)}`,
      input: guestInput,
      output: hostInput,
      executor: {
        async execute(runId, _envelope, bridge) {
          const model = await bridge.model("model-1", {
            leaseId: "lease-1",
            provider: "provider",
            model: "model",
            requestId: "request-1",
            body: {},
          });
          const capability = await bridge.capability("tool-1", {
            method: "memory.read",
            revision: "revision-1",
            arguments: {},
          });
          await bridge.event({ type: "message" });
          await bridge.checkpoint({ sequence: 1, terminal: false, state: { turn: 1 } });
          return { runId, model, capability };
        },
      },
    });
    const host = createExecutionPeer({
      role: "host",
      generation: "generation-1",
      input: hostInput,
      output: guestInput,
      handlers: {
        "host.model": async ({ payload }) => {
          calls.push("model");
          expect((payload as GuestModelRequest).leaseId).toBe("lease-1");
          return { events: [{ text: "answer" }], outputBytes: 12 };
        },
        "host.capability": async ({ payload }) => {
          calls.push("capability");
          expect((payload as GuestCapabilityRequest).method).toBe("memory.read");
          return { memory: "value" };
        },
        "host.event": async () => {
          calls.push("event");
        },
        "host.checkpoint": async () => {
          calls.push("checkpoint");
        },
      },
    });
    await expect(
      host.request("runtime.start", { generation: "generation-1", runId: "run-1" }, {}),
    ).rejects.toMatchObject({ code: "conflict" });
    await host.request(
      "runtime.bootstrap",
      { generation: "generation-1" },
      {
        generation: "generation-1",
        imageDigest: `sha256:${"a".repeat(64)}`,
        runtimeProtocolRevision: RUNTIME_PROTOCOL_REVISION,
      },
    );
    await expect(
      host.request("runtime.start", { generation: "generation-1", runId: "run-1" }, {}),
    ).resolves.toMatchObject({ runId: "run-1", capability: { memory: "value" } });
    expect(calls).toEqual(["model", "capability", "event", "checkpoint"]);
    host.close();
    worker.close();
  });

  it("binds bootstrap, duplicate runs, steer, cancellation, and shutdown", async () => {
    const hostInput = new PassThrough();
    const guestInput = new PassThrough();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const observations: string[] = [];
    const worker = serveExecutionWorker({
      generation: "generation-1",
      imageDigest: `sha256:${"a".repeat(64)}`,
      input: guestInput,
      output: hostInput,
      executor: {
        async execute(_runId, _envelope, _bridge, signal) {
          signal.addEventListener("abort", () => observations.push("aborted"), { once: true });
          await gate;
          return { done: true };
        },
        async steer(runId, input) {
          observations.push(`${runId}:${String(input)}`);
        },
      },
    });
    const host = createExecutionPeer({
      role: "host",
      generation: "generation-1",
      input: hostInput,
      output: guestInput,
      handlers: {},
    });
    await expect(
      host.request(
        "runtime.bootstrap",
        { generation: "generation-1" },
        {
          generation: "forged",
          imageDigest: `sha256:${"a".repeat(64)}`,
          runtimeProtocolRevision: RUNTIME_PROTOCOL_REVISION,
        },
      ),
    ).rejects.toMatchObject({ code: "handshake_mismatch" });
    await expect(
      host.request(
        "runtime.bootstrap",
        { generation: "generation-1" },
        {
          generation: "generation-1",
          imageDigest: `sha256:${"a".repeat(64)}`,
          runtimeProtocolRevision: "invalid-revision",
        },
      ),
    ).rejects.toMatchObject({ code: "handshake_mismatch" });
    await host.request(
      "runtime.bootstrap",
      { generation: "generation-1" },
      {
        generation: "generation-1",
        imageDigest: `sha256:${"a".repeat(64)}`,
        runtimeProtocolRevision: RUNTIME_PROTOCOL_REVISION,
      },
    );
    const run = host.request("runtime.start", { generation: "generation-1", runId: "run-1" }, {});
    await Bun.sleep(0);
    await expect(
      host.request("runtime.start", { generation: "generation-1", runId: "run-1" }, {}),
    ).rejects.toMatchObject({ code: "conflict" });
    await host.request("runtime.steer", { generation: "generation-1", runId: "run-1" }, "message");
    await host.request("runtime.cancel", { generation: "generation-1", runId: "run-1" });
    expect(observations).toEqual(["run-1:message", "aborted"]);
    await expect(
      host.request("runtime.cancel", { generation: "generation-1" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await host.request("runtime.shutdown", { generation: "generation-1" });
    release();
    await run;
    host.close();
    worker.close();
  });

  it("refuses steering when the run or executor steering method is absent", async () => {
    const hostInput = new PassThrough();
    const guestInput = new PassThrough();
    const worker = serveExecutionWorker({
      generation: "generation-1",
      imageDigest: "digest",
      input: guestInput,
      output: hostInput,
      executor: { execute: async () => ({}) },
    });
    const host = createExecutionPeer({
      role: "host",
      generation: "generation-1",
      input: hostInput,
      output: guestInput,
      handlers: {},
    });
    await host.request(
      "runtime.bootstrap",
      { generation: "generation-1" },
      {
        generation: "generation-1",
        imageDigest: "digest",
        runtimeProtocolRevision: RUNTIME_PROTOCOL_REVISION,
      },
    );
    await expect(
      host.request("runtime.steer", { generation: "generation-1", runId: "missing" }, {}),
    ).rejects.toMatchObject({ code: "not_found" });
    host.close();
    worker.close();
  });
});
