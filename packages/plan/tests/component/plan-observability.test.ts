/**
 * The operator-facing events `@clarvis/plan` emits, and the fields an operator
 * greps. Each case pins one decision the package used to make in silence: a
 * losing compare-and-swap, a document dropped from a listing, a continuation
 * rewriting the user's plan, retention deleting it, an unmodelled tool failure,
 * and the tracking port's absence.
 */
import { describe, expect, it } from "bun:test";
import {
  createCapabilityServices,
  type AgentBuildContext,
  type AgentScope,
  type TaskTrackingProvider,
  type RunCapability,
} from "@clarvis/capability";

import {
  createPlanStore,
  type PlanDocument,
  type PlanRef,
  type PlanStore,
} from "../../src/index.ts";
import { createInMemoryPlanRepository } from "../../src/testing.ts";
import { PlanSession } from "../../src/capability/session.ts";
import { createPlansCapability, PLAN_PORT } from "../../src/capability/index.ts";
import {
  CREATE_PLAN_TOOL_NAME,
  LIST_PLANS_TOOL_NAME,
  handlePlanRuntimeCall,
} from "../../src/capability/runtime-tools.ts";
import {
  fakeAgentBuildContext,
  fakeExecutionRecord,
  fakeRunCapabilityContext,
} from "../helpers/context.ts";
import { recordingLogger } from "../helpers/recording-logger.ts";

async function seed(store: PlanStore): Promise<PlanDocument> {
  return store.create({
    title: "Plan",
    objective: "Objective",
    tasks: [{ title: "One" }],
    createdByRun: "run-1",
  });
}

describe("plan.cas.rejected", () => {
  it("names which of the three components disagreed on update", async () => {
    const log = recordingLogger();
    const store = createPlanStore({
      repository: createInMemoryPlanRepository(),
      logger: log.logger,
    });
    const created = await seed(store);
    await store.update(created.id, created, (plan) => {
      plan.notes = "moved on";
    });

    await expect(store.update(created.id, created, () => {})).rejects.toThrow(
      "Plan changed since it was read",
    );
    const record = log.one("plan.cas.rejected");
    expect(record.level).toBe("debug");
    expect(record.fields.plan_id).toBe(created.id);
    expect(record.fields.mismatch).toEqual(["revision", "digest"]);
    expect(record.fields.expected_revision).toBe(created.revision);
    expect(record.fields.actual_revision).toBe(created.revision + 1);
  });

  it("reports a spec_digest-only mismatch, which a revision alone cannot show", async () => {
    const log = recordingLogger();
    const store = createPlanStore({
      repository: createInMemoryPlanRepository(),
      logger: log.logger,
    });
    const created = await seed(store);

    await expect(
      store.update(created.id, { ...created, spec_digest: "stale" }, () => {}),
    ).rejects.toThrow("Plan changed since it was read");
    expect(log.one("plan.cas.rejected").fields.mismatch).toEqual(["spec_digest"]);
  });

  it("reports the conflict a compare-and-swap delete refuses on", async () => {
    const log = recordingLogger();
    const store = createPlanStore({
      repository: createInMemoryPlanRepository(),
      logger: log.logger,
    });
    const created = await seed(store);
    const moved = await store.update(created.id, created, (plan) => {
      plan.notes = "moved on";
    });

    await expect(store.delete(created.id, created)).rejects.toThrow(
      "Plan changed since it was read",
    );
    const record = log.one("plan.cas.rejected");
    expect(record.fields.actual_revision).toBe(moved.revision);
    expect(record.fields.mismatch).toEqual(["revision", "digest"]);
  });

  it("stays silent when the baseline still matches", async () => {
    const log = recordingLogger();
    const store = createPlanStore({
      repository: createInMemoryPlanRepository(),
      logger: log.logger,
    });
    const created = await seed(store);
    await store.delete(created.id, created);
    expect(log.of("plan.cas.rejected")).toHaveLength(0);
  });
});

