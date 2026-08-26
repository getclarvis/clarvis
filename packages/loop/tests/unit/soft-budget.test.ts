import { describe, it, expect } from "../bun-test.ts";
import {
  buildSoftLimitAsk,
  createSoftBudget,
  evaluateSoftBudget,
  type SoftCrossing,
} from "../../src/runtime/budget/index.ts";
import { ElicitTimeoutError, type Elicit } from "../../src/runtime/tools/index.ts";
import { createComputeClock, type ComputeClock } from "../../src/runtime/support/index.ts";
import type { SoftLimitCheckDetail } from "@clarvis/capability";

const CROSSING: SoftCrossing = { dimension: "tokens", used: 100, limit: 100 };

describe("createSoftBudget", () => {
  it("returns undefined when no soft limit is set (HARD mode)", () => {
    expect(createSoftBudget({})).toBeUndefined();
    expect(createSoftBudget({ maxEscalations: 3 })).toBeUndefined();
  });

  it("token checkpoint follows the fixed cadence S, 2S, 3S…", () => {
    const sb = createSoftBudget({ softTokenLimit: 100 })!;
    expect(sb.crossed(99, 0)).toBeNull();
    expect(sb.crossed(100, 0)).toEqual({ dimension: "tokens", used: 100, limit: 100 });
    expect(sb.advance("tokens")).toBe(200);
    expect(sb.crossed(150, 0)).toBeNull();
    expect(sb.crossed(200, 0)).toEqual({ dimension: "tokens", used: 200, limit: 200 });
    expect(sb.advance("tokens")).toBe(300);
    expect(sb.escalations()).toBe(2);
  });

  it("tokens are checked before iterations at the same checkpoint", () => {
    const sb = createSoftBudget({ softTokenLimit: 10, softIterationLimit: 2 })!;
    expect(sb.crossed(10, 2)).toEqual({ dimension: "tokens", used: 10, limit: 10 });
  });

  it("iteration cadence when only soft_iteration_limit is set", () => {
    const sb = createSoftBudget({ softIterationLimit: 3 })!;
    expect(sb.crossed(99_999, 2)).toBeNull();
    expect(sb.crossed(0, 3)).toEqual({ dimension: "iterations", used: 3, limit: 3 });
    expect(sb.advance("iterations")).toBe(6);
  });

  it("escalationsExhausted honors maxEscalations", () => {
    const sb = createSoftBudget({ softTokenLimit: 5, maxEscalations: 2 })!;
    expect(sb.escalationsExhausted()).toBe(false);
    sb.advance("tokens");
    expect(sb.escalationsExhausted()).toBe(false);
    sb.advance("tokens");
    expect(sb.escalationsExhausted()).toBe(true);
  });

  it("unbounded by default (no maxEscalations) — never exhausts", () => {
    const sb = createSoftBudget({ softTokenLimit: 5 })!;
    for (let i = 0; i < 50; i += 1) sb.advance("tokens");
    expect(sb.escalationsExhausted()).toBe(false);
    expect(sb.escalations()).toBe(50);
  });
});

describe("createSoftBudget advance — dimension without a soft limit", () => {
  it("returns 0 and does not escalate when advancing a dimension that has no limit", () => {
    const sb = createSoftBudget({ softIterationLimit: 3 })!;
    expect(sb.advance("tokens")).toBe(0);
    expect(sb.escalations()).toBe(0);
  });
});

