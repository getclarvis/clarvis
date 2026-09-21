import { describe, expect, test } from "bun:test";
import { admitGoalRun, advanceGoalRun, applyGoalControl } from "@clarvis/goal";
import type { RunResult, Session } from "@clarvis/protocol";
import { settleGoalSession } from "../../src/goals/settlement.ts";
import { goalStateToDto } from "../../src/goals/session-state.ts";

/**
 * The terminal cause a physically closed goal stage leaves in durable state.
 *
 * @remarks The domain owns the operator-facing sentence and the kernel owns the
 *   mapping from the engine's own error code, so this suite sits on the one seam
 *   between them: what the host observed becomes the reason a blocked goal shows.
 *   A stage that stagnated must be distinguishable from one whose control could not
 *   be read, and neither may be reported as a stage that simply produced no
 *   candidate. No objective, blocker or provider text may reach the reason.
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

function failedResult(code: string, message = "the run stopped"): RunResult {
  return {
    execution_id: "run-1",
    status: "failed",
    error: { code, message },
    usage: { iterations: 3, elapsed_ms: 120, input_tokens: 100, output_tokens: 10 },
  };
}

function settle(session: Session, result: RunResult): void {
  settleGoalSession(session, result, { disposition: "final", completion_validated: false }, 40);
}

describe("goal stage settlement cause", () => {
  test("names a stagnated stage as stagnation rather than a missing candidate", () => {
    const session = sessionWithRunningStage();

    settle(
      session,
      failedResult("no_progress", "Lead made no progress for 6 consecutive iterations"),
    );

    expect(session.goal_state!.current).toMatchObject({ status: "blocked" });
    expect(session.goal_state!.current!.reason).toContain(
      "no progress across its unproductive-attempt allowance",
    );
    expect(session.goal_state!.current!.reason).not.toContain("Goal run failed");
    expect(session.goal_state!.current!.reason).not.toContain("candidate");
    expect(JSON.stringify(session.goal_state)).not.toContain("6 consecutive iterations");
  });

  test("keeps an unreadable control distinct from stagnation", () => {
    const session = sessionWithRunningStage();

    settle(session, failedResult("goal_control_failed", "Host attention is required"));

    expect(session.goal_state!.current!.reason).toContain("Goal control was unavailable");
    expect(session.goal_state!.current!.reason).not.toContain("unproductive-attempt");
  });

  test("keeps the generic wording for a failure the host cannot name", () => {
    const session = sessionWithRunningStage();

    settle(session, failedResult("empty_response"));

    expect(session.goal_state!.current!.reason).toBe("Goal run failed");
  });
});
