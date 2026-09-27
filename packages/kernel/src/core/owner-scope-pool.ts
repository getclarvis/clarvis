import { kernelError } from "./errors.ts";

/** A timer owned by one owner generation; cancellation must be idempotent. */
export interface OwnerScopeTimer {
  cancel(): void;
  unref(): void;
}

/** Clock and scheduler share one time source for idle expiry. */
export interface OwnerScopeClock {
  now(): number;
  schedule(delayMs: number, callback: () => void): OwnerScopeTimer;
}

const SYSTEM_CLOCK: OwnerScopeClock = {
  now: Date.now,
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    return { cancel: () => clearTimeout(timer), unref: () => timer.unref?.() };
  },
};

interface OwnerEntry<T> {
  value: T;
  generation: number;
  refs: number;
  runRefs: number;
  runDrained?: Promise<void>;
  resolveRunDrained?: () => void;
  pinned: boolean;
  lastUsedAt: number;
  timer?: OwnerScopeTimer;
}

/** Private owner residency policy; product service construction remains with the caller. */
export function createOwnerScopePool<T>(options: {
  maxOwners: number;
  idleMs: number;
  build(owner: string, generation: number): T;
  retire(owner: string, value: T): Promise<void>;
  observeRetirement(promise: Promise<void>): void;
  isOpen(): boolean;
  clock?: OwnerScopeClock;
}) {
  const clock = options.clock ?? SYSTEM_CLOCK;
  const entries = new Map<string, OwnerEntry<T>>();
  const retiring = new Map<string, Promise<void>>();
  let generation = 0;
  let sealed = false;
  let closing: Promise<void> | undefined;

  const current = (owner: string, id: number): OwnerEntry<T> | undefined => {
    const entry = entries.get(owner);
    return entry?.generation === id ? entry : undefined;
  };
  const cancelTimer = (entry: OwnerEntry<T>): void => {
    entry.timer?.cancel();
    delete entry.timer;
  };
  const retire = (owner: string, entry: OwnerEntry<T>): Promise<void> => {
    if (entry.refs > 0 || entry.runRefs > 0 || entry.pinned) return Promise.resolve();
    if (current(owner, entry.generation) !== entry) return retiring.get(owner) ?? Promise.resolve();
    cancelTimer(entry);
    entries.delete(owner);
    const pending = Promise.resolve()
      .then(() => options.retire(owner, entry.value))
      .finally(() => {
        if (retiring.get(owner) === pending) retiring.delete(owner);
      });
    retiring.set(owner, pending);
    options.observeRetirement(pending);
    return pending;
  };
  const scheduleRetirement = (owner: string, entry: OwnerEntry<T>): void => {
    if (
      sealed ||
      entry.refs > 0 ||
      entry.runRefs > 0 ||
      entry.pinned ||
      current(owner, entry.generation) !== entry
    )
      return;
    cancelTimer(entry);
    if (options.idleMs === 0) {
      retire(owner, entry).catch(() => undefined);
      return;
    }
    const id = entry.generation;
    entry.timer = clock.schedule(options.idleMs, () => {
      if (current(owner, id) !== entry) return;
      delete entry.timer;
      retire(owner, entry).catch(() => undefined);
    });
    entry.timer.unref();
  };
  const evictIdle = (): void => {
    let candidate: [string, OwnerEntry<T>] | undefined;
    for (const pair of entries) {
      const entry = pair[1];
      if (entry.refs > 0 || entry.runRefs > 0 || entry.pinned) continue;
      if (candidate === undefined || entry.lastUsedAt < candidate[1].lastUsedAt) candidate = pair;
    }
    if (candidate !== undefined) retire(candidate[0], candidate[1]).catch(() => undefined);
  };
  const resident = (owner: string, pin: boolean): T => {
    if (owner.trim() === "")
      throw new Error("InProcessKernel.forOwner: 'owner' must be a non-empty string.");
    if (sealed || !options.isOpen()) throw kernelError("unavailable", "kernel is closing");
    if (retiring.has(owner))
      throw kernelError("unavailable", `owner '${owner}' is still releasing resources`);
    const hit = entries.get(owner);
    if (hit !== undefined) {
      hit.lastUsedAt = clock.now();
      if (pin) hit.pinned = true;
      cancelTimer(hit);
      return hit.value;
    }
    if (entries.size + retiring.size >= options.maxOwners) evictIdle();
    if (entries.size + retiring.size >= options.maxOwners)
      throw kernelError(
        "resource_exhausted",
        `kernel owner cache is full (${options.maxOwners} active, pinned, or retiring owners)`,
      );
    const id = ++generation;
    const value = options.build(owner, id);
    entries.set(owner, {
      value,
      generation: id,
      refs: 0,
      runRefs: 0,
      pinned: pin,
      lastUsedAt: clock.now(),
    });
    return value;
  };

  return {
    resident,
    isCurrent(owner: string, id: number): boolean {
      return current(owner, id) !== undefined;
    },
    acquire(owner: string): Promise<{ value: T; release(): void }> {
      return (async () => {
        const pending = retiring.get(owner);
        if (pending !== undefined) await pending;
        const value = resident(owner, false);
        const entry = entries.get(owner)!;
        entry.refs++;
        let released = false;
        return {
          value,
          release(): void {
            if (released) return;
            released = true;
            entry.refs = Math.max(0, entry.refs - 1);
            entry.lastUsedAt = clock.now();
            scheduleRetirement(owner, entry);
          },
        };
      })();
    },
    retainRun(owner: string, id: number): () => void {
      const entry = current(owner, id);
      if (entry === undefined)
        throw kernelError("unavailable", `owner '${owner}' is no longer resident`);
      cancelTimer(entry);
      if (entry.runRefs === 0) {
        let resolve!: () => void;
        entry.runDrained = new Promise<void>((done) => {
          resolve = done;
        });
        entry.resolveRunDrained = resolve;
      }
      entry.runRefs++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        entry.runRefs = Math.max(0, entry.runRefs - 1);
        if (entry.runRefs === 0) {
          entry.resolveRunDrained?.();
          delete entry.resolveRunDrained;
          delete entry.runDrained;
        }
        entry.lastUsedAt = clock.now();
        scheduleRetirement(owner, entry);
      };
    },
    async startRun<R extends { closed: Promise<unknown> }>(
      owner: string,
      id: number,
      start: () => Promise<R>,
    ): Promise<R> {
      const release = this.retainRun(owner, id);
      try {
        const handle = await start();
        handle.closed.then(release, release).catch(() => undefined);
        return handle;
      } catch (error) {
        release();
        throw error;
      }
    },
    hasActiveRuns(): boolean {
      return [...entries.values()].some((entry) => entry.runRefs > 0);
    },
    forEachResident(callback: (value: T) => void): void {
      for (const entry of entries.values()) callback(entry.value);
    },
    close(): Promise<void> {
      if (closing !== undefined) return closing;
      sealed = true;
      closing = (async () => {
        const pending: Promise<void>[] = [];
        for (const [owner, entry] of entries) {
          cancelTimer(entry);
          entry.refs = 0;
          entry.pinned = false;
          pending.push(
            entry.runDrained === undefined
              ? retire(owner, entry)
              : entry.runDrained.then(() => retire(owner, entry)),
          );
        }
        pending.push(...retiring.values());
        await Promise.allSettled(pending);
      })();
      return closing;
    },
  };
}
