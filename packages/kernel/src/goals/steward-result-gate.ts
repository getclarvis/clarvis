import type { GoalStewardMode } from "@clarvis/goal";
import type { Capability, GateOutcome } from "@clarvis/capability";

/** Validate the structured review protocol, allowing one bounded in-run correction. */
export function createStewardResultGate(
  mode: GoalStewardMode,
  validate: (value: unknown) => Promise<void>,
): Capability {
  return {
    name: "goal-steward-result",
    required: true,
    forRun: () => ({
      name: "goal-steward-result",
      forAgent: (scope) =>
        scope.entry
          ? {
              attach: (context) => {
                let nudged = false;
                return {
                  gates: [
                    {
                      fastAcceptOk: () => false,
                      async check(attempt): Promise<GateOutcome> {
                        const cancelled = context.maybeCancelled();
                        if (cancelled) return { kind: "terminal", result: cancelled };
                        try {
                          await validate(attempt.value);
                          const cancelled = context.maybeCancelled();
                          return cancelled
                            ? { kind: "terminal", result: cancelled }
                            : { kind: "pass" };
                        } catch {
                          const cancelled = context.maybeCancelled();
                          if (cancelled) return { kind: "terminal", result: cancelled };
                          if (!nudged) {
                            nudged = true;
                            return {
                              kind: "nudge",
                              note: `Review rejected: call submit_result with verdict set to exactly one of ${mode === "definition" ? "accept_definition, revise_definition" : "achieved, needs_work, needs_evidence"}. Optional message may explain your decision. No other fields are required.`,
                            };
                          }
                          return {
                            kind: "terminal",
                            result: {
                              status: "error",
                              partialText: context.state.lastAssistantText,
                              error: {
                                code: "invalid_output",
                                message: "Goal Steward did not return a recognized verdict",
                              },
                            },
                          };
                        }
                      },
                    },
                  ],
                };
              },
            }
          : null,
    }),
  };
}
