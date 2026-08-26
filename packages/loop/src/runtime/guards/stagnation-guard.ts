/** Options for the stagnation guard; `threshold` is the repeat count that trips
 * it (default 3, `<= 0` disables the guard) and `soft` the repeat count that
 * warns (default one below `threshold`, `0` disables the warning). */
export interface StagnationGuardOptions {
  threshold?: number;
  soft?: number;
}

/** Warns and then trips when the same tool call keeps returning the identical
 * result — progress has stalled even though nothing is failing. */
export interface StagnationGuard {
  /** Record one tool result: its call `signature`, a `resultHash` of its output
   * (see {@link hashResult}), and whether it errored (errors reset the streak). */
  record(signature: string, resultHash: number, isError: boolean): void;
  /**
   * A pending soft-tier warning, consumed by reading.
   *
   * @returns the warning text, or `null` when none is pending.
   * @remarks One-shot by read, so a signature sitting over the soft line warns
   *   once rather than on every repeat.
   */
  takeSoft(): string | null;
  /** Whether the repeat threshold has been reached (latches once tripped). */
  tripped(): boolean;
  /** The explanation for the trip, or empty string before it trips. */
  reason(): string;
  /**
   * Clear the trip and the active consecutive-repeat counter.
   *
   * @remarks The active observation must go too. It already sits at the
   *   threshold when the guard tripped, so clearing only the latch would
   *   re-trip on the very next repeat.
   */
  reset(): void;
}

interface ActiveObservation {
  signatureHash: number;
  resultHash: number;
  repeat: number;
  warned?: boolean;
}

/**
 * Create a {@link StagnationGuard} that trips when one call's result hash repeats
 * `threshold` times.
 *
 * @param opts - the repeat threshold; see {@link StagnationGuardOptions}.
 * @returns the guard, or an inert no-op guard when `threshold <= 0`.
 * @remarks Only a consecutive streak of the same call and result is stagnant.
 *   Any different call, changed result, or error resets the streak; successful
 *   verification repeated after edits is therefore progress, not stagnation.
 *   The active signature is retained only as an FNV-1a hash, so one large tool
 *   argument does not remain in memory. A spurious signature collision still
 *   needs the independent result hash to collide before it can affect a streak.
 */
export function createStagnationGuard(opts: StagnationGuardOptions = {}): StagnationGuard {
  const raw = opts.threshold ?? 3;
  if (raw <= 0) {
    return {
      record() {},
      takeSoft() {
        return null;
      },
      tripped() {
        return false;
      },
      reason() {
        return "";
      },
      reset() {},
    };
  }
  const threshold = raw;
  const soft = opts.soft ?? Math.max(0, threshold - 1);

  let active: ActiveObservation | undefined;
  let tripped = false;
  let reasonText = "";
  let pendingSoft: string | null = null;

  const trip = (repeat: number): void => {
    tripped = true;
    reasonText =
      `The identical result from the same tool call was observed ${repeat} times ` +
      `(threshold ${threshold}); ` +
      `terminating to avoid an unproductive loop.`;
  };

  return {
    record(signature: string, resultHash: number, isError: boolean): void {
      if (tripped) return;
      if (isError) {
        active = undefined;
        return;
      }

      const sigHash = hashResult(signature);
      if (
        active === undefined ||
        active.signatureHash !== sigHash ||
        active.resultHash !== resultHash
      ) {
        active = { signatureHash: sigHash, resultHash, repeat: 1 };
        return;
      }

      active.repeat += 1;
      if (active.repeat >= threshold) {
        trip(active.repeat);
        return;
      }
      if (soft > 0 && active.repeat >= soft && !active.warned) {
        active.warned = true;
        pendingSoft =
          `the same tool call has returned the identical result ${active.repeat} times in a row, ` +
          `and the run stops at ${threshold}. Change the call or take a different step.`;
      }
    },
    takeSoft(): string | null {
      const out = pendingSoft;
      pendingSoft = null;
      return out;
    },
    tripped(): boolean {
      return tripped;
    },
    reason(): string {
      return reasonText;
    },
    reset(): void {
      tripped = false;
      reasonText = "";
      pendingSoft = null;
      active = undefined;
    },
  };
}

/**
 * FNV-1a 32-bit hash of a result string, used to detect identical tool outputs
 * cheaply without retaining the full text.
 *
 * @param text - the result text to hash.
 * @returns an unsigned 32-bit hash.
 */
export function hashResult(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}
