import type { SoftLimitCheckDetail } from "@clarvis/capability";
import type { ComputeClock } from "@clarvis/capability";
import { elicitWithClockPause, type Elicit, type ElicitParams } from "../tools/ask-user-tool.ts";
import type { AgentRole } from "@clarvis/capability";

/**
 * Configuration for a soft budget: the token and/or iteration checkpoint
 * interval and an optional cap on how many times the user may be asked to
 * continue.
 */
export interface SoftBudgetConfig {
  softTokenLimit?: number;
  softIterationLimit?: number;
  maxEscalations?: number;
}

/**
 * A crossed soft checkpoint: which `dimension` tripped, the `used` amount, and
 * the `limit` (current checkpoint) it reached.
 */
export interface SoftCrossing {
  dimension: "tokens" | "iterations";
  used: number;
  limit: number;
}

/** Stateful tracker of soft-limit checkpoints and how far they have escalated. */
export interface SoftBudget {
  /** The first checkpoint reached by the given usage, or `null` if none. Tokens
   * are tested before iterations. */
  crossed(usedTokens: number, usedIterations: number): SoftCrossing | null;
  /** Push the given dimension's checkpoint out by one interval, count the
   * escalation, and return the new checkpoint (0 if the dimension is unset). */
  advance(dimension: "tokens" | "iterations"): number;
  /** Whether `maxEscalations` is set and the escalation count has reached it. */
  escalationsExhausted(): boolean;
  /** Escalations recorded so far. */
  escalations(): number;
}

/**
 * Build a {@link SoftBudget} from its config.
 *
 * @param config - the checkpoint intervals and escalation cap.
 * @returns a tracker, or `undefined` when neither `softTokenLimit` nor
 *   `softIterationLimit` is set (there is nothing soft to enforce).
 */
export function createSoftBudget(config: SoftBudgetConfig): SoftBudget | undefined {
  const { softTokenLimit, softIterationLimit, maxEscalations } = config;
  if (softTokenLimit === undefined && softIterationLimit === undefined) return undefined;

  let tokenCheckpoint = softTokenLimit;
  let iterCheckpoint = softIterationLimit;
  let escalationCount = 0;

  return {
    crossed(usedTokens, usedIterations) {
      if (
        softTokenLimit !== undefined &&
        tokenCheckpoint !== undefined &&
        usedTokens >= tokenCheckpoint
      ) {
        return { dimension: "tokens", used: usedTokens, limit: tokenCheckpoint };
      }
      if (
        softIterationLimit !== undefined &&
        iterCheckpoint !== undefined &&
        usedIterations >= iterCheckpoint
      ) {
        return { dimension: "iterations", used: usedIterations, limit: iterCheckpoint };
      }
      return null;
    },
    advance(dimension) {
      if (dimension === "tokens" && softTokenLimit !== undefined && tokenCheckpoint !== undefined) {
        tokenCheckpoint += softTokenLimit;
        escalationCount += 1;
        return tokenCheckpoint;
      }
      if (
        dimension === "iterations" &&
        softIterationLimit !== undefined &&
        iterCheckpoint !== undefined
      ) {
        iterCheckpoint += softIterationLimit;
        escalationCount += 1;
        return iterCheckpoint;
      }
      return 0;
    },
    escalationsExhausted() {
      return maxEscalations !== undefined && escalationCount >= maxEscalations;
    },
    escalations() {
      return escalationCount;
    },
  };
}

/**
 * The user's answer to a soft-limit prompt: `continue` past it, `decline` and
 * stop with the partial result, or `no_response` when the prompt was not
 * answered (e.g. timed out).
 */
export type SoftDecision = "continue" | "decline" | "no_response";

/** Prompts the user about a crossed soft limit and resolves to their decision. */
export type SoftLimitAsk = (crossing: SoftCrossing) => Promise<SoftDecision>;

const ELICIT_CONTINUE_FIELD = "continue";

function buildSoftLimitElicitParams(crossing: SoftCrossing): ElicitParams {
  return {
    message: `Used ${crossing.used} of the soft ${crossing.dimension} limit (${crossing.limit}). Continue?`,
    requestedSchema: {
      type: "object",
      properties: {
        [ELICIT_CONTINUE_FIELD]: {
          type: "string",
          enum: ["continue", "stop"],
          description: "Continue past the soft limit, or stop with the partial result?",
        },
      },
      required: [ELICIT_CONTINUE_FIELD],
    },
  };
}

