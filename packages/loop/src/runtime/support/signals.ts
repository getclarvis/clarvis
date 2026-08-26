/**
 * Combine up to two abort signals into one that aborts when either does.
 *
 * @param a - first optional signal.
 * @param b - second optional signal.
 * @returns `undefined` when neither is given; the single signal when only one
 *   is; otherwise a composite via `AbortSignal.any` that fires on the first
 *   abort.
 */
export function combineSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  const sigs = [a, b].filter((s): s is AbortSignal => s !== undefined);
  if (sigs.length === 0) return undefined;
  if (sigs.length === 1) return sigs[0];
  return AbortSignal.any(sigs);
}
