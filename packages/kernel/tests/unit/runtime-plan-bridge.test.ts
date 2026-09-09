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
  type PlanRef,
} from "@clarvis/plan";
import { createInMemoryPlanRepository } from "@clarvis/plan/testing";
import type { GuestExecutionBridge } from "../../src/runtime/execution-worker.ts";
import {
  createGuestPlanFactory,
  createHostPlansGrant,
  RUNTIME_PLANS_METHOD,
  RUNTIME_PLANS_REVISION,
} from "../../src/runtime/plan-bridge.ts";

type PlanAuthority = Parameters<typeof createHostPlansGrant>[2];

function bridgeFor(
  factory: PlanFactory,
  owner: string,
  context: PlanAuthority = {
    runId: "run-1",
    readTerminalRecord: () => null,
  },
): GuestExecutionBridge {
  const grant = createHostPlansGrant(factory, owner, context);
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

function planRef(document: PlanDocument, key = "markdown:host"): PlanRef {
  return {
    id: document.id,
    provider_key: key,
    final_revision: document.revision,
    final_spec_revision: document.spec_revision,
    status: document.status,
    retention: document.retention,
  };
}

function terminalRecord(document: PlanDocument): ReturnType<PlanAuthority["readTerminalRecord"]> {
  return {
    id: "run-1",
    owner_key_name: "owner-a",
    status: "completed",
    capability_state: { plans: planRef(document) },
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
    let terminal: ReturnType<PlanAuthority["readTerminalRecord"]> = null;
    const guest = await createGuestPlanFactory(
      bridgeFor(hostFactory, "owner-a", {
        runId: "run-1",
        readTerminalRecord: () => terminal,
      }),
    ).storeFor("forged-owner");

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
    await expect(guest.store.delete(created.id, reconciled)).rejects.toMatchObject({
      code: "unauthorized",
    });
    const completed = await guest.store.update(created.id, reconciled, (draft) => {
      draft.status = "completed";
      draft.retention = "discard";
    });
    terminal = terminalRecord(completed);
    expect(await guest.store.delete(created.id, completed)).toBe(true);
    expect(await guest.store.delete(created.id)).toBe(false);
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
      { runId: "run", readTerminalRecord: () => null },
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
      { runId: "run", readTerminalRecord: () => null },
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

  it("never binds another run's plan through read or list and rejects forged creators", async () => {
    const canonical = createPlanStore({ repository: createInMemoryPlanRepository() });
    const foreign = await canonical.create({
      title: "Retained",
      objective: "Protect host plans",
      tasks: [],
      createdByRun: "other-run",
    });
    const guest = (
      await createGuestPlanFactory(
        bridgeFor(
          {
            storeFor: async () => ({
              key: "markdown:host",
              providerKind: "markdown",
              store: canonical,
            }),
          },
          "owner-a",
          { runId: "run-1", readTerminalRecord: () => terminalRecord(foreign) },
        ),
      ).storeFor("owner-a")
    ).store;
    await guest.read(foreign.id);
    await guest.list();
    await expect(guest.delete(foreign.id)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      guest.update(foreign.id, foreign, (draft) => {
        draft.retention = "discard";
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      guest.revise(foreign.id, foreign, { type: "set_context", context: "forged" }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(guest.reconcile(foreign.id, foreign)).rejects.toMatchObject({
      code: "unauthorized",
    });
    await expect(
      guest.create({ title: "Forgery", objective: "", tasks: [], createdByRun: "other-run" }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(await canonical.read(foreign.id)).toEqual(foreign);
    expect((await canonical.list()).plans).toHaveLength(1);
  });

  it.each([
    "active",
    "keep",
    "missing_trace",
    "failed_run",
    "other_run",
    "other_owner",
    "other_plan",
    "other_provider",
    "stale_revision",
    "stale_spec",
    "retained_ref",
    "active_ref",
  ])("enforces host retention with %s even for a continuation binding", async (scenario) => {
    const canonical = createPlanStore({ repository: createInMemoryPlanRepository() });
    const created = await canonical.create({
      title: "Continuation",
      objective: "",
      tasks: [],
      createdByRun: "prior-run",
    });
    const document = await canonical.update(created.id, created, (draft) => {
      draft.status = scenario === "active" ? "active" : "completed";
      draft.retention = scenario === "keep" ? "keep" : "discard";
    });
    const record = terminalRecord(document)!;
    const ref = record.capability_state!.plans as PlanRef;
    if (scenario === "failed_run") record.status = "error";
    if (scenario === "other_run") record.id = "other-run";
    if (scenario === "other_owner") record.owner_key_name = "other-owner";
    if (scenario === "other_plan") ref.id = "other-plan";
    if (scenario === "other_provider") ref.provider_key = "other-provider";
    if (scenario === "stale_revision") ref.final_revision -= 1;
    if (scenario === "stale_spec") ref.final_spec_revision += 1;
    if (scenario === "retained_ref") ref.retention = "keep";
    if (scenario === "active_ref") ref.status = "active";
    const grant = createHostPlansGrant(
      {
        storeFor: async () => ({
          key: "markdown:host",
          providerKind: "markdown",
          store: canonical,
        }),
      },
      "owner-a",
      {
        runId: "run-1",
        priorRef: planRef(document),
        readTerminalRecord: () => (scenario === "missing_trace" ? null : record),
      },
    );
    await expect(
      grant.invoke(
        { operation: "delete", input: { id: document.id } },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(await canonical.read(document.id)).toEqual(document);
  });

  it("uses host CAS for retention even when the guest omits it", async () => {
    const canonical = createPlanStore({ repository: createInMemoryPlanRepository() });
    const created = await canonical.create({
      title: "Race",
      objective: "",
      tasks: [],
      createdByRun: "prior-run",
    });
    const document = await canonical.update(created.id, created, (draft) => {
      draft.status = "completed";
      draft.retention = "discard";
    });
    const grant = createHostPlansGrant(
      {
        storeFor: async () => ({
          key: "markdown:host",
          providerKind: "markdown",
          store: {
            ...canonical,
            async delete(id, expected) {
              expect(expected).toEqual(planCas(document));
              await canonical.update(id, document, (draft) => {
                draft.retention = "keep";
              });
              return canonical.delete(id, expected);
            },
          },
        }),
      },
      "owner-a",
      {
        runId: "run-1",
        priorRef: planRef(document),
        readTerminalRecord: () => terminalRecord(document),
      },
    );
    await expect(
      grant.invoke(
        { operation: "delete", input: { id: document.id } },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(PlanConflictError);
    expect((await canonical.read(document.id)).retention).toBe("keep");
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
