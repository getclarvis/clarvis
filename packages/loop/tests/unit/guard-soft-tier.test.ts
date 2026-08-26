import { describe, it, expect } from "../bun-test.ts";
import { createDoomLoopGuard } from "../../src/runtime/guards/doom-loop-guard.ts";
import { createStagnationGuard, hashResult } from "../../src/runtime/guards/stagnation-guard.ts";
import { createConvergenceGuards } from "../../src/runtime/guards/convergence-guards.ts";
import {
  buildGuardEscalationAsk,
  escalateGuardTrip,
} from "../../src/runtime/guards/guard-escalation.ts";
import type { GuardTrip } from "../../src/runtime/guards/convergence-guards.ts";
import { createComputeClock } from "../../src/runtime/support/index.ts";
import { ElicitTimeoutError } from "../../src/runtime/tools/index.ts";

const TRIP: GuardTrip = { code: "tool_failure_loop", message: "looping" };

describe("doom-loop guard — soft tier", () => {
  it("warns once at the soft line and trips at the hard one", () => {
    const g = createDoomLoopGuard();

    g.record("a", true);
    expect(g.takeSoft()).toBeNull();

    g.record("a", true);
    expect(g.takeSoft()).toContain("2 times in a row");
    expect(g.tripped()).toBe(false);

    g.record("a", true);
    expect(g.tripped()).toBe(true);
  });

  it("warns only once while the same streak stays over the line", () => {
    const g = createDoomLoopGuard({ identicalThreshold: 5, errorThreshold: 99, identicalSoft: 2 });

    g.record("a", true);
    g.record("a", true);
    expect(g.takeSoft()).not.toBeNull();
    g.record("a", true);
    expect(g.takeSoft()).toBeNull();
    g.record("a", true);
    expect(g.takeSoft()).toBeNull();
  });

  it("re-arms the warning after a success clears the streak", () => {
    const g = createDoomLoopGuard({ identicalThreshold: 5, errorThreshold: 99, identicalSoft: 2 });

    g.record("a", true);
    g.record("a", true);
    expect(g.takeSoft()).not.toBeNull();

    g.record("a", false);
    g.record("a", true);
    g.record("a", true);
    expect(g.takeSoft()).not.toBeNull();
  });

  it("warns on the consecutive-failure tier too", () => {
    const g = createDoomLoopGuard({ identicalThreshold: 99, errorThreshold: 6 });
    for (let i = 0; i < 4; i += 1) g.record(`sig-${i}`, true);
    expect(g.takeSoft()).toContain("4 tool calls have failed in a row");
    expect(g.tripped()).toBe(false);
  });

  it("emits no warning when the soft tier is disabled", () => {
    const g = createDoomLoopGuard({ identicalSoft: 0, errorSoft: 0 });
    g.record("a", true);
    g.record("a", true);
    expect(g.takeSoft()).toBeNull();
  });

  it("reset clears the latch AND the counters, so one failure does not re-trip", () => {
    const g = createDoomLoopGuard();
    g.record("a", true);
    g.record("a", true);
    g.record("a", true);
    expect(g.tripped()).toBe(true);

    g.reset();
    expect(g.tripped()).toBe(false);
    expect(g.reason()).toBe("");

    g.record("a", true);
    expect(g.tripped()).toBe(false);
  });
});

describe("stagnation guard — soft tier", () => {
  const h = hashResult("same");

  it("warns once before tripping", () => {
    const g = createStagnationGuard();
    g.record("a", h, false);
    expect(g.takeSoft()).toBeNull();
    g.record("a", h, false);
    expect(g.takeSoft()).toContain("identical result 2 times");
    expect(g.tripped()).toBe(false);
    g.record("a", h, false);
    expect(g.tripped()).toBe(true);
  });

  it("re-arms when the result changes", () => {
    const g = createStagnationGuard({ threshold: 5, soft: 2 });
    g.record("a", h, false);
    g.record("a", h, false);
    expect(g.takeSoft()).not.toBeNull();
    g.record("a", hashResult("different"), false);
    g.record("a", hashResult("different"), false);
    expect(g.takeSoft()).not.toBeNull();
  });

  /**
   * The per-signature repeat counters sit at the threshold when the guard trips,
   * so clearing only the latch would re-trip on the very next repeat and make
   * the escalation decorative.
   */
  it("reset clears the per-signature repeat map", () => {
    const g = createStagnationGuard();
    g.record("a", h, false);
    g.record("a", h, false);
    g.record("a", h, false);
    expect(g.tripped()).toBe(true);

    g.reset();
    g.record("a", h, false);
    expect(g.tripped()).toBe(false);
  });

  it("stays inert when disabled", () => {
    const g = createStagnationGuard({ threshold: 0 });
    g.record("a", h, false);
    g.record("a", h, false);
    g.record("a", h, false);
    expect(g.tripped()).toBe(false);
    expect(g.takeSoft()).toBeNull();
    expect(() => g.reset()).not.toThrow();
  });
});

