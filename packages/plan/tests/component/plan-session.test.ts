import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PLAN_RETENTION,
  InvalidPlanError,
  PlanSealedError,
  PlanService,
  createPlanStore,
  type PlanCas,
  type PlanStore,
} from "../../src/index.ts";

import { DEFAULT_PENDING_TASK_NUDGES } from "@clarvis/capability";
import { PLANS_DEFAULTS } from "../../src/settings.ts";
import { PlanSession } from "../../src/capability/session.ts";
import { createEditablePlanRepository, type EditablePlanRepository } from "../helpers/store.ts";

function planStoreFor(repository: EditablePlanRepository): PlanStore {
  return createPlanStore({ repository });
}

function cas(session: PlanSession): PlanCas {
  const plan = session.cached()!;
  return { revision: plan.revision, digest: plan.digest, specDigest: plan.spec_digest };
}

async function fixture(review = false): Promise<{
  repository: EditablePlanRepository;
  store: PlanStore;
  session: PlanSession;
}> {
  const repository = createEditablePlanRepository();
  const store = planStoreFor(repository);
  return {
    repository,
    store,
    session: new PlanSession({
      store,
      executionId: "run-1",
      review,
    }),
  };
}

describe("PlanSession", () => {
  test("reconciles valid external edits before mutations", async () => {
    const { repository, session } = await fixture();
    const created = await session.create({
      title: "Plan",
      objective: "Initial",
      tasks: [{ title: "One" }],
    });
    const source = (await repository.read(created.id))!.source;
    repository.poke(created.id, source.replace("Initial", "Edited externally"));

    const reconciled = await session.reconcile();
    expect(reconciled?.objective).toBe("Edited externally");
    expect(reconciled?.revision).toBe(created.revision + 1);
    expect(reconciled?.spec_revision).toBe(created.spec_revision + 1);

    const revised = await session.revise(cas(session), {
      type: "set_title",
      title: "Renamed",
    });
    expect(revised.title).toBe("Renamed");
    expect(revised.spec_revision).toBe(reconciled!.spec_revision);
  });

  test("preserves an invalid external document and blocks mutations", async () => {
    const { repository, session } = await fixture();
    const created = await session.create({
      title: "Plan",
      objective: "Initial",
      tasks: [{ title: "One" }],
    });
    const invalid = (await repository.read(created.id))!.source.replace(
      "status: active",
      "status: nonsense",
    );
    repository.poke(created.id, invalid);

    expect((await session.reconcile())?.title).toBe("Plan");
    await expect(
      session.revise(cas(session), {
        type: "set_title",
        title: "Must not be written",
      }),
    ).rejects.toBeInstanceOf(InvalidPlanError);
    expect(repository.source(created.id)).toBe(invalid);
  });

  test("adopts a concurrent control-plane write so the run can still finalize", async () => {
    const { repository, session } = await fixture();
    const created = await session.create({
      title: "Plan",
      objective: "Initial",
      tasks: [{ title: "One" }],
    });

    const service = new PlanService(planStoreFor(repository));
    const bumped = await service.setRetention(created.id, "keep");
    expect(bumped.revision).toBe(created.revision + 1);

    const reconciled = await session.reconcile();
    expect(reconciled?.revision).toBe(bumped.revision);
    expect(reconciled?.retention).toBe("keep");

    await session.transition({
      expected: cas(session),
      transitions: [{ taskId: "t1", status: "done", result: "Complete" }],
    });
    const ref = await session.finalize("completed");
    expect(ref?.status).toBe("completed");
  });

  test("invalidates a plan removed outside the plan API and allows a replacement", async () => {
    const { repository, session } = await fixture();
    const created = await session.create({
      title: "Plan",
      objective: "Initial",
      tasks: [{ title: "One" }],
    });
    expect(await repository.delete(created.id)).toBeTrue();

    expect(await session.reconcile()).toBeUndefined();
    expect(session.cached()).toBeUndefined();
    expect(session.missing()).toMatchObject({
      id: created.id,
      path: created.path,
      revision: created.revision,
      specRevision: created.spec_revision,
    });
    expect(session.ref()).toMatchObject({
      id: created.id,
      path: created.path,
      final_revision: created.revision,
      final_spec_revision: created.spec_revision,
      status: "active",
      retention: DEFAULT_PLAN_RETENTION,
    });
    expect(await session.finalize("failed")).toEqual(session.ref());
    await expect(
      session.transition({
        expected: {
          revision: created.revision,
          digest: created.digest,
          specDigest: created.spec_digest,
        },
        transitions: [{ taskId: "t1", status: "in_progress" }],
      }),
    ).rejects.toThrow(/Do not retry this mutation/);

    const replacement = await session.create({
      title: "Replacement",
      objective: "Resume from confirmed state",
      tasks: [{ title: "Rebuild the missing work" }],
    });
    expect(replacement.id).not.toBe(created.id);
    expect(session.missing()).toBeUndefined();
    expect(session.takeRemoval()?.id).toBe(created.id);
  });

  test("recovers in-progress tasks from a continuation", async () => {
    const repository = createEditablePlanRepository();
    const store = planStoreFor(repository);
    const created = await store.create({
      title: "Plan",
      objective: "Initial",
      tasks: [{ title: "One" }],
      createdByRun: "run-1",
    });
    const running = await store.update(created.id, created, (plan) => {
      plan.tasks[0]!.status = "in_progress";
      plan.status = "failed";
    });
    const session = new PlanSession({
      store: planStoreFor(repository),
      executionId: "run-2",
      review: false,
      initialRef: {
        id: running.id,
        provider_key: "markdown",
        final_revision: running.revision,
        final_spec_revision: running.spec_revision,
        status: "failed",
        retention: "keep",
      },
    });

    const recovered = await session.reconcile();
    expect(recovered?.status).toBe("active");
    expect(recovered?.tasks[0]?.status).toBe("pending");
    expect(recovered?.revision).toBe(running.revision + 1);
  });

  /**
   * Approval binds to the run, not to the document. A plan approved under
   * `mode: "review"` and continued under `mode: "on"` must not keep a binding
   * this run has no gate to renew, or a structural revision would revoke it and
   * strand the document at `awaiting_approval` in a run that cannot leave it.
   */
  test("drops an approval carried into a run that has no review gate", async () => {
    const repository = createEditablePlanRepository();
    const store = planStoreFor(repository);
    const created = await store.create({
      title: "Plan",
      objective: "Initial",
      tasks: [{ title: "One" }],
      createdByRun: "run-1",
      review: true,
    });
    const approved = await store.update(created.id, created, (plan) => {
      plan.approved_spec_revision = plan.spec_revision;
      plan.status = "active";
    });
    expect(approved.approved_spec_revision).toBe(approved.spec_revision);

    const session = new PlanSession({
      store: planStoreFor(repository),
      executionId: "run-2",
      review: false,
      initialRef: {
        id: approved.id,
        provider_key: "markdown",
        final_revision: approved.revision,
        final_spec_revision: approved.spec_revision,
        status: "active",
        retention: "keep",
      },
    });

    const continued = await session.reconcile();
    expect(continued?.approved_spec_revision).toBeUndefined();

    const revised = await session.revise(cas(session), {
      type: "set_objective",
      objective: "Changed mid-run",
    });
    expect(revised.status).toBe("active");
  });

  test("keeps an approval carried into a run that still has the gate", async () => {
    const repository = createEditablePlanRepository();
    const store = planStoreFor(repository);
    const created = await store.create({
      title: "Plan",
      objective: "Initial",
      tasks: [{ title: "One" }],
      createdByRun: "run-1",
      review: true,
    });
    const approved = await store.update(created.id, created, (plan) => {
      plan.approved_spec_revision = plan.spec_revision;
      plan.status = "active";
    });

    const session = new PlanSession({
      store: planStoreFor(repository),
      executionId: "run-2",
      review: true,
      initialRef: {
        id: approved.id,
        provider_key: "markdown",
        final_revision: approved.revision,
        final_spec_revision: approved.spec_revision,
        status: "active",
        retention: "keep",
      },
    });

    expect((await session.reconcile())?.approved_spec_revision).toBe(approved.spec_revision);
  });

  test("creates the plan with the workspace's configured retention", async () => {
    const repository = createEditablePlanRepository();
    const session = new PlanSession({
      store: planStoreFor(repository),
      executionId: "run-1",
      review: false,
      retention: "discard",
    });
    const created = await session.create({
      title: "Throwaway",
      objective: "Do not linger",
      tasks: [{ title: "One" }],
    });
    expect(created.retention).toBe("discard");
    expect((await repository.read(created.id))?.source).toContain("retention: discard");
  });

  test("create_plan's own retention overrides the workspace default", async () => {
    const session = new PlanSession({
      store: planStoreFor(createEditablePlanRepository()),
      executionId: "run-1",
      review: false,
      retention: "keep",
    });
    const created = await session.create({
      title: "Throwaway",
      objective: "Do not linger",
      tasks: [{ title: "One" }],
      retention: "discard",
    });
    expect(created.retention).toBe("discard");
  });

  test("the loop's settings default and the plan store's fallback never drift", () => {
    expect(PLANS_DEFAULTS.retention).toBe(DEFAULT_PLAN_RETENTION);
  });

  test("the plans default and the contract's copy of the nudge budget never drift", () => {
    expect(PLANS_DEFAULTS.pending_task_nudges).toBe(DEFAULT_PENDING_TASK_NUDGES);
  });

  test("setRetention changes the plan's retention policy in place", async () => {
    const { session } = await fixture();
    const created = await session.create({
      title: "Plan",
      objective: "Initial",
      tasks: [{ title: "One" }],
    });
    expect(created.retention).toBe("keep");

    const updated = await session.setRetention("discard");
    expect(updated.retention).toBe("discard");
    expect(updated.revision).toBe(created.revision + 1);
    expect(session.cached()?.retention).toBe("discard");
  });
});