describe("plan.document.unparsable", () => {
  it("reports a plan the store's own listing drops, with the basename only", async () => {
    const log = recordingLogger();
    const repository = createInMemoryPlanRepository();
    const store = createPlanStore({
      repository: {
        ...repository,
        list: () =>
          Promise.resolve({
            records: [
              {
                id: "p1",
                source: "this is not a plan document",
                digest: "d",
                index: {
                  title: "Broken",
                  status: "active",
                  retention: "keep",
                  revision: 1,
                  spec_revision: 1,
                  created_at: "2026-08-01T00:00:00.000Z",
                  updated_at: "2026-08-01T00:00:00.000Z",
                  created_by_run: "run-0",
                  path: ".clarvis/plans/2026-08-01T00-00-00-broken.md",
                },
              },
            ],
          }),
      },
      logger: log.logger,
    });

    const page = await store.list();
    expect(page.plans).toHaveLength(0);
    const record = log.one("plan.document.unparsable");
    expect(record.level).toBe("warn");
    expect(record.fields.layer).toBe("store");
    expect(String(record.fields.path)).not.toContain("/");
    expect(String(record.fields.reason).length).toBeGreaterThan(0);
    expect(String(record.fields.reason)).not.toContain("\n");
    expect(String(record.fields.reason).length).toBeLessThanOrEqual(500);
  });
});

describe("plan.continuation.*", () => {
  it("reports the tasks a continuation reset and the approval it dropped", async () => {
    const log = recordingLogger();
    const store = createPlanStore({ repository: createInMemoryPlanRepository() });
    const created = await store.create({
      title: "Plan",
      objective: "Objective",
      tasks: [{ title: "One", status: "in_progress" }, { title: "Two" }],
      createdByRun: "run-0",
    });
    const approved = await store.update(created.id, created, (plan) => {
      plan.approved_spec_revision = plan.spec_revision;
    });

    const session = new PlanSession({
      store,
      executionId: "run-1",
      review: false,
      logger: log.logger,
      initialRef: {
        id: approved.id,
        provider_key: "markdown",
        status: "active",
        retention: "keep",
        final_revision: approved.revision,
        final_spec_revision: approved.spec_revision,
      },
    });
    await session.reconcile();

    const record = log.one("plan.continuation.reset");
    expect(record.level).toBe("info");
    expect(record.fields.plan_id).toBe(created.id);
    expect(record.fields.tasks_reset).toBe(1);
    expect(record.fields.status_from).toBe("active");
    expect(record.fields.stale_approval_cleared).toBe(true);
  });

  it("says a discarded plan's absence is its own retention, not data loss", async () => {
    const log = recordingLogger();
    const store = createPlanStore({ repository: createInMemoryPlanRepository() });
    const session = new PlanSession({
      store,
      executionId: "run-1",
      review: false,
      logger: log.logger,
      initialRef: {
        id: "00000000-0000-4000-8000-000000000000",
        provider_key: "markdown",
        status: "completed",
        retention: "discard",
        final_revision: 4,
        final_spec_revision: 1,
      },
    });

    expect(await session.reconcile()).toBeUndefined();
    const record = log.one("plan.continuation.absent");
    expect(record.level).toBe("debug");
    expect(record.fields.reason).toBe("discarded");
  });
});

