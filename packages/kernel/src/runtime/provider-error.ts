import { z } from "zod";
import { ProviderError, sanitizeErrorMessage } from "@clarvis/capability";

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const usageSchema = z
  .object({
    input_tokens: counter,
    output_tokens: counter,
    cached_tokens: counter,
    cache_write_tokens: counter,
    usage_unknown: z.literal(true).optional(),
    cache_unknown: z.literal(true).optional(),
  })
  .strict();

/** Closed, bounded provider failure data; no cause, stack, response body or headers cross RPC. */
export const runtimeProviderErrorSchema = z
  .object({
    kind: z.enum(["transient", "context_overflow", "client", "auth", "quota", "content_policy"]),
    status: z.number().int().min(100).max(599).optional(),
    retryAfterMs: counter.optional(),
    streamStarted: z.boolean(),
    partialUsage: usageSchema.optional(),
    accumulatedUsage: usageSchema.optional(),
  })
  .strict();

/** Preserve recovery and accounting fields while normalizing host diagnostics for the wire. */
export function encodeRuntimeProviderError(error: ProviderError) {
  return {
    code: error.code,
    message: sanitizeErrorMessage(error.message).slice(0, 16_384),
    provider: runtimeProviderErrorSchema.parse({
      kind: error.kind,
      status: error.status,
      retryAfterMs: error.retryAfterMs,
      streamStarted: error.streamStarted,
      partialUsage: error.partialUsage,
      accumulatedUsage: error.accumulatedUsage,
    }),
  };
}

/** Restore the engine's typed error so overflow, forced-choice and failed-attempt handling apply. */
export function decodeRuntimeProviderError(
  message: string,
  provider: z.infer<typeof runtimeProviderErrorSchema>,
): ProviderError {
  const error = new ProviderError(message, provider);
  if (provider.accumulatedUsage !== undefined) error.accumulatedUsage = provider.accumulatedUsage;
  return error;
}
