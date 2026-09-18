import { z } from "zod";
import {
  ProviderError,
  ModelCallInactivityError,
  type LLMCallParams,
  type LLMCallResult,
  type LLMProvider,
  type LLMUsage,
  type PersistedTraceProjector,
  type TracePort,
} from "@clarvis/capability";

export const GUARD_REVIEWER_MODEL_CALL = "guard_reviewer_model_call";

/** Operational failures remain distinguishable from an uncertain policy verdict. */
export type ReviewerFailureKind =
  | "timeout"
  | "auth"
  | "quota"
  | "rate_limit"
  | "transport"
  | "admission"
  | "cancelled"
  | "invalid_response"
  | "unknown";

const detailSchema = z
  .object({
    reviewer: z.literal("judge"),
    judge_execution_id: z.string().min(1).max(256).optional(),
    path: z.enum(["call_local", "effect_review"]),
    consumer: z.enum(["command_guard", "configure_clarvis"]),
    stage: z.enum(["compile", "decide"]),
    started_at: z.number().finite().nonnegative(),
    ended_at: z.number().finite().nonnegative(),
    model: z.string().min(1),
    provider: z.string().min(1),
    status: z.enum(["completed", "failed"]),
    attempts: z.number().int().positive(),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cached_tokens: z.number().int().nonnegative(),
    cache_write_tokens: z.number().int().nonnegative(),
    cache_read_ratio: z.number().finite().min(0).optional(),
    usage_unknown: z.literal(true).optional(),
    cache_unknown: z.literal(true).optional(),
    billing_source: z.literal("subscription").optional(),
    failure_kind: z
      .enum([
        "timeout",
        "auth",
        "quota",
        "rate_limit",
        "transport",
        "admission",
        "cancelled",
        "invalid_response",
        "unknown",
      ])
      .optional(),
    authority_revision: z.number().int().nonnegative().optional(),
    effect_id: z.string().min(1).max(256).optional(),
  })
  .strict();

export type GuardReviewerModelCallDetail = z.infer<typeof detailSchema>;
export type GuardReviewerModelCallEvent = Omit<
  GuardReviewerModelCallDetail,
  "started_at" | "ended_at"
> & {
  type: typeof GUARD_REVIEWER_MODEL_CALL;
  started_at: number;
  ended_at: number;
};

/** Validate and flatten the kernel-owned contributed trace event for persistence. */
export const guardReviewerModelCallProjector: PersistedTraceProjector = {
  kind: GUARD_REVIEWER_MODEL_CALL,
  project(entry, context) {
    const parsed = detailSchema.safeParse(entry.detail);
    if (!parsed.success) return null;
    return {
      type: GUARD_REVIEWER_MODEL_CALL,
      ...parsed.data,
      started_at: context.absoluteTime(parsed.data.started_at),
      ended_at: context.absoluteTime(parsed.data.ended_at),
    } satisfies GuardReviewerModelCallEvent;
  },
};

function addUsage(left: LLMUsage, right: LLMUsage): LLMUsage {
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    cached_tokens: left.cached_tokens + right.cached_tokens,
    cache_write_tokens: left.cache_write_tokens + right.cache_write_tokens,
    ...(left.usage_unknown === true || right.usage_unknown === true
      ? { usage_unknown: true as const }
      : {}),
    ...(left.cache_unknown === true || right.cache_unknown === true
      ? { cache_unknown: true as const }
      : {}),
  };
}

const unknownUsage = (): LLMUsage => ({
  input_tokens: 0,
  output_tokens: 0,
  cached_tokens: 0,
  cache_write_tokens: 0,
  usage_unknown: true,
  cache_unknown: true,
});

function usageFields(usage: LLMUsage, cacheUsageKnown = true) {
  const cacheKnown = cacheUsageKnown && usage.cache_unknown !== true;
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cached_tokens: usage.cached_tokens,
    cache_write_tokens: usage.cache_write_tokens,
    ...(usage.usage_unknown === true ? { usage_unknown: true as const } : {}),
    ...(!cacheKnown ? { cache_unknown: true as const } : {}),
    ...(cacheKnown && usage.input_tokens > 0
      ? { cache_read_ratio: usage.cached_tokens / usage.input_tokens }
      : {}),
  };
}

