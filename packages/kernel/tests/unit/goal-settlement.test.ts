import { describe, expect, test } from "bun:test";
import { admitGoalRun, advanceGoalRun, applyGoalControl, type GoalRunCause } from "@clarvis/goal";
import type { RunResult, Session } from "@clarvis/protocol";
import { goalStageOutcome, settleGoalSession } from "../../src/goals/settlement.ts";
import { goalStateToDto } from "../../src/goals/session-state.ts";

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
