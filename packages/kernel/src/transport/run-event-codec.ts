import type { RunEvent } from "@clarvis/protocol";
import { z } from "zod";

const finite = z.number().finite();
const nonnegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();
const text = z.string();
const runStatus = z.enum(["running", "completed", "failed", "cancelled"]);
const agent = z.enum(["lead", "subagent"]);
const attributed = {
  at: finite,
  agent,
  subagent_id: text.optional(),
};
const argumentsRecord = z.record(z.string(), z.unknown());
const commandGuardReview = z
  .object({
    mode: z.enum(["on", "auto"]),
    outcome: z.enum(["allowed", "denied"]),
    answerer: z.enum(["policy", "human", "judge", "session_allowlist", "unavailable"]),
  })
  .strict();

const planTask = z
  .object({
    id: text,
    title: text,
    status: z.enum(["pending", "in_progress", "returned", "done", "abandoned", "failed"]),
    detail: text.optional(),
    exit: text.optional(),
    assignee: text.optional(),
    result: text.optional(),
    error: text.optional(),
    reason: text.optional(),
  })
  .strict();
const planStatus = z.enum(["awaiting_approval", "active", "completed", "cancelled", "failed"]);
const planRetention = z.enum(["discard", "keep"]);
const planProjection = {
  id: text,
  path: text.optional(),
  title: text,
  status: planStatus,
  retention: planRetention,
  revision: finite,
  spec_revision: finite,
  tasks: z.array(planTask),
};

const memoryIngestDetail = z.discriminatedUnion("phase", [
  z.object({ execution_id: text, phase: z.literal("started") }).strict(),
  z
    .object({ execution_id: text, phase: z.literal("queued"), indexer_run_id: text.optional() })
    .strict(),
  z
    .object({
      execution_id: text,
      phase: z.literal("done"),
      written: finite.optional(),
      deleted: finite.optional(),
      reindexed: z.boolean().optional(),
      skipped: z.boolean().optional(),
      note: text.optional(),
      indexer_run_id: text.optional(),
    })
    .strict(),
  z
    .object({
      execution_id: text,
      phase: z.literal("failed"),
      error: text.optional(),
      indexer_run_id: text.optional(),
    })
    .strict(),
  z.object({ execution_id: text, phase: z.literal("blocked"), note: text.optional() }).strict(),
]);

/**
 * Closed runtime schema registry for every protocol-owned run event.
 *
 * @remarks The `satisfies` clause makes a new `RunEvent` discriminator fail
 * compilation until its complete wire payload is classified here. Every schema
 * is strict so a peer cannot smuggle stale fields through a known variant.
 */
