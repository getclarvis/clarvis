import { PersistenceError } from "@clarvis/capability";
import type { ExecutionVisibility } from "@clarvis/capability";

/** Reject unclassified writes and legacy bodies instead of inferring public disclosure. */
export function assertExecutionVisibility(value: unknown): asserts value is ExecutionVisibility {
  if (value !== "public" && value !== "internal")
    throw new PersistenceError("Execution visibility must be explicitly public or internal.");
}
