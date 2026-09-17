import { z } from "zod";
import type { ExecutionRecord, RunRequest, RunResponse, Trace } from "@clarvis/capability";
import { createTraceVisibilityView, projectTraceStoreWrites } from "@clarvis/trace";
import type { JournalHeader, TraceStore, TraceWriteProjection } from "@clarvis/trace";
import { createJudgeEventProjection } from "./judge-event-projection.ts";
import { projectJudgeRequest } from "./judge-request-projection.ts";
import { projectJudgeResponse } from "./judge-response-projection.ts";

const number = z.number().finite().nonnegative();
const count = number.int();
const discard = z
  .unknown()
  .optional()
  .transform(() => undefined);
const request = z.custom<RunRequest>().transform(projectJudgeRequest);
const response = z.custom<RunResponse>().transform(projectJudgeResponse);

/** Construct the host-owned closed reconstruction policy once per physical store composition. */
export function createJudgeTraceProjection(): TraceWriteProjection {
  const event = createJudgeEventProjection();
  const trace = z
    .object({
      events: z
        .array(z.custom<Trace["events"][number]>().transform(event))
        .transform((events) => events.filter((entry) => entry !== null)),
    } satisfies Record<keyof Trace, z.ZodType>)
    .strict();
  const header = z
    .object({
      visibility: z.literal("internal"),
      id: z.string().min(1),
      owner_key_name: z.string().min(1),
      started_at: number,
      request,
      host_metadata: discard,
      writer: discard,
    } satisfies Record<keyof Omit<JournalHeader, "v">, z.ZodType>)
    .strict();
  const record = z
    .object({
      visibility: z.literal("internal"),
      id: z.string().min(1),
      owner_key_name: z.string().min(1),
      status: z.enum([
        "completed",
        "budget_exhausted",
        "error",
        "cancelled",
        "soft_limit_declined",
        "interrupted",
      ]),
      started_at: number,
      ended_at: number,
      elapsed_ms: number,
      request,
      response,
      trace,
      total_input_tokens: count,
      total_output_tokens: count,
      total_cached_tokens: count,
      total_cache_write_tokens: count,
      final_context: discard,
      capability_state: discard,
      host_metadata: discard,
      operator_authority_state: discard,
      recovery: z
        .object({ skipped_lines: count, synthesized_tool_calls: count })
        .strict()
        .optional(),
    } satisfies Record<keyof ExecutionRecord, z.ZodType>)
    .strict();
  return {
    header: (value) => header.parse(value),
    event,
    record: (value) => record.parse(value),
    context: () => [],
  };
}

/** Private writes never receive the physical store; all payload-bearing paths are projected. */
export function createJudgeTraceStore(physical: TraceStore): TraceStore {
  return projectTraceStoreWrites(
    createTraceVisibilityView(physical, "internal"),
    createJudgeTraceProjection(),
  );
}
