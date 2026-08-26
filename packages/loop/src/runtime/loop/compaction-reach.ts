import type { Logger } from "@clarvis/capability";
import { NOOP_LOGGER } from "@clarvis/capability";
import type { CompactionConfig } from "../context/context-compaction.ts";

/** Per-agent-loop state behind `compaction.unreachable`. */
export interface CompactionReachWatch {
  /**
   * Fold in one context-overflow rejection.
   *
   * @param observedTokens - the estimated size of the prompt the provider just
   *   refused.
   */
  observeOverflow(observedTokens: number): void;
}

/**
 * Create the per-agent-loop {@link CompactionReachWatch}.
 *
 * @param config - the agent's resolved {@link CompactionConfig}.
 * @param logger - the agent-bound logger.
 * @returns a watch that reports at most once per agent loop.
 * @remarks `windowTokens` comes from a request's `context_window_tokens` and
 *   nothing verifies it against the model. Declaring one far wider than the
 *   model really has pushes the high-water mark past any conversation the
 *   provider would accept, so compaction is configured on and silently never
 *   fires. `specs/engine/context-compaction.md` §6 records the failure and the
 *   one signal that diagnoses it, precisely because the user otherwise "has no
 *   way to learn they have turned compaction off".
 *
 *   The evidence is a provider rejection, and nothing else. The engine holds no
 *   independent knowledge of a model's real window, so a comparison against
 *   `CLARVIS_DEFAULT_CONTEXT_WINDOW_TOKENS` — the previous test — said only that
 *   the declared window was larger than a constant, and a correctly declared
 *   200k window tripped it on every agent of every run. A `context_overflow`
 *   error raised while the context is still *below* the high-water mark is the
 *   one observation that proves the trigger unreachable: the provider refused a
 *   prompt smaller than the size at which Clarvis would have compacted, so the
 *   real window is smaller than the trigger and no conversation can ever reach
 *   it. Above the high-water mark the trigger is plainly reachable and the
 *   overflow means something else — a low `target_fraction`, or non-evictable
 *   content — which this event must not claim.
 *
 *   This is a diagnosis, not a clamp. Clamping the high-water mark alone is a
 *   no-op, because the low-water mark still derives from the unclamped window.
 */
export function createCompactionReachWatch(
  config: CompactionConfig,
  logger: Logger = NOOP_LOGGER,
): CompactionReachWatch {
  let reported = false;
  return {
    observeOverflow(observedTokens: number): void {
      if (reported || !config.enabled) return;
      const highWaterTokens = Math.floor(config.windowTokens * config.fraction);
      if (observedTokens >= highWaterTokens) return;
      reported = true;
      logger.warn(
        {
          event: "compaction.unreachable",
          declared_window_tokens: config.windowTokens,
          high_water_tokens: highWaterTokens,
          observed_tokens: observedTokens,
        },
        "the provider refused a prompt smaller than compaction's trigger; the declared context " +
          "window is wider than the model's real one, so scheduled compaction can never fire and " +
          "every turn pays an emergency eviction instead",
      );
    },
  };
}
