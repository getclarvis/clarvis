import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import { createPlanStore, MAX_PLAN_DOCUMENT_BYTES, renderPlan } from "@clarvis/plan";
import { createInMemoryPlanRepository } from "@clarvis/plan/testing";
import {
  createCapabilityBroker,
  type GuestCapabilityRequest,
  type HostCapabilityGrant,
} from "../../src/runtime/authority-brokers.ts";
import { createExecutionPeer } from "../../src/runtime/execution-rpc.ts";
import { createGuestPlanFactory, createHostPlansGrant } from "../../src/runtime/plan-bridge.ts";
import {
  callPlanTransfer,
  createPlanTransferGrant,
  PLAN_DOCUMENT_WIRE_BYTES,
  PLAN_TRANSFER_CHUNK_BYTES,
} from "../../src/runtime/plan-transfer.ts";
import { decodePlanWireDocument, validPlanWireDocument } from "../../src/runtime/plan-wire.ts";

const signal = new AbortController().signal;
const read = { operation: "read", input: { id: "plan" } };

function grantFor(invoke: HostCapabilityGrant["invoke"]): HostCapabilityGrant {
  return {
    method: "runtime.plans",
    revision: "v2",
    idempotent: false,
    validateArguments: (value) =>
      typeof value === "object" &&
      value !== null &&
      (value as { operation?: unknown }).operation === "read",
    invoke,
  };
}

function transferCall(grant: HostCapabilityGrant) {
  return (request: unknown, requestSignal = signal) => grant.invoke(request, requestSignal);
}

