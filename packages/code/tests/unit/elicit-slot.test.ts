import { expect, test } from "bun:test";
import type { ElicitRequestParams, ElicitResult } from "../../src/adapters/elicit-types.ts";
import { createElicitSlot } from "../../src/adapters/elicit-slot.ts";

const REQ_A = { message: "question A" } as ElicitRequestParams;
const REQ_B = { message: "question B" } as ElicitRequestParams;

/** Deterministic clock/ticker so the countdown is exercised without waiting. */
function fakeRuntime() {
  let now = 1_000;
  let nextId = 1;
  const timers = new Map<number, { every: number; tick: () => void; last: number }>();
  return {
    runtime: {
      now: () => now,
      every: (ms: number, tick: () => void) => {
        const id = nextId++;
        timers.set(id, { every: ms, tick, last: now });
        return () => void timers.delete(id);
      },
    },
    advance(ms: number): void {
      now += ms;
      for (const entry of [...timers.values()]) {
        while (entry.last + entry.every <= now) {
          entry.last += entry.every;
          entry.tick();
        }
      }
    },
    get liveTimers(): number {
      return timers.size;
    },
  };
}

/** Two microtask turns: one for the presenter, one for the slot's `.then`. */
async function settleProjection(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("ask parks the request; resolve settles the promise and clears the slot", async () => {
  const slot = createElicitSlot();
  expect(slot.request()).toBeNull();
  const answered = slot.ask(REQ_A);
  expect(slot.request()).toBe(REQ_A);
  slot.resolve({ action: "accept", content: { x: "1" } });
  expect(slot.request()).toBeNull();
  expect(await answered).toEqual({ action: "accept", content: { x: "1" } });
});

test("a superseding ask answers the previous request cancel — never an abandoned promise", async () => {
  const slot = createElicitSlot();
  const first = slot.ask(REQ_A);
  const second = slot.ask(REQ_B);
  expect(await first).toEqual({ action: "cancel" });
  expect(slot.request()).toBe(REQ_B);
  slot.resolve({ action: "decline" });
  expect(await second).toEqual({ action: "decline" });
});

test("cancelPending answers cancel only when a request is pending", async () => {
  const slot = createElicitSlot();
  slot.cancelPending();
  expect(slot.request()).toBeNull();
  const pending = slot.ask(REQ_A);
  slot.cancelPending();
  expect(await pending).toEqual({ action: "cancel" });
  expect(slot.request()).toBeNull();
});

test("a question the kernel retires is settled by id, without a human answer", async () => {
  const slot = createElicitSlot();
  const answered = slot.ask({ ...REQ_A, id: "q1", windowMs: 30_000 }, async () => 30_000);
  slot.settle("q2");
  expect(slot.request()?.id).toBe("q1");
  expect(slot.remaining()).toBeNull();
  slot.settle("q1");
  expect(slot.request()).toBeNull();
  expect(await answered).toEqual({ action: "decline", settled: true });
});

test("settling an empty slot is a safe no-op", () => {
  const slot = createElicitSlot();
  slot.settle("q1");
  expect(slot.request()).toBeNull();
});

test("a late resolve after the slot was already settled is a safe no-op", async () => {
  const slot = createElicitSlot();
  const results: ElicitResult[] = [];
  void slot.ask(REQ_A).then((r) => results.push(r));
  slot.resolve({ action: "accept", content: {} });
  slot.resolve({ action: "decline" });
  await Promise.resolve();
  expect(results).toEqual([{ action: "accept", content: {} }]);
});

test("present confirms once and counts the kernel's projection down to zero", async () => {
  const clock = fakeRuntime();
  const slot = createElicitSlot(clock.runtime);
  let confirms = 0;
  const answered = slot.ask({ ...REQ_A, id: "q1", windowMs: 30_000 }, async () => {
    confirms += 1;
    return 30_000;
  });
  expect(slot.remaining()).toBeNull();
  slot.present();
  await settleProjection();
  expect(confirms).toBe(1);
  expect(slot.remaining()).toBe(30_000);
  clock.advance(1_000);
  expect(slot.remaining()).toBe(29_000);
  slot.present();
  await settleProjection();
  expect(confirms).toBe(1);
  clock.advance(29_000);
  expect(slot.remaining()).toBe(0);
  expect(clock.liveTimers).toBe(0);
  slot.resolve({ action: "decline" });
  expect(await answered).toEqual({ action: "decline" });
});

test("a question the kernel does not window never counts down", async () => {
  const clock = fakeRuntime();
  const slot = createElicitSlot(clock.runtime);
  void slot.ask(REQ_A, async () => undefined);
  slot.present();
  await settleProjection();
  expect(slot.remaining()).toBeNull();
  expect(clock.liveTimers).toBe(0);
});

test("a projection that lands after the question changed cannot arm the next one", async () => {
  const clock = fakeRuntime();
  const slot = createElicitSlot(clock.runtime);
  let release: ((remaining: number | undefined) => void) | undefined;
  const first = slot.ask(
    REQ_A,
    () =>
      new Promise<number | undefined>((resolve) => {
        release = resolve;
      }),
  );
  slot.present();
  const second = slot.ask(REQ_B, async () => 30_000);
  expect(await first).toEqual({ action: "cancel" });
  release?.(30_000);
  await settleProjection();
  expect(slot.remaining()).toBeNull();
  expect(clock.liveTimers).toBe(0);
  slot.resolve({ action: "decline" });
  expect(await second).toEqual({ action: "decline" });
});

test("resolving stops the countdown and clears the remaining projection", async () => {
  const clock = fakeRuntime();
  const slot = createElicitSlot(clock.runtime);
  void slot.ask(REQ_A, async () => 30_000);
  slot.present();
  await settleProjection();
  expect(clock.liveTimers).toBe(1);
  slot.resolve({ action: "accept", content: {} });
  expect(clock.liveTimers).toBe(0);
  expect(slot.remaining()).toBeNull();
});
