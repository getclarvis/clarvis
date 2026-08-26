import type { ComputeClock } from "@clarvis/capability";
import type { Elicit } from "../tools/ask-user-tool.ts";
import { elicitWithClockPause } from "../tools/ask-user-tool.ts";
import type { ConvergenceGuards, GuardTrip } from "./convergence-guards.ts";

/** The field the guard-escalation elicitation asks the user to fill. */
const ELICIT_CONTINUE_FIELD = "guard_continue";

/**
 * The elicitation `kind` a guard escalation identifies itself as.
 *
 * @remarks A distinct kind, so a UI can frame it as "the run
 * looks stuck — keep going?" rather than as a generic agent question. The
 * protocol's elicitation `kind` is an open union, so naming it costs nothing.
 */
const GUARD_ESCALATION_KIND = "guard_escalation";

/** What the user decided about a tripped convergence guard. */
export type GuardDecision = "continue" | "decline" | "no_response";

/** Asks the user whether to continue past a tripped guard. */
export type GuardEscalationAsk = (trip: GuardTrip) => Promise<GuardDecision>;

/**
 * Adapt an {@link Elicit} port into a {@link GuardEscalationAsk}.
 *
 * @param elicit - the user-elicitation port.
 * @param clock - the compute clock, paused while awaiting the human so a person
 *   deliberating does not consume the run's inactivity budget.
 * @param signal - optional abort signal forwarded to the elicitation.
 * @param waitBoundMs - optional bound on how long to wait for an answer.
 * @returns an ask resolving `continue` only on an explicit continue; any other
 *   answer is `decline`, and an elapsed wait bound is `no_response`.
 * @remarks Mirrors `buildSoftLimitAsk`. The default is to stop: a guard trip
 *   means the run has already shown it is not converging, so an ambiguous or
 *   absent answer must not be read as permission to keep spending.
 */
export function buildGuardEscalationAsk(
  elicit: Elicit,
  clock: ComputeClock,
  signal?: AbortSignal,
  waitBoundMs?: number,
): GuardEscalationAsk {
  return (trip: GuardTrip): Promise<GuardDecision> =>
    elicitWithClockPause<GuardDecision>(
      clock,
      signal,
      () =>
        elicit(
          {
            message: `${trip.message} Continue anyway?`,
            kind: GUARD_ESCALATION_KIND,
            requestedSchema: {
              type: "object",
              properties: {
                [ELICIT_CONTINUE_FIELD]: {
                  type: "string",
                  enum: ["continue", "stop"],
                  description: "Keep going despite the convergence guard, or stop the run?",
                },
              },
              required: [ELICIT_CONTINUE_FIELD],
            },
          },
          { signal, ...(waitBoundMs !== undefined ? { timeoutMs: waitBoundMs } : {}) },
        ),
      {
        onResult: (raw) => {
          if (raw.action !== "accept") return "decline";
          return raw.content?.[ELICIT_CONTINUE_FIELD] === "continue" ? "continue" : "decline";
        },
        onNoResponse: () => "no_response",
      },
    );
}

/** The outcome of putting a guard trip to the user. */
export type GuardEscalationOutcome =
  { kind: "continue" } | { kind: "declined" } | { kind: "cancelled" };

/**
 * Put a tripped convergence guard to the user and act on the answer.
 *
 * @param args.guards - the guards, reset on a `continue`.
 * @param args.ask - the prompt; when absent the trip is terminal, unasked.
 * @param args.maxEscalations - how many times one run may be waved through; `0`
 *   disables escalation entirely.
 * @param args.escalations - how many have already been spent.
 * @returns `continue` when the user agreed (and the guards were reset),
 *   `declined` otherwise, or `cancelled` when the run aborted mid-prompt.
 * @remarks The reset is the whole point of a `continue`: the guards' counters
 *   are at their thresholds, so leaving them would re-trip on the very next
 *   failure and the question would have been decoration.
 *
 *   The escalation budget here is **separate** from the soft-budget one. They
 *   bound different things, and a chatty budget sharing the counter could spend
 *   the guard's allowance before the guard ever fired.
 */
export async function escalateGuardTrip(args: {
  trip: GuardTrip;
  guards: ConvergenceGuards;
  ask?: GuardEscalationAsk;
  maxEscalations: number;
  escalations: number;
  signal?: AbortSignal;
  record: (outcome: "continued" | "declined" | "no_response" | "escalations_exhausted") => void;
}): Promise<GuardEscalationOutcome> {
  const { trip, guards, ask, maxEscalations, escalations, signal, record } = args;
  if (ask === undefined || maxEscalations <= 0) return { kind: "declined" };
  if (escalations >= maxEscalations) {
    record("escalations_exhausted");
    return { kind: "declined" };
  }

  let decision: GuardDecision;
  try {
    decision = await ask(trip);
  } catch {
    if (signal?.aborted) return { kind: "cancelled" };
    record("no_response");
    return { kind: "declined" };
  }

  if (decision === "continue") {
    guards.reset();
    record("continued");
    return { kind: "continue" };
  }
  record(decision === "no_response" ? "no_response" : "declined");
  return { kind: "declined" };
}
