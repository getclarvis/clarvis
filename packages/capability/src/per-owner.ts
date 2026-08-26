/**
 * Memoize a per-owner provider so each owner's instance is built at most once.
 *
 * @typeParam T - the per-owner instance type.
 * @param build - constructs the instance for an owner; called once per distinct
 *   owner and never again.
 * @returns a resolver serving the memoized instance.
 * @remarks Entries are **never evicted**. A per-owner instance may hold exclusive
 * state — a memory tree's on-disk lock, a plan repository's mutex — that a second
 * instance built over the same tree would not observe, which is exactly the
 * failure this guards against. Bounding how many owners a process serves is a
 * deployment concern, not a cache policy.
 */
export function memoizeByOwner<T>(build: (owner: string) => T): (owner: string) => T {
  const cache = new Map<string, T>();
  return (owner: string): T => {
    const hit = cache.get(owner);
    if (hit !== undefined) return hit;
    const built = build(owner);
    cache.set(owner, built);
    return built;
  };
}

/**
 * Build a per-owner provider that hands every owner the same one instance,
 * built at most once total.
 *
 * @typeParam T - the shared instance type.
 * @param build - constructs the instance; called at most once, on first use.
 * @returns a `(owner) => T` provider that ignores its argument.
 * @remarks The default fallback for a host that supplies no per-owner factory,
 * so every owner collapses onto the single store the local product has always
 * used. Meant to be composed as {@link memoizeByOwner}'s own fallback build
 * function — `memoizeByOwner(opts.storeFor ?? sharedFallback(() => ...))` —
 * never as a replacement for it: {@link memoizeByOwner}'s cache is keyed by
 * owner, so building directly inside it would build one instance *per* owner.
 * This holds the single build outside that cache instead, so a rebuild
 * triggered by a settings change in the per-owner layer above it can never
 * produce a second instance over the same underlying resource — which, for a
 * file-backed store, would mean two independent exclusion locks over one tree.
 */
export function sharedFallback<T>(build: () => T): (owner: string) => T {
  let instance: T | undefined;
  return (): T => (instance ??= build());
}
