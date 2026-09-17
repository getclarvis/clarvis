import { z } from "zod";
import { BUILTIN_ERROR_CODES, PersistenceError } from "@clarvis/capability";
import type {
  CheckpointMetadata,
  ErrorBody,
  PerAgentUsage,
  RunResponse,
  Usage,
} from "@clarvis/capability";

type Keys<T> = T extends unknown ? keyof T : never;
const count = z.number().int().nonnegative();
const elapsed = z.number().finite().nonnegative();
const discard = z
  .unknown()
  .optional()
  .transform(() => undefined);
const counters = {
  model: z.string(),
  input_tokens: count,
  output_tokens: count,
  cached_tokens: count,
  cache_write_tokens: count,
};
const agentUsage = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("lead"),
      ...counters,
      iterations: count,
      subagents_spawned: count,
    } satisfies Record<keyof Extract<PerAgentUsage, { type: "lead" }>, z.ZodType>)
    .strict(),
  z
    .object({
      type: z.literal("subagent"),
      ...counters,
      iterations: count.optional(),
      instances: count.optional(),
    } satisfies Record<keyof Extract<PerAgentUsage, { type: "subagent" }>, z.ZodType>)
    .strict(),
  z
    .object({ type: z.literal("vision"), ...counters } satisfies Record<
      keyof Extract<PerAgentUsage, { type: "vision" }>,
      z.ZodType
    >)
    .strict(),
]);
const usage = z
  .object({
    iterations_used: count,
    elapsed_ms: elapsed,
    by_agent: z.array(agentUsage),
    warnings: discard,
  } satisfies Record<keyof Usage, z.ZodType>)
  .strict();
const details = z.record(z.string(), z.unknown()).transform((value): Record<string, unknown> => {
  const safe: Record<string, unknown> = {};
  for (const key of ["status", "retry_after_ms", "timeout_ms", "attempts"] as const) {
    if (typeof value[key] === "number" && Number.isFinite(value[key])) safe[key] = value[key];
  }
  if (
    typeof value.kind === "string" &&
    ["transient", "context_overflow", "client", "auth", "quota", "content_policy"].includes(
      value.kind,
    )
  )
    safe.kind = value.kind;
  return safe;
});
const error = z
  .object({
    code: z.enum([...BUILTIN_ERROR_CODES, "judge_invalid_response"]),
    message: z.string().transform(() => "Private reviewer execution failed."),
    details: details.optional(),
  } satisfies Record<keyof ErrorBody, z.ZodType>)
  .strict();
const checkpoint = z
  .object({ summary: z.string(), next_step: z.string() } satisfies Record<
    keyof CheckpointMetadata,
    z.ZodType
  >)
  .strict()
  .transform(() => ({
    summary: "Private reviewer checkpoint.",
    next_step: "Private reviewer continuation.",
  }));
const response = z
  .object({
    status: z.enum([
      "completed",
      "budget_exhausted",
      "cancelled",
      "soft_limit_declined",
      "interrupted",
      "error",
    ]),
    usage,
    result: discard,
    error: error.optional(),
    disposition: z.enum(["final", "checkpoint"]).optional(),
    checkpoint: checkpoint.optional(),
  } satisfies Record<Keys<RunResponse>, z.ZodType>)
  .strict();

/** Preserve operational outcome and accounting while replacing every model/provider payload. */
export function projectJudgeResponse(value: RunResponse): RunResponse {
  const parsed = response.parse(value);
  if ((parsed.disposition === "checkpoint") !== (parsed.checkpoint !== undefined))
    throw new PersistenceError("Invalid private response disposition.");
  const finalization =
    parsed.disposition === "checkpoint"
      ? { disposition: "checkpoint" as const, checkpoint: parsed.checkpoint! }
      : parsed.disposition === "final"
        ? { disposition: "final" as const }
        : {};
  if (parsed.status === "error") {
    if (parsed.error === undefined) throw new PersistenceError("Invalid private error response.");
    return { status: "error", usage: parsed.usage, error: parsed.error, ...finalization };
  }
  if (parsed.error !== undefined) throw new PersistenceError("Invalid private result response.");
  return {
    status: parsed.status,
    result: "[private judge result]",
    usage: parsed.usage,
    ...finalization,
  };
}
