import { afterEach, describe, expect, it } from "bun:test";
import type {
  GoalChange,
  GoalControlRequest,
  GoalReceipt,
  GoalService,
  GoalView,
} from "@clarvis/protocol";
import {
  createGoalController,
  type GoalBinding,
  type GoalController,
} from "../../src/features/goal/controller.ts";

const controllers: GoalController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
});

function fixture() {
  let binding: GoalBinding | null = { sessionId: "conversation", generation: 1 };
  let serial = 0;
  let releases = 0;
  let preparations = 0;
  let current: GoalView = { state: { version: 1, revision: 0, archive: [], receipts: [] } };
  const subscriptions = new Set<(change: GoalChange) => void>();
  const requests: GoalControlRequest[] = [];
  const receipts = new Map<string, GoalReceipt>();
  const order: string[] = [];
  const updates: Array<{ binding: GoalBinding; view: GoalView }> = [];
  const service: GoalService = {
    async availability() {
      return { available: true };
    },
    async get() {
      order.push("get");
      return structuredClone(current);
    },
    async subscribe(_sessionId, listener) {
      order.push("subscribe");
      subscriptions.add(listener);
      return () => {
        releases++;
        subscriptions.delete(listener);
      };
    },
    async control(request) {
      requests.push(request);
      if (request.expected_revision !== current.state.revision)
        throw Object.assign(new Error("Goal changed"), { code: "conflict" });
      const receipt = {
        operation_id: request.operation_id,
        fingerprint: "fixture",
        revision: current.state.revision + 1,
      };
      current = { state: { ...current.state, revision: receipt.revision } };
      receipts.set(request.operation_id, receipt);
      return receipt;
    },
    async receipt(_sessionId, operationId) {
      return receipts.get(operationId) ?? null;
    },
  };
  const controller = createGoalController({
    binding: () => binding,
    prepare: async () => {
      preparations++;
      binding ??= { sessionId: "new-conversation", generation: 1 };
      return { ...binding };
    },
    service: () => service,
    operationId: () => `operation-${++serial}`,
    updated: (binding, view) => updates.push({ binding, view }),
  });
  controllers.push(controller);
  return {
    controller,
    service,
    requests,
    receipts,
    order,
    updates,
    releases: () => releases,
    preparations: () => preparations,
    bind(next: GoalBinding | null) {
      binding = next;
    },
    state(next: GoalView) {
      current = next;
    },
    notify() {
      for (const listener of subscriptions) listener({ session_id: binding!.sessionId });
    },
  };
}