/**
 * Adapt an {@link Elicit} port into a {@link SoftLimitAsk} that prompts "continue
 * past the soft limit?" and maps the reply to a {@link SoftDecision}.
 *
 * @param elicit - the user-elicitation port.
 * @param clock - the compute clock, paused while awaiting the human so the wait
 *   does not burn the run's compute timeout (see {@link elicitWithClockPause}).
 * @param signal - optional abort signal forwarded to the elicitation.
 * @param waitBoundMs - optional bound on how long to wait for an answer.
 * @returns an ask that resolves `continue` unless the reply is a non-accept or
 *   selects `"stop"` (both `decline`), or there was no response (`no_response`).
 */
export function buildSoftLimitAsk(
  elicit: Elicit,
  clock: ComputeClock,
  signal?: AbortSignal,
  waitBoundMs?: number,
): SoftLimitAsk {
  return (crossing: SoftCrossing): Promise<SoftDecision> =>
    elicitWithClockPause<SoftDecision>(
      clock,
      signal,
      () =>
        elicit(buildSoftLimitElicitParams(crossing), {
          signal,
          ...(waitBoundMs !== undefined ? { timeoutMs: waitBoundMs } : {}),
        }),
      {
        onResult: (raw) => {
          if (raw.action !== "accept") return "decline";
          return raw.content?.[ELICIT_CONTINUE_FIELD] === "stop" ? "decline" : "continue";
        },
        onNoResponse: () => "no_response",
      },
    );
}

/**
 * The result of evaluating a soft budget at one checkpoint: `continue`,
 * `declined` (user stopped, no response, or escalations exhausted), or
 * `cancelled` (aborted while asking).
 */
export type SoftEvalOutcome = { kind: "continue" } | { kind: "declined" } | { kind: "cancelled" };

/**
 * Check the soft budget at the current usage and, if a checkpoint was crossed,
 * ask the user whether to continue — recording the outcome to the trace.
 *
 * @param args.softBudget - the tracker to test and, on `continue`, advance.
 * @param args.softLimitAsk - the prompt invoked when a checkpoint is crossed.
 * @param args.usedTokens - consumed tokens to test against the token checkpoint.
 * @param args.usedIterations - iterations to test against the iteration checkpoint.
 * @param args.agent - role attributed on the recorded detail.
 * @param args.signal - abort signal; if aborted while asking, the outcome is
 *   `cancelled` rather than `declined`.
 * @param args.record - sink for the `soft_limit_check` trace detail.
 * @returns `continue` when nothing crossed or the user agreed (checkpoint then
 *   advanced), `declined` when escalations are exhausted or the user stopped /
 *   gave no response, or `cancelled` when aborted mid-prompt.
 * @remarks A crossing with escalations already exhausted declines without asking.
 *   A thrown ask maps to `cancelled` if the signal is aborted, otherwise
 *   `declined` with a `no_response` outcome.
 */
export async function evaluateSoftBudget(args: {
  softBudget: SoftBudget;
  softLimitAsk: SoftLimitAsk;
  usedTokens: number;
  usedIterations: number;
  agent: AgentRole;
  signal?: AbortSignal;
  record: (detail: SoftLimitCheckDetail) => void;
}): Promise<SoftEvalOutcome> {
  const { softBudget, softLimitAsk, usedTokens, usedIterations, agent, signal, record } = args;
  const crossing = softBudget.crossed(usedTokens, usedIterations);
  if (!crossing) return { kind: "continue" };

  const base = {
    agent,
    dimension: crossing.dimension,
    used: crossing.used,
    limit: crossing.limit,
  } as const;

  if (softBudget.escalationsExhausted()) {
    record({ ...base, outcome: "escalations_exhausted", escalations: softBudget.escalations() });
    return { kind: "declined" };
  }

  let decision: SoftDecision;
  try {
    decision = await softLimitAsk(crossing);
  } catch {
    if (signal?.aborted) return { kind: "cancelled" };
    record({ ...base, outcome: "no_response", escalations: softBudget.escalations() });
    return { kind: "declined" };
  }

  if (decision === "continue") {
    const newCheckpoint = softBudget.advance(crossing.dimension);
    record({
      ...base,
      outcome: "continued",
      new_checkpoint: newCheckpoint,
      escalations: softBudget.escalations(),
    });
    return { kind: "continue" };
  }

  record({
    ...base,
    outcome: decision === "no_response" ? "no_response" : "declined",
    escalations: softBudget.escalations(),
  });
  return { kind: "declined" };
}
