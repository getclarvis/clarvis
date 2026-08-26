import { afterEach, beforeEach, describe, it, expect, vi } from "../bun-test.ts";
import { withGuardElicitWaitBound } from "../../src/runtime/capabilities/tools.ts";
import type {
  Elicit as GuardElicit,
  ElicitRequest,
} from "../../src/runtime/tools/builtin/index.ts";

const req: ElicitRequest = { tool: "shell", args: { command: "rm -rf /tmp/x" } };
const never: GuardElicit = () => new Promise<boolean>(() => {});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("withGuardElicitWaitBound", () => {
  it("denies (false) when a non-conforming guardElicit never resolves, once the bound elapses", async () => {
    const bounded = withGuardElicitWaitBound(never, 20, undefined);
    const pending = bounded(req);
    await vi.advanceTimersByTimeAsync(20);
    await expect(pending).resolves.toBe(false);
  });

  it("passes through an allow (true) that arrives within the bound", async () => {
    const bounded = withGuardElicitWaitBound(() => Promise.resolve(true), 1000, undefined);
    await expect(bounded(req)).resolves.toBe(true);
  });

  it("passes through a deny (false)", async () => {
    const bounded = withGuardElicitWaitBound(() => Promise.resolve(false), 1000, undefined);
    await expect(bounded(req)).resolves.toBe(false);
  });

  it("preserves a rich judge answer within the wait bound", async () => {
    const answer = { allowed: true, answerer: "judge" as const };
    const bounded = withGuardElicitWaitBound(() => Promise.resolve(answer), 1000, undefined);
    await expect(bounded(req)).resolves.toEqual(answer);
  });

  it("denies when the guardElicit throws, rather than aborting the run", async () => {
    const bounded = withGuardElicitWaitBound(
      () => {
        throw new Error("boom");
      },
      1000,
      undefined,
    );
    await expect(bounded(req)).resolves.toBe(false);
  });

  it("denies immediately on an already-aborted signal without invoking the elicit", async () => {
    const ac = new AbortController();
    ac.abort();
    let called = false;
    const bounded = withGuardElicitWaitBound(
      () => {
        called = true;
        return Promise.resolve(true);
      },
      1000,
      ac.signal,
    );
    await expect(bounded(req)).resolves.toBe(false);
    expect(called).toBe(false);
  });

  it("passes an already-available answer straight through at a zero/infinite bound", async () => {
    await expect(withGuardElicitWaitBound(() => true, 0, undefined)(req)).resolves.toBe(true);
    await expect(withGuardElicitWaitBound(() => true, Infinity, undefined)(req)).resolves.toBe(
      true,
    );
  });

  it("waitMs 0 means never block on a human: denies promptly rather than waiting forever", async () => {
    const pending = withGuardElicitWaitBound(never, 0, undefined)(req);
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toBe(false);
  });

  it("arms no timer only for a non-finite bound: an unresolved elicit stays pending there", async () => {
    let settled = false;
    void Promise.resolve(withGuardElicitWaitBound(never, Infinity, undefined)(req)).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(30);
    expect(settled).toBe(false);
  });

  it("denies when the run signal aborts mid-wait", async () => {
    const ac = new AbortController();
    const bounded = withGuardElicitWaitBound(never, 10_000, ac.signal);
    const p = bounded(req);
    ac.abort();
    await expect(p).resolves.toBe(false);
  });

  it("swallows a guardElicit resolution that lands after the bound already denied", async () => {
    let resolveLate!: (value: boolean) => void;
    const late: GuardElicit = () => new Promise<boolean>((resolve) => (resolveLate = resolve));
    const bounded = withGuardElicitWaitBound(late, 5, undefined);
    const pending = bounded(req);
    await vi.advanceTimersByTimeAsync(5);
    await expect(pending).resolves.toBe(false);
    resolveLate(true);
    await Promise.resolve();
  });
});
