/** Explicit user choice survives content revisions and native owner disposal. */
export type BlockOverride = "expanded" | "collapsed";

/**
 * Steps `delta` positions from `current` within `keys`, clamped to the list's
 * bounds. Returns `null` when `keys` is empty; an unrecognized `current`
 * starts from the last key.
 */
export function nextFocus(keys: string[], current: string | null, delta: number): string | null {
  if (keys.length === 0) return null;
  const idx = current === null ? -1 : keys.indexOf(current);
  if (idx === -1) return keys[keys.length - 1]!;
  const next = Math.max(0, Math.min(keys.length - 1, idx + delta));
  return keys[next]!;
}
