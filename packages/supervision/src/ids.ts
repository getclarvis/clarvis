import { randomUUID } from "node:crypto";

/** Prefix every supervision handle carries, so an `agent_id` is recognizable on
 * sight and never confused with the four native id spaces it fronts. */
const AGENT_ID_PREFIX = "ag_";

/** Matches a well-formed `agent_id`. */
export const AGENT_ID_PATTERN = /^ag_[0-9a-f]{8}$/;

/**
 * Mint an `agent_id` unique among `taken`.
 *
 * @param taken - ids already handed out in this run.
 * @returns a fresh `ag_` + 8 lowercase hex id.
 * @remarks Uniqueness is only ever needed *within a run* — one registry holds
 *   one entry agent's direct children — so 8 hex digits are ample and the
 *   collision check is a formality rather than a birthday-bound calculation. It
 *   is here because a silent collision would alias two children onto one handle,
 *   which is far worse than the loop it costs.
 */
export function mintAgentId(taken: ReadonlySet<string>): string {
  let id = candidateAgentId();
  while (taken.has(id)) id = candidateAgentId();
  return id;
}

/** One unqualified `ag_` candidate, before it is checked against the run's ids. */
function candidateAgentId(): string {
  return AGENT_ID_PREFIX + randomUUID().replace(/-/g, "").slice(0, 8);
}