/**
 * A session in `code` spans every turn the user takes, each one continuing the
 * last, so the plan of the first feature used to become a container every later
 * feature was rewritten into. The forensic case: a plan created as "Metas
 * financeiras" ended up titled "Pagamentos parcelados", ten spec revisions deep,
 * with the record of the savings-goals work it had actually completed gone.
 */
describe("PlanSession — a completed plan is a final record", () => {
  /** A finished plan with `open` extra tasks the run never closed. */
  async function completed(open: string[] = []): Promise<{
    repository: EditablePlanRepository;
    store: PlanStore;
    ref: NonNullable<Awaited<ReturnType<PlanSession["finalize"]>>>;
  }> {
    const repository = createEditablePlanRepository();
    const store = planStoreFor(repository);
    const first = new PlanSession({ store, executionId: "run-1", review: false });
    await first.create({
      title: "Feature one",
      objective: "Ship the first feature",
      tasks: [{ title: "Build it" }, ...open.map((title) => ({ title }))],
    });
    await first.transitionCurrent({ taskId: "t1", status: "done", result: "Shipped" });
    const ref = await first.finalize("completed");
    return { repository, store, ref: ref! };
  }

  const nextTurn = (
    repository: EditablePlanRepository,
    ref: NonNullable<Awaited<ReturnType<PlanSession["finalize"]>>>,
  ) =>
    new PlanSession({
      store: planStoreFor(repository),
      executionId: "run-2",
      review: false,
      initialRef: ref,
    });

  test("a continued run loads it as it stands instead of republishing it as active", async () => {
    const { repository, ref } = await completed();
    const session = nextTurn(repository, ref);

    const loaded = await session.reconcile();
    expect(loaded?.status).toBe("completed");
    expect(loaded?.revision).toBe(ref.final_revision);
  });

  test("the next turn creates the next plan rather than rewriting the finished one", async () => {
    const { repository, store, ref } = await completed();
    const session = nextTurn(repository, ref);

    const second = await session.create({
      title: "Feature two",
      objective: "Ship the second feature",
      tasks: [{ title: "Build that too" }],
    });
    expect(second.id).not.toBe(ref.id);

    const first = await store.read(ref.id);
    expect(first.title).toBe("Feature one");
    expect(first.status).toBe("completed");
    expect(first.spec_revision).toBe(ref.final_spec_revision);
  });

  test("a task the earlier run finished but forgot to record can still be closed", async () => {
    const { repository, ref } = await completed(["Actually finished, never recorded"]);
    const session = nextTurn(repository, ref);

    const closed = await session.transitionCurrent({
      taskId: "t2",
      status: "done",
      result: "It was done all along",
    });
    expect(closed.tasks[1]?.status).toBe("done");
    expect(closed.status).toBe("completed");
  });

  test("but that task cannot be put back to work, and a closed one cannot reopen", async () => {
    const { repository, ref } = await completed(["Never started"]);
    const session = nextTurn(repository, ref);
    await session.reconcile();

    await expect(
      session.transitionCurrent({ taskId: "t2", status: "in_progress" }),
    ).rejects.toThrow(PlanSealedError);
    await expect(session.transitionCurrent({ taskId: "t1", status: "pending" })).rejects.toThrow(
      PlanSealedError,
    );
  });

  test("a cancelled continuation does not overwrite the completed record", async () => {
    // `finalize` stamps the run's own outcome onto the plan, so a continued turn
    // the user interrupted used to write `cancelled` over work that had shipped.
    const { repository, store, ref } = await completed();
    const session = nextTurn(repository, ref);
    await session.reconcile();

    const finalRef = await session.finalize("cancelled");
    expect(finalRef?.status).toBe("completed");
    expect((await store.read(ref.id)).status).toBe("completed");
  });
});

