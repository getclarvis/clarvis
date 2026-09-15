import { z } from "zod";
import type { LLMCallParams, LLMCallResult } from "@clarvis/capability";
import { assertInlineModelMedia } from "../runtime/model-media.ts";

/** Private model-channel limits; independent of the retired execution protocol. */
export const MODEL_INPUT_BYTES = 32 * 1024 * 1024;
export const MODEL_QUEUE_BYTES = 8 * 1024 * 1024;
export const MODEL_QUEUE_EVENTS = 1_024;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = count.positive();
const text = z.string();
const id = text.min(1).max(256);
const toolNamespace = text.max(256);
const json = z.unknown().refine((value) => value !== undefined);
const record = z.record(text, json);
const providerOptions = z.record(text, record).optional();
const reasoningPart = z.object({ text, providerOptions }).strict();
const textPart = z
  .object({ text, phase: z.enum(["commentary", "final_answer"]).optional(), providerOptions })
  .strict();
const toolCall = z.object({ id, name: id, arguments: json, providerOptions }).strict();
const content = z.union([
  text,
  z.array(
    z.union([
      z.object({ type: z.literal("text"), text }).strict(),
      z.object({ type: z.literal("image"), image: text, mediaType: text.optional() }).strict(),
    ]),
  ),
]);
const message = z.union([
  z.object({ role: z.enum(["system", "user", "assistant"]), content }).strict(),
  z
    .object({
      role: z.literal("assistant"),
      content,
      reasoning: z.array(reasoningPart),
      text_parts: z.array(textPart).optional(),
    })
    .strict(),
  z.object({ role: z.literal("assistant"), content: text, text_parts: z.array(textPart) }).strict(),
  z
    .object({
      role: z.literal("assistant"),
      content: text,
      tool_calls: z.array(toolCall),
      reasoning: z.array(reasoningPart).optional(),
      text_parts: z.array(textPart).optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal("tool"),
      tool_call_id: id,
      content: text,
      images: z.array(z.object({ data: text, mediaType: text }).strict()).optional(),
    })
    .strict(),
]);
const tool = z
  .object({
    fullName: id,
    wireName: id,
    mcpName: toolNamespace,
    toolName: id,
    description: text.optional(),
    inputSchema: record,
    kind: z.enum(["resource_list", "resource_read"]).optional(),
  })
  .strict();
/** Closed native input, deliberately excluding provider construction and authority. */
const containerModelInputSchema = z
  .object({
    messages: z.array(message),
    tools: z.array(tool),
    toolChoice: z
      .union([
        z.enum(["auto", "required"]),
        z
          .object({ type: z.literal("function"), function: z.object({ name: id }).strict() })
          .strict(),
      ])
      .optional(),
    timeoutMs: positive.optional(),
    maxOutputTokens: positive.optional(),
    reasoningSummary: z.enum(["off", "auto", "detailed"]).optional(),
    reasoningEffort: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
    promptCacheKey: text.optional(),
    promptCacheTtl: z.enum(["5m", "1h"]).optional(),
    cacheBreakpoints: z.array(count).optional(),
    maxRetries: count.optional(),
    maxRetryAfterMs: count.optional(),
  })
  .strict();
/** Attribution is guest data, not authorization to a native run. */
export const containerModelCallSchema = z
  .object({
    leaseId: text.regex(/^[a-f0-9]{64}$/u),
    generation: z.uuid(),
    callId: z.uuid(),
    runId: id,
    sessionId: id.optional(),
    agentInstanceId: id.optional(),
    purpose: z.enum(["generation", "memory", "compaction", "goal"]),
    provider: id,
    model: id,
    input: containerModelInputSchema,
  })
  .strict();
export type ContainerModelCall = z.infer<typeof containerModelCallSchema>;
const usage = z
  .object({
    input_tokens: count,
    output_tokens: count,
    cached_tokens: count,
    cache_write_tokens: count,
    usage_unknown: z.literal(true).optional(),
    cache_unknown: z.literal(true).optional(),
  })
  .strict();
