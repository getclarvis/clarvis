import type { SessionClock } from "#src/lib/execution-session.ts";

/** A test-owned clock that delivers scheduled callbacks in deadline order. */
export function manualClock() {
  let time = 0;
  let nextId = 0;
  const tasks = new Map<number, { due: number; fn: () => void }>();
  const clock: SessionClock = {
    now: () => time,
    setTimeout(fn, ms) {
      const id = ++nextId;
      tasks.set(id, { due: time + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      tasks.delete(handle as number);
    },
  };
  const advance = async (ms: number) => {
    const end = time + ms;
    while (true) {
      const first = [...tasks].sort((a, b) => a[1].due - b[1].due)[0];
      if (first === undefined || first[1].due > end) break;
      time = first[1].due;
      tasks.delete(first[0]);
      first[1].fn();
      await Promise.resolve();
    }
    time = end;
    await Promise.resolve();
  };
  return { clock, advance, pending: () => tasks.size };
}
