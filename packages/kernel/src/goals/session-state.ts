import { boundedGoalState, GoalError, type GoalState, type GoalRecord } from "@clarvis/goal";
import type {
  GoalState as GoalStateDto,
  GoalRecord as GoalRecordDto,
  Session,
} from "@clarvis/protocol";
import { kernelError } from "../core/errors.ts";

/** Explicit domain-to-protocol mapping keeps the transport independent of the domain package. */
export function goalStateToDto(state: GoalState): GoalStateDto {
  const record = (goal: GoalRecord): GoalRecordDto => ({
    ...goal,
    runs: goal.runs.map(({ usage_estimate, ...run }) => ({
      ...run,
      ...(usage_estimate === undefined
        ? {}
        : { usage_estimate: { sequence: usage_estimate.sequence, usage: usage_estimate.usage } }),
    })),
  });
  const { current, archive, ...rest } = state;
  return structuredClone({
    ...rest,
    archive: archive.map(record),
    ...(current === undefined ? {} : { current: record(current) }),
  });
}

/** Decode the host-owned field, including archived bindings, without restoring foreign state. */
export function goalStateFromSession(session: Session): GoalState | undefined {
  if (session.goal_state === undefined) return undefined;
  const state = boundedGoalState(session.goal_state, true);
  const goals = [...state.archive, ...(state.current === undefined ? [] : [state.current])];
  if (goals.some((goal) => goal.session_id !== session.id))
    throw kernelError("invalid_request", "goal state belongs to another conversation");
  return state;
}

/** Persisted state is strict and bounded; diagnostics never reflect objective or evidence text. */
export function validateSessionGoalState(session: Session): void {
  try {
    goalStateFromSession(session);
  } catch (error) {
    if (error instanceof GoalError && error.code === "resource_exhausted")
      throw kernelError("resource_exhausted", "goal state exceeds its session allocation");
    throw kernelError("invalid_request", "invalid or foreign session goal state");
  }
}
