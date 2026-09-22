import { describe, expect, it } from "bun:test";
import {
  admitGoalCreationIntent,
  admitGoalRun,
  advanceGoalRun,
  applyGoalControl,
  retryGoalResume,
  boundedGoalState,
  closeGoalRunByRecovery,
  declareGoalImpediment,
  emptyGoalState,
  goalAdmission,
  goalNetTokens,
  goalRecordSchema,
  pauseGoalForPolicy,
  prepareGoalSettlement,
  recordGoalCandidate,
  recordGoalCheckpoint,
  recordGoalProgress,
  recordGoalUsageEstimate,
  resolveGoalLimits,
  settleGoalRun,
  stopGoalContinuation,
  validateGoalCandidate,
  type GoalCandidate,
  type GoalControl,
  type GoalState,
  type GoalUsage,
} from "../../src/index.ts";

const context = { session_id: "session", new_goal_id: "goal-1", now: 100, physically_busy: false };
const limits = { max_net_tokens: 1000, max_auto_continuations: 8, max_no_progress_stages: 3 };
const measured: GoalUsage = { kind: "complete", input: 100, cached: 80, output: 10 };

describe("guided creation intent", () => {
  it("persists a formulating intent without creating a Goal and is idempotent", () => {
    const first = admitGoalCreationIntent(undefined, {
      session_id: "session",
      execution_id: "run",
      operation_id: "goal-create:run",
      seed: "Build a calculator",
      expected_revision: 0,
      now: 10,
    });
    expect(first.current).toBeUndefined();
    expect(first.creation_intent).toMatchObject({
      seed: "Build a calculator",
      execution_id: "run",
      phase: "formulating",
    });
    const replayed = admitGoalCreationIntent(first, {
      session_id: "session",
      execution_id: "run",
      operation_id: "goal-create:run",
      seed: "Build a calculator",
      expected_revision: 0,
      now: 11,
    });
    expect(replayed.revision).toBe(first.revision);
    expect(replayed.creation_intent?.execution_id).toBe("run");
  });

  it("clears the intent when a Goal is created and refuses a second live Goal", () => {
    const intent = admitGoalCreationIntent(undefined, {
      session_id: "session",
      execution_id: "run",
      operation_id: "goal-create:run",
      seed: "Build a calculator",
      expected_revision: 0,
      now: 10,
    });
    const created = applyGoalControl(
      intent,
      {
        expected_revision: intent.revision,
        operation_id: "goal-create:run",
        action: {
          kind: "create",
          objective: "Build a calculator",
          limits: { max_net_tokens: 1000 },
        },
      },
      { ...context, new_goal_id: "goal-1" },
    );
    expect(created.state.creation_intent).toBeUndefined();
    expect(created.state.current?.objective).toBe("Build a calculator");
    expect(() =>
      admitGoalCreationIntent(created.state, {
        session_id: "session",
        execution_id: "other",
        operation_id: "goal-create:other",
        seed: "Another",
        expected_revision: created.state.revision,
        now: 12,
      }),
    ).toThrow("already exists");
  });
});

describe("host continuation retirement", () => {
  it("persists a bounded settlement preparation and rejects ambiguous activity", () => {
    const state = run(create());
    const input = {
      goal_id: "goal-1",
      execution_id: "run-1",
      now: 102,
      preparation: {
        outcome: "failed" as const,
        disposition: "final" as const,
        usage: measured,
        activity: ["b".repeat(64), "a".repeat(64), "b".repeat(64)],
      },
    };
    const prepared = prepareGoalSettlement(state, input);
    expect(prepared.current!.runs[0]!.settlement_preparation).toMatchObject({
      outcome: "failed",
      activity: ["a".repeat(64), "b".repeat(64)],
    });
    expect(
      prepareGoalSettlement(prepared, {
        ...input,
        preparation: prepared.current!.runs[0]!.settlement_preparation!,
      }),
    ).toEqual(prepared);
    expect(() =>
      prepareGoalSettlement(state, {
        ...input,
        preparation: { ...input.preparation, activity_unavailable: true },
      }),
    ).toThrow("Unavailable activity");
    expect(() =>
      prepareGoalSettlement(state, {
        ...input,
        preparation: { ...input.preparation, outcome: "completed" },
      }),
    ).toThrow("fresh validation");
  });

  it("preserves the semantic progress allowance when stage activity is unavailable", () => {
    const state = run(create());
    state.current!.no_progress_stages = 2;
    const next = settle(state, "run-1", measured, {
      outcome: "failed",
      cause: "local_limit",
      activity_unavailable: true,
    });
    expect(next.current).toMatchObject({
      status: "active",
      no_progress_stages: 2,
      consumption: { net_tokens: 30 },
    });
    expect(next.current!.runs[0]).toMatchObject({
      phase: "closed",
      activity_unavailable: true,
      decision: "continue",
    });
    expect(next.current!.runs[0]!.progress_observed).toBeUndefined();
    expect(next.current!.runs[0]!.activity).toBeUndefined();
    expect(
      settle(next, "run-1", measured, {
        outcome: "failed",
        cause: "local_limit",
        activity_unavailable: true,
      }),
    ).toEqual(next);
    const exhausted = run(create());
    exhausted.current!.auto_continuations = exhausted.current!.limits.max_auto_continuations;
    expect(
      settle(exhausted, "run-1", measured, {
        outcome: "failed",
        cause: "local_limit",
        activity_unavailable: true,
      }).current!.status,
    ).toBe("usage_limited");
  });
  it.each(["completed", "cancelled", "failed"] as const)(
    "settles an expired %s stage as usage_limited and retains its measured cost",
    (outcome) => {
      const created = create();
      created.current!.limits.deadline_at = 215;
      let state = run(created);
      state = recordGoalCandidate(state, {
        goal_id: "goal-1",
        execution_id: "run-1",
        candidate: candidate(state),
        now: 205,
      });
      const result = settle(state, "run-1", measured, {
        outcome,
        disposition: "final",
        completion_validated: true,
      });
      expect(result.current).toMatchObject({
        status: "usage_limited",
        reason: "Goal deadline reached",
        consumption: { net_tokens: 30 },
        runs: [{ phase: "closed", outcome }],
      });
      expect(() =>
        applyGoalControl(
          result,
          {
            expected_revision: result.revision,
            operation_id: `resume-${outcome}`,
            action: { kind: "resume" },
          },
          { ...context, now: 220 },
        ),
      ).toThrow("deadline");
    },
  );

  it("edits one limit without resetting the other configured limits", () => {
    const created = applyGoalControl(
      undefined,
      {
        expected_revision: 0,
        operation_id: "create",
        action: {
          kind: "create",
          objective: "Finish",
          limits: {
            max_net_tokens: 1000,
            max_auto_continuations: 20,
            max_no_progress_stages: 5,
          },
        },
      },
      context,
    );
    const edited = applyGoalControl(
      created.state,
      {
        expected_revision: created.state.revision,
        operation_id: "edit",
        action: { kind: "edit", limits: { max_net_tokens: 2000 } },
      },
      context,
    );
    expect(edited.state.current!.limits).toEqual({
      max_net_tokens: 2000,
      max_auto_continuations: 20,
      max_no_progress_stages: 5,
    });
    expect(edited.state.current!.objective_revision).toBe(
      created.state.current!.objective_revision,
    );
  });

  it("replays the reserved start receipt independently of changed configuration defaults", () => {
    const input = {
      expected_revision: 0,
      operation_id: "create",
      action: { kind: "create", objective: "Finish the task" },
    };
    const created = applyGoalControl(undefined, input, {
      ...context,
      new_execution_id: "first",
      entry_token_limit: 1234,
    });
    expect(created.state.current!.limits).toEqual({
      max_net_tokens: 1234,
      max_auto_continuations: 8,
      max_no_progress_stages: 3,
    });
    expect(created.receipt.execution_id).toBe("first");
    const replayed = applyGoalControl(created.state, input, {
      ...context,
      new_execution_id: "duplicate",
      entry_token_limit: 9876,
      default_limits: { max_auto_continuations: 20 },
    });
    expect(replayed.receipt).toEqual(created.receipt);
    expect(replayed.replayed).toBe(true);
    expect(replayed.start).toBe(false);
    expect(replayed.state).toEqual(created.state);
    expect(() => applyGoalControl(undefined, input, context)).toThrow("finite");
    expect(() =>
      applyGoalControl(
        created.state,
        { ...input, action: { ...input.action, limits: { max_net_tokens: 9876 } } },
        context,
      ),
    ).toThrow("different goal control");
  });
  it.each(["revoked", "failed"] as const)(
    "records %s before or during the bound stage without releasing work",
    (reason) => {
      for (const state of [create(), run(create())]) {
        const stopped = stopGoalContinuation(state, {
          goal_id: "goal-1",
          execution_id: "run-1",
          control_revision: state.current!.control_revision,
          reason,
          now: 300,
        });
        expect(stopped.current!.status).toBe(reason === "revoked" ? "paused" : "blocked");
        expect(stopped.current!.runs).toEqual(state.current!.runs);
        expect(stopped.current!.consumption).toEqual(state.current!.consumption);
      }
    },
  );

  it("ignores retirement after a new control, replacement or successor admission", () => {
    const current = run(create());
    const input = {
      goal_id: "goal-1",
      execution_id: "run-1",
      control_revision: current.current!.control_revision,
      reason: "failed" as const,
      now: 400,
    };
    const closed = settle(checkpoint(current));
    const next = run(closed, "run-2", true);
    const replaced = applyGoalControl(
      closed,
      {
        expected_revision: closed.revision,
        operation_id: "replace",
        action: { kind: "replace", objective: "Another task", criteria: [], limits },
      },
      { ...context, new_goal_id: "goal-2" },
    ).state;
    for (const state of [
      next,
      replaced,
      control(current, { kind: "pause", running: false }),
      control(current, { kind: "cancel" }),
    ]) {
      expect(stopGoalContinuation(state, input)).toEqual(state);
    }
    const pending = { ...input, execution_id: "run-3", previous_execution_id: "run-1" };
    expect(stopGoalContinuation(closed, pending).current!.status).toBe("blocked");
    expect(stopGoalContinuation(next, pending)).toEqual(next);
  });
});

