import type { OutputTokenBudget } from "@clarvis/capability";

/** Independent per-case ceiling; reservations also enforce the per-stage attempt allowance. */
export function createJudgeOutputBudget(
  cap: number,
  attempts: number,
  stages: number,
): OutputTokenBudget {
  const perStage = cap * attempts;
  let available = perStage * stages;
  return {
    remaining: () => Math.max(0, available),
    reserveOutput(requested) {
      const amount = Math.max(0, Math.min(Math.floor(requested), perStage, available));
      if (!Number.isFinite(amount) || amount < 1) return null;
      available -= amount;
      let active = true;
      return {
        amount,
        settle(used) {
          if (!active) return;
          active = false;
          available += amount - (Number.isFinite(used) && used >= 0 ? used : amount);
        },
        release() {
          if (!active) return;
          active = false;
          available += amount;
        },
      };
    },
  };
}
