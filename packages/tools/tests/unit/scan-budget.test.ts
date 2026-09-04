import { describe, expect, it } from "bun:test";
import { createScanBudget } from "../../src/lib/scan-budget.ts";
import { DEFAULT_REGEX_SCAN_BUDGET_MS } from "../../src/config.ts";

function controlledClock(): { now: () => number; advance: (ms: number) => void } {
  let current = 0;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
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

  it("charges only the work handed to it, not the time around it", () => {
    const clock = controlledClock();
    const budget = createScanBudget(5, clock.now);
    clock.advance(50);
    expect(budget.exhausted()).toBe(false);
    budget.charge(() => undefined);
    clock.advance(50);
    expect(budget.exhausted()).toBe(false);
  });

  it("keeps 200,000 inexpensive charges far inside the default budget", () => {
    const clock = controlledClock();
    const budget = createScanBudget(DEFAULT_REGEX_SCAN_BUDGET_MS, clock.now);
    const re = /needle/;
    for (let i = 0; i < 200_000; i++) {
      budget.charge(() => {
        if (i % 40_000 === 0) clock.advance(1);
        return re.test("haystack line without the word");
      });
    }
    expect(budget.exhausted()).toBe(false);
  });

  it("exhausts once a single charged call outspends the budget", () => {
    const clock = controlledClock();
    const budget = createScanBudget(5, clock.now);
    expect(budget.exhausted()).toBe(false);
    budget.charge(() => clock.advance(20));
    expect(budget.exhausted()).toBe(true);
  });

  it("accumulates across calls rather than measuring each one alone", () => {
    const clock = controlledClock();
    const budget = createScanBudget(30, clock.now);
    budget.charge(() => clock.advance(12));
    expect(budget.exhausted()).toBe(false);
    budget.charge(() => clock.advance(12));
    expect(budget.exhausted()).toBe(false);
    budget.charge(() => clock.advance(12));
    expect(budget.exhausted()).toBe(true);
  });
});
