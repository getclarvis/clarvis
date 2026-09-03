import { afterEach, beforeEach, describe, it, expect, vi } from "../helpers/bun-test.ts";
import {
  makeDeltaBatcher,
  makeToolInputReporter,
  TOOL_INPUT_REPORT_MS,
} from "../../src/ai-sdk/streaming.ts";

type Delta = { channel: "text" | "reasoning"; text: string; reset: boolean };

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

function collector(opts?: { maxChars: number; maxMs: number }): {
  deltas: Delta[];
  push: (channel: "text" | "reasoning", text: string) => void;
  flush: () => void;
} {
  const deltas: Delta[] = [];
  const b = opts
    ? makeDeltaBatcher((d) => deltas.push(d), opts)
    : makeDeltaBatcher((d) => deltas.push(d));
  return { deltas, push: b.push, flush: b.flush };
}

describe("makeDeltaBatcher", () => {
  it("flushes the very first token immediately, then starts batching", () => {
    const c = collector({ maxChars: 1000, maxMs: 10_000 });
    c.push("text", "H");
    expect(c.deltas).toHaveLength(1);
    expect(c.deltas[0]).toEqual({ channel: "text", text: "H", reset: true });

    c.push("text", "ello");
    c.push("text", " world");
    expect(c.deltas).toHaveLength(1);
  });

  it("aggregates until the char budget is reached", () => {
    const c = collector({ maxChars: 10, maxMs: 10_000 });
    c.push("text", "0123456789"); // first push: immediate
    c.deltas.length = 0;
    c.push("text", "abcd");
    c.push("text", "efg");
    expect(c.deltas).toHaveLength(0);
    c.push("text", "hij");
    expect(c.deltas).toHaveLength(1);
    expect(c.deltas[0]!.text).toBe("abcdefghij");
  });

  it("aggregates until the time budget elapses, then flushes without being pushed again", () => {
    // The budget must be a deadline, not a stale-check the next delta performs:
    // the provider goes silent for tens of seconds the moment it switches to
    // tool-call arguments, and the tail of the last sentence used to sit in the
    // buffer for all of it — which is what froze the assistant mid-word.
    const c = collector({ maxChars: 10_000, maxMs: 20 });
    c.push("text", "first"); // immediate
    c.deltas.length = 0;
    c.push("text", "a");
    expect(c.deltas).toHaveLength(0);
    vi.advanceTimersByTime(20);
    expect(c.deltas).toHaveLength(1);
    expect(c.deltas[0]!.text).toBe("a");
  });

  it("delivers the tail during a long silence, not when the stream finally ends", () => {
    const c = collector({ maxChars: 10_000, maxMs: 20 });
    c.push("text", "Vamos ver."); // immediate
    c.deltas.length = 0;
    c.push("text", " Segu");
    // Stand in for the provider switching to tool-call arguments: no further
    // delta of any channel arrives for a long time.
    vi.advanceTimersByTime(200);
    expect(c.deltas.map((d) => d.text)).toEqual([" Segu"]);
    // The end-of-stream flush then has nothing left to deliver.
    c.flush();
    expect(c.deltas).toHaveLength(1);
  });

  it("does not leave a timer armed once the buffer has drained", () => {
    const c = collector({ maxChars: 10_000, maxMs: 20 });
    c.push("text", "first");
    c.deltas.length = 0;
    c.push("text", "tail");
    c.flush();
    expect(c.deltas).toHaveLength(1);
    // A timer surviving the explicit flush would emit an empty or duplicate
    // batch here; `flush` disarms before it inspects the buffer.
    vi.advanceTimersByTime(60);
    expect(c.deltas).toHaveLength(1);
  });

  it("captures a sink failure from an idle timer and surfaces it on the owning call", () => {
    let reports = 0;
    const batcher = makeDeltaBatcher(
      () => {
        reports += 1;
        if (reports === 2) throw new Error("sink failed");
      },
      { maxChars: 10_000, maxMs: 20 },
    );
    batcher.push("text", "first");
    batcher.push("text", "tail");
    expect(() => vi.advanceTimersByTime(20)).not.toThrow();
    expect(() => batcher.flush()).toThrow("sink failed");
    batcher.dispose();
  });

  it("wraps a non-Error sink failure so the owning call still gets a throwable", () => {
    // A sink is caller-supplied, so it can reject with anything at all. The
    // batcher must still surface something with a stack, and must not lose what
    // was actually thrown.
    let reports = 0;
    const batcher = makeDeltaBatcher(
      () => {
        reports += 1;
        if (reports === 2) throw "sink exploded";
      },
      { maxChars: 10_000, maxMs: 20 },
    );
    batcher.push("text", "first");
    batcher.push("text", "tail");
    expect(() => vi.advanceTimersByTime(20)).not.toThrow();
    try {
      batcher.flush();
      throw new Error("flush should have rethrown the sink failure");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("Stream delta sink failed");
      expect((err as Error).cause).toBe("sink exploded");
    }
    batcher.dispose();
  });

  it("flushes the pending buffer when the channel switches, so the two never bleed together", () => {
    const c = collector({ maxChars: 10_000, maxMs: 10_000 });
    c.push("reasoning", "weighing"); // immediate
    c.push("reasoning", " it up");
    c.push("text", "answer");
    expect(c.deltas.map((d) => [d.channel, d.text])).toEqual([
      ["reasoning", "weighing"],
      ["reasoning", " it up"],
    ]);

    c.flush();
    expect(c.deltas.at(-1)).toEqual({ channel: "text", text: "answer", reset: true });
  });

  it("marks reset once per channel — the first batch of each stream, not each batch", () => {
    const c = collector({ maxChars: 4, maxMs: 10_000 });
    c.push("text", "aaaa");
    c.push("text", "bbbb");
    c.push("reasoning", "cccc");
    c.push("reasoning", "dddd");

    const resets = c.deltas.filter((d) => d.reset);
    expect(resets).toHaveLength(2);
    expect(resets.map((d) => d.channel).sort()).toEqual(["reasoning", "text"]);
    expect(c.deltas.find((d) => d.channel === "text")!.reset).toBe(true);
    expect(c.deltas.find((d) => d.channel === "reasoning")!.reset).toBe(true);
  });

  it("loses nothing: flush() drains the tail the thresholds never triggered", () => {
    const c = collector({ maxChars: 10_000, maxMs: 10_000 });
    c.push("text", "opening"); // immediate
    c.push("text", " and the rest");
    c.flush();
    expect(c.deltas.map((d) => d.text).join("")).toBe("opening and the rest");
    c.flush();
    expect(c.deltas).toHaveLength(2);
  });

  it("holds a fast stream under ~20 updates/s (the flicker budget)", () => {
    const CHARS_PER_SECOND = 6000;
    const TOKEN = "token ";
    const rate = (opts: { maxChars: number; maxMs: number }): number => {
      const deltas: Delta[] = [];
      const b = makeDeltaBatcher((d) => deltas.push(d), opts);
      let elapsed = 0;
      const stepMs = (TOKEN.length * 1000) / CHARS_PER_SECOND;
      while (elapsed < 1000) {
        b.push("text", TOKEN);
        elapsed += stepMs;
        vi.advanceTimersByTime(stepMs);
      }
      b.flush();
      return deltas.length;
    };

    expect(rate({ maxChars: 384, maxMs: 64 })).toBeLessThanOrEqual(20);
    expect(rate({ maxChars: 64, maxMs: 80 })).toBeGreaterThan(20);
  });
});

