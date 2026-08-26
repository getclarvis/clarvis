import { describe, it, expect } from "../bun-test.ts";
import { createStagnationGuard, hashResult } from "../../src/runtime/guards/index.ts";

describe("createStagnationGuard", () => {
  it("does not accumulate identical verification results across intervening activity", () => {
    const g = createStagnationGuard();
    g.record("bash:test", 100, false);
    g.record("edit:/a", 1, false);
    g.record("bash:test", 100, false);
    expect(g.tripped()).toBe(false);
    g.record("edit:/b", 2, false);
    g.record("bash:test", 100, false);
    expect(g.tripped()).toBe(false);
    expect(g.reason()).toBe("");
  });

  it("does not call an edit→test→edit→test workflow stagnant", () => {
    const g = createStagnationGuard();
    g.record("edit:fix1", 11, false);
    g.record("bash:test", 100, false);
    g.record("edit:fix2", 22, false);
    g.record("bash:test", 100, false);
    g.record("edit:fix3", 33, false);
    expect(g.tripped()).toBe(false);
    g.record("bash:test", 100, false);
    expect(g.tripped()).toBe(false);
  });

  it("never trips when the result CHANGES (a healthy loop makes progress)", () => {
    const g = createStagnationGuard();
    g.record("bash:test", 100, false);
    g.record("edit:/a", 1, false);
    g.record("bash:test", 200, false);
    g.record("edit:/b", 2, false);
    g.record("bash:test", 300, false);
    g.record("edit:/c", 3, false);
    g.record("bash:test", 400, false);
    expect(g.tripped()).toBe(false);
    expect(g.reason()).toBe("");
  });

  it("trips on back-to-back identical calls — a tight unproductive loop (no intervening activity required)", () => {
    const g = createStagnationGuard();
    g.record("poll:status", 7, false);
    g.record("poll:status", 7, false);
    expect(g.tripped()).toBe(false);
    g.record("poll:status", 7, false);
    expect(g.tripped()).toBe(true);
  });

  it("does NOT trip back-to-back when the result keeps changing (a healthy poll that makes progress)", () => {
    const g = createStagnationGuard();
    g.record("poll:status", 1, false);
    g.record("poll:status", 2, false);
    g.record("poll:status", 3, false);
    g.record("poll:status", 4, false);
    expect(g.tripped()).toBe(false);
  });

  it("treats an error as intervening activity that resets the successful-result streak", () => {
    const g = createStagnationGuard();
    g.record("bash:test", 100, false);
    g.record("edit:/a", 0, true);
    g.record("bash:test", 100, false);
    g.record("edit:/a", 0, true);
    g.record("bash:test", 100, false);
    expect(g.tripped()).toBe(false);
  });

  it("latches once tripped — a later success does not un-trip", () => {
    const g = createStagnationGuard({ threshold: 2 });
    g.record("x:{}", 5, false);
    g.record("x:{}", 5, false);
    expect(g.tripped()).toBe(true);
    g.record("x:{}", 6, false);
    expect(g.tripped()).toBe(true);
  });

  it("threshold 1 does NOT trip on the first successful tool call, but trips on the first repeat", () => {
    const g = createStagnationGuard({ threshold: 1 });
    g.record("bash:test", 100, false);
    expect(g.tripped()).toBe(false);
    g.record("edit:/a", 1, false);
    expect(g.tripped()).toBe(false);
    g.record("bash:test", 100, false);
    expect(g.tripped()).toBe(false);
    g.record("bash:test", 100, false);
    expect(g.tripped()).toBe(true);
    expect(g.reason()).toContain("threshold 1");
  });

  it("threshold 1 does NOT trip when the repeated call's result changes", () => {
    const g = createStagnationGuard({ threshold: 1 });
    g.record("bash:test", 100, false);
    g.record("bash:test", 200, false);
    g.record("bash:test", 300, false);
    expect(g.tripped()).toBe(false);
  });

  it("threshold 0 DISABLES the guard entirely (no-op)", () => {
    const g = createStagnationGuard({ threshold: 0 });
    g.record("bash:test", 100, false);
    g.record("edit:/a", 1, false);
    g.record("bash:test", 100, false);
    g.record("edit:/b", 2, false);
    g.record("bash:test", 100, false);
    g.record("bash:test", 100, false);
    expect(g.tripped()).toBe(false);
    expect(g.reason()).toBe("");
  });

  it("is total — never throws on odd inputs", () => {
    const g = createStagnationGuard();
    expect(() => g.record("", 0, false)).not.toThrow();
    expect(() => g.record("a:b:c", -1, true)).not.toThrow();
  });

  it("does not retain the full signature text for large tool arguments (bounded footprint)", () => {
    const g = createStagnationGuard();
    const largeArg = "x".repeat(20_000);
    Bun.gc(true);
    const before = process.memoryUsage().external;
    for (let i = 0; i < 500; i++) {
      g.record(`write_file:${largeArg}:${i}`, i, false);
    }
    Bun.gc(true);
    const after = process.memoryUsage().external;
    // Bun/JavaScriptCore accounts large string backing stores under `external`,
    // not `heapUsed`. 500 distinct ~20k-char signatures retained verbatim as Map
    // keys (the unfixed behavior) grows `external` by roughly 10MB; a hashed key
    // only ever keeps an 8-byte number, so the fixed guard's growth stays two
    // orders of magnitude below that.
    expect(after - before).toBeLessThan(2_000_000);
  });
});

describe("hashResult", () => {
  it("is deterministic for identical text", () => {
    expect(hashResult("FAIL: assertion error")).toBe(hashResult("FAIL: assertion error"));
  });

  it("differs for different text (incl. one-character changes)", () => {
    expect(hashResult("abc")).not.toBe(hashResult("abd"));
    expect(hashResult("FAIL 1")).not.toBe(hashResult("FAIL 2"));
  });

  it("returns a non-negative integer, even for empty / large input", () => {
    expect(hashResult("")).toBeGreaterThanOrEqual(0);
    const big = "x".repeat(100_000);
    const h = hashResult(big);
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
  });
});
