import type { Capability, GateOutcome } from "@clarvis/capability";

/** Validate private review evidence before acceptance, allowing one bounded in-run correction. */
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
                              note: "Review rejected: use the current frame's mode, criterion IDs and evidence IDs. Read every cited inspected_path completely in THIS evaluation, including normative sources for achieved. Historical reads do not qualify. Then call submit_result again; if verification is unavailable, report inconclusive without claiming unverified reads.",
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