describe("goal presentation controller", () => {
  it("refuses a reviewed form after switching to another conversation with the same revision", async () => {
    const f = fixture();
    const binding = f.controller.binding();
    await f.controller.refresh();
    f.bind({ sessionId: "another", generation: 2 });
    await expect(
      f.controller.control({ kind: "edit", objective: "Reviewed" }, 0, binding),
    ).rejects.toThrow("another conversation");
    expect(f.requests).toHaveLength(0);
  });
  it("subscribes before reading and refreshes on invalidation without issuing a control", async () => {
    const f = fixture();
    await f.controller.refresh();
    expect(f.order).toEqual(["subscribe", "get"]);
    f.state({ state: { version: 1, revision: 2, archive: [], receipts: [] } });
    f.notify();
    await f.controller.refresh();
    expect(f.controller.view()?.state.revision).toBe(2);
    expect(f.requests).toHaveLength(0);
    expect(f.order.filter((item) => item === "subscribe")).toHaveLength(1);
  });

  it("retains reviewed CAS instead of silently applying an edit to newer state", async () => {
    const f = fixture();
    await f.controller.refresh();
    f.state({ state: { version: 1, revision: 4, archive: [], receipts: [] } });
    await expect(
      f.controller.control({ kind: "edit", objective: "Reviewed objective" }, 0),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(f.requests[0]?.expected_revision).toBe(0);
    expect(f.controller.pendingOperation()).toBeUndefined();
    expect(f.controller.view()?.state.revision).toBe(4);
  });

  it("materializes a conversation only for creation and preserves user cancellation semantics", async () => {
    const f = fixture();
    f.bind(null);
    await f.controller.refresh();
    expect(f.preparations()).toBe(0);
    expect(f.controller.view()).toBeUndefined();
    await f.controller.control({ kind: "create", objective: "Run the fixture" });
    expect(f.preparations()).toBe(1);
    await f.controller.control({ kind: "pause", running: true });
    expect(f.preparations()).toBe(1);
    expect(f.requests.map((request) => request.action)).toEqual([
      { kind: "create", objective: "Run the fixture" },
      { kind: "pause", running: true },
    ]);
    expect(new Set(f.requests.map((request) => request.operation_id)).size).toBe(2);
    expect(f.requests.every((request) => request.session_id === "new-conversation")).toBe(true);
  });

  it("recovers a committed change whose reply was lost without repeating its mutation", async () => {
    const f = fixture();
    const control = f.service.control.bind(f.service);
    f.service.control = async (request) => {
      await control(request);
      throw new Error("Reply lost");
    };
    const receipt = await f.controller.control({ kind: "pause" });
    expect(receipt.operation_id).toBe("operation-1");
    expect(f.requests).toHaveLength(1);
    expect(f.controller.pendingOperation()).toBeUndefined();
    expect(f.controller.view()?.state.revision).toBe(1);
  });

  it("returns a confirmed receipt when the follow-up view refresh fails", async () => {
    const f = fixture();
    const get = f.service.get.bind(f.service);
    let reads = 0;
    f.service.get = async (sessionId) => {
      if (reads++ === 0) return get(sessionId);
      throw new Error("Refresh unavailable");
    };
    const receipt = await f.controller.control({ kind: "pause" });
    expect(receipt.operation_id).toBe("operation-1");
    expect(f.controller.pendingOperation()).toBeUndefined();
    expect(f.controller.failure()).toBe("Refresh unavailable");
  });

  it("returns a recovered receipt when its follow-up view refresh fails", async () => {
    const f = fixture();
    f.service.control = async (request) => {
      f.requests.push(request);
      throw new Error("Reply lost");
    };
    await expect(f.controller.control({ kind: "pause" })).rejects.toThrow("Reply lost");
    const receipt = { operation_id: "operation-1", fingerprint: "fixture", revision: 1 };
    f.receipts.set(receipt.operation_id, receipt);
    f.service.get = async () => {
      throw new Error("Refresh unavailable");
    };
    expect(await f.controller.recover()).toEqual(receipt);
    expect(f.controller.pendingOperation()).toBeUndefined();
    expect(f.controller.failure()).toBe("Refresh unavailable");
  });

  it("keeps an uncertain operation across reconnect and never resubmits while its receipt is absent", async () => {
    const f = fixture();
    f.service.control = async (request) => {
      f.requests.push(request);
      throw new Error("Transport lost");
    };
    await expect(f.controller.control({ kind: "pause" })).rejects.toThrow("Transport lost");
    expect(f.controller.pendingOperation()).toBe("operation-1");
    f.bind({ sessionId: "conversation", generation: 2 });
    f.controller.reset();
    await f.controller.refresh();
    await expect(f.controller.control({ kind: "resume" })).rejects.toThrow("unconfirmed");
    expect(await f.controller.recover()).toBeNull();
    expect(f.requests).toHaveLength(1);
    const receipt = { operation_id: "operation-1", fingerprint: "fixture", revision: 1 };
    f.receipts.set("operation-1", receipt);
    expect(await f.controller.recover()).toEqual(receipt);
    expect(f.controller.pendingOperation()).toBeUndefined();
    expect(f.requests).toHaveLength(1);
  });

  it("does not expose an old read after the conversation changes", async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<GoalView>();
    f.service.get = async () => {
      entered.resolve();
      return gate.promise;
    };
    const old = f.controller.refresh();
    await entered.promise;
    f.bind({ sessionId: "next", generation: 2 });
    f.controller.reset();
    gate.resolve({ state: { version: 1, revision: 9, archive: [], receipts: [] } });
    await old;
    expect(f.controller.view()).toBeUndefined();
    expect(f.updates).toHaveLength(0);
    expect(f.releases()).toBe(1);
  });

  it("keeps uncertainty when receipt lookup fails even after an apparent refusal", async () => {
    const f = fixture();
    f.service.control = async (request) => {
      f.requests.push(request);
      throw Object.assign(new Error("Admission failed"), { code: "resource_exhausted" });
    };
    f.service.receipt = async () => {
      throw new Error("Read unavailable");
    };
    await expect(f.controller.control({ kind: "resume" })).rejects.toThrow("Admission failed");
    expect(f.controller.pendingOperation()).toBe("operation-1");
    await expect(f.controller.control({ kind: "resume" })).rejects.toThrow("unconfirmed");
    expect(f.requests).toHaveLength(1);
  });

  it("releases a late subscription after disposal and performs no read", async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<() => void>();
    let released = 0;
    f.service.subscribe = async () => {
      entered.resolve();
      return gate.promise;
    };
    const pending = f.controller.refresh();
    await entered.promise;
    f.controller.dispose();
    gate.resolve(() => {
      released++;
    });
    await pending;
    expect(released).toBe(1);
    expect(f.order).toHaveLength(0);
    expect(f.controller.view()).toBeUndefined();
  });

  it("rereads an invalidation received while the previous read was pending", async () => {
    const f = fixture();
    await f.controller.refresh();
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<GoalView>();
    const get = f.service.get.bind(f.service);
    f.service.get = async (_id) => {
      f.service.get = get;
      entered.resolve();
      return gate.promise;
    };
    const pending = f.controller.refresh();
    await entered.promise;
    f.state({ state: { version: 1, revision: 2, archive: [], receipts: [] } });
    f.notify();
    gate.resolve({ state: { version: 1, revision: 1, archive: [], receipts: [] } });
    await pending;
    expect(f.controller.view()?.state.revision).toBe(2);
  });

  it("announces unsupported without subscribing or sending a mutation", async () => {
    const f = fixture();
    f.service.availability = async () => ({ available: false, reason: "Unsupported host" });
    await f.controller.refresh();
    expect(f.controller.available()).toBe(false);
    expect(f.controller.failure()).toBe("Unsupported host");
    await expect(f.controller.control({ kind: "pause" })).rejects.toThrow("Unsupported host");
    expect(f.order).toHaveLength(0);
    expect(f.requests).toHaveLength(0);
  });

  it("does not lose an invalidation queued as the current refresh completes", async () => {
    const f = fixture();
    const get = f.service.get.bind(f.service);
    f.service.get = async (id) => {
      f.service.get = get;
      const value = await get(id);
      queueMicrotask(() =>
        queueMicrotask(() => {
          f.state({ state: { version: 1, revision: 2, archive: [], receipts: [] } });
          f.notify();
        }),
      );
      return value;
    };
    await f.controller.refresh();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.controller.view()?.state.revision).toBe(2);
  });
});