function create(): GoalState {
  return applyGoalControl(
    undefined,
    {
      expected_revision: 0,
      operation_id: "create",
      action: { kind: "create", objective: "Implement and verify the requested behavior", limits },
    },
    context,
  ).state;
}

function control(
  state: GoalState,
  action: GoalControl["action"],
  operation_id = `op-${state.revision}`,
): GoalState {
  return applyGoalControl(
    state,
    { expected_revision: state.revision, operation_id, action },
    context,
  ).state;
}

function run(state: GoalState, execution_id = "run-1", automatic = false): GoalState {
  const admitted = admitGoalRun(state, {
    goal_id: "goal-1",
    execution_id,
    admission_id: `admission-${execution_id}`,
    automatic,
    expected_revision: state.revision,
    control_revision: state.current!.control_revision,
    now: 200,
  });
  return advanceGoalRun(admitted, { goal_id: "goal-1", execution_id, phase: "running", now: 201 });
}

function checkpoint(state: GoalState, execution_id = "run-1", fingerprint?: string): GoalState {
  return recordGoalCheckpoint(state, {
    goal_id: "goal-1",
    execution_id,
    objective_revision: state.current!.objective_revision,
    now: 210,
    checkpoint: {
      summary: "A bounded stage ended",
      next_step: "Verify remaining work",
      evidence: [],
      progress_accepted: fingerprint !== undefined,
      activity_fingerprint: fingerprint,
      reason: "Host-observed activity",
    },
  });
}

function settle(
  state: GoalState,
  execution_id = "run-1",
  usage: GoalUsage = measured,
  overrides: Partial<Parameters<typeof settleGoalRun>[1]> = {},
): GoalState {
  return settleGoalRun(state, {
    goal_id: "goal-1",
    execution_id,
    physical_closed: true,
    outcome: "completed",
    disposition: "checkpoint",
    usage,
    completion_validated: false,
    now: 220,
    ...overrides,
  });
}

function candidate(state: GoalState, execution_id = "run-1"): GoalCandidate {
  return {
    execution_id,
    objective_revision: state.current!.objective_revision,
    summary: "Requested result verified",
    assessments: [
      {
        criterion_id: "objective",
        kind: "qualitative",
        justification: "The result matches the requested behavior",
        evidence: [],
      },
    ],
  };
}

