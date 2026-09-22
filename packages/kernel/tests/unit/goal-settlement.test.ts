import { describe, expect, test } from "bun:test";
import {
  admitGoalRun,
  prepareGoalSettlement,
  advanceGoalRun,
  applyGoalControl,
  type GoalRunCause,
  type GoalUsage,
} from "@clarvis/goal";
import type { RunResult, Session } from "@clarvis/protocol";
import {
  goalStageOutcome,
  pendingInstant,
  settleGoalSession,
  recoverGoalSettlementSession,
} from "../../src/goals/settlement.ts";
import { goalStateFromSession, goalStateToDto } from "../../src/goals/session-state.ts";
import { createGoalUsageTracker } from "../../src/goals/usage.ts";

/**
 * The terminal cause a physically closed goal stage leaves in durable state.
 *
 * @remarks The domain owns the operator-facing sentence and the decision; the kernel
 *   owns the classification of the engine's own codes. This suite sits on that one
 *   seam: what the host observed becomes both the reason a goal shows and whether a
 *   successor stage may re-evaluate the work. A stage that stagnated must be
 *   distinguishable from one whose control could not be read; a provider fault is
 *   classified from the provider's own bounded classification rather than its code;
 *   and an ending the host cannot name must not be presumed recoverable. No objective,
 *   blocker or provider text may reach the reason.
 */
function sessionWithRunningStage(): Session {
  const created = applyGoalControl(
    undefined,
    {
      expected_revision: 0,
      operation_id: "create-op",
      action: {
        kind: "create",
        objective: "Produce and verify a scoped result",
        criteria: [],
        limits: { max_net_tokens: 10000 },
      },
    },
    { session_id: "conversation", new_goal_id: "goal-1", now: 1, physically_busy: false },
  ).state;
  const admitted = admitGoalRun(created, {
    goal_id: "goal-1",
    execution_id: "run-1",
    admission_id: "run-1",
    automatic: false,
    expected_revision: created.revision,
    control_revision: created.current!.control_revision,
    now: 2,
  });
  const running = advanceGoalRun(admitted, {
    goal_id: "goal-1",
    execution_id: "run-1",
    phase: "running",
    now: 3,
  });
  return {
    id: "conversation",
    title: "Objective work",
    project_id: "project",
    workspace: "workspace",
    created_at: 1,
    updated_at: 1,
    turns: [],
    totals: { input: 0, output: 0, cached: 0 },
    goal_state: goalStateToDto(running),
  };
}

const USAGE = { iterations: 3, elapsed_ms: 120, input_tokens: 100, output_tokens: 10 };

function failedResult(code: string, message = "the run stopped", extra = {}): RunResult {
  return {
    execution_id: "run-1",
    status: "failed",
    error: { code, message, ...extra },
    usage: USAGE,
  };
}

function settle(session: Session, result: RunResult): void {
  settleGoalSession(session, result, { disposition: "final", completion_validated: false }, 40);
}

function stage(session: Session) {
  return session.goal_state!.current!.runs.at(-1)!;
}

