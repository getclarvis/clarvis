import { JUDGE_DEFAULTS, type EffectReviewConfig } from "@clarvis/judge/settings";
import { loadEnv } from "@clarvis/capability";

/** Operator scope chooses the reviewer; workspace input can only reduce operational limits. */
export function resolveEffectReviewSettings(
  operator?: EffectReviewConfig,
  workspace?: EffectReviewConfig,
  defaultTimeoutMs = loadEnv({}).CLARVIS_DEFAULT_CALL_TIMEOUT_MS,
  defaultMaxRetries = loadEnv({}).CLARVIS_DEFAULT_MAX_RETRIES,
): EffectReviewConfig | undefined {
  if (operator === undefined && workspace === undefined) return undefined;
  return {
    ...operator,
    ...(operator?.timeout_ms === undefined && workspace?.timeout_ms === undefined
      ? {}
      : {
          timeout_ms: Math.min(
            operator?.timeout_ms ?? defaultTimeoutMs,
            workspace?.timeout_ms ?? Infinity,
          ),
        }),
    ...(operator?.max_retries === undefined && workspace?.max_retries === undefined
      ? {}
      : {
          max_retries: Math.min(
            operator?.max_retries ?? defaultMaxRetries,
            workspace?.max_retries ?? Infinity,
          ),
        }),
    on_unsure:
      workspace?.on_unsure === "deny" ? "deny" : (operator?.on_unsure ?? JUDGE_DEFAULTS.onUnsure),
  };
}