describe("PlanSession — one open plan at a time, not one plan per run", () => {
  test("a single turn may finish a plan and start the next, sealing the first", async () => {
    // Nothing inside a run can move a plan to `completed` -- only teardown calls
    // `finalize` -- so without this the bound would be one plan per *turn*, and
    // rewriting the finished plan would again be the only way onward.
    const { store, session } = await fixture();
    const first = await session.create({
      title: "Feature one",
      objective: "Ship one",
      tasks: [{ title: "Build it" }],
    });
    await session.transitionCurrent({ taskId: "t1", status: "done", result: "Shipped" });

    const second = await session.create({
      title: "Feature two",
      objective: "Ship two",
      tasks: [{ title: "Build that" }],
    });
    expect(second.id).not.toBe(first.id);

    const sealed = await store.read(first.id);
    expect(sealed.status).toBe("completed");
    expect(sealed.title).toBe("Feature one");
  });

  test("and may not start a second while the first still has open tasks", async () => {
    const { session } = await fixture();
    await session.create({
      title: "Feature one",
      objective: "Ship one",
      tasks: [{ title: "Build it" }, { title: "Test it" }],
    });
    await session.transitionCurrent({ taskId: "t1", status: "done", result: "Shipped" });

    await expect(
      session.create({ title: "Feature two", objective: "Ship two", tasks: [{ title: "Later" }] }),
    ).rejects.toThrow(/already exists/);
  });
});

