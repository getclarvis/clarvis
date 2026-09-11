import { z } from "zod";

/** Bounds leave room in the private session for turn settlement and recovery. */
export const GOAL_STATE_MAX_BYTES = 1024 * 1024;
export const GOAL_CONTROL_MAX_BYTES = GOAL_STATE_MAX_BYTES - 64 * 1024;
export const GOAL_ARCHIVE_MAX = 8;
export const GOAL_RUNS_MAX = 256;
export const GOAL_RECEIPTS_MAX = 64;

const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9._:-]+$/u);
const counter = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
const text = z.string().trim().min(1).max(4096);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);

export const goalStatusSchema = z.enum([
  "active",
  "paused",
  "blocked",
  "budget_limited",
  "usage_limited",
  "complete",
  "cancelled",
]);

export const goalLimitsSchema = z
  .object({
    max_net_tokens: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER - 1),
    max_auto_continuations: counter.max(255).default(8),
    max_no_progress_checkpoints: z.number().int().min(1).max(32).default(3),
    deadline_at: counter.optional(),
  })
  .strict();

export const goalCriterionSchema = z
  .object({
    id,
    description: text,
    kind: z.enum(["host", "qualitative", "human"]),
    verification: z
      .discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("tool_success"),
            tool_name: z.string().min(1).max(256),
            arguments_digest: digest.optional(),
          })
          .strict(),
        z
          .object({ kind: z.literal("artifact_digest"), path: z.string().min(1).max(4096), digest })
          .strict(),
      ])
      .optional(),
  })
  .strict()
  .refine((value) => (value.kind === "host") === (value.verification !== undefined), {
    message: "host criteria require an explicit verification; other criteria cannot carry one",
  });

/** A reference names host-observed evidence; it never asserts its own truth. */
export const goalEvidenceRefSchema = z
  .object({
    id,
    execution_id: id,
    goal_id: id,
    objective_revision: counter,
    kind: z.enum(["tool_result", "artifact", "human_acceptance"]),
    digest: digest.optional(),
  })
  .strict();

export const goalAssessmentSchema = z
  .object({
    criterion_id: id,
    kind: z.enum(["host", "qualitative", "human"]),
    justification: text,
    evidence: z.array(goalEvidenceRefSchema).max(8).default([]),
  })
  .strict();

export const goalCandidateSchema = z
  .object({
    objective_revision: counter,
    execution_id: id,
    summary: text,
    assessments: z.array(goalAssessmentSchema).min(1).max(32),
  })
  .strict();

export const goalCheckpointSchema = z
  .object({
    summary: text,
    next_step: text,
    evidence: z.array(goalEvidenceRefSchema).max(8).default([]),
    activity_fingerprint: digest.optional(),
    progress_accepted: z.boolean(),
    reason: text,
  })
  .strict();

/** Latest progress annotation; it neither ends a stage nor proves useful activity. */
export const goalProgressSchema = goalCheckpointSchema.pick({ summary: true, evidence: true });

export const goalUsageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unknown") }).strict(),
  z
    .object({
      kind: z.literal("measured"),
      input: counter,
      output: counter,
      cached: counter.optional(),
    })
    .strict()
    .refine((value) => value.cached === undefined || value.cached <= value.input, {
      message: "cached tokens cannot exceed input tokens",
    }),
]);

export const goalRunSchema = z
  .object({
    execution_id: id,
    admission_id: id,
    control_revision: counter,
    objective_revision: counter,
    automatic: z.boolean(),
    phase: z.enum(["preparing", "running", "settling", "unknown", "closed"]),
    admitted_at: counter,
    ended_at: counter.optional(),
    disposition: z.enum(["final", "checkpoint"]).optional(),
    outcome: z.enum(["completed", "failed", "cancelled"]).optional(),
    usage: goalUsageSchema.optional(),
    usage_estimate: z.object({ sequence: counter, usage: goalUsageSchema }).strict().optional(),
    checkpoint: goalCheckpointSchema.optional(),
    progress: goalProgressSchema.optional(),
    candidate: goalCandidateSchema.optional(),
  })
  .strict();

