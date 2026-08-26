import { describe, expect, it } from "bun:test";
import { createScanBudget } from "../../src/lib/scan-budget.ts";
import { DEFAULT_REGEX_SCAN_BUDGET_MS } from "../../src/config.ts";

function burn(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin */
  }
}

describe("createScanBudget", () => {
  it("returns whatever the charged call returned, unchanged", () => {
    const budget = createScanBudget(1000);
    expect(budget.charge(() => "value")).toBe("value");
    expect(budget.charge(() => 42)).toBe(42);
    expect(budget.charge(() => null)).toBe(null);
  });

  it("is not exhausted before anything is charged", () => {
    expect(createScanBudget(1).exhausted()).toBe(false);
  });

  // Half of what keeps the guard from being flaky: time spent outside `charge`
  // — the stat, the read, the directory walk, and whatever else the machine was
  // busy with — is never billed, so a slow disk or a loaded CI runner cannot
  // turn a legitimate scan into a reported-incomplete one.
  it("charges only the work handed to it, not the time around it", () => {
    const budget = createScanBudget(5);
    burn(50);
    expect(budget.exhausted()).toBe(false);
    budget.charge(() => undefined);
    burn(50);
    expect(budget.exhausted()).toBe(false);
  });

  // The other half: a legitimate pattern applied once per line over a large
  // tree charges a few milliseconds in total (measured 5-7ms for 200,000
  // applications on Bun 1.3.11), so the 5s default leaves ~1000x of headroom.
  // Note the accounting is not free of Date.now()'s 1ms granularity — a run of
  // cheap charges does bill a handful of milliseconds, which is why the
  // assertion is against the real default and not against a 1ms budget.
  it("leaves a legitimate 200,000-line scan far inside the default budget", () => {
    const budget = createScanBudget(DEFAULT_REGEX_SCAN_BUDGET_MS);
    const re = /needle/;
    for (let i = 0; i < 200_000; i++) {
      budget.charge(() => re.test("haystack line without the word"));
    }
    expect(budget.exhausted()).toBe(false);
  });

  it("exhausts once a single charged call outspends the budget", () => {
    const budget = createScanBudget(5);
    expect(budget.exhausted()).toBe(false);
    budget.charge(() => burn(20));
    expect(budget.exhausted()).toBe(true);
  });

  it("accumulates across calls rather than measuring each one alone", () => {
    const budget = createScanBudget(30);
    budget.charge(() => burn(12));
    expect(budget.exhausted()).toBe(false);
    budget.charge(() => burn(12));
    expect(budget.exhausted()).toBe(false);
    budget.charge(() => burn(12));
    expect(budget.exhausted()).toBe(true);
  });
});