describe("PlanSession — a batch of transitions", () => {
  test("closes every task in one revision", async () => {
    const { session } = await fixture();
    await session.create({
      title: "Batch",
      objective: "o",
      tasks: [{ title: "One" }, { title: "Two" }, { title: "Three" }],
    });
    const before = session.cached()!.revision;

    const moved = await session.transition({
      expected: cas(session),
      transitions: [
        { taskId: "t1", status: "done", result: "a" },
        { taskId: "t2", status: "done", result: "b" },
        { taskId: "t3", status: "abandoned", reason: "c" },
      ],
    });
    expect(moved.revision).toBe(before + 1);
  });

  test("is all-or-nothing: an illegal member leaves the whole plan untouched", async () => {
    const { session } = await fixture();
    await session.create({
      title: "Atomic",
      objective: "o",
      tasks: [{ title: "One" }, { title: "Two" }],
    });
    await session.transitionCurrent({ taskId: "t1", status: "done", result: "a" });
    const before = session.cached()!.revision;

    await expect(
      session.transition({
        expected: cas(session),
        transitions: [
          { taskId: "t2", status: "done", result: "b" },
          // Illegal: `done` is terminal, so this refuses -- and takes t2 with it.
          { taskId: "t1", status: "pending" },
        ],
      }),
    ).rejects.toThrow("Invalid task transition");

    const after = await session.reconcile();
    expect(after?.revision).toBe(before);
    expect(after?.tasks[1]?.status).toBe("pending");
  });

  test("on a sealed plan, one reopening member refuses the whole batch", async () => {
    const repository = createEditablePlanRepository();
    const store = planStoreFor(repository);
    const first = new PlanSession({ store, executionId: "run-1", review: false });
    await first.create({
      title: "Feature",
      objective: "o",
      tasks: [{ title: "One" }, { title: "Two" }, { title: "Three" }],
    });
    await first.transitionCurrent({ taskId: "t1", status: "done", result: "a" });
    const ref = (await first.finalize("completed"))!;

    const session = new PlanSession({
      store: planStoreFor(repository),
      executionId: "run-2",
      review: false,
      initialRef: ref,
    });
    await session.reconcile();

    await expect(
      session.transition({
        expected: cas(session),
        transitions: [
          { taskId: "t2", status: "done", result: "was done all along" },
          { taskId: "t3", status: "in_progress" },
        ],
      }),
    ).rejects.toThrow(PlanSealedError);
    expect((await store.read(ref.id)).tasks[1]?.status).toBe("pending");
  });
});