const RUN_EVENT_SCHEMAS = {
  run_started: z
    .object({
      type: z.literal("run_started"),
      at: finite,
      lead_model: text.optional(),
      subagent_model: text.optional(),
    })
    .strict(),
  run_ended: z
    .object({
      type: z.literal("run_ended"),
      at: finite,
      status: runStatus,
      reason: text.optional(),
      code: text.optional(),
    })
    .strict(),
  iteration_started: z
    .object({
      type: z.literal("iteration_started"),
      ...attributed,
      iteration: finite,
      model: text.optional(),
    })
    .strict(),
  iteration_completed: z
    .object({
      type: z.literal("iteration_completed"),
      ...attributed,
      iteration: finite,
      model: text.optional(),
      response: text,
      response_phase: z.enum(["commentary", "final_answer"]).optional(),
      input_tokens: finite,
      output_tokens: finite,
      cached_tokens: finite.optional(),
    })
    .strict(),
  tool_call_started: z
    .object({
      type: z.literal("tool_call_started"),
      ...attributed,
      call_id: text,
      tool: text,
      server: text,
      arguments: argumentsRecord.optional(),
    })
    .strict(),
  tool_call: z
    .object({
      type: z.literal("tool_call"),
      ...attributed,
      call_id: text.optional(),
      tool: text,
      server: text,
      arguments: argumentsRecord.optional(),
      ok: z.boolean(),
      result: text.optional(),
      error: text.optional(),
      diff: text.optional(),
      guard: commandGuardReview.optional(),
    })
    .strict(),
  tool_output_delta: z
    .object({
      type: z.literal("tool_output_delta"),
      ...attributed,
      call_id: text,
      chunk: text,
    })
    .strict(),
  tool_input_delta: z
    .object({
      type: z.literal("tool_input_delta"),
      ...attributed,
      call_id: text,
      tool: text,
      chars: finite,
      stream_chars: finite.optional(),
      complete: z.literal(true).optional(),
    })
    .strict(),
  reasoning: z
    .object({ type: z.literal("reasoning"), ...attributed, iteration: finite, text })
    .strict(),
  text_delta: z
    .object({
      type: z.literal("text_delta"),
      ...attributed,
      iteration: finite,
      channel: z.enum(["text", "reasoning"]),
      text,
      reset: z.boolean(),
    })
    .strict(),
  model_error: z
    .object({
      type: z.literal("model_error"),
      ...attributed,
      iteration: finite,
      kind: text,
      message: text,
    })
    .strict(),
  model_retry: z
    .object({
      type: z.literal("model_retry"),
      ...attributed,
      iteration: finite,
      kind: text,
      attempt: finite,
      max_retries: finite,
      delay_ms: finite,
      status: finite.optional(),
      retry_after_ms: finite.optional(),
    })
    .strict(),
  delegation_created: z
    .object({
      type: z.literal("delegation_created"),
      at: finite,
      delegation_id: text,
      task_id: text.optional(),
      title: text,
      task: text,
      profile: text.optional(),
      tools: z.array(text).optional(),
    })
    .strict(),
  delegation_started: z
    .object({
      type: z.literal("delegation_started"),
      at: finite,
      delegation_id: text,
      task_id: text.optional(),
      model: text.optional(),
    })
    .strict(),
  delegation_completed: z
    .object({
      type: z.literal("delegation_completed"),
      at: finite,
      delegation_id: text,
      task_id: text.optional(),
      status: text,
      summary: text.optional(),
    })
    .strict(),
  delegation_failed: z
    .object({
      type: z.literal("delegation_failed"),
      at: finite,
      delegation_id: text,
      task_id: text.optional(),
      status: text,
      summary: text.optional(),
    })
    .strict(),
  workflow_run_started: z
    .object({
      type: z.literal("workflow_run_started"),
      at: finite,
      run_id: text,
      parent_run_id: text,
      profile: text.optional(),
      title: text,
      task: text,
      round_id: text.optional(),
      pass: finite.optional(),
      item_index: finite.optional(),
      replica: finite.optional(),
      replica_count: finite.optional(),
    })
    .strict(),
  workflow_title_updated: z
    .object({ type: z.literal("workflow_title_updated"), at: finite, run_id: text, title: text })
    .strict(),
  workflow_sequence_state: z
    .object({
      type: z.literal("workflow_sequence_state"),
      at: finite,
      run_id: text,
      session_id: text,
      status: z.enum([
        "running_round",
        "awaiting_manager",
        "completed",
        "stopped",
        "failed",
        "cancelled",
      ]),
      revision: nonnegativeInteger,
      round_id: text.optional(),
      pass: nonnegativeInteger.optional(),
      next_round_id: text.optional(),
      next_pass: nonnegativeInteger.optional(),
      leaders_started: nonnegativeInteger,
      max_total_leaders: positiveInteger,
      reason: text.optional(),
    })
    .strict()
    .refine((event) => event.leaders_started <= event.max_total_leaders),
  workflow_run_progress: z
    .object({
      type: z.literal("workflow_run_progress"),
      at: finite,
      run_id: text,
      parent_run_id: text,
      iterations: finite,
      input_tokens: finite,
      output_tokens: finite,
      cached_tokens: finite.optional(),
    })
    .strict(),
  workflow_run_completed: z
    .object({
      type: z.literal("workflow_run_completed"),
      at: finite,
      run_id: text,
      parent_run_id: text,
      status: runStatus,
    })
    .strict(),
  workflow_run_failed: z
    .object({
      type: z.literal("workflow_run_failed"),
      at: finite,
      run_id: text,
      parent_run_id: text,
      status: runStatus,
      error: z.object({ code: text, message: text }).strict().optional(),
    })
    .strict(),
  plan_created: z
    .object({ type: z.literal("plan_created"), at: finite, ...planProjection })
    .strict(),
  plan_updated: z
    .object({
      type: z.literal("plan_updated"),
      at: finite,
      change: z.enum(["content", "task", "status", "recovery"]),
      ...planProjection,
    })
    .strict(),
  plan_removed: z
    .object({
      type: z.literal("plan_removed"),
      at: finite,
      id: text,
      path: text.optional(),
      revision: finite,
      spec_revision: finite,
      title: text.optional(),
      status: planStatus.optional(),
      retention: planRetention.optional(),
      tasks: z.array(planTask).optional(),
    })
    .strict(),
  plan_review_requested: z
    .object({ type: z.literal("plan_review_requested"), at: finite, ...planProjection })
    .strict(),
  plan_review_resolved: z
    .object({
      type: z.literal("plan_review_resolved"),
      at: finite,
      outcome: z.enum(["approved", "changes_requested", "cancelled"]),
      ...planProjection,
    })
    .strict(),
  soft_limit_check: z
    .object({
      type: z.literal("soft_limit_check"),
      at: finite,
      dimension: z.enum(["tokens", "iterations"]),
      used: finite,
      limit: finite,
      outcome: text,
    })
    .strict(),
  compaction_started: z
    .object({
      type: z.literal("compaction_started"),
      ...attributed,
      mode: z.enum(["scheduled", "forced"]),
    })
    .strict(),
  compaction: z
    .object({
      type: z.literal("compaction"),
      ...attributed,
      operation: text,
      fallback_reason: z.enum(["summarization_failed", "summary_not_effective"]).optional(),
      freed_chars: finite.optional(),
      contribution_count: finite.optional(),
      requested: z.literal(true).optional(),
      user_contribution_count: finite.optional(),
    })
    .strict(),
  vision_analysis: z
    .object({
      type: z.literal("vision_analysis"),
      at: finite,
      model: text,
      image_count: finite,
      status: z.enum(["completed", "failed"]),
      result: text,
    })
    .strict(),
  compaction_skipped: z
    .object({
      type: z.literal("compaction_skipped"),
      ...attributed,
      reason: z.enum([
        "disabled",
        "nothing_to_compact",
        "summarization_disabled",
        "summarization_failed",
        "summary_not_effective",
      ]),
    })
    .strict(),
  elicitation_requested: z
    .object({
      type: z.literal("elicitation_requested"),
      at: finite,
      agent: agent.optional(),
      subagent_id: text.optional(),
      question: text,
      options: z.array(text).optional(),
    })
    .strict(),
  elicitation_resolved: z
    .object({
      type: z.literal("elicitation_resolved"),
      at: finite,
      agent: agent.optional(),
      subagent_id: text.optional(),
      question: text,
      outcome: z.enum(["accept", "decline", "cancel"]),
      answer: text.optional(),
      options: z.array(text).optional(),
    })
    .strict(),
  steering_applied: z
    .object({ type: z.literal("steering_applied"), ...attributed, message: text })
    .strict(),
  memory_ingest: z
    .object({ type: z.literal("memory_ingest"), at: finite, detail: memoryIngestDetail })
    .strict(),
  capability_event: z
    .object({
      type: z.literal("capability_event"),
      at: finite,
      capability: text,
      kind: text,
      projection: text,
      detail: z.unknown().optional(),
      truncated: z.boolean(),
    })
    .strict(),
  events_dropped: z
    .object({ type: z.literal("events_dropped"), at: finite, dropped: finite })
    .strict(),
  mcp_degraded: z
    .object({
      type: z.literal("mcp_degraded"),
      at: finite,
      servers: z.array(z.object({ name: text, reason: text }).strict()),
    })
    .strict(),
} satisfies Record<RunEvent["type"], z.ZodType>;