describe("goal user controls", () => {
  it("records a declared impediment without revoking the Goal's own authority", () => {
    const running = run(create());
    const input = {
      goal_id: "goal-1",
      execution_id: "run-1",
      objective_revision: 1,
      reason: "User authority is required",
      now: 210,
    };
    const declared = declareGoalImpediment(running, input);
    expect(declared.current!.status).toBe("active");
    expect(declared.current!.control_revision).toBe(running.current!.control_revision);
    expect(declared.current!.runs.at(-1)).toMatchObject({
      execution_id: "run-1",
      phase: "running",
      impediment: { reason: "User authority is required", declared_at: 210 },
    });
    expect(declared.current!.consumption).toEqual(running.current!.consumption);
    expect(declareGoalImpediment(declared, input)).toEqual(declared);
    expect(
      declareGoalImpediment(declared, {
        ...input,
        reason: "A different impediment",
        now: 211,
      }),
    ).toEqual(declared);
    for (const action of [{ kind: "pause", running: false }, { kind: "cancel" }] as const) {
      const controlled = control(running, action);
      expect(declareGoalImpediment(controlled, input)).toEqual(controlled);
    }
    expect(() => declareGoalImpediment(running, { ...input, objective_revision: 2 })).toThrow(
      "obsolete",
    );
    expect(() => declareGoalImpediment(running, { ...input, execution_id: "foreign" })).toThrow();
    expect(() => declareGoalImpediment(running, { ...input, reason: "" })).toThrow();
    const closed = settle(checkpoint(running));
    expect(() => declareGoalImpediment(closed, input)).toThrow("running stage");
    expect(running.current!.status).toBe("active");
  });

  it("retains progress and candidates from a running stage after future-only pause without resuming or completing", () => {
    const running = run(create());
    const paused = control(running, { kind: "pause", running: false });
    const progressInput = {
      goal_id: "goal-1",
      execution_id: "run-1",
      objective_revision: paused.current!.objective_revision,
      now: 211,
      progress: { summary: "Completed the current verification", evidence: [] },
    };
    const progress = recordGoalProgress(paused, progressInput);
    expect(progress.current!.status).toBe("paused");
    expect(progress.current!.runs[0]!.progress).toEqual(progressInput.progress);
    expect(progress.current!.no_progress_stages).toBe(0);
    expect(progress.current!.consumption).toEqual(paused.current!.consumption);
    const proposed = recordGoalCandidate(progress, {
      goal_id: "goal-1",
      execution_id: "run-1",
      now: 212,
      candidate: candidate(progress),
    });
    const closed = settle(checkpoint(proposed), "run-1", measured, {
      disposition: "final",
      completion_validated: true,
    });
    expect(closed.current!.status).toBe("paused");
    expect(closed.current!.candidate).toBeDefined();
    expect(goalAdmission(closed.current!, 220, true).allowed).toBe(false);
    expect(() => recordGoalProgress(closed, progressInput)).toThrow("bound goal run");
    expect(() => recordGoalProgress(control(running, { kind: "cancel" }), progressInput)).toThrow(
      "bound goal run",
    );
    expect(() =>
      recordGoalProgress(running, { ...progressInput, objective_revision: 100 }),
    ).toThrow("bound goal run");
    expect(paused.current!.runs[0]!.progress).toBeUndefined();
  });

  it("rejects ambiguous audit identities and revisions across current and archived goals", () => {
    const state = run(create());
    const duplicate = structuredClone(state);
    duplicate.archive.push(structuredClone(duplicate.current!));
    expect(() => boundedGoalState(duplicate)).toThrow("goal ids must be unique");
    duplicate.archive[0]!.goal_id = "other-goal";
    expect(() => boundedGoalState(duplicate)).toThrow("multiple goals");
    duplicate.archive = [];
    duplicate.receipts.push(structuredClone(duplicate.receipts[0]!));
    expect(() => boundedGoalState(duplicate)).toThrow("receipts must be unique");
    duplicate.receipts.pop();
    duplicate.current!.control_revision = duplicate.revision + 1;
    expect(() => boundedGoalState(duplicate)).toThrow("audit revisions");
  });

  it("retains sequenced usage estimates without charging or reopening settled runs", () => {
    const state = run(create());
    const input = {
      goal_id: "goal-1",
      execution_id: "run-1",
      sequence: 1,
      usage: measured,
      now: 202,
    };
    const estimated = recordGoalUsageEstimate(state, input);
    expect(estimated.current!.runs[0]!.usage_estimate).toEqual({ sequence: 1, usage: measured });
    expect(estimated.current!.consumption.net_tokens).toBe(0);
    expect(recordGoalUsageEstimate(estimated, { ...input, sequence: 0 })).toEqual(estimated);
    expect(recordGoalUsageEstimate(estimated, input)).toEqual(estimated);
    const closed = settle(checkpoint(estimated));
    expect(recordGoalUsageEstimate(closed, { ...input, sequence: 2 })).toEqual(closed);
    expect(closed.current!.consumption.net_tokens).toBe(30);
  });
  it("requires a finite total and never multiplies it by automatic continuations", () => {
    expect(resolveGoalLimits({}, 1000)).toEqual(limits);
    for (const value of [undefined, Infinity, 0, -1, NaN])
      expect(() => resolveGoalLimits({}, value)).toThrow("finite");
    expect(resolveGoalLimits({ max_net_tokens: 4000 }, 1000).max_net_tokens).toBe(4000);
  });

  it("creates one goal and deduplicates an operation without repeating start", () => {
    const input = {
      expected_revision: 0,
      operation_id: "create",
      action: { kind: "create", objective: "Build a feature", limits },
    };
    const first = applyGoalControl(undefined, input, context);
    expect(first.start).toBe(true);
    const replay = applyGoalControl(first.state, input, context);
    expect(replay.receipt).toEqual(first.receipt);
    expect(replay).toMatchObject({ replayed: true, start: false });
    expect(() =>
      applyGoalControl(
        first.state,
        { ...input, action: { ...input.action, objective: "Different scope" } },
        context,
      ),
    ).toThrow("different goal control");
    expect(() => applyGoalControl(first.state, { ...input, operation_id: "new" }, context)).toThrow(
      "revision changed",
    );
    expect(() =>
      control(first.state, { kind: "create", objective: "Second", criteria: [], limits }),
    ).toThrow("already exists");
  });

  it("isolates sessions and refuses creation over ordinary physical work", () => {
    const state = create();
    expect(() =>
      applyGoalControl(
        state,
        { expected_revision: state.revision, operation_id: "other", action: { kind: "pause" } },
        { ...context, session_id: "other" },
      ),
    ).toThrow("another conversation");
    expect(() =>
      applyGoalControl(
        undefined,
        {
          expected_revision: 0,
          operation_id: "create",
          action: { kind: "create", objective: "Scope", limits },
        },
        { ...context, physically_busy: true },
      ),
    ).toThrow("running conversation");
  });

  it("edits objective revision without clearing spend and invalidates old candidates", () => {
    let state = run(create());
    state = recordGoalCandidate(state, {
      goal_id: "goal-1",
      execution_id: "run-1",
      candidate: candidate(state),
      now: 210,
    });
    state = control(state, { kind: "pause", running: false });
    state = settle(state);
    const cost = structuredClone(state.current!.consumption);
    const oldRevision = state.current!.objective_revision;
    state = control(state, { kind: "edit", limits: { max_net_tokens: 2000 } });
    expect(state.current!.candidate).toBeDefined();
    expect(state.current!.objective_revision).toBe(oldRevision);
    state = control(state, { kind: "edit", objective: "Explicitly revised scope" });
    expect(state.current!.objective_revision).toBe(oldRevision + 1);
    expect(state.current!.candidate).toBeUndefined();
    expect(state.current!.consumption).toEqual(cost);
  });

  it("pauses future work without pretending the current run physically ended", () => {
    const running = run(create());
    const paused = applyGoalControl(
      running,
      {
        expected_revision: running.revision,
        operation_id: "pause",
        action: { kind: "pause", running: true },
      },
      context,
    );
    expect(paused.cancel_execution_id).toBe("run-1");
    expect(paused.state.current!.status).toBe("paused");
    expect(paused.state.current!.runs[0]!.phase).toBe("running");
    expect(() => control(paused.state, { kind: "edit", objective: "Change" })).toThrow(
      "physical execution",
    );
    expect(() => control(paused.state, { kind: "clear" })).toThrow("physical execution");
    expect(() => control(paused.state, { kind: "resume" })).toThrow("physical execution");
  });

  it("replaces atomically, retains audit, and reopens a terminal goal only through resume", () => {
    let state = control(create(), { kind: "cancel" });
    // Editing a terminal goal is still refused: an explicit resume is the one transition that
    // reopens it, and it does so without touching the definition.
    expect(() => control(state, { kind: "edit", objective: "Other" })).toThrow("Terminal");
    const reopened = control(state, { kind: "resume" });
    expect(reopened.current).toMatchObject({ status: "active", goal_id: "goal-1" });
    state = control(reopened, { kind: "cancel" });
    const replaced = applyGoalControl(
      state,
      {
        expected_revision: state.revision,
        operation_id: "replace",
        action: { kind: "replace", objective: "New commitment", limits },
      },
      { ...context, new_goal_id: "goal-2" },
    ).state;
    expect(replaced.archive[0]!.goal_id).toBe("goal-1");
    expect(replaced.current!.goal_id).toBe("goal-2");
    expect(() => control(replaced, { kind: "clear" })).toThrow("Pause or cancel");
    state = control(control(replaced, { kind: "pause", running: false }), { kind: "clear" });
    expect(state.current).toBeUndefined();
    expect(state.archive).toHaveLength(2);
  });

  it("keeps replay fenced after bounded receipt eviction", () => {
    let state = create();
    for (let index = 0; index < 70; index++)
      state = control(state, { kind: "pause", running: false });
    expect(state.receipts).toHaveLength(64);
    expect(() =>
      applyGoalControl(
        state,
        {
          expected_revision: 0,
          operation_id: "create",
          action: { kind: "create", objective: "Scope", limits },
        },
        context,
      ),
    ).toThrow("revision changed");
  });

  it("does not mutate the previous state when validation or archive bounds reject a write", () => {
    const state = create();
    const before = structuredClone(state);
    expect(() =>
      control(state, {
        kind: "edit",
        criteria: [
          { id: "same", description: "One", kind: "qualitative" },
          { id: "same", description: "Two", kind: "qualitative" },
        ],
      }),
    ).toThrow();
    expect(state).toEqual(before);
    state.archive = Array.from({ length: 8 }, (_, index) => ({
      ...structuredClone(state.current!),
      goal_id: `old-${index}`,
    }));
    const paused = control(state, { kind: "pause", running: false });
    expect(() => control(paused, { kind: "clear" })).toThrow("archive is full");
    expect(paused.archive).toHaveLength(8);
  });
});

