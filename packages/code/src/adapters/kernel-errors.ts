import type { KernelErrorCode } from "@clarvis/protocol";

/** Whether an arbitrary local or transported failure carries a kernel error code. */
export function hasKernelErrorCode(
  error: unknown,
  code: KernelErrorCode,
): error is { code: KernelErrorCode } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