describe("buildSoftLimitAsk", () => {
  it("accept → 'continue'; brackets the wait in pause()/resume()", async () => {
    let paused = 0;
    let resumed = 0;
    const clock: ComputeClock = {
      race: async (l) => l,
      pause: () => {
        paused += 1;
      },
      resume: () => {
        resumed += 1;
      },
      enter: () => {},
      leave: () => {},
      pauseCompute: () => () => {},
      enterBackground: () => ({ pause: () => () => {}, leave: () => {} }),
      poke: () => {},
    };
    const elicit: Elicit = async () => ({ action: "accept" });
    const ask = buildSoftLimitAsk(elicit, clock);
    expect(await ask(CROSSING)).toBe("continue");
    expect(paused).toBe(1);
    expect(resumed).toBe(1);
  });

  it("accept with content {continue:'stop'} → 'decline' (honors an explicit stop)", async () => {
    const clock = createComputeClock(1000);
    const ask = buildSoftLimitAsk(
      async () => ({ action: "accept", content: { continue: "stop" } }),
      clock,
    );
    expect(await ask(CROSSING)).toBe("decline");
  });

  it("accept with content {continue:'continue'} → 'continue'", async () => {
    const clock = createComputeClock(1000);
    const ask = buildSoftLimitAsk(
      async () => ({ action: "accept", content: { continue: "continue" } }),
      clock,
    );
    expect(await ask(CROSSING)).toBe("continue");
  });

  it("accept with no content field falls back to 'continue'", async () => {
    const clock = createComputeClock(1000);
    const ask = buildSoftLimitAsk(async () => ({ action: "accept" }), clock);
    expect(await ask(CROSSING)).toBe("continue");
  });

  it("decline AND cancel-of-question both → 'decline'", async () => {
    const clock = createComputeClock(1000);
    for (const action of ["decline", "cancel"] as const) {
      const ask = buildSoftLimitAsk(async () => ({ action }), clock);
      expect(await ask(CROSSING)).toBe("decline");
    }
  });

  it("optional wait-bound elapse → 'no_response'", async () => {
    const clock = createComputeClock(1000);
    const elicit: Elicit = () => Promise.reject(new ElicitTimeoutError());
    const ask = buildSoftLimitAsk(elicit, clock, undefined, 10);
    expect(await ask(CROSSING)).toBe("no_response");
  });

  it("run-level abort propagates (so the loop returns cancelled)", async () => {
    const clock = createComputeClock(1000);
    const ac = new AbortController();
    const elicit: Elicit = (_p, opts) =>
      new Promise((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const ask = buildSoftLimitAsk(elicit, clock, ac.signal);
    const p = ask(CROSSING);
    ac.abort();
    await expect(p).rejects.toThrow();
  });
});

describe("evaluateSoftBudget", () => {
  const sink = () => {
    const events: SoftLimitCheckDetail[] = [];
    return { events, record: (d: SoftLimitCheckDetail) => events.push(d) };
  };

  it("no crossing → continue, no event", async () => {
    const { events, record } = sink();
    const out = await evaluateSoftBudget({
      softBudget: createSoftBudget({ softTokenLimit: 100 })!,
      softLimitAsk: async () => "continue",
      usedTokens: 50,
      usedIterations: 0,
      agent: "subagent",
      record,
    });
    expect(out).toEqual({ kind: "continue" });
    expect(events).toHaveLength(0);
  });

  it("crossing + accept → continue; advances + records continued with new_checkpoint", async () => {
    const { events, record } = sink();
    const out = await evaluateSoftBudget({
      softBudget: createSoftBudget({ softTokenLimit: 100 })!,
      softLimitAsk: async () => "continue",
      usedTokens: 100,
      usedIterations: 0,
      agent: "subagent",
      record,
    });
    expect(out).toEqual({ kind: "continue" });
    expect(events[0]).toMatchObject({
      dimension: "tokens",
      used: 100,
      limit: 100,
      outcome: "continued",
      new_checkpoint: 200,
      escalations: 1,
    });
  });

  it("crossing + decline → declined; records declined", async () => {
    const { events, record } = sink();
    const out = await evaluateSoftBudget({
      softBudget: createSoftBudget({ softTokenLimit: 100 })!,
      softLimitAsk: async () => "decline",
      usedTokens: 100,
      usedIterations: 0,
      agent: "subagent",
      record,
    });
    expect(out).toEqual({ kind: "declined" });
    expect(events[0]).toMatchObject({ outcome: "declined" });
    expect(events[0]!.new_checkpoint).toBeUndefined();
  });

  it("crossing + no_response → declined; records no_response", async () => {
    const { events, record } = sink();
    const out = await evaluateSoftBudget({
      softBudget: createSoftBudget({ softTokenLimit: 100 })!,
      softLimitAsk: async () => "no_response",
      usedTokens: 100,
      usedIterations: 0,
      agent: "subagent",
      record,
    });
    expect(out).toEqual({ kind: "declined" });
    expect(events[0]).toMatchObject({ outcome: "no_response" });
  });

  it("escalations exhausted → declined WITHOUT eliciting", async () => {
    const sb = createSoftBudget({ softTokenLimit: 100, maxEscalations: 1 })!;
    let asked = 0;
    const ask = async (): Promise<"continue"> => {
      asked += 1;
      return "continue";
    };
    const first = sink();
    await evaluateSoftBudget({
      softBudget: sb,
      softLimitAsk: ask,
      usedTokens: 100,
      usedIterations: 0,
      agent: "subagent",
      record: first.record,
    });
    const second = sink();
    const out = await evaluateSoftBudget({
      softBudget: sb,
      softLimitAsk: ask,
      usedTokens: 200,
      usedIterations: 0,
      agent: "subagent",
      record: second.record,
    });
    expect(out).toEqual({ kind: "declined" });
    expect(second.events[0]).toMatchObject({ outcome: "escalations_exhausted" });
    expect(asked).toBe(1);
  });

  it("run-level abort during the wait → cancelled (no event)", async () => {
    const { events, record } = sink();
    const ac = new AbortController();
    const out = await evaluateSoftBudget({
      softBudget: createSoftBudget({ softTokenLimit: 100 })!,
      softLimitAsk: async () => {
        ac.abort();
        throw new Error("aborted");
      },
      usedTokens: 100,
      usedIterations: 0,
      agent: "subagent",
      signal: ac.signal,
      record,
    });
    expect(out).toEqual({ kind: "cancelled" });
    expect(events).toHaveLength(0);
  });

  it("non-abort elicit failure → declined (preserves the partial); records no_response", async () => {
    const { events, record } = sink();
    const out = await evaluateSoftBudget({
      softBudget: createSoftBudget({ softTokenLimit: 100 })!,
      softLimitAsk: async () => {
        throw new Error("elicit channel down");
      },
      usedTokens: 100,
      usedIterations: 0,
      agent: "subagent",
      record,
    });
    expect(out).toEqual({ kind: "declined" });
    expect(events[0]).toMatchObject({ outcome: "no_response" });
  });
});