describe("goal physical settlement, usage and continuation", () => {
  it("requires physical closure and an accepted checkpoint before automatic continuation", () => {
    let state = checkpoint(run(create()), "run-1", "a".repeat(64));
    expect(goalAdmission(state.current!, 220, true).allowed).toBe(false);
    expect(() => settle(state, "run-1", measured, { physical_closed: false as true })).toThrow(
      "physical closure",
    );
    state = settle(state);
    expect(state.current).toMatchObject({
      status: "active",
      consumption: { net_tokens: 30 },
      no_progress_stages: 0,
    });
    expect(goalAdmission(state.current!, 220, true)).toEqual({
      allowed: true,
      remaining_tokens: 970,
    });
    state = run(state, "run-2", true);
    expect(state.current!.auto_continuations).toBe(1);
    expect(() => run(state, "run-3", true)).toThrow("physically settled");
  });

  it("invalidates a pending admission on pause and rejects stale starts", () => {
    const first = create();
    const input = {
      goal_id: "goal-1",
      execution_id: "run-1",
      admission_id: "intent-1",
      automatic: false,
      expected_revision: first.revision,
      control_revision: first.current!.control_revision,
      now: 200,
    };
    const admitted = admitGoalRun(first, input);
    expect(admitGoalRun(admitted, input)).toEqual(admitted);
    const paused = control(admitted, { kind: "pause", running: false });
    expect(() =>
      advanceGoalRun(paused, {
        goal_id: "goal-1",
        execution_id: "run-1",
        phase: "running",
        now: 201,
      }),
    ).toThrow("revoked");
    expect(() => admitGoalRun(control(first, { kind: "pause", running: false }), input)).toThrow(
      "changed before admission",
    );
  });

  it("reconciles late usage after cancel once and preserves cancellation over a late candidate", () => {
    let state = run(create());
    state = recordGoalCandidate(state, {
      goal_id: "goal-1",
      execution_id: "run-1",
      candidate: candidate(state),
      now: 205,
    });
    state = control(state, { kind: "cancel" });
    const settled = settle(state, "run-1", measured, {
      disposition: "final",
      completion_validated: true,
    });
    expect(settled.current).toMatchObject({ status: "cancelled", consumption: { net_tokens: 30 } });
    expect(settle(settled, "run-1", measured)).toEqual(settled);
    expect(settled.current!.candidate).toBeDefined();
    expect(
      advanceGoalRun(settled, {
        goal_id: "goal-1",
        execution_id: "run-1",
        phase: "running",
        now: 300,
      }),
    ).toEqual(settled);
  });

  it("charges what it can, suspends only automatic work, and accepts the gap on explicit resume", () => {
    expect(goalNetTokens({ kind: "unknown" })).toBeUndefined();
    expect(goalNetTokens({ kind: "complete", input: 100, output: 10 })).toBe(110);
    expect(() => goalNetTokens({ kind: "complete", input: 1, output: 0, cached: 2 })).toThrow();
    expect(
      goalNetTokens({
        kind: "partial",
        input: 100,
        output: 10,
        gaps: [{ cause: "no_usage", calls: 1 }],
      }),
    ).toBe(110);
    let state = settle(checkpoint(run(create())), "run-1", { kind: "unknown" });
    expect(state.current).toMatchObject({
      status: "blocked",
      consumption: { usage_unknown: true },
    });
    expect(goalAdmission(state.current!, 100, true)).toMatchObject({ allowed: false });
    state = control(state, { kind: "resume" });
    expect(state.current).toMatchObject({ status: "active", consumption: { usage_unknown: true } });
    expect(state.current!.consumption.usage_accepted_runs).toEqual(["run-1"]);
    expect(goalAdmission(state.current!, 100, true).allowed).toBe(true);
    state = settle(state, "run-1", { kind: "complete", input: 100, output: 10 });
    expect(state.current!.consumption).toMatchObject({
      usage_unknown: false,
      cache_estimated: true,
      net_tokens: 110,
      usage_accepted_runs: [],
    });
    expect(state.current!.consumption.cached).toBeUndefined();
    // The late measurement closes the gap, so the Goal it had asked about is no longer waiting.
    expect(state.current!.status).toBe("active");
    // A late cache report adds information: the gross figures stay, the net charge goes down.
    state = settle(state, "run-1", measured);
    expect(state.current!.consumption).toMatchObject({
      input: 100,
      output: 10,
      cached: 80,
      net_tokens: 30,
      cache_estimated: false,
    });
    // A smaller revision is a conflict, not an update, and never overwrites the measurement.
    expect(() =>
      settle(state, "run-1", { kind: "complete", input: 10, output: 1, cached: 0 }),
    ).toThrow("cannot be rewritten");
    expect(control(state, { kind: "resume" }).current!.consumption.net_tokens).toBe(30);
  });

  it("keeps the confirmed subtotal of a partial stage and accepts only its own gap", () => {
    const partial: GoalUsage = {
      kind: "partial",
      input: 100,
      output: 10,
      cached: 20,
      gaps: [
        { cause: "no_usage", calls: 2 },
        { cause: "pending_call", calls: 1 },
      ],
    };
    let state = settle(checkpoint(run(create())), "run-1", partial);
    expect(state.current!.consumption).toMatchObject({
      input: 100,
      output: 10,
      net_tokens: 90,
      usage_unknown: false,
      gaps: [
        { cause: "no_usage", calls: 2 },
        { cause: "pending_call", calls: 1 },
      ],
      usage_accepted_runs: [],
    });
    expect(state.current!.status).toBe("blocked");
    expect(state.current!.reason).toContain("resume");
    state = control(state, { kind: "resume" });
    expect(state.current!.consumption.usage_accepted_runs).toEqual(["run-1"]);
    expect(state.current!.consumption.gaps).toHaveLength(2);

    // A later stage's own gap is a new execution and is unaccepted again.
    state = settle(checkpoint(run(state, "run-2"), "run-2"), "run-2", {
      kind: "partial",
      input: 10,
      output: 1,
      gaps: [{ cause: "provider_unknown", calls: 1 }],
    });
    expect(state.current!.consumption.usage_accepted_runs).toEqual(["run-1"]);
    expect(state.current!.consumption.net_tokens).toBe(101);
    expect(state.current!.status).toBe("blocked");
  });

  it("assigns late reconciliation to an archived goal instead of the replacement", () => {
    let state = settle(run(create()), "run-1", { kind: "unknown" });
    state = applyGoalControl(
      state,
      {
        expected_revision: state.revision,
        operation_id: "replace",
        action: { kind: "replace", objective: "Next scope", limits },
      },
      { ...context, new_goal_id: "goal-2" },
    ).state;
    state = settle(state);
    expect(state.current!.consumption.net_tokens).toBe(0);
    expect(state.archive[0]!.consumption.net_tokens).toBe(30);
  });

  it("records overrun and resume never grants new budget or continuation allowance", () => {
    let state = settle(checkpoint(run(create())), "run-1", {
      kind: "complete",
      input: 1100,
      output: 100,
      cached: 0,
    });
    expect(state.current).toMatchObject({
      status: "budget_limited",
      consumption: { net_tokens: 1200, overrun_tokens: 200 },
    });
    expect(() => control(state, { kind: "resume" })).toThrow("budget exhausted");
    state = control(state, { kind: "edit", limits: { max_net_tokens: 2000 } });
    state = control(state, { kind: "resume" });
    expect(goalAdmission(state.current!, 300, true)).toMatchObject({
      allowed: true,
      remaining_tokens: 800,
    });
    state.current!.auto_continuations = 8;
    // The automatic ceiling gates automation, never a manual decision — and resuming does not
    // reset it either, so the next automatic stage still stops at the same bound.
    expect(goalAdmission(state.current!, 100, true)).toMatchObject({
      allowed: false,
      status: "usage_limited",
    });
    const resumed = control(state, { kind: "resume" });
    expect(resumed.current).toMatchObject({ status: "active", auto_continuations: 8 });
    state.current!.limits.deadline_at = 50;
    expect(() => control(state, { kind: "resume" })).toThrow("deadline");
  });

  it("blocks the first empty final and the configured sequence of unproductive checkpoints", () => {
    expect(settle(run(create()), "run-1", measured, { disposition: "final" }).current!.status).toBe(
      "blocked",
    );
    expect(settle(run(create())).current!.reason).toContain("without an accepted checkpoint");
    let state = create();
    for (let index = 0; index < 3; index++) {
      const executionId = `run-${index}`;
      state = settle(checkpoint(run(state, executionId, index > 0), executionId), executionId);
    }
    expect(state.current).toMatchObject({ status: "blocked", no_progress_stages: 3 });
    const resumed = control(state, { kind: "resume" });
    expect(resumed.current!.no_progress_stages).toBe(0);
    expect(resumed.current!.auto_continuations).toBe(2);
    expect(resumed.current!.consumption.net_tokens).toBe(90);
  });

  it("names the host's typed failure cause instead of a generic stage failure", () => {
    const failed = (
      state: GoalState,
      overrides: Partial<Parameters<typeof settleGoalRun>[1]> = {},
    ): GoalState =>
      settle(state, "run-1", measured, {
        outcome: "failed",
        disposition: "final",
        ...overrides,
      });
    expect(failed(run(create()), { cause: "control_failure" }).current).toMatchObject({
      status: "blocked",
    });
    expect(failed(run(create()), { cause: "control_failure" }).current!.reason).toContain(
      "Goal control was unavailable",
    );
    // An ending the host cannot classify keeps the generic wording rather than inventing a cause.
    expect(failed(run(create())).current!.reason).toBe("Goal run failed");
    expect(
      settle(run(create()), "run-1", measured, { outcome: "cancelled", disposition: "final" })
        .current!.reason,
    ).toBe("Goal run was cancelled");
  });

  it("keeps the Goal active and continues after a recoverable ending", () => {
    for (const cause of [
      "local_limit",
      "stagnation",
      "empty_response",
      "transient",
      "steward_interrupted",
    ] as const) {
      const state = settle(run(create()), "run-1", measured, {
        outcome: "failed",
        disposition: "final",
        cause,
      });
      expect(state.current).toMatchObject({ status: "active", no_progress_stages: 1 });
      expect(state.current!.runs.at(-1)).toMatchObject({
        phase: "closed",
        decision: "continue",
        cause,
        progress_observed: false,
      });
      expect(goalAdmission(state.current!, 230, true).allowed).toBe(true);
    }
    // A transient ending records the earliest instant the host may start the successor.
    const delayed = settle(run(create()), "run-1", measured, {
      outcome: "failed",
      disposition: "final",
      cause: "transient",
      not_before: 600,
    });
    expect(delayed.current!.runs.at(-1)!.not_before).toBe(600);
  });

  it("clears the progress sequence when the stage advanced the work and spends it otherwise", () => {
    const productive = settle(run(create()), "run-1", measured, {
      outcome: "failed",
      disposition: "final",
      cause: "stagnation",
      activity: ["c".repeat(64)],
    });
    expect(productive.current).toMatchObject({ status: "active", no_progress_stages: 0 });
    expect(productive.current!.runs.at(-1)).toMatchObject({
      progress_observed: true,
      activity: ["c".repeat(64)],
      decision: "continue",
    });
    let state = create();
    for (let index = 1; index <= 3; index++) {
      const executionId = `run-${index}`;
      const admitted = index === 1 ? run(state) : run(state, executionId, true);
      state = settle(admitted, executionId, measured, {
        outcome: "failed",
        disposition: "final",
        cause: "stagnation",
      });
      if (index < 3)
        expect(state.current).toMatchObject({ status: "active", no_progress_stages: index });
    }
    expect(state.current).toMatchObject({
      status: "blocked",
      reason: "Goal stage progress limit reached",
      no_progress_stages: 3,
    });
    expect(state.current!.runs.at(-1)!.decision).toBe("closed");
  });

  it("does not count receipts an earlier stage already presented as fresh progress", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    const c = "c".repeat(64);
    let state = settle(run(create()), "run-1", measured, {
      outcome: "failed",
      disposition: "final",
      cause: "stagnation",
      activity: [a],
    });
    expect(state.current).toMatchObject({ status: "active", no_progress_stages: 0 });
    state = settle(run(state, "run-2", true), "run-2", measured, {
      outcome: "failed",
      disposition: "final",
      cause: "stagnation",
      activity: [b],
    });
    expect(state.current).toMatchObject({ status: "active", no_progress_stages: 0 });
    /** A stage that only recombines receipts the Goal already recorded advanced nothing. */
    state = settle(run(state, "run-3", true), "run-3", measured, {
      outcome: "failed",
      disposition: "final",
      cause: "stagnation",
      activity: [a, b],
    });
    expect(state.current).toMatchObject({ status: "active", no_progress_stages: 1 });
    expect(state.current!.runs.at(-1)).toMatchObject({ progress_observed: false, activity: [] });
    /** The history accumulates per receipt, so a later stage contributes only what is new. */
    state = settle(run(state, "run-4", true), "run-4", measured, {
      outcome: "failed",
      disposition: "final",
      cause: "stagnation",
      activity: [a, b, c],
    });
    expect(state.current).toMatchObject({ status: "active", no_progress_stages: 0 });
    expect(state.current!.runs.at(-1)).toMatchObject({ progress_observed: true, activity: [c] });
  });

  it("blocks on a declared impediment once without spending the Goal's own authority", () => {
    let state = run(create());
    state = declareGoalImpediment(state, {
      goal_id: "goal-1",
      execution_id: "run-1",
      objective_revision: state.current!.objective_revision,
      reason: "The requested source credentials are unavailable",
      now: 205,
    });
    const control_revision = state.current!.control_revision;
    state = settle(state, "run-1", measured, {
      outcome: "failed",
      disposition: "final",
      cause: "unclassified",
    });
    expect(state.current).toMatchObject({
      status: "blocked",
      reason: "The requested source credentials are unavailable",
      no_progress_stages: 0,
    });
    expect(state.current!.runs.at(-1)).toMatchObject({
      decision: "attention",
      cause: "impediment",
    });
    expect(state.current!.control_revision).toBe(control_revision);
    /**
     * The declaration ends the Goal's automatic path, so a successor can never retry an
     * authenticated refusal the model reported as its own blocker. What it does not cost
     * the Goal is authority: resume continues with the same limits, approvals and spend.
     */
    const resumed = control(state, { kind: "resume" });
    expect(resumed.current).toMatchObject({ status: "active", auto_continuations: 0 });
    expect(resumed.current!.limits).toEqual(state.current!.limits);
    expect(resumed.current!.consumption).toEqual(state.current!.consumption);
  });

  it("never presumes an unclassified or refused ending recoverable", () => {
    for (const cause of [
      "provider_refused",
      "tools_unavailable",
      "control_failure",
      "usage_unknown",
      "unclassified",
    ] as const) {
      const state = settle(run(create()), "run-1", measured, {
        outcome: "failed",
        disposition: "final",
        cause,
      });
      expect(state.current).toMatchObject({ status: "blocked", no_progress_stages: 0 });
      expect(state.current!.runs.at(-1)!.decision).toBe("attention");
    }
    /** A context overflow replays the payload that did not fit unless the stage advanced the work. */
    const overflow = settle(run(create()), "run-1", measured, {
      outcome: "failed",
      disposition: "final",
      cause: "context_overflow",
    });
    expect(overflow.current!.status).toBe("blocked");
    expect(overflow.current!.runs.at(-1)!.decision).toBe("attention");
    const progressing = settle(run(create()), "run-1", measured, {
      outcome: "failed",
      disposition: "final",
      cause: "context_overflow",
      activity: ["d".repeat(64)],
    });
    expect(progressing.current!.status).toBe("active");
    expect(progressing.current!.runs.at(-1)!.decision).toBe("continue");
  });

  it("closes the automatic path on an operator refusal or a durable control", () => {
    const declined = settle(run(create()), "run-1", measured, {
      outcome: "failed",
      disposition: "final",
      cause: "declined",
    });
    expect(declined.current).toMatchObject({ status: "blocked" });
    expect(declined.current!.reason).toContain("declined");
    expect(declined.current!.runs.at(-1)!.decision).toBe("closed");
    for (const action of [{ kind: "pause", running: false }, { kind: "cancel" }] as const) {
      const controlled = control(run(create()), action);
      const settled = settle(controlled, "run-1", measured, {
        outcome: "failed",
        disposition: "final",
        cause: "stagnation",
      });
      expect(settled.current!.status).toBe(action.kind === "pause" ? "paused" : "cancelled");
      expect(settled.current!.runs.at(-1)!.decision).toBe("closed");
    }
    const cancelled = settle(run(create()), "run-1", measured, {
      outcome: "cancelled",
      disposition: "final",
    });
    expect(cancelled.current!.runs.at(-1)).toMatchObject({
      decision: "closed",
      cause: "unclassified",
    });
  });

  it("does not count changing prose around the same activity as fresh progress", () => {
    let state = settle(checkpoint(run(create()), "run-1", "a".repeat(64)));
    state = settle(checkpoint(run(state, "run-2", true), "run-2", "a".repeat(64)), "run-2");
    expect(state.current!.no_progress_stages).toBe(1);
    state = settle(checkpoint(run(state, "run-3", true), "run-3", "b".repeat(64)), "run-3");
    expect(state.current!.no_progress_stages).toBe(0);
  });

  it("pauses on disconnect/restart while retaining physical occupancy and accumulated spend", () => {
    const state = run(create());
    const paused = pauseGoalForPolicy(state, "Controller disconnected", 210);
    expect(paused.current!.status).toBe("paused");
    expect(paused.current!.runs[0]!.phase).toBe("running");
    expect(pauseGoalForPolicy(paused, "Restart", 220)).toEqual(paused);
    const unknown = advanceGoalRun(state, {
      goal_id: "goal-1",
      execution_id: "run-1",
      phase: "unknown",
      now: 211,
    });
    expect(unknown.current!.status).toBe("blocked");
    expect(() => control(unknown, { kind: "resume" })).toThrow("physical execution");
    expect(() =>
      advanceGoalRun(unknown, {
        goal_id: "goal-1",
        execution_id: "run-1",
        phase: "settling",
        now: 212,
      }),
    ).toThrow("host recovery");
  });

  it("does not make failed or cancelled runs successful through checkpoint metadata", () => {
    for (const outcome of ["failed", "cancelled"] as const)
      expect(
        settle(checkpoint(run(create())), "run-1", measured, { outcome }).current!.status,
      ).toBe("blocked");
  });

  it.each(["failed", "cancelled"] as const)(
    "reports exhausted measured budget on a %s stage without hiding its physical outcome",
    (outcome) => {
      const usage: GoalUsage = { kind: "complete", input: 1100, output: 100, cached: 0 };
      const state = settle(run(create()), "run-1", usage, { outcome });
      expect(state.current).toMatchObject({
        status: "budget_limited",
        reason: "Goal token budget exhausted",
        consumption: { net_tokens: 1200, overrun_tokens: 200 },
        runs: [{ phase: "closed", outcome }],
      });
      expect(() => control(state, { kind: "resume" })).toThrow("budget exhausted");
      for (const action of [{ kind: "pause", running: false }, { kind: "cancel" }] as const) {
        const controlled = control(run(create()), action);
        const settled = settle(controlled, "run-1", usage, { outcome });
        expect(settled.current!.status).toBe(action.kind === "pause" ? "paused" : "cancelled");
        expect(settled.current!.consumption.net_tokens).toBe(1200);
      }
    },
  );
});

