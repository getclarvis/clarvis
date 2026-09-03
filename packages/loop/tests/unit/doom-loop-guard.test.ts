import { describe, it, expect } from "../bun-test.ts";
import { createDoomLoopGuard } from "../../src/runtime/guards/index.ts";

describe("createDoomLoopGuard", () => {
  it("trips when the identical call fails the threshold times in a row (default 3)", () => {
    const g = createDoomLoopGuard();
    g.record("read:/a", true);
    g.record("read:/a", true);
    expect(g.tripped()).toBe(false);
    g.record("read:/a", true);
    expect(g.tripped()).toBe(true);
    expect(g.reason()).toContain("identical");
  });

  it("trips on a long run of consecutive failures of differing calls (default 6)", () => {
    const g = createDoomLoopGuard();
    for (let i = 0; i < 5; i += 1) g.record(`call:${i}`, true);
    expect(g.tripped()).toBe(false);
    g.record("call:6", true);
    expect(g.tripped()).toBe(true);
    expect(g.reason()).toContain("consecutive");
  });

  it("a single success resets both streaks (a success rescues the agent)", () => {
    const g = createDoomLoopGuard();
    g.record("read:/a", true);
    g.record("read:/a", true);
    g.record("read:/a", false);
    g.record("read:/a", true);
    g.record("read:/a", true);
    expect(g.tripped()).toBe(false);
  });

  it("a later success in the same dispatch rescues an unobserved threshold crossing", () => {
    const g = createDoomLoopGuard({ identicalThreshold: 100, errorThreshold: 2 });
    g.record("read:/a", true);
    g.record("read:/b", true);
    g.record("read:/ok", false);
    expect(g.tripped()).toBe(false);
    expect(g.takeSoft()).toBeNull();
  });

  it("never trips on repeated SUCCESSFUL identical calls", () => {
    const g = createDoomLoopGuard();
    for (let i = 0; i < 10; i += 1) g.record("read:/same", false);
    expect(g.tripped()).toBe(false);
    expect(g.reason()).toBe("");
  });

  it("respects custom thresholds and latches once tripped", () => {
    const g = createDoomLoopGuard({ identicalThreshold: 2, errorThreshold: 100 });
    g.record("x:{}", true);
    g.record("x:{}", true);
    expect(g.tripped()).toBe(true);
    g.record("x:{}", false);
    expect(g.tripped()).toBe(true);
  });

  it("is total — never throws on odd signatures", () => {
    const g = createDoomLoopGuard();
    expect(() => g.record("", true)).not.toThrow();
    expect(() => g.record("a:b:c", false)).not.toThrow();
  });
});
