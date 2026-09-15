import { z } from "zod";
import { boundedGoalState, goalReceiptSchema, GOAL_STATE_MAX_BYTES } from "@clarvis/goal";
import type { GoalChange, GoalReceipt, GoalService, GoalView } from "@clarvis/protocol";
import { decodeHostedRunRef, MAX_HOST_INDEX_BYTES } from "../hosting/state.ts";
import { goalStateToDto } from "../goals/session-state.ts";

const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9._:-]+$/u);
const availability = z.strictObject({
  available: z.boolean(),
  reason: z.string().max(4096).optional(),
});
const change = z.strictObject({ session_id: id });
const view = z.strictObject({
  state: z.unknown(),
  physical_run: z.unknown().optional(),
  attention: z.string().max(4096).optional(),
});

/** Refuse malformed capability replies rather than coercing availability. */
export function decodeGoalAvailability(
  value: unknown,
): Awaited<ReturnType<GoalService["availability"]>> | null {
  const parsed = availability.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Receipt identity must match the requested operation, including a replay after later revisions. */
export function decodeGoalReceipt(value: unknown, operationId: string): GoalReceipt | null {
  const parsed = goalReceiptSchema.safeParse(value);
  return parsed.success && parsed.data.operation_id === operationId ? parsed.data : null;
}

/** Invalidation metadata has no state, command or controller authority. */
export function decodeGoalChange(value: unknown): GoalChange | null {
  const parsed = change.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Decode the bounded audit and physical projection under this exact connection/session scope. */
export function decodeGoalView(
  value: unknown,
  sessionId: string,
  workspaceId: string,
): GoalView | null {
  try {
    if (
      Buffer.byteLength(JSON.stringify(value), "utf8") >
      GOAL_STATE_MAX_BYTES + MAX_HOST_INDEX_BYTES
    )
      return null;
    const parsed = view.safeParse(value);
    if (!parsed.success) return null;
    const state = boundedGoalState(parsed.data.state, true);
    if (
      [...state.archive, ...(state.current === undefined ? [] : [state.current])].some(
        (goal) => goal.session_id !== sessionId,
      )
    )
      return null;
    const physical =
      parsed.data.physical_run === undefined
        ? undefined
        : decodeHostedRunRef(parsed.data.physical_run);
    if (
      physical === null ||
      (physical !== undefined &&
        (physical.session_id !== sessionId || physical.workspace_id !== workspaceId))
    )
      return null;
    return {
      state: goalStateToDto(state),
      ...(physical === undefined ? {} : { physical_run: physical }),
      ...(parsed.data.attention === undefined ? {} : { attention: parsed.data.attention }),
    };
  } catch {
    return null;
  }
}
