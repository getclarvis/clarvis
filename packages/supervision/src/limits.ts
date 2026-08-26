/**
 * Resolving the effective supervision bounds for one run.
 *
 * @remarks The `agents` block reaches the loop as a per-run request param (the
 * host projects its settings block onto it, exactly as it does for `plans`), so
 * this is the one place that folds the request over the product defaults. Every
 * field is a ceiling on something the *parent* pays for, which is why a partial
 * override merges over the defaults rather than replacing them.
 */
import type { AgentsParam, EnvConfig, RunRequest } from "@clarvis/capability";
import { AGENTS_DEFAULTS } from "./settings.ts";
import type { AgentsLimits } from "./registry.ts";

/**
 * Fold a run request's `agents` param over {@link AGENTS_DEFAULTS}.
 *
 * @param request - the validated run request.
 * @param _env - the resolved environment, reserved for a future env-level
 *   override of these bounds (they have none today).
 * @returns the effective {@link AgentsLimits} for this run.
 */
export function resolveAgentsLimits(request: RunRequest, _env: EnvConfig): AgentsLimits {
  const param: AgentsParam = request.agents ?? {};
  return {
    bufferLines: param.buffer_lines ?? AGENTS_DEFAULTS.buffer_lines,
    bufferBytes: param.buffer_bytes ?? AGENTS_DEFAULTS.buffer_bytes,
    maxTotalBufferBytes: param.max_total_buffer_bytes ?? AGENTS_DEFAULTS.max_total_buffer_bytes,
    pollMaxBytes: param.poll_max_bytes ?? AGENTS_DEFAULTS.poll_max_bytes,
    awaitTimeoutMs: param.await_timeout_ms ?? AGENTS_DEFAULTS.await_timeout_ms,
    maxLiveChildren: param.max_live_children ?? AGENTS_DEFAULTS.max_live_children,
    maxRetainedChildren: param.max_retained_children ?? AGENTS_DEFAULTS.max_retained_children,
    maxNoticesPerIteration:
      param.max_notices_per_iteration ?? AGENTS_DEFAULTS.max_notices_per_iteration,
    maxConsecutiveFailedChildren:
      param.max_consecutive_failed_children ?? AGENTS_DEFAULTS.max_consecutive_failed_children,
    finishNudges: param.finish_nudges ?? AGENTS_DEFAULTS.finish_nudges,
  };
}
