import { describe, expect, it } from "bun:test";
import { createCapabilityBroker, createModelBroker } from "../../src/runtime/authority-brokers.ts";

const identity = { generation: "generation-1", runId: "run-1", callId: "call-1" };

describe("runtime authority brokers", () => {
  it("bounds call identities without retaining non-replayable response bodies", async () => {
    let invoked = 0;
    const broker = createCapabilityBroker({
      generation: identity.generation,
      runId: identity.runId,
      maxArgumentsBytes: 128,
      maxResultBytes: 1024 * 1024,
      maxCalls: 3,
      maxRetainedResultBytes: 1,
      grants: [
        {
          method: "plans.read",
          revision: "v1",
          idempotent: false,
          validateArguments: () => true,
          invoke: async () => {
            invoked++;
            return "x".repeat(512 * 1024);
          },
        },
      ],
    });
    const request = { method: "plans.read", revision: "v1", arguments: {} };
    for (let i = 0; i < 3; i++) {
      expect(
        ((await broker.invoke({ ...identity, callId: `read-${i}` }, request)) as string).length,
      ).toBe(512 * 1024);
    }
    await expect(broker.invoke({ ...identity, callId: "overflow" }, request)).rejects.toMatchObject(
      { code: "resource_exhausted" },
    );
    await expect(broker.invoke({ ...identity, callId: "read-0" }, request)).rejects.toMatchObject({
      code: "outcome_unknown",
    });
    expect(invoked).toBe(3);
    broker.revoke();
  });

  it("reserves aggregate replay bytes before invoking and checks replay arguments", async () => {
    let invoked = 0;
    const broker = createCapabilityBroker({
      generation: identity.generation,
      runId: identity.runId,
      maxArgumentsBytes: 128,
      maxResultBytes: 64,
      maxCalls: 10,
      maxRetainedResultBytes: 128,
      grants: [
        {
          method: "read.value",
          revision: "v1",
          idempotent: true,
          validateArguments: () => true,
          invoke: async () => {
            invoked++;
            return "x".repeat(50);
          },
        },
      ],
    });
    const request = { method: "read.value", revision: "v1", arguments: { id: "first" } };
    await broker.invoke(identity, request);
    await broker.invoke({ ...identity, callId: "second" }, request);
    await expect(broker.invoke({ ...identity, callId: "third" }, request)).rejects.toMatchObject({
      code: "resource_exhausted",
    });
    expect(await broker.invoke(identity, request)).toBe("x".repeat(50));
    await expect(
      broker.invoke(identity, { ...request, arguments: { id: "different" } }),
    ).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(invoked).toBe(2);
    broker.revoke();
  });

  it("counts concurrent response reservations and releases failed reservations", async () => {
    const gate = Promise.withResolvers<void>();
    let invoked = 0;
    const broker = createCapabilityBroker({
      generation: identity.generation,
      runId: identity.runId,
      maxArgumentsBytes: 128,
      maxResultBytes: 64,
      maxRetainedResultBytes: 64,
      grants: [
        {
          method: "read.value",
          revision: "v1",
          idempotent: true,
          validateArguments: () => true,
          invoke: async () => {
            if (++invoked === 1) {
              await gate.promise;
              throw new Error("failed read");
            }
            return null;
          },
        },
      ],
    });
    const request = { method: "read.value", revision: "v1", arguments: {} };
    const first = broker.invoke(identity, request);
    void first.catch(() => undefined);
    try {
      await expect(broker.invoke({ ...identity, callId: "second" }, request)).rejects.toMatchObject(
        { code: "resource_exhausted" },
      );
    } finally {
      gate.resolve();
    }
    await expect(first).rejects.toThrow("failed read");
    await expect(broker.invoke({ ...identity, callId: "third" }, request)).resolves.toBeNull();
    expect(invoked).toBe(2);
    broker.revoke();
  });

  it.each(["drain", "cancel", "revoke", "expire"])(
    "bounds FIFO model waiting and handles %s",
    async (mode) => {
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const calls: string[] = [];
      let now = 1;
      const broker = createModelBroker(
        {
          id: "lease",
          generation: "generation-1",
          runId: "run-1",
          provider: "test",
          model: "model",
          destination: new URL("https://example.test"),
          expiresAt: 100,
          maxConcurrent: 1,
          maxQueued: 1,
          maxInputBytes: 128,
          maxOutputBytes: 128,
        },
        async function* (request) {
          calls.push(request.requestId);
          entered.resolve();
          await gate.promise;
          yield null;
        },
        () => now,
      );
      const request = {
        leaseId: "lease",
        provider: "test",
        model: "model",
        requestId: "one",
        body: {},
      };
      const first = broker.execute(identity, request);
      void first.catch(() => undefined);
      await entered.promise;
      const controller = new AbortController();
      const second = broker.execute(
        { ...identity, callId: "two" },
        { ...request, requestId: "two" },
        controller.signal,
      );
      void second.catch(() => undefined);
      await expect(broker.execute({ ...identity, callId: "three" }, request)).rejects.toMatchObject(
        { code: "resource_exhausted" },
      );
      expect(calls).toEqual(["one"]);
      if (mode === "cancel") controller.abort(new Error("queued cancellation"));
      if (mode === "revoke") broker.revoke();
      if (mode === "expire") now = 101;
      gate.resolve();
      if (mode === "drain" || mode === "cancel") await first;
      else await expect(first).rejects.toBeInstanceOf(Error);
      if (mode === "drain") {
        await second;
        expect(calls).toEqual(["one", "two"]);
      } else {
        await expect(second).rejects.toBeInstanceOf(Error);
        expect(calls).toEqual(["one"]);
      }
      broker.revoke();
    },
  );

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
