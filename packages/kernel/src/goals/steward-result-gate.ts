import type { Capability, GateOutcome } from "@clarvis/capability";

/** Validate the structured review protocol, allowing one bounded in-run correction. */
export function createStewardResultGate(validate: (value: unknown) => Promise<void>): Capability {
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
                              note: "Review rejected: use the current frame's mode, criterion IDs and evidence IDs, then call submit_result again. If the supplied context is insufficient, return needs_evidence with the specific missing information.",
                            };
                          }
                          return {
                            kind: "terminal",
                            result: {
                              status: "error",
                              partialText: context.state.lastAssistantText,
                              error: {
                                code: "goal_steward_failed",
                                message: "Goal Steward result validation failed",
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
