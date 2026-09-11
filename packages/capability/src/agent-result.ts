import type { BuiltinErrorCode } from "./run.ts";
import type { RunFinalization } from "./finalization.ts";

/**
 * The {@link import("./run.ts").ErrorCode}s the *engine's own* agent loop can
 * terminate itself with: empty responses, unavailable tools, and the
 * tool-failure / stagnation / no-progress / child-supervision guards.
 */
export const BUILTIN_AGENT_ERROR_CODES = [
  "empty_response",
  "all_tools_unavailable",
  "tool_failure_loop",
  "stagnation_detected",
  "no_progress",
  "agents_unfinished",
  "background_children_failing",
] as const;

/** A self-termination code the engine itself declares. */
export type BuiltinAgentErrorCode = (typeof BUILTIN_AGENT_ERROR_CODES)[number];

/**
 * A code an agent loop can terminate itself with.
 *
 * @remarks Open, and it has to be: a capability's finalize gate ends the agent
 * through {@link AgentResult}, so a closed set here would make the *only* path a
 * capability has to terminate a run pass through a union the engine owns. This
 * used to be `Extract<ErrorCode, …>`, which is a trap once `ErrorCode` opens —
 * `Extract` distributes, the open arm matches no literal and collapses to
 * `never`, and the set silently stays closed while looking as though it opened.
 */
export type AgentErrorCode = BuiltinAgentErrorCode | (string & {});

/**
 * Compile-time drift lock: every engine-declared agent code must also be an
 * engine-declared {@link BuiltinErrorCode}, since an agent's failure becomes the
 * run's failure verbatim.
 */
const _agentCodesAreErrorCodes: [Exclude<BuiltinAgentErrorCode, BuiltinErrorCode>] extends [never]
  ? true
  : false = true;
void _agentCodesAreErrorCodes;

/**
 * The terminal outcome of one agent's loop: its `status`, the final `text` (when
 * completed) or the always-present `partialText` accumulated so far, the
 * {@link AgentErrorCode} `error` on failure, and — for structured personas — the
 * completed `structuredResult` or the best-effort `partialStructured` value.
 */
export type AgentResult = RunFinalization & {
  status: "completed" | "budget_exhausted" | "error" | "cancelled" | "soft_limit_declined";
  text?: string;
  partialText: string;
  error?: { code: AgentErrorCode; message: string };
  structuredResult?: { value: unknown };
  partialStructured?: { value: unknown };
};

/**
 * Build the `partialStructured` fragment of an {@link AgentResult} from a
 * remembered submit attempt.
 *
 * @param lastSubmitAttempt - the last structured submit, if any.
 * @returns `{ partialStructured }` when a submit was attempted, or an empty
 *   object (spread-ready) otherwise.
 * @remarks Lives beside the type it builds rather than in the engine, so a
 * capability whose gate terminates an agent can surface the same partial the
 * engine would.
 */
export function partialStructOf(
  lastSubmitAttempt: { value: unknown } | undefined,
): { partialStructured: { value: unknown } } | Record<string, never> {
  return lastSubmitAttempt ? { partialStructured: lastSubmitAttempt } : {};
}
