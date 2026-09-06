import { describe, expect, it } from "bun:test";
import {
  InvalidPlanError,
  PlanConflictError,
  PlanNotFoundError,
  PlanProviderUnavailableError,
  PlanSealedError,
  createPlanStore,
  type PlanDocument,
  type PlanFactory,
} from "@clarvis/plan";
import { createInMemoryPlanRepository } from "@clarvis/plan/testing";
import type { GuestExecutionBridge } from "../../src/runtime/execution-worker.ts";
import {
  createGuestPlanFactory,
  createHostPlansGrant,
  RUNTIME_PLANS_METHOD,
  RUNTIME_PLANS_REVISION,
} from "../../src/runtime/plan-bridge.ts";

function bridgeFor(factory: PlanFactory, owner: string): GuestExecutionBridge {
  const grant = createHostPlansGrant(factory, owner);
  return {
    async model() {
      throw new Error("model is outside this test");
    },
    async capability(_callId, request, signal) {
      expect(request.method).toBe(RUNTIME_PLANS_METHOD);
      expect(request.revision).toBe(RUNTIME_PLANS_REVISION);
      return grant.invoke(request.arguments, signal ?? new AbortController().signal);
    },
    async event() {},
    async checkpoint() {},
  };
}

function bridgeWith(capability: GuestExecutionBridge["capability"]): GuestExecutionBridge {
  return {
    model: () => Promise.reject(new Error("model is outside this test")),
    capability,
    event: () => Promise.resolve(),
    checkpoint: () => Promise.resolve(),
  };
}

function planCas(document: PlanDocument) {
  return {
    revision: document.revision,
    digest: document.digest,
    specDigest: document.spec_digest,
  };
}

