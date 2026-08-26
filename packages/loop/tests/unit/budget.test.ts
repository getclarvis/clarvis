import { describe, it, expect } from "../bun-test.ts";
import {
  createTokenLedger,
  createIterationCounter,
  checkLimits,
} from "../../src/runtime/budget/index.ts";

describe("createTokenLedger (shared token pool)", () => {
  it("meters NET-NEW tokens: cached (re-sent) input is excluded from the budget", () => {
    const l = createTokenLedger(100);
    expect(l.remaining()).toBe(100);
    expect(l.consumed()).toBe(0);
    expect(l.totals()).toEqual({ input: 0, output: 0, cached: 0, cache_write: 0 });

    l.consume({ input_tokens: 30, output_tokens: 20, cached_tokens: 5, cache_write_tokens: 0 });
    expect(l.totals()).toEqual({ input: 30, output: 20, cached: 5, cache_write: 0 });
    expect(l.consumed()).toBe(45);
    expect(l.remaining()).toBe(55);
  });

  it("a fully-cached re-read costs the budget nothing but its output", () => {
    const l = createTokenLedger(1000);
    l.consume({ input_tokens: 800, output_tokens: 10, cached_tokens: 800, cache_write_tokens: 0 });
    expect(l.consumed()).toBe(10);
    expect(l.remaining()).toBe(990);
  });

  it("wouldExceed(projected) compares (net-consumed + projected) to max", () => {
    const l = createTokenLedger(100);
    expect(l.wouldExceed(50)).toBe(false);
    expect(l.wouldExceed(100)).toBe(true);
    l.consume({ input_tokens: 30, output_tokens: 20, cached_tokens: 0, cache_write_tokens: 0 });
    expect(l.wouldExceed(49)).toBe(false);
    expect(l.wouldExceed(50)).toBe(true);
  });
});

describe("createIterationCounter (per-agent cap)", () => {
  it("counts and reports the cap", () => {
    const c = createIterationCounter(3);
    expect(c.count()).toBe(0);
    expect(c.atCap()).toBe(false);
    c.start();
    c.start();
    expect(c.count()).toBe(2);
    expect(c.atCap()).toBe(false);
    c.start();
    expect(c.atCap()).toBe(true);
  });

  it("max_iterations:0 is already at the cap", () => {
    expect(createIterationCounter(0).atCap()).toBe(true);
  });
});

describe("checkLimits — iterations before tokens", () => {
  it("reports iterations when the counter is at cap", () => {
    const c = createIterationCounter(1);
    const l = createTokenLedger(1000);
    c.start();
    expect(checkLimits(c, l)).toEqual({ terminal: true, reason: "iterations" });
  });

  it("reports tokens when the ledger is depleted", () => {
    const c = createIterationCounter(100);
    const l = createTokenLedger(50);
    l.consume({ input_tokens: 30, output_tokens: 25, cached_tokens: 0, cache_write_tokens: 0 });
    expect(checkLimits(c, l)).toEqual({ terminal: true, reason: "tokens" });
  });

  it("is independent across two agents sharing one ledger", () => {
    const ledger = createTokenLedger(1000);
    const lead = createIterationCounter(2);
    const subagent = createIterationCounter(5);
    lead.start();
    lead.start();
    subagent.start();
    expect(checkLimits(lead, ledger).terminal).toBe(true);
    expect(checkLimits(subagent, ledger).terminal).toBe(false);
  });
});
