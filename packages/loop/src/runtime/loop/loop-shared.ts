import type { LLMProvider, ResolvedProviderConfig, TracePort } from "@clarvis/capability";
import type { IterationCounter, TokenLedger } from "../budget/budget.ts";
import type { TokenAccumulator } from "@clarvis/capability";
import type { SoftBudget, SoftLimitAsk } from "../budget/soft-budget.ts";
import type { ReasoningEffort, ReasoningSummary } from "@clarvis/capability";

/** The no-progress streak length at which the lead agent is aborted with a `no_progress` error. */
export const LEAD_NO_PROGRESS_LIMIT = 6;
/** The no-progress streak length at which a subagent is aborted with a `no_progress` error. */
export const SUBAGENT_NO_PROGRESS_LIMIT = 6;

/**
 * The agent-termination vocabulary, re-exported from the contract that owns it.
 *
 * @remarks These used to be redeclared here, byte-identical to
 * `@clarvis/capability`'s pair. Two independent declarations of one contract is
 * a drift hazard that cost nothing until the codes opened — at which point the
 * engine's copy stayed closed and refused every capability-contributed code,
 * with an error message pointing at structural incompatibility rather than at
 * the duplication that caused it.
 */
export type { AgentErrorCode, AgentResult } from "@clarvis/capability";

/**
 * A fully resolved model call target: the {@link LLMProvider} plus the model id,
 * provider name, and the optional per-call knobs (provider config, capability
 * set, reasoning summary/effort, timeout, output-token cap, retry policy, and
 * streaming) the loop passes through to the provider.
 */
export interface LlmTarget {
  llm: LLMProvider;
  model: string;
  provider: string;
  providerConfig?: ResolvedProviderConfig;
  capabilities?: Set<string>;
  reasoningSummary?: ReasoningSummary;
  reasoningEffort?: ReasoningEffort;
  callTimeoutMs?: number;
  maxOutputTokens?: number;
  maxRetries?: number;
  maxRetryAfterMs?: number;
  stream?: boolean;
}

export { partialStructOf } from "@clarvis/capability";

/**
 * Assemble an {@link LlmTarget} from a provider and a source config, copying only
 * the optional knobs that are defined.
 *
 * @param llm - the resolved provider.
 * @param src - the model/provider identity plus any per-call knobs to forward
 *   (every {@link LlmTarget} field except `llm` itself, which this supplies).
 * @returns the target with `undefined` optional fields omitted rather than set.
 */
export function toLlmTarget(llm: LLMProvider, src: Omit<LlmTarget, "llm">): LlmTarget {
  return {
    llm,
    model: src.model,
    provider: src.provider,
    ...(src.providerConfig ? { providerConfig: src.providerConfig } : {}),
    ...(src.capabilities !== undefined ? { capabilities: src.capabilities } : {}),
    ...(src.reasoningSummary !== undefined ? { reasoningSummary: src.reasoningSummary } : {}),
    ...(src.reasoningEffort !== undefined ? { reasoningEffort: src.reasoningEffort } : {}),
    ...(src.callTimeoutMs !== undefined ? { callTimeoutMs: src.callTimeoutMs } : {}),
    ...(src.maxOutputTokens !== undefined ? { maxOutputTokens: src.maxOutputTokens } : {}),
    ...(src.maxRetries !== undefined ? { maxRetries: src.maxRetries } : {}),
    ...(src.maxRetryAfterMs !== undefined ? { maxRetryAfterMs: src.maxRetryAfterMs } : {}),
    ...(src.stream !== undefined ? { stream: src.stream } : {}),
  };
}

/**
 * The budget accounting bundle for one agent loop: the token `ledger`, the
 * iteration `counter`, the cumulative `usage`, and the optional soft-budget
 * {@link SoftBudget} plus its {@link SoftLimitAsk} continuation prompt.
 */
export interface LoopBudget {
  ledger: TokenLedger;
  counter: IterationCounter;
  usage: TokenAccumulator;
  softBudget?: SoftBudget;
  softLimitAsk?: SoftLimitAsk;
}

/** The ambient runtime handles every loop needs: the {@link TracePort} and the optional cancellation `signal`. */
export interface LoopRuntime {
  trace: TracePort;
  signal?: AbortSignal;
}

/**
 * Build the standard `empty_response` error for an agent that returned neither
 * text nor tool calls on consecutive completions.
 *
 * @param agent - the label used in the message (`"LLM"` for a subagent, `"Lead"`
 *   for the lead).
 * @returns the `empty_response` error code and message.
 */
export function emptyResponseError(agent: "LLM" | "Lead"): {
  code: "empty_response";
  message: string;
} {
  return {
    code: "empty_response",
    message: `${agent} returned neither text nor tool calls in consecutive completions.`,
  };
}

/**
 * Short-circuit on cancellation before running a checkpoint step.
 *
 * @param maybeCancelled - probe returning a terminal value when the run was
 *   cancelled, `null` otherwise.
 * @param checkpoint - the step to run only when not cancelled.
 * @returns the cancellation value if cancelled, otherwise the checkpoint's
 *   result (which may itself be `null`).
 */
export async function cancelOrCheckpoint<R>(
  maybeCancelled: () => R | null,
  checkpoint: () => Promise<R | null>,
): Promise<R | null> {
  const c = maybeCancelled();
  if (c) return c;
  return checkpoint();
}