describe("goal stage classification", () => {
  test("preparation bounds new activity after excluding already credited receipts", () => {
    const session = sessionWithRunningStage();
    const state = goalStateFromSession(session)!;
    const receipts = Array.from({ length: 80 }, (_, index) => index.toString(16).padStart(64, "0"));
    state.current!.runs[0]!.activity = receipts.slice(0, 32);
    const input = {
      goal_id: "goal-1",
      execution_id: "run-1",
      now: 4,
      preparation: {
        outcome: "failed" as const,
        disposition: "final" as const,
        usage: { kind: "unknown" as const },
        activity: [...receipts].reverse().concat(receipts),
      },
    };
    const prepared = prepareGoalSettlement(state, input);
    expect(prepared.current!.runs[0]!.settlement_preparation!.activity).toEqual(
      receipts.slice(32, 64),
    );
    expect(prepareGoalSettlement(prepared, input)).toEqual(prepared);
  });

  test("settlement preparation is idempotent and cannot carry a final completion", () => {
    const state = goalStateFromSession(sessionWithRunningStage())!;
    const input = {
      goal_id: "goal-1",
      execution_id: "run-1",
      now: 4,
      preparation: {
        outcome: "failed" as const,
        disposition: "final" as const,
        usage: { kind: "unknown" as const },
        activity_unavailable: true,
      },
    };
    const prepared = prepareGoalSettlement(state, input);
    expect(prepareGoalSettlement(prepared, input)).toEqual(prepared);
    expect(prepared.current!.control_revision).toBe(state.current!.control_revision);
    expect(() =>
      prepareGoalSettlement(prepared, {
        ...input,
        preparation: { ...input.preparation, usage: { kind: "complete", input: 1, output: 2 } },
      }),
    ).toThrow("cannot be rewritten");
    expect(() =>
      prepareGoalSettlement(state, {
        ...input,
        preparation: { ...input.preparation, outcome: "completed" },
      }),
    ).toThrow("fresh validation");
  });

  test.each(["failed", "cancelled", "completed"] as const)(
    "recovers prepared %s stages without asserting completion",
    (status) => {
      const session = sessionWithRunningStage();
      const disposition = status === "completed" ? ("checkpoint" as const) : ("final" as const);
      const result: RunResult = {
        execution_id: "run-1",
        status,
        usage: USAGE,
        ...(disposition === "checkpoint"
          ? { disposition, checkpoint: { summary: "Retained work", next_step: "Remaining work" } }
          : { disposition }),
      };
      expect(recoverGoalSettlementSession(session, result, 10)).toBe(false);
      session.goal_state = goalStateToDto(
        prepareGoalSettlement(goalStateFromSession(session)!, {
          goal_id: "goal-1",
          execution_id: "run-1",
          now: 4,
          preparation: {
            outcome: status,
            disposition,
            usage: { kind: "complete", input: 19, output: 7, cost_usd: 0.00003 },
            activity_unavailable: true,
          },
        }),
      );
      const before = structuredClone(session);
      expect(
        recoverGoalSettlementSession(session, { ...result, execution_id: "foreign" }, 10),
      ).toBe(false);
      expect(recoverGoalSettlementSession(session, { ...result, status: "running" }, 10)).toBe(
        false,
      );
      expect(session).toEqual(before);
      expect(recoverGoalSettlementSession(session, result, 10)).toBe(true);
      expect(stage(session).phase).toBe("closed");
      expect(stage(session).decision).not.toBe("complete");
      expect(session.totals.input).toBe(19);
      expect(session.totals.output).toBe(7);
      expect(session.totals.cost_usd).toBeCloseTo(0.00003, 10);
      expect(recoverGoalSettlementSession(session, result, 10)).toBe(false);
      expect(session.totals.input).toBe(19);
    },
  );

  test("persists unavailable activity without manufacturing a negative progress observation", () => {
    const session = sessionWithRunningStage();
    settleGoalSession(
      session,
      failedResult("provider_error", "transient", { kind: "transient" }),
      {
        disposition: "final",
        completion_validated: false,
        activity_unavailable: true,
      },
      40,
    );
    expect(stage(session).activity_unavailable).toBe(true);
    expect(stage(session).progress_observed).toBeUndefined();
    expect(stage(session).activity).toBeUndefined();
    expect(session.goal_state!.current!.no_progress_stages).toBe(0);
    expect(stage(session).decision).toBe("continue");
  });
  const cases: Array<[string, RunResult, GoalRunCause]> = [
    [
      "a checkpoint handoff",
      {
        execution_id: "run-1",
        status: "completed",
        disposition: "checkpoint",
        checkpoint: { summary: "Stage ended", next_step: "Continue" },
        usage: USAGE,
      },
      "checkpoint",
    ],
    [
      "a stage budget",
      { execution_id: "run-1", status: "failed", ended_reason: "budget_exhausted", usage: USAGE },
      "local_limit",
    ],
    [
      "a declined extension",
      {
        execution_id: "run-1",
        status: "failed",
        ended_reason: "soft_limit_declined",
        usage: USAGE,
      },
      "declined",
    ],
    ["a cancellation", { execution_id: "run-1", status: "cancelled", usage: USAGE }, "cancelled"],
    ["an empty response", failedResult("empty_response"), "empty_response"],
    ["unavailable tools", failedResult("all_tools_unavailable"), "tools_unavailable"],
    ["a context overflow", failedResult("context_overflow"), "context_overflow"],
    ["an unreadable control", failedResult("goal_control_failed"), "control_failure"],
    ["an interrupted Steward", failedResult("goal_steward_inconclusive"), "steward_interrupted"],
    ["an exhausted quota", failedResult("provider_quota_exhausted"), "provider_refused"],
    ["a content refusal", failedResult("provider_content_policy"), "provider_refused"],
    [
      "an authenticated credential fault",
      failedResult("provider_error", "denied", { kind: "auth" }),
      "provider_refused",
    ],
    ["an internal fault", failedResult("internal_error"), "unclassified"],
    ["a run the host could not classify", failedResult("provider_error"), "unclassified"],
    [
      "a rebuilt interrupted record",
      { execution_id: "run-1", status: "failed", ended_reason: "interrupted", usage: USAGE },
      "unclassified",
    ],
  ];

  test.each(cases)("classifies %s", (_name, result, cause) => {
    expect(goalStageOutcome(result, 1_000).cause).toBe(cause);
  });

  test("bounds the provider-requested backoff it will wait", () => {
    const transient = (retry_after_ms?: number) =>
      goalStageOutcome(
        failedResult("provider_error", "timeout", { kind: "transient", retry_after_ms }),
        1_000,
      );
    expect(transient(4_000)).toEqual({ cause: "transient", not_before: 5_000 });
    expect(transient(600_000)).toEqual({ cause: "transient", not_before: 61_000 });
    expect(transient(undefined)).toEqual({ cause: "transient", not_before: 1_000 });
  });
});

