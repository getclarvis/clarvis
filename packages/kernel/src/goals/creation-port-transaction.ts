import { createHash, randomUUID } from "node:crypto";
import {
  admitGoalRun,
  advanceGoalRun,
  applyGoalFormulation,
  type GoalCreationInput,
  type GoalRepository,
  type GoalState,
} from "@clarvis/goal";
import type { Session } from "@clarvis/protocol";
import { goalStateFromSession } from "./session-state.ts";
import type { CreationTransactionOptions } from "./creation-port-types.ts";

export function creationFingerprint(options: {
  sessionId: string;
  executionId: string;
  seed: string;
  input: GoalCreationInput;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        session_id: options.sessionId,
        execution_id: options.executionId,
        seed: options.seed,
        input: options.input,
      }),
    )
    .digest("hex");
}

/** Pure state transition for the authenticated creation turn. */
function applyCreationAndAdmission(
  previous: GoalState | undefined,
  input: GoalCreationInput,
  options: CreationTransactionOptions,
): { state: GoalState; result: undefined } {
  const state = goalStateFromSession({ ...options.session, goal_state: previous });
  const created = applyGoalFormulation(
    state,
    {
      objective: input.objective,
      criteria: input.criteria,
      constraints: input.constraints,
      exclusions: input.exclusions,
      assumptions: input.assumptions,
    },
    {
      session_id: options.session.id,
      new_goal_id: randomUUID(),
      new_execution_id: options.executionId,
      default_limits: options.defaultLimits,
      entry_token_limit: options.entryTokenLimit,
      now: options.now(),
      physically_busy: false,
      fingerprint: options.fingerprint,
      sources: [],
      origin: {
        kind: "guided",
        seed: options.seed,
        formulation_execution_id: options.executionId,
        source_session_revision: options.session.revision ?? 0,
        source_execution_ids: [options.executionId],
        trajectory_digest: options.fingerprint,
        trajectory_truncated: false,
      },
      operation_id: `goal-create:${options.executionId}`,
      expected_revision: state?.revision ?? 0,
    },
  );
  const goal = created.state.current;
  if (goal === undefined) throw new Error("Goal creation did not produce a current goal");
  if (goal.runs.some((run) => run.execution_id === options.executionId))
    return { state: created.state, result: undefined };

  const admitted = admitGoalRun(created.state, {
    goal_id: goal.goal_id,
    expected_revision: created.state.revision,
    control_revision: goal.control_revision,
    execution_id: options.executionId,
    admission_id: options.executionId,
    automatic: false,
    now: options.now(),
  });
  return {
    state: advanceGoalRun(admitted, {
      goal_id: goal.goal_id,
      execution_id: options.executionId,
      phase: "running",
      now: options.now(),
    }),
    result: undefined,
  };
}

export function persistCreation(
  repository: GoalRepository,
  session: Session,
  input: GoalCreationInput,
  options: Omit<CreationTransactionOptions, "session">,
): Promise<void> {
  return repository
    .transact(session.id, (previous) =>
      applyCreationAndAdmission(previous, input, { ...options, session }),
    )
    .then(() => undefined);
}