describe("goal criteria and completion", () => {
  it("labels textual completion as model judgment and only commits it after settlement", async () => {
    let state = run(create());
    const proposed = candidate(state);
    const validation = await validateGoalCandidate(state.current!, proposed, {
      verify: async () => ({ valid: false }),
    });
    expect(validation).toEqual({
      valid: true,
      reasons: [],
      qualitative_criteria: ["objective"],
      revision: state.current!.revision,
    });
    state = recordGoalCandidate(state, {
      goal_id: "goal-1",
      execution_id: "run-1",
      candidate: proposed,
      now: 210,
    });
    expect(state.current!.status).toBe("active");
    state = settle(state, "run-1", measured, {
      disposition: "final",
      completion_validated: validation.valid,
    });
    expect(state.current!.status).toBe("complete");
  });

  it("reopens a completed or cancelled goal for a new attempt without rewriting its audit", async () => {
    let completed = run(create());
    const proposed = candidate(completed);
    const validation = await validateGoalCandidate(completed.current!, proposed, {
      verify: async () => ({ valid: false }),
    });
    completed = recordGoalCandidate(completed, {
      goal_id: "goal-1",
      execution_id: "run-1",
      candidate: proposed,
      now: 210,
    });
    completed = settle(completed, "run-1", measured, {
      disposition: "final",
      completion_validated: validation.valid,
    });
    expect(completed.current!.status).toBe("complete");
    const cancelled = control(settle(run(create()), "run-1", measured), { kind: "cancel" });

    for (const closed of [completed, cancelled]) {
      closed.current!.auto_continuations = closed.current!.limits.max_auto_continuations;
      const before = structuredClone(closed.current!);
      const reopened = control(closed, { kind: "resume" });

      // The objective, its limits, its spend and its audit survive; the closed attempt's own
      // validation does not, and the new attempt gets a fresh progress sequence.
      expect(reopened.current).toMatchObject({
        status: "active",
        goal_id: before.goal_id,
        objective: before.objective,
        limits: before.limits,
        consumption: before.consumption,
        auto_continuations: before.limits.max_auto_continuations,
        no_progress_stages: 0,
      });
      expect(reopened.current!.candidate).toBeUndefined();
      expect(reopened.current!.control_revision).toBeGreaterThan(before.control_revision);
      expect(reopened.current!.objective_revision).toBe(before.objective_revision);
      expect(reopened.current!.runs.map((item) => item.execution_id)).toEqual(
        before.runs.map((item) => item.execution_id),
      );
    }
  });

  it("releases a physically unknown stage without inventing its outcome", () => {
    let state = advanceGoalRun(run(create()), {
      goal_id: "goal-1",
      execution_id: "run-1",
      phase: "unknown",
      now: 215,
    });
    expect(state.current).toMatchObject({ status: "blocked" });
    expect(state.current!.reason).toContain("host recovery");
    expect(goalAdmission(state.current!, 300, false)).toMatchObject({ allowed: false });

    const recovered = closeGoalRunByRecovery(state, {
      goal_id: "goal-1",
      execution_id: "run-1",
      recovered_at: 220,
    });
    const stage = recovered.current!.runs[0]!;
    // The attestation is recorded; the outcome it never established is not invented.
    expect(stage).toMatchObject({ phase: "closed", recovered_at: 220 });
    expect(stage.outcome).toBeUndefined();
    expect(stage.disposition).toBeUndefined();
    expect(stage.decision).toBeUndefined();
    expect(stage.ended_at).toBeUndefined();
    // The stage was never measured either, so the release asks for the gap to be accepted instead
    // of letting the next attempt start against an unknown baseline.
    expect(recovered.current!.consumption.usage_unknown).toBe(true);
    expect(recovered.current!.status).toBe("blocked");
    expect(recovered.current!.reason).toContain("resume the goal to accept the gap");

    state = control(recovered, { kind: "resume" });
    expect(state.current).toMatchObject({
      status: "active",
      consumption: { usage_accepted_runs: ["run-1"] },
    });
    const admitted = admitGoalRun(state, {
      goal_id: "goal-1",
      execution_id: "run-2",
      admission_id: "admission-run-2",
      automatic: false,
      expected_revision: state.revision,
      control_revision: state.current!.control_revision,
      now: 230,
    });
    expect(admitted.current!.runs.map((item) => item.execution_id)).toEqual(["run-1", "run-2"]);
    // A second resolution for the same execution changes nothing.
    expect(
      closeGoalRunByRecovery(recovered, {
        goal_id: "goal-1",
        execution_id: "run-1",
        recovered_at: 240,
      }),
    ).toEqual(recovered);
  });

  it("suspends only automatic admission while a measured gap stays unaccepted", () => {
    const partial = (calls: number): GoalUsage => ({
      kind: "partial",
      input: 100,
      output: 10,
      gaps: [{ cause: "no_usage", calls }],
    });
    let state = settle(checkpoint(run(create())), "run-1", partial(1));
    expect(state.current!.status).toBe("blocked");
    state = control(state, { kind: "resume" });
    expect(state.current).toMatchObject({
      status: "active",
      consumption: { usage_accepted_runs: ["run-1"] },
    });
    expect(goalAdmission(state.current!, 100, true).allowed).toBe(true);

    // A late revision that widens the same stage's gap stops matching the acceptance, so the
    // gap is unaccepted again while the Goal itself stays active.
    state = settle(state, "run-1", partial(2));
    expect(state.current!.status).toBe("active");
    const automatic = goalAdmission(state.current!, 200, true);
    expect(automatic).toMatchObject({ allowed: false, status: "blocked" });
    if (automatic.allowed) throw new Error("the automatic admission must be refused");
    expect(automatic.reason).toContain("Consumption is not fully measured for 1 closed stage(s)");
    expect(automatic.reason).toContain("run-1");
    expect(automatic.reason).toContain("resume the goal to accept that gap");
    // The operator's own decision is what accepts it, and it is not a standing bypass.
    expect(goalAdmission(state.current!, 200, false).allowed).toBe(true);
    expect(control(state, { kind: "resume" }).current!.consumption.usage_accepted_runs).toEqual([
      "run-1",
    ]);
  });

  it("requires explicit host assertions and recorded human decisions", async () => {
    let state = control(create(), {
      kind: "edit",
      criteria: [
        {
          id: "tests",
          description: "The specified check passes",
          kind: "host",
          verification: { kind: "tool_success", tool_name: "run_tests" },
        },
        { id: "review", description: "User accepts behavior", kind: "human" },
      ],
    });
    state = run(state);
    const proposed: GoalCandidate = {
      execution_id: "run-1",
      objective_revision: state.current!.objective_revision,
      summary: "Done",
      assessments: [
        {
          criterion_id: "tests",
          kind: "host",
          justification: "Check finished",
          evidence: [
            {
              id: "event-1",
              execution_id: "run-1",
              goal_id: "goal-1",
              objective_revision: state.current!.objective_revision,
              kind: "tool_result",
            },
          ],
        },
        { criterion_id: "review", kind: "human", justification: "Please accept", evidence: [] },
      ],
    };
    expect(
      (
        await validateGoalCandidate(state.current!, proposed, {
          verify: async () => ({ valid: true }),
        })
      ).valid,
    ).toBe(false);
    state = control(state, {
      kind: "accept",
      criterion_id: "review",
      objective_revision: state.current!.objective_revision,
    });
    expect(
      (
        await validateGoalCandidate(state.current!, proposed, {
          verify: async () => ({ valid: true }),
        })
      ).valid,
    ).toBe(true);
    expect(
      (
        await validateGoalCandidate(state.current!, proposed, {
          verify: async () => ({
            valid: false,
            reason: "Result was contradicted or digest changed",
          }),
        })
      ).reasons,
    ).toContain("Result was contradicted or digest changed");
    proposed.assessments[0]!.evidence[0]!.goal_id = "another-goal";
    expect(
      (
        await validateGoalCandidate(state.current!, proposed, {
          verify: async () => ({ valid: true }),
        })
      ).valid,
    ).toBe(false);
  });

  it("rejects missing, duplicate, substituted and obsolete assessments", async () => {
    const state = run(create());
    for (const proposed of [
      { ...candidate(state), objective_revision: 0 },
      { ...candidate(state), execution_id: "unbound" },
      { ...candidate(state), assessments: [] },
      {
        ...candidate(state),
        assessments: [...candidate(state).assessments, ...candidate(state).assessments],
      },
      {
        ...candidate(state),
        assessments: [
          {
            criterion_id: "other",
            kind: "qualitative" as const,
            justification: "done",
            evidence: [],
          },
        ],
      },
    ])
      expect(
        (
          await validateGoalCandidate(state.current!, proposed, {
            verify: async () => ({ valid: true }),
          })
        ).valid,
      ).toBe(false);
  });

  it("enforces structural, serialized and physical-binding limits", () => {
    const state = create();
    expect(boundedGoalState(emptyGoalState())).toEqual(emptyGoalState());
    const wrong = {
      ...state.current!,
      runs: [
        {
          execution_id: "first",
          admission_id: "one",
          control_revision: 1,
          objective_revision: 1,
          automatic: false,
          phase: "running",
          admitted_at: 0,
        },
        {
          execution_id: "second",
          admission_id: "two",
          control_revision: 1,
          objective_revision: 1,
          automatic: false,
          phase: "running",
          admitted_at: 0,
        },
      ],
    };
    expect(() => goalRecordSchema.parse(wrong)).toThrow("only one physical run");
    const large = structuredClone(state.current!);
    large.criteria = Array.from({ length: 32 }, (_, index) => ({
      id: `criterion-${index}`,
      description: "x".repeat(4096),
      kind: "qualitative" as const,
    }));
    state.current = large;
    state.archive = Array.from({ length: 8 }, (_, index) => ({
      ...structuredClone(large),
      goal_id: `old-${index}`,
    }));
    expect(() => boundedGoalState(state)).toThrow("capacity reached");
  });
});

