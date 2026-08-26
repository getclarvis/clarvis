import type { RunCapability } from "@clarvis/capability";

/**
 * Sort a run's capabilities into the order their contributions are folded.
 *
 * @param capabilities - the activated capabilities, in registration order.
 * @returns the same set, ascending by {@link RunCapability.order} (default `0`),
 *   with registration order preserved among equals.
 * @remarks Handler dispatch is first-match, so this is behaviour. A stable sort
 *   is required, not incidental: two capabilities that declare no order must
 *   keep the order the host registered them in, which is the only thing a host
 *   can reason about.
 */
export function orderCapabilities(capabilities: readonly RunCapability[]): RunCapability[] {
  return [...capabilities].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