/** Decode one untrusted run event against its complete discriminator-specific schema. */
export function decodeRunEvent(value: unknown): RunEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("type" in value)) {
    return null;
  }
  const type = value.type;
  if (typeof type !== "string") return null;
  if (!Object.hasOwn(RUN_EVENT_SCHEMAS, type)) return null;
  const schema = RUN_EVENT_SCHEMAS[type as keyof typeof RUN_EVENT_SCHEMAS];
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Pick the {@link RunEvent} member whose discriminator admits `K`.
 *
 * @remarks
 * Not `Extract<RunEvent, { type: K }>`. One member declares a *union* discriminator —
 * `delegation_completed | delegation_failed` (`RunEvent` in `packages/protocol/src/runs.ts`) — and a union is
 * not assignable to one of its own literals, so `Extract` answers `never` for it and `keyof never`
 * widens to `string | number | symbol`, reporting drift on a variant that has none. Asking whether
 * `K` is one of the member's own types is the question that survives a shared member, and it stays
 * correct if a second shared member is ever added.
 */
type RunEventVariant<K extends RunEvent["type"]> = RunEvent extends infer E
  ? E extends RunEvent
    ? K extends E["type"]
      ? E
      : never
    : never
  : never;

/**
 * Every field name a variant declares but its codec schema omits, or the reverse.
 *
 * @remarks
 * The `satisfies Record<RunEvent["type"], z.ZodType>` below constrains the key set only, never a
 * payload's shape, so `tsc` could not see that `run_ended`'s schema was `.strict()` over four keys
 * while the protocol declared a fifth. A strict object rejects the extra key, `decodeRunEvent`
 * answers `null`, and `connectKernelClient` reads that as a protocol violation and settles every
 * live run `unavailable`. One field nobody had round-tripped could therefore end a client session.
 * Resolving to `never` is the whole guard: a drifted field makes this type a description of itself
 * and {@link AssertNoDrift} fails, naming the variant and the field.
 */
type CodecFieldDrift = {
  [K in RunEvent["type"]]:
    | Exclude<keyof RunEventVariant<K>, keyof z.infer<(typeof RUN_EVENT_SCHEMAS)[K]>>
    | Exclude<keyof z.infer<(typeof RUN_EVENT_SCHEMAS)[K]>, keyof RunEventVariant<K>> extends never
    ? never
    : {
        variant: K;
        drifted_field:
          | Exclude<keyof RunEventVariant<K>, keyof z.infer<(typeof RUN_EVENT_SCHEMAS)[K]>>
          | Exclude<keyof z.infer<(typeof RUN_EVENT_SCHEMAS)[K]>, keyof RunEventVariant<K>>;
      };
}[RunEvent["type"]];

/** Fails to compile when {@link CodecFieldDrift} finds a field on one side and not the other. */
type AssertNoDrift<T extends never> = T;
type _RunEventCodecHasNoFieldDrift = AssertNoDrift<CodecFieldDrift>;
