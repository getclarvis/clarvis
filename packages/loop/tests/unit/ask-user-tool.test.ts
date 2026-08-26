import { describe, it, expect } from "../bun-test.ts";
import {
  buildElicitParams,
  extractAnswer,
  mapOutcomeToText,
  buildAskUser,
  elicitWithClockPause,
  ElicitTimeoutError,
  ELICIT_RESPONSE_FIELD,
  type Elicit,
} from "../../src/runtime/tools/index.ts";
import { createComputeClock, type ComputeClock } from "../../src/runtime/support/index.ts";

describe("ask-user-tool helpers", () => {
  it("buildElicitParams: free-text one-field schema by default", () => {
    const p = buildElicitParams({ question: "What name?" });
    expect(p.message).toBe("What name?");
    expect(p.requestedSchema.required).toEqual([ELICIT_RESPONSE_FIELD]);
    const field = p.requestedSchema.properties[ELICIT_RESPONSE_FIELD]!;
    expect(field.type).toBe("string");
    expect(field.enum).toBeUndefined();
  });

  it("buildElicitParams: enum field when options supplied (constrained answer)", () => {
    const p = buildElicitParams({ question: "Deploy?", options: ["prod", "staging"] });
    expect(p.requestedSchema.properties[ELICIT_RESPONSE_FIELD]!.enum).toEqual(["prod", "staging"]);
  });

  it("extractAnswer: reads the response field; coerces non-strings; empty when absent", () => {
    expect(extractAnswer({ response: "staging" })).toBe("staging");
    expect(extractAnswer({ response: 42 })).toBe("42");
    expect(extractAnswer(undefined)).toBe("");
  });

  it("mapOutcomeToText: distinct, non-fatal strings for every outcome", () => {
    const accept = mapOutcomeToText({ action: "accept", answer: "staging" });
    const decline = mapOutcomeToText({ action: "decline" });
    const cancel = mapOutcomeToText({ action: "cancel" });
    const noResponse = mapOutcomeToText({ action: "decline", noResponse: true });
    expect(accept).toContain("staging");
    expect(new Set([accept, decline, cancel, noResponse]).size).toBe(4);
  });
});

describe("buildAskUser bridge", () => {
  it("accept: returns the extracted answer and brackets the wait in pause()/resume()", async () => {
    let paused = 0;
    let resumed = 0;
    const clock: ComputeClock = {
      race: async (loop) => loop,
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
    let seenTimeout: number | undefined;
    const elicit: Elicit = async (_params, opts) => {
      seenTimeout = opts.timeoutMs;
      return { action: "accept", content: { response: "staging" } };
    };
    const askUser = buildAskUser(elicit, clock, undefined, 1234);
    expect(await askUser({ question: "?" })).toEqual({ action: "accept", answer: "staging" });
    expect(paused).toBe(1);
    expect(resumed).toBe(1);
    expect(seenTimeout).toBe(1234);
  });

  it("decline / cancel pass through unchanged (non-fatal)", async () => {
    const clock = createComputeClock(1000);
    for (const action of ["decline", "cancel"] as const) {
      const askUser = buildAskUser(async () => ({ action }), clock);
      expect(await askUser({ question: "?" })).toEqual({ action });
    }
  });

  it("optional wait-bound elapse → non-fatal 'no response' decline", async () => {
    const clock = createComputeClock(1000);
    const elicit: Elicit = () => Promise.reject(new ElicitTimeoutError());
    const askUser = buildAskUser(elicit, clock, undefined, 10);
    expect(await askUser({ question: "?" })).toEqual({ action: "decline", noResponse: true });
  });

  it("run-level abort propagates (so the loop returns cancelled)", async () => {
    const clock = createComputeClock(1000);
    const ac = new AbortController();
    const elicit: Elicit = (_params, opts) =>
      new Promise((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const askUser = buildAskUser(elicit, clock, ac.signal);
    const p = askUser({ question: "?" });
    ac.abort();
    await expect(p).rejects.toThrow();
  });
});

describe("ask-user-tool elicitation plumbing", () => {
  it("extractAnswer stringifies content when the response field is absent", () => {
    expect(extractAnswer({})).toBe("{}");
    expect(extractAnswer({ other: 1 })).toBe('{"other":1}');
  });

  it("mapOutcomeToText renders an accept with no answer as an empty answer", () => {
    expect(mapOutcomeToText({ action: "accept" })).toBe("User answered: ");
  });

  it("ElicitTimeoutError carries a default message", () => {
    expect(new ElicitTimeoutError().message).toMatch(/wait bound/i);
  });

  it("elicitWithClockPause maps a successful result", async () => {
    const clock = createComputeClock(60_000);
    const out = await elicitWithClockPause(
      clock,
      undefined,
      async () => ({ action: "accept", content: { response: "yes" } }),
      { onResult: (raw) => raw.action, onNoResponse: () => "none" },
    );
    expect(out).toBe("accept");
  });

  it("elicitWithClockPause maps a timeout to onNoResponse", async () => {
    const clock = createComputeClock(60_000);
    const out = await elicitWithClockPause(
      clock,
      undefined,
      async () => {
        throw new ElicitTimeoutError();
      },
      { onResult: () => "result", onNoResponse: () => "none" },
    );
    expect(out).toBe("none");
  });

  it("elicitWithClockPause does not start the elicitation when the signal is already aborted", async () => {
    const clock = createComputeClock(60_000);
    const controller = new AbortController();
    controller.abort();
    let called = false;
    await expect(
      elicitWithClockPause(
        clock,
        controller.signal,
        async () => {
          called = true;
          throw new ElicitTimeoutError();
        },
        { onResult: () => "r", onNoResponse: () => "n" },
      ),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });

  it("elicitWithClockPause rethrows when the signal aborts during the elicitation", async () => {
    const clock = createComputeClock(60_000);
    const controller = new AbortController();
    await expect(
      elicitWithClockPause(
        clock,
        controller.signal,
        async () => {
          controller.abort();
          throw new ElicitTimeoutError();
        },
        { onResult: () => "r", onNoResponse: () => "n" },
      ),
    ).rejects.toBeInstanceOf(ElicitTimeoutError);
  });

  it("elicitWithClockPause rethrows a non-timeout error", async () => {
    const clock = createComputeClock(60_000);
    await expect(
      elicitWithClockPause(
        clock,
        undefined,
        async () => {
          throw new Error("other");
        },
        { onResult: () => "r", onNoResponse: () => "n" },
      ),
    ).rejects.toThrow("other");
  });
});