describe("plan.tool.unexpected_error", () => {
  const brokenSession = (error: unknown): PlanSession =>
    ({
      create: (): never => {
        throw error;
      },
      takeRemoval: () => undefined,
    }) as unknown as PlanSession;

  const call = (session: PlanSession, log: ReturnType<typeof recordingLogger>) =>
    handlePlanRuntimeCall(
      CREATE_PLAN_TOOL_NAME,
      { title: "Plan", objective: "Objective", tasks: [{ title: "One" }], validation: [] },
      session,
      log.logger,
    );

  it("reports an error the dispatcher does not model", async () => {
    const log = recordingLogger();
    const result = await call(brokenSession(new TypeError("plan.tasks is not iterable")), log);

    expect(result.error).toContain("not iterable");
    const record = log.one("plan.tool.unexpected_error");
    expect(record.level).toBe("error");
    expect(record.fields.tool).toBe(CREATE_PLAN_TOOL_NAME);
    expect(record.fields.error_name).toBe("TypeError");
    expect(record.fields.cause).toContain("not iterable");
    expect(record.fields.stack).toBeDefined();
  });

  it("reports a thrown non-Error too, whose name is only its type", async () => {
    const log = recordingLogger();
    await call(brokenSession("no"), log);
    expect(log.one("plan.tool.unexpected_error").fields.error_name).toBe("string");
  });

  it("stays silent for a refusal the model can act on", async () => {
    const log = recordingLogger();
    const store = createPlanStore({ repository: createInMemoryPlanRepository() });
    const session = new PlanSession({ store, executionId: "run-1", review: false });
    await call(session, log);
    const refused = await handlePlanRuntimeCall(
      CREATE_PLAN_TOOL_NAME,
      { title: "Second", objective: "Objective", tasks: [{ title: "One" }], validation: [] },
      session,
      log.logger,
    );

    expect(refused.error).toContain("An active plan already exists");
    expect(log.of("plan.tool.unexpected_error")).toHaveLength(0);
  });

  it("stays silent for a cursor the model made up", async () => {
    // A stale or hallucinated cursor is an ordinary model mistake, so it must
    // read as a refusal. `PlanCursorError` carries its own `name`, so leaving it
    // out of the expected set logged every one at ERROR with a full stack -
    // exactly the noise that set exists to suppress.
    const log = recordingLogger();
    const store = createPlanStore({ repository: createInMemoryPlanRepository() });
    const session = new PlanSession({ store, executionId: "run-1", review: false });

    const refused = await handlePlanRuntimeCall(
      LIST_PLANS_TOOL_NAME,
      { cursor: "zz9:not-a-cursor-this-store-minted" },
      session,
      log.logger,
    );

    expect(refused.error).toBeDefined();
    expect(log.of("plan.tool.unexpected_error")).toHaveLength(0);
  });

  it("stays silent for a rejected argument schema", async () => {
    const log = recordingLogger();
    const store = createPlanStore({ repository: createInMemoryPlanRepository() });
    const session = new PlanSession({ store, executionId: "run-1", review: false });

    const rejected = await handlePlanRuntimeCall(CREATE_PLAN_TOOL_NAME, {}, session, log.logger);
    expect(rejected.error).toBeDefined();
    expect(log.of("plan.tool.unexpected_error")).toHaveLength(0);
  });
});

async function runWithLogger(
  log: ReturnType<typeof recordingLogger>,
  store: PlanStore,
): Promise<RunCapability> {
  const capability = createPlansCapability({
    factory: {
      storeFor: () =>
        Promise.resolve({ key: "markdown", providerKind: "markdown" as const, store }),
    },
    defaultPendingTaskNudges: 3,
    defaultElicitWaitMs: 30_000,
    logger: log.logger,
  });
  const run = await capability.forRun(
    fakeRunCapabilityContext({
      services: createCapabilityServices(),
      requestParam: (key) => (key === "plans" ? "on" : undefined),
    }),
  );
  if (run === null) throw new Error("the plans capability refused the run");
  return run;
}

