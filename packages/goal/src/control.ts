import { createHash } from "node:crypto";
import { z } from "zod";
import { GoalError } from "./errors.ts";
import { goalAdmission, goalHasPhysicalRun, resolveGoalLimits } from "./policy.ts";
import {
  GOAL_ARCHIVE_MAX,
  GOAL_CONTROL_MAX_BYTES,
  GOAL_RECEIPTS_MAX,
  GOAL_STATE_MAX_BYTES,
  goalCriterionSchema,
  goalLimitsSchema,
  goalRecordSchema,
  goalStateSchema,
  type GoalRecord,
  type GoalReceipt,
  type GoalState,
  type GoalLimits,
} from "./schemas.ts";

const objective = z.string().trim().min(1).max(16384);
const criteria = z.array(goalCriterionSchema).max(32);
const limitOverrides = goalLimitsSchema.partial().extend({
  max_auto_continuations: goalLimitsSchema.shape.max_auto_continuations.removeDefault().optional(),
  max_no_progress_checkpoints: goalLimitsSchema.shape.max_no_progress_checkpoints
    .removeDefault()
    .optional(),
});
const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9._:-]+$/u);

export const goalControlSchema = z
  .object({
    expected_revision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 2),
    operation_id: id,
    action: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("create"),
          objective,
          criteria: criteria.default([]),
          limits: limitOverrides.optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("replace"),
          objective,
          criteria: criteria.default([]),
          limits: limitOverrides.optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("edit"),
          objective: objective.optional(),
          criteria: criteria.optional(),
          limits: limitOverrides.optional(),
        })
        .strict(),
      z.object({ kind: z.literal("pause"), running: z.boolean().default(false) }).strict(),
      z.object({ kind: z.literal("resume") }).strict(),
      z.object({ kind: z.literal("cancel") }).strict(),
      z.object({ kind: z.literal("clear") }).strict(),
      z
        .object({
          kind: z.literal("accept"),
          criterion_id: id,
          objective_revision: z.number().int().nonnegative(),
        })
        .strict(),
    ]),
  })
  .strict();

export type GoalControl = z.infer<typeof goalControlSchema>;

/** Internal host context; no model or public control request supplies these authorities. */
export interface GoalControlContext {
  session_id: string;
  new_goal_id?: string;
  new_execution_id?: string;
  default_limits?: Partial<GoalLimits>;
  entry_token_limit?: number;
  now: number;
  physically_busy: boolean;
}

/** A durable receipt is the mutation result; current display state is read independently. */
export interface GoalControlResult {
  state: GoalState;
  receipt: GoalReceipt;
  replayed: boolean;
  start: boolean;
  cancel_execution_id?: string;
}

/** Empty optional session state carries no objective and does not authorize execution. */
export function emptyGoalState(): GoalState {
  return { version: 1, revision: 0, archive: [], receipts: [] };
}

/** Validate both structure and the goal's reserved slice of the bounded session document. */
export function boundedGoalState(value: unknown, settling = false): GoalState {
  const state = goalStateSchema.parse(value);
  const limit = settling ? GOAL_STATE_MAX_BYTES : GOAL_CONTROL_MAX_BYTES;
  if (Buffer.byteLength(JSON.stringify(state), "utf8") > limit)
    throw new GoalError(
      "resource_exhausted",
      "Goal audit capacity reached; no state was discarded",
    );
  return state;
}

function requireCurrent(state: GoalState): GoalRecord {
  if (state.current === undefined)
    throw new GoalError("not_found", "Conversation has no current goal");
  return state.current;
}

function requireInactive(goal: GoalRecord, context: GoalControlContext): void {
  if (context.physically_busy || goalHasPhysicalRun(goal))
    throw new GoalError(
      "conflict",
      "Wait for physical execution to close before editing this goal",
    );
}

function requireNonterminal(goal: GoalRecord): void {
  if (goal.status === "complete" || goal.status === "cancelled")
    throw new GoalError("conflict", "Terminal goals require explicit replacement");
}

function archive(state: GoalState, goal: GoalRecord): void {
  if (state.archive.length >= GOAL_ARCHIVE_MAX)
    throw new GoalError(
      "resource_exhausted",
      "Goal archive is full; audit records cannot be silently deleted",
    );
  state.archive.push(structuredClone(goal));
}

/**
 * Apply one user control to a clone. The host commits the complete session atomically before
 * acting on start/cancel effects. Replay returns its original receipt without re-running effects;
 * evicted receipts remain protected by their old expected revision.
 */