describe("goal stage settlement cause", () => {
  test.each(["no_progress", "stagnation_detected", "tool_failure_loop"])(
    "names %s as stagnation and leaves the Goal continuable",
    (code) => {
      const session = sessionWithRunningStage();

      settle(session, failedResult(code, "the run repeated itself"));

      expect(session.goal_state!.current).toMatchObject({
        status: "active",
        no_progress_stages: 1,
      });
      expect(stage(session)).toMatchObject({ decision: "continue", cause: "stagnation" });
      expect(session.goal_state!.current!.reason).toContain("change its approach");
      expect(JSON.stringify(session.goal_state)).not.toContain("the run repeated itself");
    },
  );

  test("continues snapshot conflicts without spending or resetting semantic progress tolerance", () => {
    const session = sessionWithRunningStage();
    session.goal_state!.current!.no_progress_stages = 2;
    const limits = structuredClone(session.goal_state!.current!.limits);
    settle(session, failedResult("goal_finalization_conflict"));
    expect(session.goal_state!.current).toMatchObject({
      status: "active",
      no_progress_stages: 2,
      limits,
    });
    expect(stage(session)).toMatchObject({
      decision: "continue",
      cause: "finalization_conflict",
      progress_observed: false,
    });
    expect(session.goal_state!.current!.consumption.net_tokens).toBe(110);
  });

  test.each(["pause", "revision", "budget", "deadline", "continuations", "unknown_usage"] as const)(
    "a snapshot conflict does not bypass %s",
    (constraint) => {
      const session = sessionWithRunningStage();
      const goal = session.goal_state!.current!;
      const result = failedResult("goal_finalization_conflict");
      if (constraint === "pause") goal.status = "paused";
      if (constraint === "revision") goal.control_revision++;
      if (constraint === "budget") goal.limits.max_net_tokens = 100;
      if (constraint === "deadline") goal.limits.deadline_at = 40;
      if (constraint === "continuations") goal.limits.max_auto_continuations = 0;
      if (constraint === "unknown_usage") delete result.usage;
      settle(session, result);
      expect(stage(session).decision).not.toBe("continue");
      expect(session.goal_state!.current!.status).not.toBe("complete");
      expect(session.goal_state!.current!.no_progress_stages).toBe(0);
    },
  );

  test("keeps an unreadable control distinct from stagnation", () => {
    const session = sessionWithRunningStage();

    settle(session, failedResult("goal_control_failed", "Host attention is required"));

    expect(session.goal_state!.current!.status).toBe("blocked");
    expect(session.goal_state!.current!.reason).toContain("Goal control was unavailable");
    expect(session.goal_state!.current!.reason).not.toContain("without progress");
    expect(stage(session).decision).toBe("attention");
  });

  test("recovers an empty response and an interrupted review in a new stage", () => {
    for (const code of ["empty_response", "goal_steward_failed", "goal_steward_inconclusive"]) {
      const session = sessionWithRunningStage();

      settle(session, failedResult(code));

      expect(session.goal_state!.current!.status).toBe("active");
      expect(stage(session)).toMatchObject({
        decision: "continue",
        cause: code === "empty_response" ? "empty_response" : "steward_interrupted",
      });
    }
  });

  test("keeps the generic wording for a failure the host cannot name", () => {
    const session = sessionWithRunningStage();

    settle(session, failedResult("internal_error"));

    expect(session.goal_state!.current!.status).toBe("blocked");
    expect(session.goal_state!.current!.reason).toBe("Goal run failed");
    expect(stage(session)).toMatchObject({ decision: "attention", cause: "unclassified" });
  });

  test("never repeats a credential, quota or content refusal on its own", () => {
    for (const result of [
      failedResult("provider_quota_exhausted"),
      failedResult("provider_content_policy"),
      failedResult("provider_error", "denied", { kind: "auth" }),
    ]) {
      const session = sessionWithRunningStage();

      settle(session, result);

      expect(session.goal_state!.current!.status).toBe("blocked");
      expect(session.goal_state!.current!.reason).toContain("provider refused");
      expect(stage(session).decision).toBe("attention");
    }
  });

  test("treats a recorded instant as a pending wait rather than a permanent condition", () => {
    expect(pendingInstant(undefined, 100)).toBeUndefined();
    expect(pendingInstant(150, 100)).toBe(150);
    /** The boundary a zero backoff lands on: an instant that has arrived is not a wait. */
    expect(pendingInstant(100, 100)).toBeUndefined();
    expect(pendingInstant(50, 100)).toBeUndefined();
  });

  test("resumes a transient provider fault once its backoff has been recorded", () => {
    const session = sessionWithRunningStage();

    settle(
      session,
      failedResult("provider_error", "timed out", { kind: "transient", retry_after_ms: 2_500 }),
    );

    expect(session.goal_state!.current!.status).toBe("active");
    expect(stage(session)).toMatchObject({
      decision: "continue",
      cause: "transient",
      not_before: 2_540,
    });
  });

  test("closes the automatic path on an operator refusal or cancellation", () => {
    const declined = sessionWithRunningStage();

    settle(declined, {
      execution_id: "run-1",
      status: "failed",
      ended_reason: "soft_limit_declined",
      usage: USAGE,
    });

    expect(declined.goal_state!.current!.status).toBe("blocked");
    expect(declined.goal_state!.current!.reason).toContain("declined");
    expect(stage(declined).decision).toBe("closed");

    const cancelled = sessionWithRunningStage();
    settle(cancelled, { execution_id: "run-1", status: "cancelled", usage: USAGE });
    expect(cancelled.goal_state!.current!.status).toBe("blocked");
    expect(stage(cancelled)).toMatchObject({ decision: "closed", cause: "cancelled" });
  });

  test("reports a local stage limit as continuable while the Goal's budget lasts", () => {
    const session = sessionWithRunningStage();

    settle(session, {
      execution_id: "run-1",
      status: "failed",
      ended_reason: "budget_exhausted",
      usage: USAGE,
    });

    expect(session.goal_state!.current).toMatchObject({ status: "active", no_progress_stages: 1 });
    expect(stage(session)).toMatchObject({ decision: "continue", cause: "local_limit" });
  });
});