export const goalRecordSchema = z
  .object({
    goal_id: id,
    session_id: id,
    revision: counter,
    control_revision: counter,
    objective_revision: counter,
    objective: z.string().trim().min(1).max(16384),
    criteria: z.array(goalCriterionSchema).max(32),
    status: goalStatusSchema,
    reason: text.optional(),
    created_at: counter,
    updated_at: counter,
    limits: goalLimitsSchema,
    consumption: z
      .object({
        input: counter,
        output: counter,
        cached: counter.optional(),
        net_tokens: counter,
        usage_unknown: z.boolean(),
        cache_estimated: z.boolean(),
        overrun_tokens: counter,
      })
      .strict(),
    auto_continuations: counter,
    no_progress_checkpoints: counter,
    runs: z.array(goalRunSchema).max(GOAL_RUNS_MAX),
    candidate: goalCandidateSchema.optional(),
    human_acceptances: z
      .array(
        z
          .object({
            criterion_id: id,
            objective_revision: counter,
            operation_id: id,
            accepted_at: counter,
          })
          .strict(),
      )
      .max(32),
    plan_ref: z
      .object({ id, revision: counter, provider_key: z.string().max(512) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((goal, ctx) => {
    if (new Set(goal.criteria.map((criterion) => criterion.id)).size !== goal.criteria.length)
      ctx.addIssue({ code: "custom", message: "criterion ids must be unique", path: ["criteria"] });
    if (new Set(goal.runs.map((run) => run.execution_id)).size !== goal.runs.length)
      ctx.addIssue({ code: "custom", message: "execution ids must be unique", path: ["runs"] });
    if (goal.runs.filter((run) => run.phase !== "closed").length > 1)
      ctx.addIssue({
        code: "custom",
        message: "a goal can bind only one physical run",
        path: ["runs"],
      });
  });

export const goalReceiptSchema = z
  .object({
    operation_id: id,
    fingerprint: digest,
    revision: counter,
    execution_id: id.optional(),
    goal_id: id.optional(),
    status: goalStatusSchema.optional(),
  })
  .strict();

export const goalStateSchema = z
  .object({
    version: z.literal(1),
    revision: counter,
    current: goalRecordSchema.optional(),
    archive: z.array(goalRecordSchema).max(GOAL_ARCHIVE_MAX),
    receipts: z.array(goalReceiptSchema).max(GOAL_RECEIPTS_MAX),
  })
  .strict()
  .superRefine((state, ctx) => {
    const goals = [...state.archive, ...(state.current === undefined ? [] : [state.current])];
    if (new Set(goals.map((goal) => goal.goal_id)).size !== goals.length)
      ctx.addIssue({ code: "custom", message: "goal ids must be unique across the session audit" });
    const executions = goals.flatMap((goal) => goal.runs.map((run) => run.execution_id));
    if (new Set(executions).size !== executions.length)
      ctx.addIssue({
        code: "custom",
        message: "a session execution cannot belong to multiple goals",
      });
    if (
      new Set(state.receipts.map((receipt) => receipt.operation_id)).size !== state.receipts.length
    )
      ctx.addIssue({ code: "custom", message: "operation receipts must be unique" });
    if (
      goals.some(
        (goal) => goal.revision > state.revision || goal.control_revision > goal.revision,
      ) ||
      state.receipts.some((receipt) => receipt.revision > state.revision)
    )
      ctx.addIssue({ code: "custom", message: "audit revisions cannot exceed their owning state" });
  });

export type GoalStatus = z.infer<typeof goalStatusSchema>;
export type GoalLimits = z.infer<typeof goalLimitsSchema>;
export type GoalCriterion = z.infer<typeof goalCriterionSchema>;
export type GoalEvidenceRef = z.infer<typeof goalEvidenceRefSchema>;
export type GoalAssessment = z.infer<typeof goalAssessmentSchema>;
export type GoalCandidate = z.infer<typeof goalCandidateSchema>;
export type GoalCheckpoint = z.infer<typeof goalCheckpointSchema>;
export type GoalProgress = z.infer<typeof goalProgressSchema>;
export type GoalUsage = z.infer<typeof goalUsageSchema>;
export type GoalRun = z.infer<typeof goalRunSchema>;
export type GoalRecord = z.infer<typeof goalRecordSchema>;
export type GoalReceipt = z.infer<typeof goalReceiptSchema>;
export type GoalState = z.infer<typeof goalStateSchema>;
