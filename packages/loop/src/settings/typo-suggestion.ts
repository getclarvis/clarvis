/**
 * Deciding when an unrecognized key is a misspelling of a known one rather than a
 * key belonging to another host.
 *
 * @remarks
 * Every reader in this directory that accepts a foreign document tolerantly needs
 * the same judgement, and two copies of a heuristic drift into two different
 * answers for the same key. One owner, so a change to how forgiving Clarvis is
 * lands everywhere it is asked.
 */

/**
 * Levenshtein distance between two keys, bounded by `limit`.
 *
 * @param a - one key.
 * @param b - the other.
 * @param limit - the distance past which the exact value stops mattering.
 * @returns the distance, or a value greater than `limit` once it is known to
 *   exceed it — the caller only ever compares against the threshold.
 */
export function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    if (Math.min(...current) > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * The largest edit distance at which `candidate` is still read as a misspelling
 * of a known key rather than as a different word.
 *
 * @param candidate - the unrecognized key.
 * @returns the inclusive distance budget.
 * @remarks Short keys get a tighter budget. At distance 2 a four-letter key like
 *   `name` would swallow half the dictionary, and a foreign host's key wrongly
 *   reported as *our* typo is worse than one reported as merely unrecognized.
 */
export function typoBudget(candidate: string): number {
  return candidate.length <= 4 ? 1 : 2;
}
