import type { JudgeCoordinator } from "@clarvis/judge";

/** Explicit semantic-port fixture; unexpected inference paths fail instead of simulating a provider. */
export function judgePort(
  reviewCommand?: JudgeCoordinator["reviewCommand"],
  reviewEffects?: JudgeCoordinator["reviewEffects"],
): JudgeCoordinator {
  return {
    reviewCommand:
      reviewCommand ??
      (async () => {
        throw new Error("Unexpected command review");
      }),
    reviewEffects:
      reviewEffects ??
      (async () => {
        throw new Error("Unexpected effect review");
      }),
    async close() {},
  };
}
