import type { EffectReviewConfig } from "@clarvis/capability";

/** Operator scope chooses the reviewer; workspace input can only reduce operational limits. */
export function resolveEffectReviewSettings(
  operator?: EffectReviewConfig,
  workspace?: EffectReviewConfig,
): EffectReviewConfig | undefined {
  if (operator === undefined && workspace === undefined) return undefined;
  return {
    ...operator,
    timeout_ms: Math.min(operator?.timeout_ms ?? 20000, workspace?.timeout_ms ?? Infinity),
    max_retries: Math.min(operator?.max_retries ?? 1, workspace?.max_retries ?? Infinity),
    on_unsure: workspace?.on_unsure === "deny" ? "deny" : (operator?.on_unsure ?? "ask"),
  };
}
