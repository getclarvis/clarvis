import type { GoalRecord, GoalRun, GoalView, HostedRunRef } from "@clarvis/protocol";

/** Protocol-only goal fixture for client tests; domain transitions remain covered by the host. */
export function goalView(overrides: Partial<GoalRecord> = {}, physical?: HostedRunRef): GoalView {
  return {
    state: {
      version: 1,
      revision: 1,
      archive: [],
      receipts: [],
      current: {
        goal_id: "goal-fixture",
        session_id: "session-hosted",
        revision: 1,
        control_revision: 1,
        objective_revision: 1,
        objective: "Verify the fixture",
        criteria: [{ id: "objective", description: "Fixture is complete", kind: "qualitative" }],
        status: "active",
        created_at: 1,
        updated_at: 1,
        limits: {
          max_net_tokens: 10000,
          max_auto_continuations: 8,
          max_no_progress_checkpoints: 3,
        },
        consumption: {
          input: 0,
          output: 0,
          cached: 0,
          net_tokens: 0,
          usage_unknown: false,
          cache_estimated: false,
          overrun_tokens: 0,
        },
        auto_continuations: 0,
        no_progress_checkpoints: 0,
        runs: [],
        human_acceptances: [],
        ...overrides,
      },
    },
    ...(physical === undefined ? {} : { physical_run: physical }),
  };
}

export function goalRun(executionId: string, phase: GoalRun["phase"] = "running"): GoalRun {
  return {
    execution_id: executionId,
    admission_id: `admit-${executionId}`,
    control_revision: 1,
    objective_revision: 1,
    automatic: true,
    phase,
    admitted_at: 1,
  };
}
