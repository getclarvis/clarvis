import { createHash } from "node:crypto";
import { z } from "zod";
import { GoalError } from "./errors.ts";
import {
  goalAdmission,
  goalHasPhysicalRun,
  resolveGoalLimits,
  unacceptedUsageRuns,
  usageGapIdentity,
} from "./policy.ts";
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
  type GoalDefinitionSource,
  type GoalOrigin,
} from "./schemas.ts";

const objective = z.string().trim().min(1).max(16384);
const criteria = z.array(goalCriterionSchema).max(32);
const semanticItems = z.array(z.string().trim().min(1).max(4096)).max(16);
const limitOverrides = goalLimitsSchema.partial().extend({
  max_auto_continuations: goalLimitsSchema.shape.max_auto_continuations.removeDefault().optional(),
  max_no_progress_stages: goalLimitsSchema.shape.max_no_progress_stages.removeDefault().optional(),
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
          resume_operation_id: id.optional(),
          objective: objective.optional(),
          criteria: criteria.optional(),
          constraints: semanticItems.optional(),
          exclusions: semanticItems.optional(),
          assumptions: semanticItems.optional(),
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
  /** Existing healthy bound execution attested by the host; resume reattaches without spawning. */
  live_execution_id?: string;
  /** Physical recovery keeps explicit resume durable without granting start. */
  resume_pending?: boolean;
  resume_condition?: "physical" | "token_limit" | "deadline";
  /** Host-owned idempotency fingerprint for a semantic formulation operation. */
  fingerprint?: string;
}

/** A durable receipt is the mutation result; current display state is read independently. */
export interface GoalControlResult {
  state: GoalState;
  receipt: GoalReceipt;
  replayed: boolean;
  start: boolean;
  cancel_execution_id?: string;
}

export interface GoalFormulationDefinition {
  objective: string;
  criteria: GoalRecord["criteria"];
  constraints: string[];
  exclusions: string[];
  assumptions: string[];
}

export interface GoalFormulationContext extends GoalControlContext {
  sources: GoalDefinitionSource[];
  origin: Exclude<GoalOrigin, { kind: "literal" }>;
  operation_id: string;
  expected_revision: number;
  fingerprint: string;
}

export interface GoalFormulationReceiptInput {
  operation_id: string;
  expected_revision: number;
  fingerprint: string;
  formulation_execution_id?: string;
  mode: "auto" | "guided";
  outcome: "insufficient_context" | "stale_context" | "failed";
  question?: string;
  message?: string;
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
  const fingerprint =
    context.fingerprint ??
    createHash("sha256")
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
      delete old.steward.last_steward_execution_id;
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
      constraints: [],
      exclusions: [],
      assumptions: [],
      sources: [],
      origin: { kind: "literal" },
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
        gaps: [],
        usage_accepted_runs: [],
      },
      auto_continuations: 0,
      no_progress_stages: 0,
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
    delete state.creation_intent;
  } else {
    const goal = requireCurrent(state);
    /**
     * A terminal goal is replaced — except by an explicit resume, which reopens it.
     *
     * @remarks The operator asking to continue a finished or cancelled objective is asking for a
     *   new attempt at it, and the domain would otherwise have no transition for that: the only
     *   remaining route was `replace`, which discards the objective, its criteria and its audit.
     *   Reopening preserves all three and invalidates the parts that belonged to the closed
     *   attempt — see the `resume` branch below.
     */
    if (
      action.kind !== "clear" &&
      action.kind !== "resume" &&
      !(action.kind === "edit" && action.resume_operation_id !== undefined)
    )
      requireNonterminal(goal);
    if (action.kind === "edit") {
      requireInactive(goal, context);
      if (action.resume_operation_id !== undefined) {
        const pending = state.receipts.find(
          (receipt) => receipt.operation_id === action.resume_operation_id,
        );
        if (
          pending?.resume_pending !== true ||
          pending.goal_id !== goal.goal_id ||
          pending.revision !== goal.control_revision ||
          action.limits === undefined
        )
          throw new GoalError("conflict", "Limit edit does not match the pending resume");
        pending.revision = nextRevision;
      }
      if (
        action.objective === undefined &&
        action.criteria === undefined &&
        action.constraints === undefined &&
        action.exclusions === undefined &&
        action.assumptions === undefined &&
        action.limits === undefined
      )
        throw new GoalError("invalid_request", "Goal edit is empty");
      if (
        action.objective !== undefined ||
        action.criteria !== undefined ||
        action.constraints !== undefined ||
        action.exclusions !== undefined ||
        action.assumptions !== undefined
      ) {
        goal.objective_revision += 1;
        delete goal.steward.last_steward_execution_id;
        delete goal.candidate;
        goal.human_acceptances = [];
        if (action.objective !== undefined) goal.objective = action.objective;
        if (action.criteria !== undefined) goal.criteria = action.criteria;
        if (action.constraints !== undefined) goal.constraints = action.constraints;
        if (action.exclusions !== undefined) goal.exclusions = action.exclusions;
        if (action.assumptions !== undefined) goal.assumptions = action.assumptions;
        goal.sources = [];
        goal.origin = { kind: "literal" };
      }
      if (action.limits !== undefined)
        goal.limits = goalLimitsSchema.parse({ ...goal.limits, ...action.limits });
    } else if (action.kind === "clear") {
      requireInactive(goal, context);
      if (goal.status === "active")
        throw new GoalError("conflict", "Pause or cancel the goal before clearing it");
      delete goal.steward.last_steward_execution_id;
      archive(state, goal);
      delete state.current;
      delete state.creation_intent;
    } else if (action.kind === "pause" || action.kind === "cancel") {
      goal.status = action.kind === "pause" ? "paused" : "cancelled";
      if (action.kind === "cancel") delete goal.steward.last_steward_execution_id;
      goal.reason = action.kind === "pause" ? "Paused by the user" : "Cancelled by the user";
      if (action.kind === "cancel" || action.running)
        cancel_execution_id = goal.runs.find((run) => run.phase !== "closed")?.execution_id;
    } else if (action.kind === "resume" && context.resume_pending === true) {
      start = false;
    } else if (action.kind === "resume" && context.live_execution_id !== undefined) {
      const live = goal.runs.find(
        (run) => run.execution_id === context.live_execution_id && run.phase !== "closed",
      );
      if (live === undefined)
        throw new GoalError("conflict", "Live execution does not belong to this Goal");
      goal.status = "active";
      live.control_revision = nextRevision;
      delete goal.reason;
    } else if (action.kind === "resume") {
      requireInactive(goal, context);
      const candidate = { ...goal, status: "active" as const, no_progress_stages: 0 };
      const decision = goalAdmission(candidate, context.now, false);
      if (!decision.allowed)
        throw new GoalError(
          decision.status === "paused" ? "blocked" : decision.status,
          decision.reason,
        );
      /**
       * Reopening keeps the objective, its criteria, its consumption and its audit, and retires
       * what belonged to the attempt that ended.
       *
       * @remarks A completion candidate validated against the closed attempt cannot answer for the
       *   new one, and neither can the Steward's review of it, so both are dropped rather than
       *   carried forward as an answered question. Everything the operator authored — objective,
       *   criteria, constraints, sources, limits, human acceptances and the closed run's record —
       *   stays exactly as it was, and the consumption is never reset: reopening a goal does not
       *   refund the tokens it already spent.
       */
      delete goal.candidate;
      delete goal.steward.last_steward_execution_id;
      delete goal.steward.pending_execution_id;
      delete goal.steward.pending_question;
      delete goal.steward.trajectory_digest;
      goal.steward.status = "idle";
      goal.status = "active";
      goal.no_progress_stages = 0;
      /**
       * An explicit resume is where a gap in the consumption record is accepted.
       *
       * @remarks The acceptance is recorded per execution and the measurement itself is never
       *   rewritten: the operator accepts that those stages are not fully measured, which is a
       *   different fact from the tokens already charged for them. A stage that closes later with
       *   its own gap is a new execution and is unaccepted again.
       */
      goal.consumption.usage_accepted_runs = [
        ...new Set([...goal.consumption.usage_accepted_runs, ...unacceptedUsageRuns(goal)]),
      ];
      for (const run of goal.runs) {
        if (goal.consumption.usage_accepted_runs.includes(run.execution_id))
          run.accepted_usage_gaps = usageGapIdentity(run.usage);
      }
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
    ...(context.resume_pending === true && action.kind === "resume"
      ? {
          resume_pending: true,
          outcome: "needs_input" as const,
          resume_condition: context.resume_condition ?? ("physical" as const),
        }
      : {}),
    ...(action.kind === "resume" && context.live_execution_id !== undefined
      ? { execution_id: context.live_execution_id }
      : (start || context.resume_pending === true) && context.new_execution_id !== undefined
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

/** Apply a host-validated semantic proposal through the same create invariants as literal control. */
export function applyGoalFormulation(
  previous: GoalState | undefined,
  definition: GoalFormulationDefinition,
  context: GoalFormulationContext,
): GoalControlResult {
  const created = applyGoalControl(
    previous,
    {
      expected_revision: context.expected_revision,
      operation_id: context.operation_id,
      action: { kind: "create", objective: definition.objective, criteria: definition.criteria },
    },
    context,
  );
  if (created.replayed) return created;
  const current = created.state.current!;
  current.constraints = structuredClone(definition.constraints);
  current.exclusions = structuredClone(definition.exclusions);
  current.assumptions = structuredClone(definition.assumptions);
  current.sources = structuredClone(context.sources);
  current.origin = structuredClone(context.origin);
  const formulation = {
    formulation_execution_id: context.origin.formulation_execution_id,
    mode: context.origin.kind,
    outcome: "created" as const,
  };
  created.state.receipts[created.state.receipts.length - 1] = {
    ...created.state.receipts.at(-1)!,
    formulation,
  };
  const state = boundedGoalState(created.state);
  return { ...created, state, receipt: state.receipts.at(-1)! };
}

/** Persist a terminal analysis outcome without creating or partially mutating a Goal. */
export function recordGoalFormulationReceipt(
  previous: GoalState | undefined,
  input: GoalFormulationReceiptInput,
): GoalControlResult {
  const state = boundedGoalState(previous ?? emptyGoalState(), true);
  const known = state.receipts.find((receipt) => receipt.operation_id === input.operation_id);
  if (known !== undefined) {
    if (known.fingerprint !== input.fingerprint)
      throw new GoalError("conflict", "Operation ID was already used for a different goal control");
    return { state, receipt: known, replayed: true, start: false };
  }
  if (state.revision !== input.expected_revision)
    throw new GoalError("conflict", "Goal revision changed; reload before applying control");
  state.revision += 1;
  const receipt: GoalReceipt = {
    operation_id: input.operation_id,
    fingerprint: input.fingerprint,
    revision: state.revision,
    formulation: {
      ...(input.formulation_execution_id === undefined
        ? {}
        : { formulation_execution_id: input.formulation_execution_id }),
      mode: input.mode,
      outcome: input.outcome,
      ...(input.question === undefined ? {} : { question: input.question }),
      ...(input.message === undefined ? {} : { message: input.message }),
    },
  };
  state.receipts = [...state.receipts, receipt].slice(-GOAL_RECEIPTS_MAX);
  const bounded = boundedGoalState(state);
  return { state: bounded, receipt: bounded.receipts.at(-1)!, replayed: false, start: false };
}

/** Continue one recorded resume after physical recovery, retaining its reserved identity and fingerprint. */
export function retryGoalResume(
  previous: GoalState,
  operationId: string,
  context: GoalControlContext,
): GoalControlResult {
  const state = boundedGoalState(previous, true);
  const receipt = state.receipts.find((value) => value.operation_id === operationId);
  if (receipt === undefined || receipt.resume_pending !== true)
    throw new GoalError("conflict", "No pending resume exists for this operation");
  if (
    state.current?.goal_id !== receipt.goal_id ||
    state.current?.control_revision !== receipt.revision
  )
    return { state, receipt: { ...receipt, outcome: "superseded" }, replayed: true, start: false };
  state.receipts = state.receipts.filter((value) => value !== receipt);
  return applyGoalControl(
    state,
    { operation_id: operationId, expected_revision: state.revision, action: { kind: "resume" } },
    { ...context, new_execution_id: receipt.execution_id, fingerprint: receipt.fingerprint },
  );
}