describe("pending explicit resume", () => {
  it("retains the reserved identity through physical recovery and fences later cancellation", () => {
    const initial = applyGoalControl(
      undefined,
      {
        expected_revision: 0,
        operation_id: "create-pending",
        action: { kind: "create", objective: "Recover work", limits },
      },
      context,
    ).state;
    const admitted = admitGoalRun(initial, {
      goal_id: "goal-1",
      execution_id: "old",
      admission_id: "old",
      expected_revision: initial.revision,
      control_revision: initial.current!.control_revision,
      automatic: false,
      now: 101,
    });
    const unknown = advanceGoalRun(admitted, {
      goal_id: "goal-1",
      execution_id: "old",
      phase: "unknown",
      now: 102,
    });
    const pending = applyGoalControl(
      unknown,
      {
        operation_id: "resume-pending",
        expected_revision: unknown.revision,
        action: { kind: "resume" },
      },
      { ...context, physically_busy: true, resume_pending: true, new_execution_id: "successor" },
    );
    expect(pending.start).toBe(false);
    expect(pending.receipt).toMatchObject({
      execution_id: "successor",
      resume_pending: true,
      outcome: "needs_input",
    });
    const closed = closeGoalRunByRecovery(pending.state, {
      goal_id: "goal-1",
      execution_id: "old",
      recovered_at: 103,
    });
    const resumed = retryGoalResume(closed, "resume-pending", context);
    expect(resumed.start).toBe(true);
    expect(resumed.receipt.execution_id).toBe("successor");
    expect(resumed.receipt.fingerprint).toBe(pending.receipt.fingerprint);
    const cancelled = applyGoalControl(
      closed,
      {
        operation_id: "cancel-new",
        expected_revision: closed.revision,
        action: { kind: "cancel" },
      },
      context,
    );
    expect(retryGoalResume(cancelled.state, "resume-pending", context)).toMatchObject({
      start: false,
      receipt: { outcome: "superseded" },
    });
  });
});