export interface ReviewerTraceIdentity {
  judge_execution_id?: string;
  path: "call_local" | "effect_review";
  consumer: "command_guard" | "configure_clarvis";
  stage: "compile" | "decide";
  authority_revision?: number;
  effect_id?: string;
}

/** Classify a reviewer failure without retaining provider error prose. */
export function reviewerFailureKind(error: unknown, signal?: AbortSignal): ReviewerFailureKind {
  if (signal?.aborted) return "cancelled";
  if (error instanceof ModelCallInactivityError) return "timeout";
  if (error instanceof ProviderError) {
    if (error.kind === "auth" || error.kind === "quota") return error.kind;
    if (error.status === 429) return "rate_limit";
    return error.kind === "transient" ? "transport" : "admission";
  }
  return "unknown";
}

/** Observe one logical provider call and record exactly one terminal, payload-free event. */
export async function callReviewerWithTrace(
  llm: LLMProvider,
  params: LLMCallParams,
  options: ReviewerTraceIdentity & {
    trace?: TracePort;
    failureKind(error: unknown): ReviewerFailureKind;
  },
): Promise<LLMCallResult> {
  const startedAt = options.trace?.now() ?? 0;
  let attempts = 1;
  const originalRetry = params.onRetry;
  const call = llm.call({
    ...params,
    onRetry(info) {
      attempts++;
      originalRetry?.(info);
    },
  });
  let removeAbort = (): void => {};
  try {
    const result =
      params.signal === undefined
        ? await call
        : await Promise.race([
            call,
            new Promise<never>((_resolve, reject) => {
              const rejectAbort = (): void => reject(new Error("reviewer call retired"));
              if (params.signal!.aborted) rejectAbort();
              else {
                params.signal!.addEventListener("abort", rejectAbort, { once: true });
                removeAbort = () => params.signal!.removeEventListener("abort", rejectAbort);
              }
            }),
          ]);
    if (params.signal?.aborted === true) throw new Error("reviewer call retired");
    removeAbort();
    const usage =
      result.retriedUsage === undefined
        ? result.usage
        : addUsage(result.usage, result.retriedUsage);
    options.trace?.record(GUARD_REVIEWER_MODEL_CALL, {
      reviewer: "judge",
      ...(options.judge_execution_id === undefined
        ? {}
        : { judge_execution_id: options.judge_execution_id }),
      path: options.path,
      consumer: options.consumer,
      stage: options.stage,
      started_at: startedAt,
      ended_at: options.trace.now(),
      model: params.model,
      provider: params.provider,
      status: "completed",
      attempts,
      ...usageFields(usage, result.cacheUsageKnown !== false),
      ...(result.billing_source !== undefined ? { billing_source: result.billing_source } : {}),
      ...(options.authority_revision !== undefined
        ? { authority_revision: options.authority_revision }
        : {}),
      ...(options.effect_id !== undefined ? { effect_id: options.effect_id } : {}),
    } satisfies GuardReviewerModelCallDetail);
    return result;
  } catch (error) {
    removeAbort();
    const usage =
      error instanceof ProviderError && error.accumulatedUsage !== undefined
        ? error.accumulatedUsage
        : unknownUsage();
    options.trace?.record(GUARD_REVIEWER_MODEL_CALL, {
      reviewer: "judge",
      ...(options.judge_execution_id === undefined
        ? {}
        : { judge_execution_id: options.judge_execution_id }),
      path: options.path,
      consumer: options.consumer,
      stage: options.stage,
      started_at: startedAt,
      ended_at: options.trace.now(),
      model: params.model,
      provider: params.provider,
      status: "failed",
      attempts,
      ...usageFields(usage),
      failure_kind: options.failureKind(error),
      ...(options.authority_revision !== undefined
        ? { authority_revision: options.authority_revision }
        : {}),
      ...(options.effect_id !== undefined ? { effect_id: options.effect_id } : {}),
    } satisfies GuardReviewerModelCallDetail);
    throw error;
  }
}