describe("plan.retention.discarded", () => {
  const discardRef = (plan: PlanDocument): PlanRef => ({
    id: plan.id,
    provider_key: "markdown",
    status: "completed",
    retention: "discard",
    final_revision: plan.revision,
    final_spec_revision: plan.spec_revision,
  });

  it("says the document was deleted, and how far it had got", async () => {
    const log = recordingLogger();
    const store = createPlanStore({ repository: createInMemoryPlanRepository() });
    const created = await seed(store);
    const run = await runWithLogger(log, store);

    await run.onRunEnd!(fakeExecutionRecord("completed", { plans: discardRef(created) }));

    const record = log.one("plan.retention.discarded");
    expect(record.level).toBe("info");
    expect(record.fields.plan_id).toBe(created.id);
    expect(record.fields.revision).toBe(created.revision);
    expect(record.fields.deleted).toBe(true);
  });

  it("says nothing was removed when the document had already gone", async () => {
    const log = recordingLogger();
    const store = createPlanStore({ repository: createInMemoryPlanRepository() });
    const created = await seed(store);
    await store.delete(created.id);
    const run = await runWithLogger(log, store);

    await run.onRunEnd!(fakeExecutionRecord("completed", { plans: discardRef(created) }));
    expect(log.one("plan.retention.discarded").fields.deleted).toBe(false);
  });

  it("reports a failed delete through bestEffort and still ends the run", async () => {
    const log = recordingLogger();
    const store = createPlanStore({ repository: createInMemoryPlanRepository() });
    const created = await seed(store);
    const failing: PlanStore = {
      ...store,
      delete: () => Promise.reject(new Error("disk is gone")),
    };
    const run = await runWithLogger(log, failing);

    await run.onRunEnd!(fakeExecutionRecord("completed", { plans: discardRef(created) }));

    expect(log.records.some((r) => r.message === "best_effort_failed")).toBe(true);
    expect(log.one("plan.retention.discarded").fields.deleted).toBe(false);
  });
});

describe("plan.tracking_port.absent", () => {
  it("reports once for a run whose agent gets no plan task port", async () => {
    const log = recordingLogger();
    const store = createPlanStore({ repository: createInMemoryPlanRepository() });
    const services = createCapabilityServices();
    const capability = createPlansCapability({
      factory: {
        storeFor: () =>
          Promise.resolve({ key: "markdown", providerKind: "markdown" as const, store }),
      },
      defaultPendingTaskNudges: 3,
      defaultElicitWaitMs: 30_000,
      logger: log.logger,
    });
    const run = await capability.forRun(
      fakeRunCapabilityContext({
        services,
        executionId: "run-42",
        requestParam: (key) => (key === "plans" ? "on" : undefined),
      }),
    );
    expect(run).not.toBeNull();

    const provider = services.get(PLAN_PORT) as TaskTrackingProvider;
    expect(provider.forAgent(fakeAgentBuildContext())).toBeUndefined();
    expect(provider.forAgent(fakeAgentBuildContext())).toBeUndefined();

    const record = log.one("plan.tracking_port.absent");
    expect(record.level).toBe("debug");
    expect(record.fields.execution_id).toBe("run-42");
  });

  it("stays silent once the entry agent has attached", async () => {
    const log = recordingLogger();
    const store = createPlanStore({ repository: createInMemoryPlanRepository() });
    const services = createCapabilityServices();
    const capability = createPlansCapability({
      factory: {
        storeFor: () =>
          Promise.resolve({ key: "markdown", providerKind: "markdown" as const, store }),
      },
      defaultPendingTaskNudges: 3,
      defaultElicitWaitMs: 30_000,
      logger: log.logger,
    });
    const run = await capability.forRun(
      fakeRunCapabilityContext({
        services,
        requestParam: (key) => (key === "plans" ? "on" : undefined),
      }),
    );
    const scope = { agent: "lead", entry: true, grants: [] } as unknown as AgentScope;
    const bc: AgentBuildContext = fakeAgentBuildContext();
    run!.forAgent(scope)!.attach(bc);

    const provider = services.get(PLAN_PORT) as TaskTrackingProvider;
    expect(provider.forAgent(bc)).toBeDefined();
    expect(log.of("plan.tracking_port.absent")).toHaveLength(0);
  });
});
