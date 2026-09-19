import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  BUILTIN_ERROR_CODES,
  BUILTIN_RUN_ENDED_REASONS,
  PersistenceError,
} from "@clarvis/capability";
import type { BuiltinTraceEvent, TraceEvent } from "@clarvis/capability";

type EventOf<K extends BuiltinTraceEvent["type"]> = Extract<BuiltinTraceEvent, { type: K }>;
type Fields<K extends BuiltinTraceEvent["type"]> = Record<keyof EventOf<K>, z.ZodType>;
const number = z.number().finite().nonnegative();
const count = number.int();
const text = z.string().transform(() => "[private judge content]");
const discard = z
  .unknown()
  .optional()
  .transform(() => undefined);
const failure = z.enum([
  "transient",
  "context_overflow",
  "client",
  "auth",
  "quota",
  "content_policy",
]);
const actor = {
  agent: z.enum(["lead", "subagent"]),
  subagent_instance_id: z
    .string()
    .transform(() => "judge")
    .optional(),
};
const tokens = {
  model: z.string(),
  input_tokens: count,
  output_tokens: count,
  cached_tokens: count,
  cache_write_tokens: count,
  cache_read_ratio: number,
};

/**
 * Reconstruct only durable events reachable by the isolated reviewer. Every
 * schema is strict and its key table is pinned to the owning event type. Tool
 * call identities are keyed digests with one private per-store salt; provider
 * supplied strings cannot become persisted content or cross-store identifiers.
 */