describe("convergence guards — combined soft tier", () => {
  it("collects warnings from both guards and yields each once", () => {
    const guards = createConvergenceGuards();
    guards.record("a", "same", false);
    guards.record("a", "same", false);

    const first = guards.takeSoft();
    expect(first).toHaveLength(1);
    expect(first[0]!.code).toBe("stagnation_detected");
    expect(guards.takeSoft()).toHaveLength(0);
  });

  it("reset clears both members", () => {
    const guards = createConvergenceGuards();
    guards.record("a", "boom", true);
    guards.record("a", "boom", true);
    guards.record("a", "boom", true);
    expect(guards.tripped()).not.toBeNull();

    guards.reset();
    expect(guards.tripped()).toBeNull();
    guards.record("a", "boom", true);
    expect(guards.tripped()).toBeNull();
  });
});

describe("escalateGuardTrip", () => {
  const recorder = () => {
    const seen: string[] = [];
    return { seen, record: (o: string) => void seen.push(o) };
  };

  it("declines without asking when no ask is wired", async () => {
    const { seen, record } = recorder();
    const guards = createConvergenceGuards();
    const out = await escalateGuardTrip({
      trip: TRIP,
      guards,
      maxEscalations: 5,
      escalations: 0,
      record,
    });
    expect(out).toEqual({ kind: "declined" });
    expect(seen).toHaveLength(0);
  });

  it("declines without asking when the cap is zero", async () => {
    let asked = 0;
    const out = await escalateGuardTrip({
      trip: TRIP,
      guards: createConvergenceGuards(),
      ask: async () => {
        asked += 1;
        return "continue";
      },
      maxEscalations: 0,
      escalations: 0,
      record: () => {},
    });
    expect(out).toEqual({ kind: "declined" });
    expect(asked).toBe(0);
  });

  it("resets the guards and continues when the user agrees", async () => {
    const guards = createConvergenceGuards();
    guards.record("a", "boom", true);
    guards.record("a", "boom", true);
    guards.record("a", "boom", true);
    expect(guards.tripped()).not.toBeNull();

    const { seen, record } = recorder();
    const out = await escalateGuardTrip({
      trip: TRIP,
      guards,
      ask: async () => "continue",
      maxEscalations: 2,
      escalations: 0,
      record,
    });

    expect(out).toEqual({ kind: "continue" });
    expect(guards.tripped()).toBeNull();
    expect(seen).toEqual(["continued"]);
  });

  it("declines on a stop answer and leaves the trip standing", async () => {
    const guards = createConvergenceGuards();
    guards.record("a", "boom", true);
    guards.record("a", "boom", true);
    guards.record("a", "boom", true);

    const { seen, record } = recorder();
    const out = await escalateGuardTrip({
      trip: TRIP,
      guards,
      ask: async () => "decline",
      maxEscalations: 2,
      escalations: 0,
      record,
    });

    expect(out).toEqual({ kind: "declined" });
    expect(guards.tripped()).not.toBeNull();
    expect(seen).toEqual(["declined"]);
  });

  it("declines without asking once escalations are exhausted", async () => {
    let asked = 0;
    const { seen, record } = recorder();
    const out = await escalateGuardTrip({
      trip: TRIP,
      guards: createConvergenceGuards(),
      ask: async () => {
        asked += 1;
        return "continue";
      },
      maxEscalations: 1,
      escalations: 1,
      record,
    });
    expect(out).toEqual({ kind: "declined" });
    expect(asked).toBe(0);
    expect(seen).toEqual(["escalations_exhausted"]);
  });

  /** An abort while the prompt is open is a cancellation, never a decline. */
  it("reports cancelled when the signal aborts mid-prompt", async () => {
    const controller = new AbortController();
    const { seen, record } = recorder();
    const out = await escalateGuardTrip({
      trip: TRIP,
      guards: createConvergenceGuards(),
      ask: () => {
        controller.abort();
        return Promise.reject(new Error("aborted"));
      },
      maxEscalations: 2,
      escalations: 0,
      signal: controller.signal,
      record,
    });
    expect(out).toEqual({ kind: "cancelled" });
    expect(seen).toHaveLength(0);
  });

  it("treats a non-abort throw as no_response", async () => {
    const { seen, record } = recorder();
    const out = await escalateGuardTrip({
      trip: TRIP,
      guards: createConvergenceGuards(),
      ask: () => Promise.reject(new Error("boom")),
      maxEscalations: 2,
      escalations: 0,
      record,
    });
    expect(out).toEqual({ kind: "declined" });
    expect(seen).toEqual(["no_response"]);
  });
});

describe("buildGuardEscalationAsk", () => {
  it("returns no_response when the elicitation exceeds its wait bound", async () => {
    const clock = createComputeClock(1_000);
    const ask = buildGuardEscalationAsk(
      () => Promise.reject(new ElicitTimeoutError()),
      clock,
      undefined,
      5,
    );

    await expect(ask(TRIP)).resolves.toBe("no_response");
  });
});