export function applyGoalControl(
  previous: GoalState | undefined,
  input: unknown,
  context: GoalControlContext,
): GoalControlResult {
  const control = goalControlSchema.parse(input);
  const state = boundedGoalState(previous ?? emptyGoalState(), true);
  if (state.current !== undefined && state.current.session_id !== context.session_id)
    throw new GoalError("conflict", "Goal belongs to another conversation");
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ session_id: context.session_id, control }))
    .digest("hex");
  const known = state.receipts.find((receipt) => receipt.operation_id === control.operation_id);
  if (known !== undefined) {
    if (known.fingerprint !== fingerprint)
      throw new GoalError("conflict", "Operation ID was already used for a different goal control");
    return { state, receipt: known, replayed: true, start: false };
  }
  if (state.revision !== control.expected_revision)
    throw new GoalError("conflict", "Goal revision changed; reload before applying control");
  const nextRevision = state.revision + 1;
  const action = control.action;
  let start = false;
  let cancel_execution_id: string | undefined;
  if (action.kind === "create" || action.kind === "replace") {
    if (context.physically_busy)
      throw new GoalError("conflict", "A running conversation cannot acquire or replace a goal");
    if (action.kind === "create" && state.current !== undefined)
      throw new GoalError("conflict", "A goal already exists; review an explicit replacement");
    if (action.kind === "replace") {
      const old = requireCurrent(state);
      requireInactive(old, context);
      if (old.status !== "complete" && old.status !== "cancelled") {
        old.status = "cancelled";
        old.reason = "Replaced by the user";
        old.updated_at = context.now;
      }
      archive(state, old);
    }
    if (context.new_goal_id === undefined)
      throw new GoalError("invalid_request", "Host did not assign a goal identity");
    if (state.archive.some((goal) => goal.goal_id === context.new_goal_id))
      throw new GoalError("conflict", "Goal identity was already used in this conversation");
    state.current = goalRecordSchema.parse({
      goal_id: context.new_goal_id,
      session_id: context.session_id,
      revision: nextRevision,
      control_revision: nextRevision,
      objective_revision: 1,
      objective: action.objective,
      criteria: action.criteria,
      status: "active",
      created_at: context.now,
      updated_at: context.now,
      limits: resolveGoalLimits(
        { ...context.default_limits, ...action.limits },
        context.entry_token_limit,
      ),
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
    });
    const admission = goalAdmission(state.current, context.now, false);
    if (!admission.allowed)
      throw new GoalError(
        admission.status === "paused" ? "blocked" : admission.status,
        admission.reason,
      );
    start = true;
  } else {
    const goal = requireCurrent(state);
    if (action.kind !== "clear") requireNonterminal(goal);
    if (action.kind === "edit") {
      requireInactive(goal, context);
      if (
        action.objective === undefined &&
        action.criteria === undefined &&
        action.limits === undefined
      )
        throw new GoalError("invalid_request", "Goal edit is empty");
      if (action.objective !== undefined || action.criteria !== undefined) {
        goal.objective_revision += 1;
        delete goal.candidate;
        goal.human_acceptances = [];
        if (action.objective !== undefined) goal.objective = action.objective;
        if (action.criteria !== undefined) goal.criteria = action.criteria;
      }
      if (action.limits !== undefined)
        goal.limits = goalLimitsSchema.parse({ ...goal.limits, ...action.limits });
    } else if (action.kind === "clear") {
      requireInactive(goal, context);
      if (goal.status === "active")
        throw new GoalError("conflict", "Pause or cancel the goal before clearing it");
      archive(state, goal);
      delete state.current;
    } else if (action.kind === "pause" || action.kind === "cancel") {
      goal.status = action.kind === "pause" ? "paused" : "cancelled";
      goal.reason = action.kind === "pause" ? "Paused by the user" : "Cancelled by the user";
      if (action.kind === "cancel" || action.running)
        cancel_execution_id = goal.runs.find((run) => run.phase !== "closed")?.execution_id;
    } else if (action.kind === "resume") {
      requireInactive(goal, context);
      const candidate = { ...goal, status: "active" as const, no_progress_checkpoints: 0 };
      const decision = goalAdmission(candidate, context.now, true);
      if (!decision.allowed)
        throw new GoalError(
          decision.status === "paused" ? "blocked" : decision.status,
          decision.reason,
        );
      goal.status = "active";
      goal.no_progress_checkpoints = 0;
      delete goal.reason;
      start = true;
    } else {
      if (action.objective_revision !== goal.objective_revision)
        throw new GoalError("conflict", "Human acceptance refers to an obsolete objective");
      const criterion = goal.criteria.find((value) => value.id === action.criterion_id);
      if (criterion?.kind !== "human")
        throw new GoalError("invalid_request", "This criterion does not require human acceptance");
      goal.human_acceptances = goal.human_acceptances.filter(
        (value) => value.criterion_id !== criterion.id,
      );
      goal.human_acceptances.push({
        criterion_id: criterion.id,
        objective_revision: goal.objective_revision,
        operation_id: control.operation_id,
        accepted_at: context.now,
      });
    }
    if (state.current !== undefined) {
      state.current.revision = nextRevision;
      if (action.kind !== "accept") state.current.control_revision = nextRevision;
      state.current.updated_at = context.now;
    }
  }
  state.revision = nextRevision;
  const receipt: GoalReceipt = {
    operation_id: control.operation_id,
    fingerprint,
    revision: nextRevision,
    ...(start && context.new_execution_id !== undefined
      ? { execution_id: context.new_execution_id }
      : {}),
    ...(state.current === undefined
      ? {}
      : { goal_id: state.current.goal_id, status: state.current.status }),
  };
  state.receipts = [...state.receipts, receipt].slice(-GOAL_RECEIPTS_MAX);
  return {
    state: boundedGoalState(state),
    receipt,
    replayed: false,
    start,
    ...(cancel_execution_id === undefined ? {} : { cancel_execution_id }),
  };
}