export function createJudgeEventProjection(): (event: TraceEvent) => TraceEvent | null {
  const salt = randomBytes(32);
  const callId = z
    .string()
    .transform((id) => `judge_${createHmac("sha256", salt).update(id).digest("hex")}`);
  const schemas = {
    lead_iteration: z
      .object({
        type: z.literal("lead_iteration"),
        iteration: count,
        started_at: number,
        ended_at: number,
        ...tokens,
        response: text,
        response_phase: z.enum(["commentary", "final_answer"]).optional(),
      } satisfies Fields<"lead_iteration">)
      .strict(),
    subagent_iteration: z
      .object({
        type: z.literal("subagent_iteration"),
        subagent_instance_id: actor.subagent_instance_id.unwrap(),
        iteration: count,
        started_at: number,
        ended_at: number,
        ...tokens,
        response: text,
        response_phase: z.enum(["commentary", "final_answer"]).optional(),
      } satisfies Fields<"subagent_iteration">)
      .strict(),
    tool_call: z
      .object({
        type: z.literal("tool_call"),
        ...actor,
        call_id: callId.optional(),
        iteration_ref: count,
        started_at: number,
        ended_at: number,
        mcp_name: z.string().transform(() => "internal"),
        tool_name: z.string().transform(() => "judge_step"),
        arguments: z.unknown().transform(() => ({})),
        arguments_original: discard,
        result: text,
        result_digest: discard,
        tool_evidence: discard,
        error: text.nullable(),
        diff: discard,
        guard: discard,
        interruption: discard,
      } satisfies Fields<"tool_call">)
      .strict(),
    tool_call_started: z
      .object({
        type: z.literal("tool_call_started"),
        ...actor,
        call_id: callId,
        iteration_ref: count,
        started_at: number,
        mcp_name: z.string().transform(() => "internal"),
        tool_name: z.string().transform(() => "judge_step"),
        arguments: z.unknown().transform(() => ({})),
        control: discard,
      } satisfies Fields<"tool_call_started">)
      .strict(),
    tool_call_announced: z
      .object({
        type: z.literal("tool_call_announced"),
        ...actor,
        call_id: callId,
        occurred_at: number,
        tool_name: z.string().transform(() => "judge_step"),
        iteration: count,
        attempt: count,
      } satisfies Fields<"tool_call_announced">)
      .strict(),
    delegation_started: z
      .object({
        type: z.literal("delegation_started"),
        delegation_id: z.string().transform(() => "judge"),
        task_id: discard,
        occurred_at: number,
        model: z.string(),
      } satisfies Fields<"delegation_started">)
      .strict(),
    budget_check: z
      .object({
        type: z.literal("budget_check"),
        checked_at: number,
        tokens_used: count,
        tokens_remaining: count.optional(),
      } satisfies Fields<"budget_check">)
      .strict(),
    run_started: z
      .object({
        type: z.literal("run_started"),
        occurred_at: number,
        mode: z.enum(["subagent-only", "lead-subagent"]),
        lead_model: z.string().optional(),
        subagent_model: z.string().optional(),
        max_tokens: count.optional(),
      } satisfies Fields<"run_started">)
      .strict(),
    run_ended: z
      .object({
        type: z.literal("run_ended"),
        occurred_at: number,
        reason: z.enum(BUILTIN_RUN_ENDED_REASONS),
        code: z.enum([...BUILTIN_ERROR_CODES, "judge_invalid_response"]).optional(),
        disposition: z.enum(["final", "checkpoint"]).optional(),
      } satisfies Fields<"run_ended">)
      .strict(),
    model_call_error: z
      .object({
        type: z.literal("model_call_error"),
        ...actor,
        iteration: count,
        occurred_at: number,
        model: z.string(),
        kind: failure,
        message: text,
        status: count.optional(),
        retry_after_ms: number.optional(),
        usage_attributed: z.boolean().optional(),
      } satisfies Fields<"model_call_error">)
      .strict(),
    model_call_retry: z
      .object({
        type: z.literal("model_call_retry"),
        ...actor,
        iteration: count,
        occurred_at: number,
        model: z.string(),
        kind: failure,
        message: text,
        status: count.optional(),
        retry_after_ms: number.optional(),
        attempt: count,
        max_retries: count,
        delay_ms: number,
      } satisfies Fields<"model_call_retry">)
      .strict(),
    model_reasoning: z
      .object({
        type: z.literal("model_reasoning"),
        ...actor,
        iteration: count,
        occurred_at: number,
        model: z.string(),
        text,
      } satisfies Fields<"model_reasoning">)
      .strict(),
    cancellation: z
      .object({
        type: z.literal("cancellation"),
        ...actor,
        occurred_at: number,
        reason: text.optional(),
      } satisfies Fields<"cancellation">)
      .strict(),
    convergence_warning: z
      .object({
        type: z.literal("convergence_warning"),
        ...actor,
        occurred_at: number,
        code: z.enum(["tool_failure_loop", "stagnation_detected"]),
        message: text,
      } satisfies Fields<"convergence_warning">)
      .strict(),
    compaction_skipped: z
      .object({
        type: z.literal("compaction_skipped"),
        ...actor,
        occurred_at: number,
        reason: z.enum([
          "disabled",
          "nothing_to_compact",
          "summarization_disabled",
          "summarization_failed",
          "summary_not_effective",
        ]),
      } satisfies Fields<"compaction_skipped">)
      .strict(),
  } satisfies Record<string, z.ZodType<TraceEvent>>;
  const live = {
    lead_iteration_started: z
      .object({
        type: z.literal("lead_iteration_started"),
        iteration: count,
        started_at: number,
        model: z.string(),
      } satisfies Fields<"lead_iteration_started">)
      .strict(),
    subagent_iteration_started: z
      .object({
        type: z.literal("subagent_iteration_started"),
        subagent_instance_id: z.string(),
        iteration: count,
        started_at: number,
        model: z.string(),
      } satisfies Fields<"subagent_iteration_started">)
      .strict(),
    model_stream_delta: z
      .object({
        type: z.literal("model_stream_delta"),
        ...actor,
        iteration: count,
        occurred_at: number,
        model: z.string(),
        channel: z.enum(["text", "reasoning"]),
        text: z.string(),
        reset: z.boolean(),
      } satisfies Fields<"model_stream_delta">)
      .strict(),
    tool_output_delta: z
      .object({
        type: z.literal("tool_output_delta"),
        ...actor,
        call_id: z.string(),
        occurred_at: number,
        chunk: z.string(),
      } satisfies Fields<"tool_output_delta">)
      .strict(),
    tool_input_delta: z
      .object({
        type: z.literal("tool_input_delta"),
        ...actor,
        call_id: z.string(),
        occurred_at: number,
        tool_name: z.string(),
        chars: count,
        stream_chars: count.optional(),
        complete: z.literal(true).optional(),
      } satisfies Fields<"tool_input_delta">)
      .strict(),
  };
  return (event) => {
    if (Object.hasOwn(live, event.type)) {
      live[event.type as keyof typeof live].parse(event);
      return null;
    }
    if (!Object.hasOwn(schemas, event.type))
      throw new PersistenceError("Unclassified private trace event.");
    return schemas[event.type as keyof typeof schemas].parse(event);
  };
}