/**
 * The consumption side of one settlement: what gets charged, and what a late measurement does.
 *
 * @remarks The Goal charges a confirmed subtotal even when the stage's measurement is incomplete,
 *   and a later revision of that same execution adds only what it newly learned. A repeated
 *   revision is a no-op, a smaller one is refused before any accounting happens, and a correction
 *   still finds the execution after the Goal it belonged to was replaced.
 */
describe("goal usage credit", () => {
  test("prices Goal work and Guard calls once when run agent detail omits Guard", async () => {
    const session = sessionWithRunningStage();
    session.totals.cost_usd = 0.01;
    const tracker = createGoalUsageTracker();
    const provider = tracker.wrap({
      call: async (params) => ({
        text: "done",
        usage: {
          input_tokens: params.model === "guard" ? 200 : 100,
          output_tokens: params.model === "guard" ? 20 : 10,
          cached_tokens: params.model === "guard" ? 150 : 50,
          cache_write_tokens: 0,
        },
      }),
    });
    for (const model of ["work", "guard"])
      await provider.call({ provider: "fixture", model, messages: [], tools: [] });
    const usage = tracker.measure(() => ({ input: 1, output: 2, cache_read: 0.1 }));
    expect(usage).toMatchObject({ input: 300, output: 30, cached: 200 });
    expect(usage.kind === "unknown" ? undefined : usage.cost_usd).toBeCloseTo(0.00018, 10);
    const result: RunResult = {
      execution_id: "run-1",
      status: "completed",
      disposition: "checkpoint",
      checkpoint: { summary: "Stage ended", next_step: "Continue" },
      usage: {
        iterations: 1,
        elapsed_ms: 1,
        by_agent: [
          {
            role: "lead",
            model: "fixture/work",
            input_tokens: 100,
            output_tokens: 10,
            cached_tokens: 50,
            cache_write_tokens: 0,
            iterations: 1,
          },
        ],
      },
    };
    const settle = () =>
      settleGoalSession(
        session,
        result,
        { disposition: "checkpoint", completion_validated: false, usage },
        40,
        () => ({ input: 1, output: 2, cache_read: 0.1 }),
      );
    expect(settle()).toBe(true);
    expect(session.totals).toMatchObject({ input: 300, output: 30, cached: 200 });
    expect(session.totals.cost_usd).toBeCloseTo(0.01018, 10);
    expect(settle()).toBe(true);
    expect(session.totals).toMatchObject({ input: 300, output: 30, cached: 200 });
    expect(session.totals.cost_usd).toBeCloseTo(0.01018, 10);
  });

  const partial = (input: number, output: number) => ({
    kind: "partial" as const,
    input,
    output,
    gaps: [{ cause: "no_usage" as const, calls: 1 }],
  });

  function credit(session: Session, usage: GoalUsage, now = 40): boolean {
    return settleGoalSession(
      session,
      {
        execution_id: "run-1",
        status: "completed",
        disposition: "checkpoint",
        checkpoint: { summary: "Stage ended", next_step: "Continue" },
        usage: USAGE,
      },
      { disposition: "checkpoint", completion_validated: false, usage },
      now,
    );
  }

  test("charges a partial subtotal once and only the difference of a later revision", () => {
    const session = sessionWithRunningStage();
    expect(credit(session, partial(100, 10))).toBe(true);
    expect(session.totals).toMatchObject({ input: 100, output: 10 });

    expect(credit(session, partial(160, 12), 41)).toBe(true);
    expect(session.totals).toMatchObject({ input: 160, output: 12 });

    expect(credit(session, partial(160, 12), 42)).toBe(true);
    expect(session.totals).toMatchObject({ input: 160, output: 12 });
  });

  test("refuses a smaller revision without charging anything", () => {
    const session = sessionWithRunningStage();
    credit(session, partial(160, 12));
    expect(() => credit(session, partial(10, 1), 41)).toThrow("cannot be rewritten");
    expect(session.totals).toMatchObject({ input: 160, output: 12 });
  });

  test("still charges an unresolved stage after its Goal was replaced", () => {
    const session = sessionWithRunningStage();
    credit(session, { kind: "unknown" });
    expect(session.totals.input).toBe(0);

    const replaced = applyGoalControl(
      session.goal_state as never,
      {
        expected_revision: session.goal_state!.revision,
        operation_id: "replace-op",
        action: { kind: "replace", objective: "Next scope", limits: { max_net_tokens: 10000 } },
      },
      { session_id: "conversation", new_goal_id: "goal-2", now: 50, physically_busy: false },
    ).state;
    session.goal_state = goalStateToDto(replaced);
    expect(session.goal_state.current!.goal_id).toBe("goal-2");

    // The late measurement belongs to the archived execution, and is charged there.
    expect(credit(session, { kind: "complete", input: 100, output: 10 }, 60)).toBe(true);
    expect(session.totals).toMatchObject({ input: 100, output: 10 });
    expect(session.goal_state.archive[0]!.consumption).toMatchObject({
      input: 100,
      output: 10,
      usage_unknown: false,
    });
  });
});

test("versioned corrections update session and Goal by signed delta and reject conflicting revisions", () => {
  const session = sessionWithRunningStage();
  const result = failedResult("internal_error");
  const apply = (usage: GoalUsage) =>
    settleGoalSession(
      session,
      result,
      { disposition: "final", completion_validated: false, usage },
      40,
    );
  apply({ kind: "complete", revision: 1, input: 100, output: 10, cached: 20, cost_usd: 0.01 });
  apply({ kind: "complete", revision: 2, input: 90, output: 8, cached: 40, cost_usd: 0.015 });
  expect(session.totals).toMatchObject({ input: 90, output: 8, cached: 40, cost_usd: 0.015 });
  expect(session.goal_state!.current!.consumption.net_tokens).toBe(58);
  const snapshot = structuredClone(session);
  apply({ kind: "complete", revision: 1, input: 100, output: 10, cached: 20, cost_usd: 0.01 });
  expect(session).toEqual(snapshot);
  expect(() =>
    apply({ kind: "complete", revision: 2, input: 95, output: 8, cached: 40, cost_usd: 0.015 }),
  ).toThrow("Conflicting measurements");
  expect(session).toEqual(snapshot);
});
