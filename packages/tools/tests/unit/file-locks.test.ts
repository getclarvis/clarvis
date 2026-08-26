/**
 * `withFileLocks` must be deadlock-free for overlapping path sets.
 *
 * @remarks Two mutating tools really do lock two paths at once — `move` locks
 * `[src, dst]` and `apply_patch` locks every file its hunks touch — so two
 * concurrent calls can hold overlapping sets. Acquisition is a promise chain
 * per path, which makes the classic hold-and-wait cycle a genuine deadlock
 * rather than a slow path: caller A holding `a` and awaiting `b` while caller B
 * holds `b` and awaits `a` never settles, and nothing times it out.
 *
 * The sort in `withFileLocks` is the whole defence, and it is one expression
 * with no test naming it. These tests race every assertion against a timer, so
 * removing the sort fails the suite in milliseconds instead of hanging it until
 * the 60s per-test timeout.
 */
import { describe, expect, it } from "bun:test";
import { withFileLocks } from "../../src/lib/atomic.ts";

/** Reject rather than hang, so a deadlock regression reports as a failure. */
function within<T>(ms: number, work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`deadlocked: no settle within ${String(ms)}ms`)), ms),
    ),
  ]);
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe("withFileLocks", () => {
  it("does not deadlock when two callers request the same pair in opposite orders", async () => {
    const order: string[] = [];

    const a = withFileLocks(["/w/b.txt", "/w/a.txt"], async () => {
      order.push("a:enter");
      await tick();
      order.push("a:exit");
    });
    const b = withFileLocks(["/w/a.txt", "/w/b.txt"], async () => {
      order.push("b:enter");
      await tick();
      order.push("b:exit");
    });

    await within(2_000, Promise.all([a, b]));

    expect(order).toHaveLength(4);
    expect(order[1]).toBe(order[0]!.replace(":enter", ":exit"));
  });

  it("serializes overlapping sets rather than letting both sections run at once", async () => {
    let inside = 0;
    let peak = 0;
    const section = async (): Promise<void> => {
      inside += 1;
      peak = Math.max(peak, inside);
      await tick();
      inside -= 1;
    };

    await within(
      2_000,
      Promise.all([
        withFileLocks(["/w/x", "/w/y"], section),
        withFileLocks(["/w/y", "/w/x"], section),
        withFileLocks(["/w/y"], section),
      ]),
    );

    expect(peak).toBe(1);
  });

  it("lets disjoint sets proceed concurrently", async () => {
    let inside = 0;
    let peak = 0;
    const section = async (): Promise<void> => {
      inside += 1;
      peak = Math.max(peak, inside);
      await tick();
      inside -= 1;
    };

    await within(
      2_000,
      Promise.all([
        withFileLocks(["/w/p", "/w/q"], section),
        withFileLocks(["/w/r", "/w/s"], section),
      ]),
    );

    expect(peak).toBe(2);
  });

  it("collapses duplicates so one path is never awaited behind itself", async () => {
    const ran = await within(
      2_000,
      withFileLocks(["/w/dup", "/w/dup", "/w/dup"], () => Promise.resolve("ok")),
    );
    expect(ran).toBe("ok");
  });

  it("releases every held path when the section rejects", async () => {
    await expect(
      withFileLocks(["/w/m", "/w/n"], () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");

    const after = await within(
      2_000,
      withFileLocks(["/w/n", "/w/m"], () => Promise.resolve("still usable")),
    );
    expect(after).toBe("still usable");
  });
});