describe("bounded runtime plan transfer", () => {
  it("preserves aliased YAML metadata whose expanded JSON exceeds the document wire budget", async () => {
    const canonical = createPlanStore({ repository: createInMemoryPlanRepository() });
    let document = await canonical.create({
      title: "Aliased metadata",
      objective: "",
      tasks: [],
      createdByRun: "prior",
    });
    const shared = { text: "x".repeat(3 * 1024 * 1024) };
    document = await canonical.update(document.id, document, (draft) => {
      draft.unknown_frontmatter = Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [`copy_${i}`, shared]),
      );
    });
    expect(Buffer.byteLength(renderPlan(document))).toBeLessThan(MAX_PLAN_DOCUMENT_BYTES);
    expect(Buffer.byteLength(JSON.stringify(document))).toBeGreaterThan(PLAN_DOCUMENT_WIRE_BYTES);
    const grant = createHostPlansGrant(
      { storeFor: async () => ({ key: "host", providerKind: "markdown", store: canonical }) },
      "owner",
      {
        runId: "run",
        readTerminalRecord: () => null,
        priorRef: {
          id: document.id,
          provider_key: "host",
          final_revision: document.revision,
          final_spec_revision: document.spec_revision,
          status: document.status,
          retention: document.retention,
        },
      },
    );
    const broker = createCapabilityBroker({
      generation: "gen",
      runId: "run",
      grants: [grant],
      maxArgumentsBytes: 256 * 1024,
      maxResultBytes: 256 * 1024,
    });
    try {
      const store = (
        await createGuestPlanFactory({
          capability: (callId, request, requestSignal) =>
            broker.invoke({ generation: "gen", runId: "run", callId }, request, requestSignal),
          model: async () => {
            throw new Error("no model");
          },
          event: async () => {},
          checkpoint: async () => {},
        }).storeFor("owner")
      ).store;
      const loaded = await store.read(document.id);
      expect(loaded.unknown_frontmatter.copy_0).toBe(loaded.unknown_frontmatter.copy_19);
      const updated = await store.update(document.id, loaded, (draft) => {
        draft.context = "preserved";
      });
      expect(updated.unknown_frontmatter.copy_19).toEqual(shared);
      expect((await canonical.read(document.id)).digest).toBe(updated.digest);
      expect((await store.list()).plans[0]!.unknown_frontmatter.copy_19).toEqual(shared);
      for (const invalid of ["[", "true", "[]"]) {
        expect(validPlanWireDocument({ ...document, unknown_frontmatter: invalid })).toBe(false);
      }
      expect(() =>
        decodePlanWireDocument({
          ...document,
          unknown_frontmatter: "x".repeat(MAX_PLAN_DOCUMENT_BYTES + 1),
        }),
      ).toThrow("canonical document bound");
    } finally {
      broker.revoke();
    }
  });

  it("preserves large reads, mutations and list pages through the real RPC and 256 KiB broker", async () => {
    const canonical = createPlanStore({ repository: createInMemoryPlanRepository() });
    const hostGrant = createHostPlansGrant(
      {
        storeFor: async () => ({
          key: "markdown:host",
          providerKind: "markdown",
          store: canonical,
        }),
      },
      "owner",
      { runId: "run", readTerminalRecord: () => null },
    );
    const broker = createCapabilityBroker({
      generation: "gen",
      runId: "run",
      grants: [hostGrant],
      maxArgumentsBytes: 256 * 1024,
      maxResultBytes: 256 * 1024,
    });
    const hostInput = new PassThrough();
    const guestInput = new PassThrough();
    let largestFrame = 0;
    for (const stream of [hostInput, guestInput])
      stream.on("data", (chunk: Buffer) => {
        largestFrame = Math.max(largestFrame, chunk.length);
      });
    const host = createExecutionPeer({
      role: "host",
      generation: "gen",
      input: hostInput,
      output: guestInput,
      handlers: {
        "host.capability": (request) =>
          broker.invoke(
            { generation: request.generation, runId: request.runId!, callId: request.callId! },
            request.payload as GuestCapabilityRequest,
            request.signal,
          ),
      },
    });
    const guest = createExecutionPeer({
      role: "guest",
      generation: "gen",
      input: guestInput,
      output: hostInput,
      handlers: {},
    });
    try {
      const store = (
        await createGuestPlanFactory({
          capability: (callId, request, requestSignal) =>
            guest.request("host.capability", { generation: "gen", runId: "run", callId }, request, {
              signal: requestSignal,
            }),
          model: async () => {
            throw new Error("no model in plan transport fixture");
          },
          event: async () => {},
          checkpoint: async () => {},
        }).storeFor("owner")
      ).store;
      const original = await canonical.create({
        title: "Reported regression",
        objective: "x".repeat(270_000),
        tasks: [],
        createdByRun: "prior",
      });
      expect((await store.read(original.id)).objective).toBe(original.objective);

      const objective = "界".repeat(1_000_000);
      const context = "文".repeat(1_000_000);
      let large = await store.create({
        title: "Near document limit",
        objective,
        context,
        tasks: [],
        createdByRun: "run",
      });
      large = await store.update(large.id, large, (draft) => {
        draft.notes = "語".repeat(500_000);
      });
      const canonicalBytes = Buffer.byteLength(renderPlan(large));
      expect(canonicalBytes).toBeGreaterThan(7 * 1024 * 1024);
      expect(canonicalBytes).toBeLessThanOrEqual(MAX_PLAN_DOCUMENT_BYTES);
      expect((await store.read(large.id)).digest).toBe(large.digest);
      large = await store.revise(large.id, large, {
        type: "set_title",
        title: "Large mutation response",
      });
      expect((await canonical.read(large.id)).title).toBe(large.title);
      large = await store.reconcile(large.id, large);
      for (let i = 0; i < 3; i++)
        await canonical.create({
          title: `List page ${i}`,
          objective,
          context,
          tasks: [],
          createdByRun: "prior",
        });
      const page = await store.list({ limit: 100 });
      expect(page.plans).toHaveLength(5);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeGreaterThan(24 * 1024 * 1024);
      expect(page.plans.find((plan) => plan.id === large.id)?.digest).toBe(large.digest);
      expect(largestFrame).toBeLessThan(256 * 1024);
      expect(host.closed).toBe(false);
      expect(guest.closed).toBe(false);
    } finally {
      broker.revoke();
      host.close();
      guest.close();
    }
  });

  it("reserves count and aggregate bytes before effects and releases completed downloads", async () => {
    for (const limit of ["count", "bytes"]) {
      let effects = 0;
      const value = "x".repeat(PLAN_TRANSFER_CHUNK_BYTES + 1);
      const grant = createPlanTransferGrant(
        grantFor(async () => {
          effects++;
          return value;
        }),
        {
          ...(limit === "count"
            ? { maxTransfers: 1 }
            : { maxBufferedBytes: PLAN_DOCUMENT_WIRE_BYTES }),
        },
      );
      const descriptor = (await grant.invoke(read, signal)) as { id: string };
      await expect(grant.invoke(read, signal)).rejects.toMatchObject({
        code: "resource_exhausted",
      });
      expect(effects).toBe(1);
      await grant.invoke({ operation: "transfer_release", input: { id: descriptor.id } }, signal);
      expect(await callPlanTransfer(read, transferCall(grant))).toBe(value);
      expect(await callPlanTransfer(read, transferCall(grant))).toBe(value);
      expect(effects).toBe(3);
      grant.revoke?.();
    }
  });

  it("reserves response capacity before committing an uploaded mutation", async () => {
    let effects = 0;
    const grant = createPlanTransferGrant(
      grantFor(async () => {
        effects++;
        return null;
      }),
      { maxBufferedBytes: PLAN_DOCUMENT_WIRE_BYTES },
    );
    const request = { ...read, padding: "x".repeat(PLAN_TRANSFER_CHUNK_BYTES + 1) };
    await expect(callPlanTransfer(request, transferCall(grant))).rejects.toMatchObject({
      code: "resource_exhausted",
    });
    expect(effects).toBe(0);
    expect(await callPlanTransfer(read, transferCall(grant))).toBeNull();
    expect(effects).toBe(1);
  });

  it("rejects malformed, out-of-order, tiny, overflowing and incomplete uploads before dispatch", async () => {
    let effects = 0;
    const grant = createPlanTransferGrant(
      grantFor(async () => {
        effects++;
        return null;
      }),
    );
    const invoke = transferCall(grant);
    const { id } = (await invoke({
      operation: "transfer_start",
      input: { bytes: PLAN_TRANSFER_CHUNK_BYTES + 1 },
    })) as { id: string };
    for (const request of [
      { operation: "transfer_start", input: { bytes: PLAN_DOCUMENT_WIRE_BYTES + 1 } },
      { operation: "transfer_start", input: { bytes: 0.5 } },
      { operation: "transfer_append", input: { id, offset: 0, data: "%%%=" } },
      {
        operation: "transfer_append",
        input: { id, offset: 1, data: Buffer.alloc(PLAN_TRANSFER_CHUNK_BYTES).toString("base64") },
      },
      { operation: "transfer_append", input: { id, offset: 0, data: "eA==" } },
      { operation: "transfer_commit", input: { id } },
      { operation: "transfer_read", input: { id, offset: 0 } },
      { operation: "transfer_release", input: { id, path: "/host" } },
    ])
      await expect(invoke(request)).rejects.toMatchObject({ code: "invalid_request" });
    await invoke({
      operation: "transfer_append",
      input: { id, offset: 0, data: Buffer.alloc(PLAN_TRANSFER_CHUNK_BYTES).toString("base64") },
    });
    await expect(
      invoke({
        operation: "transfer_append",
        input: { id, offset: PLAN_TRANSFER_CHUNK_BYTES, data: "eHg=" },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(effects).toBe(0);
    await invoke({ operation: "transfer_release", input: { id } });
    await expect(invoke({ operation: "transfer_commit", input: { id } })).rejects.toMatchObject({
      code: "invalid_request",
    });
    grant.revoke?.();
  });

  it("keeps in-flight reservations until settlement and revokes transfers without retaining late results", async () => {
    const gate = Promise.withResolvers<void>();
    const grant = createPlanTransferGrant(
      grantFor(async () => {
        await gate.promise;
        return "x".repeat(PLAN_TRANSFER_CHUNK_BYTES + 1);
      }),
      { maxTransfers: 1 },
    );
    const running = grant.invoke(read, signal);
    await expect(grant.invoke(read, signal)).rejects.toMatchObject({ code: "resource_exhausted" });
    grant.revoke?.();
    gate.resolve();
    await expect(running).rejects.toMatchObject({ code: "unauthorized" });
    await expect(grant.invoke(read, signal)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it.each(["nested", "json", "utf8"])(
    "refuses %s uploads at commit and frees their reservation",
    async (failure) => {
      let effects = 0;
      const grant = createPlanTransferGrant(
        grantFor(async () => {
          effects++;
          return null;
        }),
        { maxTransfers: 2 },
      );
      const buffer =
        failure === "nested"
          ? Buffer.from(JSON.stringify({ operation: "transfer_start", input: { bytes: 1 } }))
          : failure === "json"
            ? Buffer.from("{")
            : Buffer.from([0xff]);
      const invoke = transferCall(grant);
      const { id } = (await invoke({
        operation: "transfer_start",
        input: { bytes: buffer.length },
      })) as { id: string };
      await invoke({
        operation: "transfer_append",
        input: { id, offset: 0, data: buffer.toString("base64") },
      });
      await expect(invoke({ operation: "transfer_commit", input: { id } })).rejects.toMatchObject({
        code: "invalid_request",
      });
      await expect(invoke({ operation: "transfer_commit", input: { id } })).rejects.toMatchObject({
        code: "invalid_request",
      });
      expect(effects).toBe(0);
      expect(await invoke(read)).toBeNull();
      expect(effects).toBe(1);
    },
  );

  it("releases a partial download after cancellation or malformed data", async () => {
    for (const failure of ["cancel", "malformed"]) {
      const controller = new AbortController();
      const value = "x".repeat(PLAN_TRANSFER_CHUNK_BYTES + 1);
      const grant = createPlanTransferGrant(
        grantFor(async () => value),
        { maxTransfers: 1 },
      );
      const call = async (request: unknown, callSignal = signal) => {
        const result = await grant.invoke(request, callSignal);
        if ((request as { operation: string }).operation === "transfer_read") {
          if (failure === "cancel") controller.abort();
          else return { offset: 0, data: "eA==", done: false };
        }
        return result;
      };
      await expect(callPlanTransfer(read, call, controller.signal)).rejects.toThrow();
      expect(await callPlanTransfer(read, transferCall(grant))).toBe(value);
      grant.revoke?.();
    }
  });
});
