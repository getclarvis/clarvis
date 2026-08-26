export * from "bun:test";

import { vi as bunVi } from "bun:test";

const nativeAdvanceTimersByTime = bunVi.advanceTimersByTime.bind(bunVi);

type CompatVi = typeof bunVi & {
  advanceTimersByTimeAsync(ms: number): Promise<void>;
};

/**
 * `bun:test`'s `vi` plus the one async timer helper the pool tests need.
 *
 * Bun advances timers synchronously, so a test that has to let an awaited
 * continuation run between ticks needs a yield after the advance. This is the
 * same shim `@clarvis/loop`'s tests carry, narrowed to what this package uses.
 */
export const vi: CompatVi = Object.assign(bunVi, {
  async advanceTimersByTimeAsync(ms: number): Promise<void> {
    nativeAdvanceTimersByTime(ms);
    await Promise.resolve();
  },
});