describe("runtime plan bridge", () => {
  it("keeps plan identity and mutations in the canonical host store", async () => {
    const canonical = createPlanStore({ repository: createInMemoryPlanRepository() });
    const owners: string[] = [];
    const hostFactory: PlanFactory = {
      async storeFor(owner) {
        owners.push(owner);
        return { key: "markdown:host", providerKind: "markdown", store: canonical };
      },
    };
    const guest = await createGuestPlanFactory(bridgeFor(hostFactory, "owner-a")).storeFor(
      "forged-owner",
    );

    expect(guest.key).toBe("markdown:host");
    const created = await guest.store.create({
      title: "Bridge the plan",
      objective: "Keep the canonical plan on the host",
      tasks: [{ title: "Exercise the bridge" }],
      createdByRun: "run-1",
      now: new Date("2026-09-05T12:00:00.000Z"),
    });
    const revised = await guest.store.revise(created.id, created, {
      type: "set_context",
      context: "guest orchestration, host persistence",
    });
    const replaced = await guest.store.update(
      created.id,
      revised,
      (draft) => {
        draft.objective = "Retain canonical host authority";
      },
      { structural: false, now: new Date("2026-09-05T12:01:00.000Z") },
    );
    const reconciled = await guest.store.reconcile(
      created.id,
      replaced,
      new Date("2026-09-05T12:02:00.000Z"),
    );

    expect(owners).toEqual(["owner-a"]);
    expect(await canonical.read(created.id)).toMatchObject({
      id: created.id,
      revision: reconciled.revision,
      context: "guest orchestration, host persistence",
      objective: "Retain canonical host authority",
    });
    expect((await guest.store.list()).plans.map((plan) => plan.id)).toEqual([created.id]);
    expect(await guest.store.delete(created.id, reconciled)).toBe(true);
    await expect(canonical.read(created.id)).rejects.toMatchObject({ code: "plan_not_found" });
  });

  it("rejects extra fields before touching the host provider", async () => {
    let resolved = false;
    const grant = createHostPlansGrant(
      {
        async storeFor() {
          resolved = true;
          throw new Error("must not resolve");
        },
      },
      "owner",
    );
    expect(
      grant.validateArguments({ operation: "read", input: { id: "plan", path: "/host" } }),
    ).toBe(false);
    expect(resolved).toBe(false);
  });

  it("validates every host operation without accepting widened wire input", async () => {
    const canonical = createPlanStore({ repository: createInMemoryPlanRepository() });
    const document = await canonical.create({
      title: "Wire contract",
      objective: "Validate plan bridge operations",
      tasks: [{ title: "Validate" }],
      createdByRun: "run",
      now: new Date("2026-09-05T12:00:00.000Z"),
    });
    const grant = createHostPlansGrant(
      {
        storeFor: async () => ({
          key: "markdown:test",
          providerKind: "markdown",
          store: canonical,
        }),
      },
      "owner",
    );
    const expected = planCas(document);
    const now = "2026-09-05T12:01:00.000Z";
    for (const request of [
      { operation: "resolve" },
      {
        operation: "create",
        input: {
          value: {
            title: "Create",
            objective: "Create through the host",
            tasks: [],
            createdByRun: "run",
            now,
          },
        },
      },
      { operation: "read", input: { id: document.id } },
      {
        operation: "list",
        input: {
          value: {
            cursor: "cursor",
            limit: 10,
            status: "active",
            retention: "keep",
          },
        },
      },
      {
        operation: "replace",
        input: { id: document.id, expected, document, structural: false, now },
      },
      { operation: "reconcile", input: { id: document.id, known: expected, now } },
      {
        operation: "revise",
        input: {
          id: document.id,
          expected,
          operation: [
            { type: "set_context", context: "one" },
            { type: "set_context", context: "two" },
          ],
          now,
        },
      },
      { operation: "delete", input: { id: document.id } },
    ]) {
      expect(grant.validateArguments(request)).toBe(true);
    }
    for (const request of [
      null,
      [],
      { operation: "resolve", input: {} },
      { operation: "create", input: { value: { title: "missing fields" } } },
      {
        operation: "create",
        input: {
          value: {
            title: "Create",
            objective: "",
            tasks: [],
            createdByRun: "run",
            hostPath: "/private",
          },
        },
      },
      { operation: "read", input: { id: "" } },
      { operation: "list", input: { value: { limit: 0 } } },
      { operation: "list", input: { value: { status: "unknown" } } },
      { operation: "replace", input: { id: document.id, expected: {}, document } },
      { operation: "reconcile", input: { id: document.id, known: expected, now: "never" } },
      { operation: "revise", input: { id: document.id, expected, operation: [] } },
      { operation: "delete", input: { id: document.id, expected: {} } },
      { operation: "unknown" },
    ]) {
      expect(grant.validateArguments(request)).toBe(false);
    }
    await expect(
      grant.invoke({ operation: "unknown" }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("maps host plan failures back to the canonical guest error classes", async () => {
    const cases = [
      ["plan_not_found", PlanNotFoundError],
      ["plan_conflict", PlanConflictError],
      ["plan_sealed", PlanSealedError],
      ["plan_invalid", InvalidPlanError],
      ["plan_provider_unavailable", PlanProviderUnavailableError],
    ] as const;
    for (const [code, ErrorType] of cases) {
      const factory = createGuestPlanFactory(
        bridgeWith(async (_callId, request) => {
          const input = request.arguments as { operation: string };
          if (input.operation === "resolve") {
            return { key: "markdown:test", providerKind: "markdown" };
          }
          throw Object.assign(new Error(`host ${code}`), { code });
        }),
      );
      const selected = await factory.storeFor("owner");
      await expect(selected.store.read("plan-id")).rejects.toBeInstanceOf(ErrorType);
    }

    const original = new Error("unexpected bridge failure");
    const factory = createGuestPlanFactory(
      bridgeWith(async (_callId, request) => {
        const input = request.arguments as { operation: string };
        if (input.operation === "resolve")
          return { key: "markdown:test", providerKind: "markdown" };
        throw original;
      }),
    );
    await expect((await factory.storeFor("owner")).store.read("plan-id")).rejects.toBe(original);
  });

  it("rejects malformed provider identities, documents, lists, cursors and delete results", async () => {
    for (const identity of [null, {}, { key: "", providerKind: "markdown" }]) {
      await expect(
        createGuestPlanFactory(bridgeWith(() => Promise.resolve(identity))).storeFor("owner"),
      ).rejects.toBeInstanceOf(PlanProviderUnavailableError);
    }

    const malformed = async (operation: string, result: unknown) => {
      const selected = await createGuestPlanFactory(
        bridgeWith(async (_callId, request) => {
          const input = request.arguments as { operation: string };
          return input.operation === "resolve"
            ? { key: "markdown:test", providerKind: "markdown" }
            : result;
        }),
      ).storeFor("owner");
      if (operation === "read") return selected.store.read("plan-id");
      if (operation === "list") return selected.store.list();
      return selected.store.delete("plan-id");
    };
    await expect(malformed("read", { id: "not-a-plan" })).rejects.toBeInstanceOf(InvalidPlanError);
    await expect(malformed("list", { plans: "invalid" })).rejects.toBeInstanceOf(InvalidPlanError);
    await expect(malformed("list", { plans: [], next_cursor: 5 })).rejects.toBeInstanceOf(
      InvalidPlanError,
    );
    await expect(malformed("delete", "yes")).rejects.toBeInstanceOf(InvalidPlanError);
  });
});
