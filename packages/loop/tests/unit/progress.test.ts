import { describe, it, expect } from "../bun-test.ts";
import { createProgressTracker } from "../../src/runtime/loop/progress.ts";

describe("createProgressTracker", () => {
  it("counts consecutive unproductive bumps and trips at the limit", () => {
    const p = createProgressTracker(3);
    expect(p.bump(false)).toBe(false);
    expect(p.streak()).toBe(1);
    expect(p.bump(false)).toBe(false);
    expect(p.streak()).toBe(2);
    expect(p.bump(false)).toBe(true);
    expect(p.streak()).toBe(3);
  });

  it("a productive bump resets the streak to zero and never trips", () => {
    const p = createProgressTracker(2);
    p.bump(false);
    expect(p.bump(true)).toBe(false);
    expect(p.streak()).toBe(0);
    expect(p.bump(false)).toBe(false);
    expect(p.bump(false)).toBe(true);
  });

  it("limit of 1 trips on the first unproductive bump", () => {
    const p = createProgressTracker(1);
    expect(p.bump(false)).toBe(true);
  });

  it("reset() clears the streak so the next unproductive bumps start over", () => {
    const p = createProgressTracker(2);
    p.bump(false);
    expect(p.streak()).toBe(1);
    p.reset();
    expect(p.streak()).toBe(0);
    expect(p.bump(false)).toBe(false);
    expect(p.bump(false)).toBe(true);
  });
});
