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
  it("routes nested MCP hook calls only to the live run and propagates cancellation", async () => {
    const generation = "hook-generation";
    const identity = { generation, runId: "hook-run" };
    const hostInput = new PassThrough();
    const guestInput = new PassThrough();
    const ready = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let hookStarted = Promise.withResolvers<void>();
    let hookCancelled = Promise.withResolvers<void>();
    const payload = { server: "review", tool: "inspect", input: { mode: "solo" } };
    const worker = serveExecutionWorker({
      generation,
      imageDigest: "digest",
      input: guestInput,
      output: hostInput,
      executor: {
        async execute(_runId, _envelope, bridge) {
          const result = await bridge.capability("hook-call", {
            method: "runtime.hooks",
            revision: "v1",
            arguments: {},
          });
          expect(result).toEqual({ guestResult: payload });
          ready.resolve();
          await finish.promise;
          return { completed: true };
        },
        async callHookMcp(runId, input, signal) {
          expect(runId).toBe(identity.runId);
          if (input !== "wait") return { guestResult: input };
          hookStarted.resolve();
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                hookCancelled.resolve();
                reject(
                  signal.reason instanceof Error ? signal.reason : new Error("hook cancelled"),
                );
              },
              { once: true },
            );
          });
        },
      },
    });
    const host = createExecutionPeer({
      role: "host",
      generation,
      input: hostInput,
      output: guestInput,
      handlers: {
        "host.capability": async () => host.request("runtime.hook_mcp", identity, payload),
      },
    });
    try {
      await expect(host.request("runtime.hook_mcp", identity, payload)).rejects.toMatchObject({
        code: "not_found",
      });
      await host.request(
        "runtime.bootstrap",
        { generation },
        { generation, imageDigest: "digest", runtimeProtocolRevision: RUNTIME_PROTOCOL_REVISION },
      );
      const run = host.request("runtime.start", identity, {});
      await ready.promise;
      await expect(host.request("runtime.hook_mcp", { generation }, payload)).rejects.toThrow(
        "invalid execution identity",
      );
      await expect(
        host.request("runtime.hook_mcp", { generation, runId: "another-run" }, payload),
      ).rejects.toMatchObject({ code: "not_found" });
      const call = new AbortController();
      const pending = host.request("runtime.hook_mcp", identity, "wait", { signal: call.signal });
      await hookStarted.promise;
      call.abort();
      await expect(pending).rejects.toThrow();
      await hookCancelled.promise;
      await expect(host.request("runtime.hook_mcp", identity, payload)).resolves.toEqual({
        guestResult: payload,
      });
      hookStarted = Promise.withResolvers<void>();
      hookCancelled = Promise.withResolvers<void>();
      const pendingRunHook = host.request("runtime.hook_mcp", identity, "wait");
      await hookStarted.promise;
      const runCancelled = pendingRunHook.catch((error: unknown) => error);
      await host.request("runtime.cancel", identity);
      expect(await runCancelled).toMatchObject({ message: "run cancelled by host" });
      await hookCancelled.promise;
      await expect(host.request("runtime.hook_mcp", identity, payload)).rejects.toThrow(
        "run cancelled by host",
      );
      finish.resolve();
      await run;
      await expect(host.request("runtime.hook_mcp", identity, payload)).rejects.toMatchObject({
        code: "not_found",
      });
    } finally {
      finish.resolve();
      host.close();
      worker.close();
    }
  });

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
    await expect(
      host.request("runtime.hook_mcp", { generation: "generation-1", runId: "missing" }, {}),
    ).rejects.toMatchObject({ code: "not_found" });
    host.close();
    worker.close();
  });
});
