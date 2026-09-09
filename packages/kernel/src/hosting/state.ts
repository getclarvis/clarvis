import { z } from "zod";
import type { HostedRunRef } from "@clarvis/protocol";
import { runtimeStatusSchema } from "../runtime/status-schema.ts";
import { kernelError } from "../core/errors.ts";
import type { HostedRegistryState } from "./registry.ts";

/** One bound for reading and committing the private discovery index. */
export const MAX_HOST_INDEX_BYTES = 2 * 1024 * 1024;

const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\s\p{Cc}]+$/u);
const natural = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
const text = z.string().max(MAX_HOST_INDEX_BYTES);
const runtime = runtimeStatusSchema({ identifier, text });
const run: z.ZodType<HostedRunRef> = z.strictObject({
  execution_id: identifier,
  session_id: identifier,
  workspace_id: identifier,
  host_generation: identifier,
  title: z.string().max(256),
  config: z.strictObject({
    agent: text,
    model: text.optional(),
    environment: text.optional(),
    extension_profile: z.strictObject({ id: text, fingerprint: text }).optional(),
    runtime: runtime.optional(),
  }),
  created_at: natural,
  updated_at: natural,
  revision: natural,
  control_epoch: natural,
  control: z.enum(["available", "self", "other"]),
  disconnect_policy: z.enum(["cancel", "continue"]),
  execution_state: z.enum(["starting", "running", "finishing", "closed", "unknown"]),
  attention: z.enum(["none", "waiting_user"]),
  recovery_error: text.optional(),
  recovery_resolution: z
    .strictObject({
      kind: z.literal("operator_verified_physical_closure"),
      previous_host_generation: identifier,
      resolving_host_generation: identifier,
      operator_connection_id: identifier,
      resolved_at: natural,
    })
    .optional(),
  outcome: z
    .strictObject({
      status: z.enum(["running", "completed", "failed", "cancelled"]),
      ended_reason: text.optional(),
      error: z.strictObject({ code: text, message: text }).optional(),
      usage: z
        .strictObject({
          iterations: natural,
          elapsed_ms: z.number().nonnegative().finite(),
          input_tokens: natural.optional(),
          output_tokens: natural.optional(),
          cached_tokens: natural.optional(),
          warnings: z.array(text).max(MAX_HOST_INDEX_BYTES).optional(),
          by_agent: z
            .array(
              z.strictObject({
                role: z.enum(["lead", "subagent", "vision"]),
                model: text,
                input_tokens: natural,
                output_tokens: natural,
                cached_tokens: natural,
                cache_write_tokens: natural,
                iterations: natural.optional(),
              }),
            )
            .max(MAX_HOST_INDEX_BYTES)
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

/** Validate untrusted disk state before it can enter the bounded registry; never expose parse data. */
export function decodeHostedRegistryState(
  value: unknown,
  limits: { runs: number; receipts: number } = { runs: 32, receipts: 128 },
): HostedRegistryState {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value));
  } catch {
    throw kernelError("invalid_request", "host index is not a JSON document");
  }
  if (bytes > MAX_HOST_INDEX_BYTES)
    throw kernelError("resource_exhausted", "host state index exceeds 2 MiB");
  const parsed = z
    .strictObject({
      schema_version: z.literal(1),
      host_generation: identifier,
      runs: z.array(z.strictObject({ run, acknowledged: z.boolean() })).max(limits.runs),
      receipts: z
        .array(
          z.strictObject({
            receipt: z.strictObject({ operation_id: identifier, run, committed_at: natural }),
            expires_at: natural,
          }),
        )
        .max(limits.receipts),
    })
    .safeParse(value);
  if (!parsed.success) throw kernelError("invalid_request", "host state index is invalid");
  const result = parsed.data;
  if (
    new Set(result.runs.map((item) => item.run.execution_id)).size !== result.runs.length ||
    new Set(result.receipts.map((item) => item.receipt.operation_id)).size !==
      result.receipts.length
  )
    throw kernelError("invalid_request", "host state index contains duplicate identities");
  return result;
}