/** All native terminal fields survive the boundary without diagnostic redaction. */
export const containerModelResultSchema = z
  .object({
    text: text.optional(),
    toolCalls: z
      .array(
        toolCall.extend({ malformedArguments: text.optional(), rewrittenFrom: json.optional() }),
      )
      .optional(),
    usage,
    retriedUsage: usage.optional(),
    cacheUsageKnown: z.boolean().optional(),
    requestPrefix: z
      .object({
        previousItems: count,
        currentItems: count,
        divergence: z
          .object({ surface: z.enum(["instructions", "tools", "history"]), item: count.optional() })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    reasoning: text.optional(),
    billing_source: z.literal("subscription").optional(),
    reasoningParts: z.array(reasoningPart).optional(),
    textParts: z.array(textPart).optional(),
    finishReason: text.optional(),
  })
  .strict();
const event = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("stream"),
      delta: z
        .object({ channel: z.enum(["text", "reasoning"]), text, reset: z.boolean() })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("tool_input"),
      delta: z
        .object({
          call_id: id,
          tool_name: id,
          chars: count,
          stream_chars: count.optional(),
          complete: z.literal(true).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("retry"),
      info: z
        .object({
          attempt: positive,
          maxRetries: count,
          delayMs: count,
          kind: z.enum([
            "transient",
            "context_overflow",
            "client",
            "auth",
            "quota",
            "content_policy",
          ]),
          message: text,
          status: count.optional(),
          retryAfterMs: count.optional(),
        })
        .strict(),
    })
    .strict(),
]);
export type ContainerModelEvent = z.infer<typeof event>;
export const containerModelDeltaSchema = z
  .object({ callId: z.uuid(), sequence: positive, event })
  .strict();
export const containerModelTerminalSchema = z
  .object({ callId: z.uuid(), lastSequence: count, result: containerModelResultSchema })
  .strict();

/** Reject rather than truncate arbitrary JSON, including dangerous property names and accessors. */
export function assertModelJson(value: unknown, maxBytes: number): number {
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 262_144 || depth > 64) throw modelBrokerError("resource_exhausted");
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object" || item === null) throw modelBrokerError("invalid_request");
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw modelBrokerError("invalid_request");
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === "length") continue;
      if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key))
        throw modelBrokerError("invalid_request");
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!("value" in descriptor)) throw modelBrokerError("invalid_request");
      if (descriptor.value === undefined && !Array.isArray(item)) continue;
      visit(descriptor.value, depth + 1);
    }
  };
  visit(value, 0);
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > maxBytes) throw modelBrokerError("resource_exhausted");
  return bytes;
}
/** Safe fixed diagnostics, never reflecting model content. */
export function modelBrokerError(
  code:
    | "invalid_request"
    | "resource_exhausted"
    | "unauthorized"
    | "conflict"
    | "cancelled"
    | "unavailable",
  unknown = false,
): Error & { code: string; details: { outcome_unknown: boolean } } {
  return Object.assign(new Error(`Container model broker: ${code}`), {
    code,
    details: { outcome_unknown: unknown },
  });
}
/** Validate before any catalog executor, credentials, SDK or downloader is consulted. */
export function decodeContainerModelCall(value: unknown): ContainerModelCall {
  assertModelJson(value, MODEL_INPUT_BYTES);
  const parsed = containerModelCallSchema.safeParse(value);
  if (!parsed.success) throw modelBrokerError("invalid_request");
  assertInlineModelMedia(parsed.data.input.messages);
  return parsed.data;
}
/** Field-by-field projection shared by client and host; no guest construction settings. */
export function modelCallInput(params: LLMCallParams): ContainerModelCall["input"] {
  return containerModelInputSchema.parse({
    messages: params.messages,
    tools: params.tools,
    toolChoice: params.toolChoice,
    timeoutMs: params.timeoutMs,
    maxOutputTokens: params.maxOutputTokens,
    reasoningSummary: params.reasoningSummary,
    reasoningEffort: params.reasoningEffort,
    promptCacheKey: params.promptCacheKey,
    promptCacheTtl: params.promptCacheTtl,
    cacheBreakpoints: params.cacheBreakpoints,
    maxRetries: params.maxRetries,
    maxRetryAfterMs: params.maxRetryAfterMs,
  });
}
/** Compile-time compatibility with the native provider result. */
export function nativeModelResult(
  value: z.infer<typeof containerModelResultSchema>,
): LLMCallResult {
  return value;
}
