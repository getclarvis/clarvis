import { describe, it, expect } from "bun:test";
import {
  buildPlanReviewAsk,
  buildPlanReviewElicitParams,
  mapPlanReviewAnswer,
} from "../../src/capability/review-gate.ts";
import type { ComputeClock, ComputeRegion } from "@clarvis/capability";
import {
  ElicitTimeoutError,
  PLAN_REVIEW_ELICIT_KIND,
  type ElicitParams,
  type ElicitRawResult,
} from "@clarvis/capability";

describe("plan-review-gate — elicitation params (slim)", () => {
  it("identifies itself by kind and asks a constrained decision + optional feedback, with NO plan body", () => {
    const params = buildPlanReviewElicitParams();
    expect(params.kind).toBe(PLAN_REVIEW_ELICIT_KIND);
    expect(params.message).not.toContain("[plan-review]");
    expect(params.message).not.toContain("[plan]");
    expect(params.message).not.toContain("phase:");
    expect(params.message.toLowerCase()).toContain("approve");
    const schema = params.requestedSchema;
    expect(schema.required).toEqual(["decision"]);
    /* Order is behaviour, not presentation: a client highlights the schema's
       `default`, else the first option, so `approve` first meant one stray
       Enter approved the plan. The safe answer leads, as it does on the guard
       prompt. */
    expect(schema.properties.decision?.enum).toEqual(["request_changes", "approve", "cancel"]);
    expect(schema.properties.decision?.enum?.[0]).not.toBe("approve");
    expect(schema.properties.feedback).toBeDefined();
    expect(schema.required).not.toContain("feedback");
  });
});

describe("plan-review-gate — answer mapping", () => {
  it("accept + approve → approve", () => {
    expect(mapPlanReviewAnswer({ action: "accept", content: { decision: "approve" } })).toEqual({
      kind: "approve",
    });
  });

  it("accept + request_changes carries the feedback when present", () => {
    expect(
      mapPlanReviewAnswer({
        action: "accept",
        content: { decision: "request_changes", feedback: "do Y first" },
      }),
    ).toEqual({ kind: "request_changes", feedback: "do Y first" });
  });

  it("accept + request_changes with empty/absent feedback omits it", () => {
    expect(
      mapPlanReviewAnswer({ action: "accept", content: { decision: "request_changes" } }),
    ).toEqual({ kind: "request_changes" });
    expect(
      mapPlanReviewAnswer({
        action: "accept",
        content: { decision: "request_changes", feedback: "" },
      }),
    ).toEqual({ kind: "request_changes" });
  });

  it("accept + cancel → cancel", () => {
    expect(mapPlanReviewAnswer({ action: "accept", content: { decision: "cancel" } })).toEqual({
      kind: "cancel",
    });
  });

  it("accept but unknown/missing decision → no_human (never silently approve)", () => {
    expect(mapPlanReviewAnswer({ action: "accept", content: { decision: "maybe" } })).toEqual({
      kind: "no_human",
    });
    expect(mapPlanReviewAnswer({ action: "accept", content: {} })).toEqual({ kind: "no_human" });
    expect(mapPlanReviewAnswer({ action: "accept" })).toEqual({ kind: "no_human" });
  });

  it("decline / cancel actions → no_human (do not proceed)", () => {
    expect(mapPlanReviewAnswer({ action: "decline" })).toEqual({ kind: "no_human" });
    expect(mapPlanReviewAnswer({ action: "cancel" })).toEqual({ kind: "no_human" });
  });
});

class StubClock implements ComputeClock {
  paused = 0;
  resumed = 0;
  async race<T>(loop: Promise<T>): Promise<T | "timeout"> {
    return loop;
  }
  pause(): void {
    this.paused += 1;
  }
  resume(): void {
    this.resumed += 1;
  }
  enter(): void {}
  leave(): void {}
  pauseCompute(): () => void {
    return () => {};
  }
  enterBackground(): ComputeRegion {
    return { pause: () => () => {}, leave: () => {} };
  }
  poke(): void {}
}

describe("plan-review-gate — buildPlanReviewAsk", () => {
  it("pauses the clock, elicits, and maps an approval (no signal path)", async () => {
    const clock = new StubClock();
    let seen: ElicitParams | undefined;
    const elicit = async (
      params: ElicitParams,
      opts: { signal?: AbortSignal },
    ): Promise<ElicitRawResult> => {
      seen = params;
      expect(opts.signal).toBeUndefined();
      return { action: "accept", content: { decision: "approve" } };
    };
    const ask = buildPlanReviewAsk(elicit, clock);
    await expect(ask()).resolves.toEqual({ kind: "approve" });
    expect(seen?.kind).toBe(PLAN_REVIEW_ELICIT_KIND);
    expect(clock.paused).toBe(1);
    expect(clock.resumed).toBe(1);
  });

  it("forwards the abort signal into the elicit call", async () => {
    const clock = new StubClock();
    const controller = new AbortController();
    const elicit = async (
      _params: ElicitParams,
      opts: { signal?: AbortSignal },
    ): Promise<ElicitRawResult> => {
      expect(opts.signal).toBe(controller.signal);
      return { action: "accept", content: { decision: "cancel" } };
    };
    const ask = buildPlanReviewAsk(elicit, clock, controller.signal);
    await expect(ask()).resolves.toEqual({ kind: "cancel" });
  });

  it("maps an elicitation timeout to no_human", async () => {
    const clock = new StubClock();
    const elicit = async (): Promise<ElicitRawResult> => {
      throw new ElicitTimeoutError();
    };
    const ask = buildPlanReviewAsk(elicit, clock);
    await expect(ask()).resolves.toEqual({ kind: "no_human" });
    expect(clock.resumed).toBe(1);
  });

  it("forwards the wait bound as timeoutMs into the elicit call", async () => {
    const clock = new StubClock();
    let seenTimeout: number | undefined;
    const elicit = async (
      _params: ElicitParams,
      opts: { signal?: AbortSignal; timeoutMs?: number },
    ): Promise<ElicitRawResult> => {
      seenTimeout = opts.timeoutMs;
      return { action: "accept", content: { decision: "approve" } };
    };
    const ask = buildPlanReviewAsk(elicit, clock, undefined, 1234);
    await expect(ask()).resolves.toEqual({ kind: "approve" });
    expect(seenTimeout).toBe(1234);
  });
});
