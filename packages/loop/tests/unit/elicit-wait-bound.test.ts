import { afterEach, beforeEach, describe, it, expect, vi } from "../bun-test.ts";
import {
  withElicitWaitBound,
  ElicitTimeoutError,
  type Elicit,
  type ElicitParams,
} from "../../src/runtime/tools/ask-user-tool.ts";

const params: ElicitParams = {
  message: "q",
  requestedSchema: {
    type: "object",
    properties: { response: { type: "string" } },
    required: ["response"],
  },
};

const never: Elicit = () => new Promise(() => {});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("withElicitWaitBound", () => {
  it("rejects with ElicitTimeoutError when a non-conforming elicit never settles", async () => {
    const bounded = withElicitWaitBound(never, 20);
    const pending = bounded(params, { timeoutMs: 30 });
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).rejects.toBeInstanceOf(ElicitTimeoutError);
  });

  it("passes through a resolution that arrives within the bound", async () => {
    const elicit: Elicit = async () => ({ action: "accept", content: { response: "yes" } });
    const bounded = withElicitWaitBound(elicit, 20);
    await expect(bounded(params, { timeoutMs: 1000 })).resolves.toEqual({
      action: "accept",
      content: { response: "yes" },
    });
  });

  it("propagates the inner elicit's own rejection", async () => {
    const boom = new Error("inner failure");
    const bounded = withElicitWaitBound(() => Promise.reject(boom), 20);
    await expect(bounded(params, { timeoutMs: 1000 })).rejects.toBe(boom);
  });

  it("does not race when no timeoutMs is given", async () => {
    let resolve!: (result: { action: "decline" }) => void;
    const elicit: Elicit = () => new Promise((done) => (resolve = done));
    const bounded = withElicitWaitBound(elicit, 0);
    const pending = bounded(params, {});
    resolve({ action: "decline" });
    await expect(pending).resolves.toEqual({ action: "decline" });
  });

  it("a zero bound (never block on a human) is enforced without grace", async () => {
    const bounded = withElicitWaitBound(never, 5000);
    const pending = bounded(params, { timeoutMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).rejects.toBeInstanceOf(ElicitTimeoutError);
  });

  it("rejects promptly when the run signal aborts mid-wait, even if the elicit ignores it", async () => {
    const ac = new AbortController();
    const bounded = withElicitWaitBound(never, 20);
    const p = bounded(params, { timeoutMs: 10_000, signal: ac.signal });
    ac.abort(new Error("cancelled by test"));
    await expect(p).rejects.toThrow("cancelled by test");
  });

  it("rejects immediately on an already-aborted signal without invoking the elicit", async () => {
    const ac = new AbortController();
    ac.abort();
    const spy = vi.fn(never);
    const bounded = withElicitWaitBound(spy, 20);
    await expect(bounded(params, { timeoutMs: 100, signal: ac.signal })).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("clamps a wait bound above Node's 32-bit timer max instead of overflowing to ~1ms", async () => {
    const ac = new AbortController();
    const bounded = withElicitWaitBound(never, 1000);
    const p = bounded(params, { timeoutMs: 2_592_000_000, signal: ac.signal }).catch(
      () => "aborted",
    );
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(60);
    expect(settled).toBe(false);
    ac.abort(new Error("cleanup"));
    await p;
  });

  it("a late inner rejection after the engine bound fires is swallowed (no unhandled rejection)", async () => {
    let rejectLate!: (e: Error) => void;
    const late: Elicit = () =>
      new Promise((_resolve, reject) => {
        rejectLate = reject;
      });
    const bounded = withElicitWaitBound(late, 10);
    const pending = bounded(params, { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(20);
    await expect(pending).rejects.toBeInstanceOf(ElicitTimeoutError);
    rejectLate(new Error("late"));
    await Promise.resolve();
  });
});
