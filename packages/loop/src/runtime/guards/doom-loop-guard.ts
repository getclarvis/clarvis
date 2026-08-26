const DOOM_IDENTICAL_FAILURE_THRESHOLD = 3;
const DOOM_CONSECUTIVE_FAILURE_THRESHOLD = 6;

/**
 * Thresholds for the doom-loop guard.
 *
 * @remarks `identicalThreshold` is how many times the *same* call may fail in a
 * row (default 3); `errorThreshold` is how many *consecutive* failures of any
 * call are tolerated (default 6). The identical bound is the tighter of the two
 * because repeating a call that has already failed twice is the one failure mode
 * no additional attempt can resolve, while a mixed run of failures may still be
 * a model working through a genuinely awkward problem — so the any-call bound is
 * set at twice the identical one rather than at a figure of its own.
 *
 * `identicalSoft`/`errorSoft` are the warning tiers, defaulting to one and two
 * below their hard counterparts so the model gets a full iteration of notice
 * before the run dies. The margins differ for a mechanical reason: several
 * results are recorded within a single dispatch batch, so the consecutive-any
 * streak can cross more than one line in one iteration and a one-step margin
 * there could be consumed before the model ever read the warning. The identical
 * streak advances on repeats of one signature, so one step is enough. `0`
 * disables a soft tier. Defaults apply when a field is omitted.
 */
export interface DoomLoopGuardOptions {
  identicalThreshold?: number;
  errorThreshold?: number;
  identicalSoft?: number;
  errorSoft?: number;
}

/** Watches a run of tool failures, warning and then tripping as they accumulate. */
export interface DoomLoopGuard {
  /** Record one tool result by call `signature` and whether it errored; any
   * success resets both failure streaks. */
  record(signature: string, isError: boolean): void;
  /**
   * A pending soft-tier warning, consumed by reading.
   *
   * @returns the warning text, or `null` when none is pending.
   * @remarks One-shot **by read** so the caller keeps no state of its own: a
   *   streak that stays over the soft line warns once, and a success that
   *   clears the streak re-arms it.
   */
  takeSoft(): string | null;
  /** Whether a threshold has been crossed (latches once tripped). */
  tripped(): boolean;
  /** The explanation for the trip, or empty string before it trips. */
  reason(): string;
  /**
   * Clear the trip **and** every counter behind it.
   *
   * @remarks Both halves matter. Clearing only the latch leaves the streaks at
   *   their thresholds, so the very next failure re-trips and a decision to
   *   continue buys nothing.
   */
  reset(): void;
}

/**
 * Create a {@link DoomLoopGuard} that trips on repeated or sustained tool
 * failure.
 *
 * @param opts - threshold overrides; see {@link DoomLoopGuardOptions}.
 * @returns the guard.
 * @remarks Trips when the identical call fails `identicalThreshold` times in a
 *   row, or when any calls fail `errorThreshold` times consecutively. A
 *   non-error result clears both counters; once tripped, further records are
 *   ignored.
 */
export function createDoomLoopGuard(opts: DoomLoopGuardOptions = {}): DoomLoopGuard {
  const identicalThreshold = opts.identicalThreshold ?? DOOM_IDENTICAL_FAILURE_THRESHOLD;
  const errorThreshold = opts.errorThreshold ?? DOOM_CONSECUTIVE_FAILURE_THRESHOLD;
  const identicalSoft = opts.identicalSoft ?? Math.max(0, identicalThreshold - 1);
  const errorSoft = opts.errorSoft ?? Math.max(0, errorThreshold - 2);

  let lastSig: string | undefined;
  let repeatedFailures = 0;
  let consecutiveFailures = 0;
  let tripped = false;
  let reasonText = "";
  let pendingSoft: string | null = null;
  let identicalWarned = false;
  let errorWarned = false;

  /**
   * Accumulates rather than overwrites: several results are recorded within one
   * dispatch batch, and a single slot let a later warning erase an earlier one
   * before the loop ever read it.
   */
  const addSoft = (message: string): void => {
    pendingSoft = pendingSoft === null ? message : `${pendingSoft} Also: ${message}`;
  };

  const clearCounters = (): void => {
    consecutiveFailures = 0;
    repeatedFailures = 0;
    lastSig = undefined;
    identicalWarned = false;
    errorWarned = false;
  };

  return {
    record(signature: string, isError: boolean): void {
      if (tripped) return;
      if (isError) {
        consecutiveFailures += 1;
        repeatedFailures = signature === lastSig ? repeatedFailures + 1 : 1;
        lastSig = signature;
      } else {
        clearCounters();
      }
      if (repeatedFailures >= identicalThreshold) {
        tripped = true;
        reasonText =
          `The identical tool call failed ${repeatedFailures} times in a row ` +
          `(threshold ${identicalThreshold}); terminating to avoid an unproductive loop.`;
        return;
      }
      if (consecutiveFailures >= errorThreshold) {
        tripped = true;
        reasonText =
          `${consecutiveFailures} consecutive tool calls failed ` +
          `(threshold ${errorThreshold}); terminating to avoid an unproductive loop.`;
        return;
      }
      if (identicalSoft > 0 && repeatedFailures >= identicalSoft && !identicalWarned) {
        identicalWarned = true;
        addSoft(
          `the identical tool call has now failed ${repeatedFailures} times in a row, ` +
            `and the run stops at ${identicalThreshold}. Try a different approach.`,
        );
      } else if (errorSoft > 0 && consecutiveFailures >= errorSoft && !errorWarned) {
        errorWarned = true;
        addSoft(
          `${consecutiveFailures} tool calls have failed in a row, ` +
            `and the run stops at ${errorThreshold}. Try a different approach.`,
        );
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
      clearCounters();
    },
  };
}
