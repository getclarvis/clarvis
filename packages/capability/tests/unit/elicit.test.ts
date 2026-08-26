import { describe, expect, it } from "../helpers/bun-test.ts";

import {
  ElicitTimeoutError,
  elicitWithClockPause,
  type ElicitRawResult,
} from "../../src/elicit.ts";
import type { ComputeClock, ComputeRegion } from "../../src/compute-clock.ts";
import type { Logger } from "../../src/ports.ts";

/**
 * A hand-rolled fake clock recording pause()/resume() calls in the order they
 * happen. elicitWithClockPause only ever calls those two methods; the rest of
 * the ComputeClock surface is implemented as inert stubs purely to satisfy the
 * type, and is never exercised by these tests.
 */
function createFakeClock(): ComputeClock & { calls: string[] } {
  const calls: string[] = [];
  const region: ComputeRegion = {
    pause: () => () => {},
    leave: () => {},
  };
  return {
    calls,
    async race<T>(loop: Promise<T>): Promise<T | "timeout"> {
      return loop;
    },
    pause(): void {
      calls.push("pause");
    },
    resume(): void {
      calls.push("resume");
    },
    enter(): void {},
    leave(): void {},
    pauseCompute(): () => void {
      return () => {};
    },
    enterBackground(): ComputeRegion {
      return region;
    },
    poke(): void {},
  };
}

const ACCEPTED: ElicitRawResult = { action: "accept", content: { answer: "yes" } };

describe("ElicitTimeoutError", () => {
  it("carries a default message and its own name", () => {
    const err = new ElicitTimeoutError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ElicitTimeoutError");
    expect(err.message).toBe("Elicitation wait bound elapsed with no response.");
  });

  it("accepts a custom message", () => {
    expect(new ElicitTimeoutError("gave up waiting").message).toBe("gave up waiting");
  });
});

describe("elicitWithClockPause — pauses around the wait and always resumes in finally", () => {
  it("pauses before the elicit and resumes after a successful, mapped result", async () => {
    const clock = createFakeClock();
    const result = await elicitWithClockPause(clock, undefined, async () => ACCEPTED, {
      onResult: (raw) => raw.content?.answer as string,
      onNoResponse: () => "no-response",
    });
    expect(result).toBe("yes");
    expect(clock.calls).toEqual(["pause", "resume"]);
  });

  it("still resumes when doElicit's wait bound elapses (ElicitTimeoutError)", async () => {
    const clock = createFakeClock();
    const result = await elicitWithClockPause(
      clock,
      undefined,
      async () => {
        throw new ElicitTimeoutError();
      },
      { onResult: () => "answered", onNoResponse: () => "no-response" },
    );
    expect(result).toBe("no-response");
    expect(clock.calls).toEqual(["pause", "resume"]);
  });

  it("still resumes when doElicit rejects with something other than a timeout, and that rejection propagates", async () => {
    const clock = createFakeClock();
    const boom = new Error("transport exploded");
    await expect(
      elicitWithClockPause(
        clock,
        undefined,
        async () => {
          throw boom;
        },
        { onResult: () => "answered", onNoResponse: () => "no-response" },
      ),
    ).rejects.toBe(boom);
    expect(clock.calls).toEqual(["pause", "resume"]);
  });
});

describe("elicitWithClockPause — a pre-aborted signal", () => {
  it("throws the signal's Error reason before pausing the clock or calling doElicit", async () => {
    const clock = createFakeClock();
    const reason = new Error("cancelled by caller");
    const controller = new AbortController();
    controller.abort(reason);
    let doElicitCalled = false;

    await expect(
      elicitWithClockPause(
        clock,
        controller.signal,
        async () => {
          doElicitCalled = true;
          return ACCEPTED;
        },
        { onResult: () => "answered", onNoResponse: () => "no-response" },
      ),
    ).rejects.toBe(reason);
    expect(doElicitCalled).toBe(false);
    expect(clock.calls).toEqual([]);
  });

  it("wraps a non-Error abort reason in a generic Error", async () => {
    const clock = createFakeClock();
    const controller = new AbortController();
    controller.abort("just a string reason");

    await expect(
      elicitWithClockPause(clock, controller.signal, async () => ACCEPTED, {
        onResult: () => "answered",
        onNoResponse: () => "no-response",
      }),
    ).rejects.toThrow("Run aborted before the elicitation started.");
    expect(clock.calls).toEqual([]);
  });
});

describe("elicitWithClockPause — a signal that aborts mid-wait", () => {
  it("propagates an ElicitTimeoutError unchanged, instead of swallowing it into onNoResponse", async () => {
    const clock = createFakeClock();
    const controller = new AbortController();
    const timeoutErr = new ElicitTimeoutError();

    const pending = elicitWithClockPause(
      clock,
      controller.signal,
      async () => {
        // Simulates the abort winning the race against doElicit's own wait
        // bound: the signal is still unaborted when elicitWithClockPause's
        // pre-check runs, but becomes aborted before doElicit settles.
        controller.abort(new Error("caller gave up"));
        throw timeoutErr;
      },
      { onResult: () => "answered", onNoResponse: () => "no-response" },
    );

    await expect(pending).rejects.toBe(timeoutErr);
    // resume still ran, even though the error propagated instead of being mapped
    expect(clock.calls).toEqual(["pause", "resume"]);
  });

  it("contrast: the identical ElicitTimeoutError is swallowed when the signal never aborts", async () => {
    const clock = createFakeClock();
    const timeoutErr = new ElicitTimeoutError();

    const result = await elicitWithClockPause(
      clock,
      undefined,
      async () => {
        throw timeoutErr;
      },
      { onResult: () => "answered", onNoResponse: () => "no-response" },
    );

    expect(result).toBe("no-response");
  });
});

describe("elicitWithClockPause — reporting an unanswered question", () => {
  function recordingLogger(): { logger: Logger; records: { level: string; fields: unknown }[] } {
    const records: { level: string; fields: unknown }[] = [];
    const at =
      (level: string) =>
      (obj: unknown): void => {
        records.push({ level, fields: obj });
      };
    return {
      records,
      logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") },
    };
  }

  it("says a human never answered, because only the caller's default records it otherwise", async () => {
    const sink = recordingLogger();
    const clock = createFakeClock();
    const result = await elicitWithClockPause(
      clock,
      undefined,
      async () => {
        await Promise.resolve();
        throw new ElicitTimeoutError();
      },
      { onResult: () => "answered", onNoResponse: () => "defaulted" },
      { logger: sink.logger },
    );
    expect(result).toBe("defaulted");
    expect(sink.records.length).toBe(1);
    expect(sink.records[0]?.level).toBe("info");
    const fields = sink.records[0]?.fields as Record<string, unknown>;
    expect(fields.event).toBe("capability.elicit_no_response");
    expect(typeof fields.waited_ms).toBe("number");
  });

  it("says nothing when the question was answered", async () => {
    const sink = recordingLogger();
    await elicitWithClockPause(
      createFakeClock(),
      undefined,
      async () => ACCEPTED,
      { onResult: () => "answered", onNoResponse: () => "defaulted" },
      { logger: sink.logger },
    );
    expect(sink.records).toEqual([]);
  });

  it("discards the report when no caller supplied a logger", async () => {
    const result = await elicitWithClockPause(
      createFakeClock(),
      undefined,
      async () => {
        await Promise.resolve();
        throw new ElicitTimeoutError();
      },
      { onResult: () => "answered", onNoResponse: () => "defaulted" },
    );
    expect(result).toBe("defaulted");
  });
});
