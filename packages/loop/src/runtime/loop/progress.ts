/**
 * Tracks a consecutive run of unproductive iterations to detect a stalled agent:
 * `bump` records each iteration and reports whether the no-progress limit is now
 * reached, `streak` reads the current unproductive count, and `reset` clears it.
 */
export interface ProgressTracker {
  bump(productive: boolean): boolean;
  streak(): number;
  reset(): void;
}

/**
 * Create a {@link ProgressTracker} that trips once unproductive iterations reach a
 * limit.
 *
 * @param limit - the streak length at which `bump` returns `true`.
 * @returns a tracker whose `bump(true)` resets the streak and returns `false`,
 *   and whose `bump(false)` increments the streak, returning `true` only once it
 *   reaches `limit`.
 */
export function createProgressTracker(limit: number): ProgressTracker {
  let streak = 0;
  return {
    bump(productive: boolean): boolean {
      if (productive) {
        streak = 0;
        return false;
      }
      streak += 1;
      return streak >= limit;
    },
    streak(): number {
      return streak;
    },
    reset(): void {
      streak = 0;
    },
  };
}