describe("makeToolInputReporter", () => {
  type Report = { call_id: string; tool_name: string; chars: number; complete?: true };
  const collect = (
    maxMs = 0,
  ): { reports: Report[]; r: ReturnType<typeof makeToolInputReporter> } => {
    const reports: Report[] = [];
    return { reports, r: makeToolInputReporter((d) => reports.push(d), maxMs) };
  };

  it("announces the call the moment the tool is named, before any argument exists", () => {
    // This is the event that ends the blind window: everything else about the
    // call arrives only after the whole model call has returned.
    const { reports, r } = collect();
    r.start("call-1", "write_file");
    expect(reports).toEqual([{ call_id: "call-1", tool_name: "write_file", chars: 0 }]);
  });

  it("reports a cumulative size, not a per-slice one", () => {
    const { reports, r } = collect();
    r.start("call-1", "write_file");
    r.delta("call-1", "aaaa");
    r.delta("call-1", "bb");
    expect(reports.map((d) => d.chars)).toEqual([0, 4, 6]);
  });

  it("keeps concurrent calls apart until each explicit end", () => {
    const { reports, r } = collect();
    r.start("call-1", "write_file");
    r.start("call-2", "read_file");
    r.delta("call-1", "12345");
    r.delta("call-2", "xy");
    r.end("call-2");
    r.delta("call-1", "!");
    expect(reports.slice(2)).toEqual([
      { call_id: "call-1", tool_name: "write_file", chars: 5 },
      { call_id: "call-2", tool_name: "read_file", chars: 2 },
      { call_id: "call-2", tool_name: "read_file", chars: 2, complete: true },
      { call_id: "call-1", tool_name: "write_file", chars: 6 },
    ]);
  });

  it("throttles per call, and the final report is never throttled away", () => {
    // At the ~1ms inter-arrival measured on the wire an unthrottled reporter
    // fires thousands of times for one call.
    const { reports, r } = collect(10_000);
    r.start("call-1", "write_file");
    for (let i = 0; i < 500; i++) r.delta("call-1", "x");
    expect(reports).toHaveLength(1);
    r.end("call-1");
    expect(reports).toHaveLength(2);
    expect(reports[1]).toEqual({
      call_id: "call-1",
      tool_name: "write_file",
      chars: 500,
      complete: true,
    });
  });

  it("defaults to a rate a person can read, not the rate prose streams at", () => {
    // A floor rather than an equality, so retuning inside the intended range
    // does not break the test. What it guards is the one change that looks
    // like a tidy-up and is not: re-matching this to DELTA_BATCH.maxMs. Prose
    // appends and reads as smooth at 64ms; this rewrites one cell, and at 64ms
    // it shimmered against the terminal UI's 200ms repaint clock.
    expect(TOOL_INPUT_REPORT_MS).toBeGreaterThanOrEqual(200);
  });

  it("ignores deltas for a call it never saw start, rather than inventing a name", () => {
    const { reports, r } = collect();
    r.delta("ghost", "payload");
    r.end("ghost");
    expect(reports).toEqual([]);
  });

  it("forgets a call once it ends, so a late delta cannot resurrect it", () => {
    const { reports, r } = collect();
    r.start("call-1", "write_file");
    r.end("call-1");
    r.delta("call-1", "late");
    expect(reports).toHaveLength(2);
  });
});
