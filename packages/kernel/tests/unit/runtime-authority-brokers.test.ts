import { describe, expect, it } from "bun:test";
import { createCapabilityBroker, createModelBroker } from "../../src/runtime/authority-brokers.ts";

const identity = { generation: "generation-1", runId: "run-1", callId: "call-1" };

describe("runtime authority brokers", () => {
  it("keeps destination and credentials behind a bounded model lease", async () => {
    let observedDestination = "";
    const broker = createModelBroker(
      {
        id: "lease-1",
        generation: "generation-1",
        runId: "run-1",
        provider: "openai",
        model: "fixed-model",
        destination: new URL("https://api.example.test/models"),
        expiresAt: 2_000,
        maxConcurrent: 1,
        maxInputBytes: 128,
        maxOutputBytes: 128,
      },
      async function* (_request, authority) {
        observedDestination = authority.destination.href;
        yield { type: "text", value: "safe" };
      },
      () => 1_000,
    );
    await expect(
      broker.execute(identity, {
        leaseId: "lease-1",
        provider: "openai",
        model: "fixed-model",
        requestId: "request-1",
        body: { prompt: "hello" },
      }),
    ).resolves.toMatchObject({ events: [{ type: "text", value: "safe" }] });
    expect(observedDestination).toBe("https://api.example.test/models");
    await expect(
      broker.execute(identity, {
        leaseId: "lease-1",
        provider: "openai",
        model: "forged-model",
        requestId: "request-2",
        body: {},
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    broker.revoke();
    await expect(
      broker.execute(identity, {
        leaseId: "lease-1",
        provider: "openai",
        model: "fixed-model",
        requestId: "request-3",
        body: {},
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("enforces exact capability methods, revision, schema, and non-replay", async () => {
    let mutations = 0;
    const broker = createCapabilityBroker({
      generation: "generation-1",
      runId: "run-1",
      maxArgumentsBytes: 128,
      maxResultBytes: 128,
      grants: [
        {
          method: "tasks.transition",
          revision: "revision-3",
          idempotent: false,
          validateArguments: (value) =>
            typeof value === "object" && value !== null && "taskId" in value,
          invoke: async () => ({ revision: ++mutations }),
        },
      ],
    });
    await expect(
      broker.invoke(identity, {
        method: "tasks.transition",
        revision: "revision-3",
        arguments: { taskId: "task-1" },
      }),
    ).resolves.toEqual({ revision: 1 });
    await expect(
      broker.invoke(identity, {
        method: "tasks.transition",
        revision: "revision-3",
        arguments: { taskId: "task-1" },
      }),
    ).rejects.toMatchObject({ code: "outcome_unknown" });
    await expect(
      broker.invoke(
        { ...identity, callId: "call-2" },
        { method: "files.read", revision: "revision-3", arguments: {} },
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      broker.invoke(
        { ...identity, callId: "call-3" },
        { method: "tasks.transition", revision: "stale", arguments: { taskId: "task-1" } },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(mutations).toBe(1);
  });

  it("replays only a completed explicitly idempotent capability result", async () => {
    let calls = 0;
    const broker = createCapabilityBroker({
      generation: "generation-1",
      runId: "run-1",
      maxArgumentsBytes: 128,
      maxResultBytes: 128,
      grants: [
        {
          method: "memory.read",
          revision: "revision-1",
          idempotent: true,
          validateArguments: () => true,
          invoke: async () => ({ calls: ++calls }),
        },
      ],
    });
    const request = { method: "memory.read", revision: "revision-1", arguments: {} };
    expect(await broker.invoke(identity, request)).toEqual({ calls: 1 });
    expect(await broker.invoke(identity, request)).toEqual({ calls: 1 });
    expect(calls).toBe(1);
  });

  it("enforces model input, concurrency, lifetime, event, and cumulative output bounds", async () => {
    const request = {
      leaseId: "lease-1",
      provider: "openai",
      model: "fixed-model",
      requestId: "request-1",
      body: {},
    };
    const lease = {
      id: "lease-1",
      generation: "generation-1",
      runId: "run-1",
      provider: "openai",
      model: "fixed-model",
      destination: new URL("https://api.example.test"),
      expiresAt: 2_000,
      maxConcurrent: 1,
      maxInputBytes: 16,
      maxOutputBytes: 32,
    };
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const inputBroker = createModelBroker(
      lease,
      async function* () {
        yield null;
      },
      () => 1_000,
    );
    await expect(inputBroker.execute(identity, { ...request, body: cyclic })).rejects.toMatchObject(
      {
        code: "resource_exhausted",
      },
    );

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const concurrent = createModelBroker(
      lease,
      async function* () {
        await gate;
        yield null;
      },
      () => 1_000,
    );
    const first = concurrent.execute(identity, request);
    await Bun.sleep(0);
    await expect(
      concurrent.execute({ ...identity, callId: "call-2" }, request),
    ).rejects.toMatchObject({ code: "resource_exhausted" });
    release();
    await first;

    let now = 1_000;
    const expiring = createModelBroker(
      { ...lease, maxOutputBytes: 128 },
      async function* () {
        now = 3_000;
        yield { value: "late" };
      },
      () => now,
    );
    await expect(expiring.execute(identity, request)).rejects.toMatchObject({
      code: "unauthorized",
    });

    const oversizedEvent = createModelBroker(
      lease,
      async function* () {
        yield { value: "x".repeat(128) };
      },
      () => 1_000,
    );
    await expect(oversizedEvent.execute(identity, request)).rejects.toMatchObject({
      code: "resource_exhausted",
    });

    const cumulative = createModelBroker(
      lease,
      async function* () {
        yield "12345678901234567890";
        yield "12345678901234567890";
      },
      () => 1_000,
    );
    await expect(cumulative.execute(identity, request)).rejects.toMatchObject({
      code: "resource_exhausted",
    });
  });

  it("bounds capability arguments and results and revokes live authority", async () => {
    let observedAbort = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const broker = createCapabilityBroker({
      generation: "generation-1",
      runId: "run-1",
      maxArgumentsBytes: 256,
      maxResultBytes: 32,
      grants: [
        {
          method: "memory.read",
          revision: "v1",
          idempotent: false,
          validateArguments: (value) => value !== null,
          async invoke(value, signal) {
            if ((value as { wait?: boolean }).wait === true) {
              signal.addEventListener("abort", () => (observedAbort = true), { once: true });
              await gate;
            }
            return (value as { result?: unknown }).result ?? { ok: true };
          },
        },
      ],
    });
    const invoke = (callId: string, value: unknown) =>
      broker.invoke(
        { ...identity, callId },
        { method: "memory.read", revision: "v1", arguments: value },
      );
    await expect(
      broker.invoke(
        { ...identity, generation: "forged" },
        { method: "memory.read", revision: "v1", arguments: {} },
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(invoke("invalid", null)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(invoke("large-args", { value: "x".repeat(512) })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(invoke("large-result", { result: "x".repeat(128) })).rejects.toMatchObject({
      code: "resource_exhausted",
    });
    const pending = invoke("pending", { wait: true });
    await Bun.sleep(0);
    broker.revoke();
    expect(observedAbort).toBe(true);
    release();
    await pending;
    await expect(invoke("revoked", {})).rejects.toMatchObject({ code: "unauthorized" });
  });
});
