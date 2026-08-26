/**
 * The one authority for every memory default.
 *
 * `schemas.ts` builds its zod defaults from these values, so the schema cannot
 * disagree with the constant. The loop mirrors them **by value** in its own
 * `memory-settings.ts` — that module must stay import-clean of this package,
 * which is an optional dependency reachable from the loop's main entrypoint —
 * and `packages/loop/tests/unit/memory-settings-drift.test.ts` asserts the two
 * never diverge. It lives over there because only a test may import both.
 */
import type { MemoryBudgets } from "./types.ts";

/**
 * Defaults for the whole memory subsystem.
 *
 * @remarks Grows one block per feature, so every default lands with the code
 * that reads it rather than being declared speculatively.
 */
export const MEMORY_DEFAULTS = {
  /** Memory is opt-in at the host level, but a present block is on unless told otherwise. */
  enabled: true,
  /** Size limits governing the subsystem's LLM interactions. */
  budgets: {
    seed_chars: 6000,
    digest_tokens: 4000,
    /**
     * Operations one index pass may return.
     *
     * @remarks Counts *files*, not facts. A pass must close the pyramid — every
     * touched leaf ships with each ancestor `TOPIC.md` and with `PROFILE.md` —
     * so learning that spans two topics already costs five operations before
     * any second fact is recorded. At 8 a substantive run could not express
     * itself within the budget, and the indexer reports an overage back to the
     * model rather than truncating it away — so a low ceiling bought a wasted
     * correction round-trip, not a smaller write.
     */
    max_index_ops: 16,
  },
  /**
   * How much superseded content is kept so an automatic change can be undone.
   *
   * @remarks `min_revisions` is a floor that outranks both other bounds: an
   * automatic overwrite must stay reversible even for a document that is
   * rewritten often or has not been touched in a long time.
   */
  history: {
    /** Revisions kept per document before the oldest are dropped. */
    keep_revisions: 20,
    /** Age past which a revision may be dropped. */
    keep_days: 90,
    /** Revisions never dropped, whatever the count or age. */
    min_revisions: 3,
  },
} as const;

/**
 * The default {@link MemoryBudgets} used when the host supplies none, and the
 * base a partial `budgets` is merged over.
 */
export const DEFAULT_BUDGETS: MemoryBudgets = { ...MEMORY_DEFAULTS.budgets };
