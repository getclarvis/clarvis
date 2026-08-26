import { PLANS_CAPABILITY_NAME } from "@clarvis/plan";
import type { PlanRef } from "@clarvis/protocol";

/** The literal {@link PlanRef.status} values a validated ref may carry. */
const PLAN_STATUSES: ReadonlySet<string> = new Set([
  "awaiting_approval",
  "active",
  "completed",
  "cancelled",
  "failed",
]);

/** The literal {@link PlanRef.retention} values a validated ref may carry. */
const PLAN_RETENTIONS: ReadonlySet<string> = new Set(["discard", "keep"]);

/**
 * Structural check for a wire {@link PlanRef}: every required field present
 * with the right primitive type, `status`/`retention` restricted to their
 * literal sets, and the one optional field (`path`) a string whenever present.
 *
 * @param value - the candidate, typically a `capability_state` slot.
 * @returns `true` when `value` satisfies {@link PlanRef}.
 */
function isPlanRef(value: unknown): value is PlanRef {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.provider_key === "string" &&
    typeof v.final_revision === "number" &&
    typeof v.final_spec_revision === "number" &&
    typeof v.status === "string" &&
    PLAN_STATUSES.has(v.status) &&
    typeof v.retention === "string" &&
    PLAN_RETENTIONS.has(v.retention) &&
    (v.path === undefined || typeof v.path === "string")
  );
}

/**
 * Reads the planning capability's ref out of a stored execution's opaque
 * `capability_state`, validating its shape before handing it back as a wire
 * {@link PlanRef}.
 *
 * @param capabilityState - `ExecutionRecord.capability_state` off a
 *   {@link import("@clarvis/loop").StoredExecution}, keyed by capability name.
 * @returns the validated ref, or `undefined` when `capabilityState` is absent,
 *   carries no {@link PLANS_CAPABILITY_NAME} slot, or that slot does not
 *   satisfy {@link PlanRef}.
 * @remarks `capability_state` is opaque to the engine and the trace store by
 *   design — each slot is written by whichever capability owns that name, and
 *   nothing upstream of this function validates its shape before persisting
 *   it. The kernel is not the planning capability, so an unchecked cast at
 *   this boundary would let a malformed or absent slot masquerade as a
 *   `PlanRef` and reach a client mid–session-recovery as, say,
 *   `undefined.final_revision`. This guard is hand-written rather than
 *   schema-validated on purpose: it is the one place `capability_state`
 *   crosses into a typed wire field, and pulling in a validation library for
 *   one boundary would put it on the kernel's eager-import path for no
 *   benefit over five type checks.
 */
export function planRefFromCapabilityState(
  capabilityState: Record<string, unknown> | undefined,
): PlanRef | undefined {
  const slot = capabilityState?.[PLANS_CAPABILITY_NAME];
  return isPlanRef(slot) ? slot : undefined;
}
