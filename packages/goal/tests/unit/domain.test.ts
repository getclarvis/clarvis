import { describe, expect, it } from "bun:test";
import {
  admitGoalRun,
  advanceGoalRun,
  applyGoalControl,
  blockGoalRun,
  boundedGoalState,
  emptyGoalState,
  goalAdmission,
  goalNetTokens,
  goalRecordSchema,
  pauseGoalForPolicy,
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
const limits = { max_net_tokens: 1000, max_auto_continuations: 8, max_no_progress_checkpoints: 3 };
const measured: GoalUsage = { kind: "measured", input: 100, cached: 80, output: 10 };

describe("host continuation retirement", () => {
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
            max_no_progress_checkpoints: 5,
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
      max_no_progress_checkpoints: 5,
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
      max_no_progress_checkpoints: 3,
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
  it("records blocking without claiming physical closure and preserves later user controls", () => {
    const running = run(create());
    const input = {
      goal_id: "goal-1",
      execution_id: "run-1",
      objective_revision: 1,
      reason: "User authority is required",
      now: 210,
    };
    const blocked = blockGoalRun(running, input);
    expect(blocked.current!.status).toBe("blocked");
    expect(blocked.current!.control_revision).toBe(blocked.revision);
    expect(blocked.current!.runs).toEqual(running.current!.runs);
    expect(blocked.current!.consumption).toEqual(running.current!.consumption);
    expect(blockGoalRun(blocked, { ...input, reason: "Repeated" })).toEqual(blocked);
    for (const action of [{ kind: "pause", running: false }, { kind: "cancel" }] as const) {
      const controlled = control(running, action);
      expect(blockGoalRun(controlled, input)).toEqual(controlled);
    }
    expect(() => blockGoalRun(running, { ...input, objective_revision: 2 })).toThrow("obsolete");
    expect(() => blockGoalRun(running, { ...input, execution_id: "foreign" })).toThrow();
    expect(() => blockGoalRun(running, { ...input, reason: "" })).toThrow();
    const closed = settle(checkpoint(running));
    expect(() => blockGoalRun(closed, input)).toThrow("running stage");
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
    expect(progress.current!.no_progress_checkpoints).toBe(0);
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

  it("replaces atomically, retains audit and never reopens terminal goals", () => {
    let state = control(create(), { kind: "cancel" });
    expect(() => control(state, { kind: "resume" })).toThrow("Terminal");
    expect(() => control(state, { kind: "edit", objective: "Other" })).toThrow("Terminal");
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
      no_progress_checkpoints: 0,
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

  it("blocks missing usage, conservatively charges missing cache, and permits explicit late reconciliation", () => {
    expect(goalNetTokens({ kind: "unknown" })).toBeUndefined();
    expect(goalNetTokens({ kind: "measured", input: 100, output: 10 })).toBe(110);
    expect(() => goalNetTokens({ kind: "measured", input: 1, output: 0, cached: 2 })).toThrow();
    let state = settle(checkpoint(run(create())), "run-1", { kind: "unknown" });
    expect(state.current).toMatchObject({
      status: "blocked",
      consumption: { usage_unknown: true },
    });
    expect(() => control(state, { kind: "resume" })).toThrow("Usage must be reconciled");
    state = settle(state, "run-1", { kind: "measured", input: 100, output: 10 });
    expect(state.current!.consumption).toMatchObject({
      usage_unknown: false,
      cache_estimated: true,
      net_tokens: 110,
    });
    expect(state.current!.consumption.cached).toBeUndefined();
    expect(state.current!.status).toBe("blocked");
    expect(() => settle(state, "run-1", measured)).toThrow("cannot be rewritten");
    expect(control(state, { kind: "resume" }).current!.consumption.net_tokens).toBe(110);
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
      kind: "measured",
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
    expect(() => control(state, { kind: "resume" })).toThrow("continuation limit");
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
    expect(state.current).toMatchObject({ status: "blocked", no_progress_checkpoints: 3 });
    const resumed = control(state, { kind: "resume" });
    expect(resumed.current!.no_progress_checkpoints).toBe(0);
    expect(resumed.current!.auto_continuations).toBe(2);
    expect(resumed.current!.consumption.net_tokens).toBe(90);
  });

  it("does not count changing prose around the same activity as fresh progress", () => {
    let state = settle(checkpoint(run(create()), "run-1", "a".repeat(64)));
    state = settle(checkpoint(run(state, "run-2", true), "run-2", "a".repeat(64)), "run-2");
    expect(state.current!.no_progress_checkpoints).toBe(1);
    state = settle(checkpoint(run(state, "run-3", true), "run-3", "b".repeat(64)), "run-3");
    expect(state.current!.no_progress_checkpoints).toBe(0);
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
      const usage: GoalUsage = { kind: "measured", input: 1100, output: 100, cached: 0 };
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
    expect(validation).toEqual({ valid: true, reasons: [], qualitative_criteria: ["objective"] });
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
