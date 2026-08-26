/**
 * Memory's stable failure identities, and how they reach a client.
 *
 * The protocol's {@link KernelErrorCode} is a small transport-level vocabulary
 * every generic client already switches on. Adding domain members to it would
 * pollute that vocabulary and set a precedent for every other service, so a
 * memory failure keeps the transport code that best describes its *class* and
 * carries its exact identity in `details.memory_code`. A memory-aware UI reads
 * the precise code; everything else keeps working unchanged.
 *
 * `@clarvis/protocol` has no value exports, so the code→transport mapping lives
 * here rather than beside the type.
 */
import type { KernelErrorCode } from "@clarvis/protocol";

import { kernelError, toKernelError, type KernelException } from "../core/errors.ts";

/** A memory failure's stable identity. */
export type MemoryErrorCode =
  "MEMORY_NOT_CONFIGURED" | "MEMORY_RECOVERY_REQUIRED" | "MEMORY_INVALID_PATH";

/** Context a memory failure carries alongside its code. */
export interface MemoryErrorDetails {
  memory_code: MemoryErrorCode;
  /** Document the failure concerns. */
  path?: string;
}

/**
 * The documented mapping from a memory identity to its transport class.
 *
 * @remarks Changing a row is a contract change: clients branch on the
 * transport code first and only then refine on `memory_code`.
 */
const KERNEL_CODE: Record<MemoryErrorCode, KernelErrorCode> = {
  MEMORY_NOT_CONFIGURED: "capability_disabled",
  MEMORY_RECOVERY_REQUIRED: "unavailable",
  MEMORY_INVALID_PATH: "invalid_request",
};

/** Package error shapes that carry their own stable discriminator. */
const PACKAGE_CODE: Record<string, MemoryErrorCode> = {
  memory_recovery_required: "MEMORY_RECOVERY_REQUIRED",
  memory_path_invalid: "MEMORY_INVALID_PATH",
};

/**
 * Build a memory-tagged kernel error.
 *
 * @param code - the memory identity.
 * @param message - an owner-readable explanation.
 * @param context - the document or revision the failure concerns.
 * @returns a {@link KernelException} whose transport code follows the mapping
 *   and whose `details` carry `memory_code`.
 */
export function memoryError(
  code: MemoryErrorCode,
  message: string,
  context: Omit<MemoryErrorDetails, "memory_code"> = {},
): KernelException {
  return kernelError(KERNEL_CODE[code], message, { memory_code: code, ...context });
}

/**
 * Normalize anything thrown by `@clarvis/memory` into a tagged kernel error.
 *
 * @param err - the thrown value.
 * @param context - the document or revision under operation.
 * @returns a memory-tagged {@link KernelException} when the error carries a
 *   known discriminator, otherwise whatever {@link toKernelError} makes of it.
 */
export function mapMemoryFailure(
  err: unknown,
  context: Omit<MemoryErrorDetails, "memory_code"> = {},
): KernelException {
  const code = (err as { code?: unknown } | null)?.code;
  const mapped = typeof code === "string" ? PACKAGE_CODE[code] : undefined;
  if (mapped !== undefined) {
    return memoryError(mapped, err instanceof Error ? err.message : String(err), context);
  }
  return toKernelError(err);
}
