/**
 * Keys the live tail should keep presenting.
 *
 * @param previousOwned - keys the tail presented on the previous turn
 * @param mountedKeysInOrder - committed keys currently in the mounted index slice,
 *   chronological
 * @param frontierKeys - mutable keys not yet in a publication batch
 * @param committedKeysInOrder - every committed key in publication order
 * @param followingTail - whether the index slice is fitted to the newest edge
 * @returns committed suffix the tail already owned, then any new frontier keys
 *
 * @remarks The tail owns every frontier key plus the longest mounted-committed
 * suffix it already presented. That suffix stays in the tail after publication so
 * Solid identity survives settle. A newer mounted key the tail never presented
 * (user message, restored history) breaks the suffix. Keys that have committed
 * but are not yet in the mounted slice stay owned while following the tail, so a
 * one-frame slice lag cannot drop them. When the reader is away from the tail,
 * unmounted committed keys are released.
 */
export function selectTailOwnedKeys(
  previousOwned: ReadonlySet<string>,
  mountedKeysInOrder: readonly string[],
  frontierKeys: readonly string[],
  committedKeysInOrder: readonly string[] = mountedKeysInOrder,
  followingTail = true,
): readonly string[] {
  const mountedSet = new Set(mountedKeysInOrder);
  const frontierSet = new Set(frontierKeys);
  const committedSet = new Set(committedKeysInOrder);
  const suffix: string[] = [];
  for (let index = mountedKeysInOrder.length - 1; index >= 0; index -= 1) {
    const key = mountedKeysInOrder[index]!;
    if (!previousOwned.has(key) && !frontierSet.has(key)) break;
    suffix.push(key);
  }
  suffix.reverse();
  const owned = new Set(suffix);
  for (const key of frontierKeys) owned.add(key);
  if (followingTail && mountedKeysInOrder.length > 0) {
    for (const key of previousOwned) {
      if (owned.has(key) || frontierSet.has(key) || mountedSet.has(key)) continue;
      if (committedSet.has(key)) owned.add(key);
    }
  }
  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (key: string): void => {
    if (seen.has(key) || !owned.has(key)) return;
    seen.add(key);
    ordered.push(key);
  };
  for (const key of committedKeysInOrder) push(key);
  for (const key of mountedKeysInOrder) push(key);
  for (const key of previousOwned) push(key);
  for (const key of frontierKeys) push(key);
  return ordered;
}
