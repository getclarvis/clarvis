import { describe, it, expect } from "bun:test";
import type { RunEvent } from "@clarvis/protocol";
import { createEventStream } from "../../src/core/event-stream.ts";
import {
  coalesceRunEvents,
  inspectCoalescedRunEvent,
  isDroppableRunEvent,
  sizeOfCoalescedRunEvent,
  sizeOfRunEvent,
} from "../../src/runs/coalesce-events.ts";

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

function textDelta(text: string, over: Partial<Extract<RunEvent, { type: "text_delta" }>> = {}) {
  return {
    type: "text_delta" as const,
    at: 1,
    agent: "lead" as const,
    iteration: 1,
    channel: "text" as const,
    text,
    reset: false,
    ...over,
  };
}

function toolDelta(chunk: string, callId = "c1") {
  return {
    type: "tool_output_delta" as const,
    at: 1,
    agent: "lead" as const,
    call_id: callId,
    chunk,
  };
}

function inputDelta(chars: number, callId = "c1") {
  return {
    type: "tool_input_delta" as const,
    at: 1,
    agent: "lead" as const,
    call_id: callId,
    tool: "write_file",
    chars,
  };
}

const RUN_ENDED: RunEvent = { type: "run_ended", at: 9, status: "completed" };

const policy = {
  maxBuffered: 4,
  coalesce: coalesceRunEvents,
  droppable: isDroppableRunEvent,
};

describe("event-stream — default policy is unchanged", () => {
  it("wakes a pending next when its consumer returns early", async () => {
    const stream = createEventStream<number>();
    const iterator = stream.iterable[Symbol.asyncIterator]();
    const pending = iterator.next();

    expect(await iterator.return?.()).toEqual({ done: true, value: undefined });
    expect(await pending).toEqual({ done: true, value: undefined });
  });

  it("is unbounded and never merges or drops when no options are given", async () => {
    const s = createEventStream<number>();
    for (let i = 0; i < 5000; i += 1) s.push(i);
    s.close();
    const items = await drain(s.iterable);
    expect(items).toHaveLength(5000);
    expect(items[0]).toBe(0);
    expect(items[4999]).toBe(4999);
    expect(s.dropped()).toBe(0);
  });

  it("still drains buffered items before close and before fail", async () => {
    const closing = createEventStream<number>();
    closing.push(1);
    closing.close();
    expect(await drain(closing.iterable)).toEqual([1]);

    const failing = createEventStream<number>();
    failing.push(1);
    failing.fail(new Error("boom"));
    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const n of failing.iterable) seen.push(n);
      })(),
    ).rejects.toThrow("boom");
    expect(seen).toEqual([1]);
  });

  it("ignores a push after close or fail", () => {
    const s = createEventStream<number>();
    s.close();
    s.push(1);
    expect(s.dropped()).toBe(0);
  });

  it("requires a size function when a byte cap is enabled", () => {
    expect(() => createEventStream<string>({ maxBufferedBytes: 10 })).toThrow(
      "maxBufferedBytes requires sizeOf",
    );
  });

  it("reports retained item and byte counters without copying the queue", async () => {
    const s = createEventStream<string>({ maxBufferedBytes: 10, sizeOf: (item) => item.length });
    s.push("abc");
    s.push("de");
    expect(s.stats()).toEqual({ bufferedItems: 2, bufferedBytes: 5, dropped: 0 });

    const iterator = s.iterable[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: "abc" });
    expect(s.stats()).toEqual({ bufferedItems: 1, bufferedBytes: 2, dropped: 0 });
    await iterator.return?.();
  });

  it("abandons the producer once and ignores every later push", async () => {
    let abandoned = 0;
    const s = createEventStream<number>({ onAbandoned: () => (abandoned += 1) });
    const iterator = s.iterable[Symbol.asyncIterator]();
    s.push(1);
    expect(await iterator.next()).toEqual({ done: false, value: 1 });
    expect(await iterator.return?.()).toEqual({ done: true, value: undefined });
    s.push(2);
    s.close();
    expect(abandoned).toBe(1);
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });
});

describe("event-stream — coalescing", () => {
  it("does not merge into a drained buffer, so a keeping-up consumer sees every item", async () => {
    const s = createEventStream<RunEvent>(policy);
    const seen: RunEvent[] = [];
    const consumer = (async () => {
      for await (const ev of s.iterable) seen.push(ev);
    })();

    for (const part of ["a", "b", "c"]) {
      s.push(textDelta(part));
      await Promise.resolve();
      await Promise.resolve();
    }
    s.close();
    await consumer;

    expect(seen).toHaveLength(3);
    expect(seen.map((e) => (e as { text: string }).text)).toEqual(["a", "b", "c"]);
    expect(s.dropped()).toBe(0);
  });

  it("merges adjacent text deltas losslessly while the consumer is behind", async () => {
    const s = createEventStream<RunEvent>(policy);
    s.push(textDelta("hello "));
    s.push(textDelta("brave "));
    s.push(textDelta("world"));
    s.close();

    const items = await drain(s.iterable);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "text_delta", text: "hello brave world", reset: false });
    expect(s.dropped()).toBe(0);
  });

  it("accounts a growing merged tail without remeasuring its full value", async () => {
    let measurements = 0;
    let mergedMeasurements = 0;
    const stream = createEventStream<string>({
      maxBufferedBytes: 100,
      sizeOf: (value) => {
        measurements += 1;
        return value.length;
      },
      coalesce: (previous, incoming) => previous + incoming,
      sizeOfCoalesced: (_previous, _incoming, merged, previousBytes, incomingBytes) => {
        mergedMeasurements += 1;
        expect(merged).toBe("ab");
        return previousBytes + incomingBytes;
      },
    });
    stream.push("a");
    stream.push("b");
    stream.close();

    expect(await drain(stream.iterable)).toEqual(["ab"]);
    expect(measurements).toBe(2);
    expect(mergedMeasurements).toBe(1);
  });

  it("keeps the first delta's `at` and `reset` when merging", async () => {
    const s = createEventStream<RunEvent>(policy);
    s.push(textDelta("a", { at: 100, reset: true }));
    s.push(textDelta("b", { at: 200 }));
    s.close();

    const items = await drain(s.iterable);
    expect(items[0]).toMatchObject({ at: 100, reset: true, text: "ab" });
  });

  it("never merges across a reset, a channel, an iteration, or an agent", async () => {
    const s = createEventStream<RunEvent>({ ...policy, maxBuffered: 0 });
    s.push(textDelta("a"));
    s.push(textDelta("b", { reset: true }));
    s.push(textDelta("c", { channel: "reasoning" }));
    s.push(textDelta("d", { iteration: 2 }));
    s.push(textDelta("e", { agent: "subagent", subagent_id: "s1" }));
    s.close();

    const items = await drain(s.iterable);
    expect(items.map((e) => (e as { text: string }).text)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("merges tool output only within one call_id", async () => {
    const s = createEventStream<RunEvent>({ ...policy, maxBuffered: 0 });
    s.push(toolDelta("x", "c1"));
    s.push(toolDelta("y", "c1"));
    s.push(toolDelta("w", "c1"));
    s.push(toolDelta("z", "c2"));
    s.close();

    const items = await drain(s.iterable);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ call_id: "c1", chunk: "xyw" });
    expect(items[1]).toMatchObject({ call_id: "c2", chunk: "z" });
  });

  it("merges tool input by replacement, because its size is cumulative", async () => {
    // Concatenating the way the two content deltas do would report a 3 KB call
    // as 6 KB — the number is the payload's total size, not a slice of it.
    const s = createEventStream<RunEvent>({ ...policy, maxBuffered: 0 });
    s.push(inputDelta(0, "c1"));
    s.push(inputDelta(1024, "c1"));
    s.push(inputDelta(3072, "c1"));
    s.push(inputDelta(12, "c2"));
    s.close();

    const items = await drain(s.iterable);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ call_id: "c1", chars: 3072, tool: "write_file" });
    expect(items[1]).toMatchObject({ call_id: "c2", chars: 12 });
  });

  it("absorbs a 5k-delta storm through a stalled consumer with zero characters lost", async () => {
    const s = createEventStream<RunEvent>(policy);
    let expected = "";
    for (let i = 0; i < 5000; i += 1) {
      const part = `chunk-${i} `;
      expected += part;
      s.push(textDelta(part));
    }
    s.push(RUN_ENDED);
    s.close();

    const items = await drain(s.iterable);
    expect(s.dropped()).toBe(0);
    expect(items).toHaveLength(2);
    expect((items[0] as { text: string }).text).toBe(expected);
    expect(items[1]).toMatchObject({ type: "run_ended" });
  });

  it("retains a delta storm as bounded chunks and materializes it once", () => {
    const parts = Array.from({ length: 20_000 }, (_, index) => String(index % 10));
    let merged = coalesceRunEvents(textDelta(parts[0]!), textDelta(parts[1]!));
    expect(merged).toBeDefined();
    const aggregate = merged!;
    for (const part of parts.slice(2)) {
      merged = coalesceRunEvents(merged!, textDelta(part));
      expect(merged).toBe(aggregate);
    }

    const before = inspectCoalescedRunEvent(aggregate);
    expect(before?.materializations).toBe(0);
    expect((before?.blocks ?? 0) + (before?.pending ?? 0)).toBeLessThan(4_100);
    expect((aggregate as Extract<RunEvent, { type: "text_delta" }>).text).toBe(parts.join(""));
    expect(JSON.parse(JSON.stringify(aggregate))).toMatchObject({
      type: "text_delta",
      text: parts.join(""),
    });
    expect(inspectCoalescedRunEvent(aggregate)?.materializations).toBe(1);
  });

  it("replaces a lazily coalesced text body through its ordinary wire property", () => {
    const merged = coalesceRunEvents(textDelta("old "), textDelta("body")) as Extract<
      RunEvent,
      { type: "text_delta" }
    >;

    merged.text = "replacement";

    expect(merged.text).toBe("replacement");
    expect(inspectCoalescedRunEvent(merged)).toEqual({
      blocks: 1,
      pending: 0,
      materializations: 0,
    });
  });

  it("replaces a lazily coalesced tool-output body through its wire property", () => {
    const previous = {
      type: "tool_output_delta",
      at: 1,
      call_id: "call",
      chunk: "old ",
      agent: "lead",
    } as const;
    const incoming = { ...previous, at: 2, chunk: "body" };
    const merged = coalesceRunEvents(previous, incoming) as { chunk: string };

    merged.chunk = "replacement";
    expect(merged.chunk).toBe("replacement");
  });

  it("accounts adjacent coalesced event bytes without materializing their full prefix", () => {
    const textPrevious = textDelta("prefix");
    const textIncoming = textDelta('\n"suffix');
    const textMerged = coalesceRunEvents(textPrevious, textIncoming)!;
    expect(
      sizeOfCoalescedRunEvent(
        textPrevious,
        textIncoming,
        textMerged,
        sizeOfRunEvent(textPrevious),
        sizeOfRunEvent(textIncoming),
      ),
    ).toBe(sizeOfRunEvent(textPrevious) + Buffer.byteLength(JSON.stringify(textIncoming.text)) - 2);

    const outputPrevious = toolDelta("prefix");
    const outputIncoming = toolDelta('\n"suffix');
    expect(
      sizeOfCoalescedRunEvent(
        outputPrevious,
        outputIncoming,
        coalesceRunEvents(outputPrevious, outputIncoming)!,
        sizeOfRunEvent(outputPrevious),
        sizeOfRunEvent(outputIncoming),
      ),
    ).toBe(
      sizeOfRunEvent(outputPrevious) + Buffer.byteLength(JSON.stringify(outputIncoming.chunk)) - 2,
    );

    const inputPrevious = inputDelta(10);
    const inputIncoming = inputDelta(2_000);
    const inputMerged = coalesceRunEvents(inputPrevious, inputIncoming)!;
    expect(
      sizeOfCoalescedRunEvent(
        inputPrevious,
        inputIncoming,
        inputMerged,
        sizeOfRunEvent(inputPrevious),
        sizeOfRunEvent(inputIncoming),
      ),
    ).toBe(sizeOfRunEvent(inputMerged));

    expect(
      sizeOfCoalescedRunEvent(RUN_ENDED, RUN_ENDED, RUN_ENDED, 1, sizeOfRunEvent(RUN_ENDED)),
    ).toBe(sizeOfRunEvent(RUN_ENDED));
  });

  it("treats a non-serializable contributed event as maximally oversized", () => {
    const detail: Record<string, unknown> = {};
    detail.self = detail;
    const event = {
      type: "capability_event",
      at: 1,
      capability: "cyclic",
      kind: "cycle",
      projection: "cycle",
      detail,
      truncated: false,
    } satisfies RunEvent;

    expect(sizeOfRunEvent(event)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("event-stream — dropping", () => {
  it("enforces retained bytes after coalescing instead of only item count", async () => {
    const s = createEventStream<RunEvent>({
      maxBuffered: 10,
      maxBufferedBytes: 5,
      sizeOf: (event) => (event.type === "text_delta" ? event.text.length : 1),
      coalesce: coalesceRunEvents,
      droppable: isDroppableRunEvent,
    });
    s.push(textDelta("abc"));
    s.push(textDelta("def"));
    s.push(RUN_ENDED);
    s.close();

    expect(await drain(s.iterable)).toEqual([RUN_ENDED]);
    expect(s.dropped()).toBe(1);
  });

  it("fails closed when one non-droppable item is larger than the byte budget", async () => {
    const s = createEventStream<RunEvent>({
      maxBufferedBytes: 4,
      sizeOf: () => 5,
      droppable: isDroppableRunEvent,
    });
    s.push(RUN_ENDED);
    await expect(drain(s.iterable)).rejects.toThrow("at 4 buffered bytes");
  });

  it("drops the oldest droppable event once the buffer is full", async () => {
    const s = createEventStream<RunEvent>(policy);
    s.push(textDelta("a"));
    s.push(toolDelta("1", "c1"));
    s.push(textDelta("b"));
    s.push(toolDelta("2", "c2"));
    s.push(textDelta("c", { iteration: 9 }));
    s.close();

    const items = await drain(s.iterable);
    expect(s.dropped()).toBe(1);
    expect(items).toHaveLength(4);
    expect(items.some((e) => e.type === "text_delta" && e.text === "a")).toBe(false);
  });

  it("fails closed instead of growing past the cap when only structural events remain", async () => {
    const saturated: RunEvent[] = [];
    const s = createEventStream<RunEvent>({
      ...policy,
      maxBuffered: 2,
      onSaturated: (event) => saturated.push(event),
    });
    const structural: RunEvent[] = [
      { type: "run_started", at: 1 },
      { type: "tool_call", at: 2, agent: "lead", tool: "t", server: "s", ok: true },
      { type: "memory_ingest", at: 3, detail: { execution_id: "x1", phase: "started" } },
      RUN_ENDED,
    ];
    for (const ev of structural) s.push(ev);
    s.close();

    const items: RunEvent[] = [];
    await expect(
      (async () => {
        for await (const item of s.iterable) items.push(item);
      })(),
    ).rejects.toThrow("saturated with 2 non-droppable items");
    expect(s.dropped()).toBe(0);
    expect(items.map((e) => e.type)).toEqual(["run_started", "tool_call"]);
    expect(saturated.map((e) => e.type)).toEqual(["memory_ingest"]);
  });

  it("drops the incoming event when the full buffer holds nothing droppable", async () => {
    const s = createEventStream<RunEvent>({ ...policy, maxBuffered: 1 });
    s.push(RUN_ENDED);
    s.push(textDelta("a"));
    s.close();

    const items = await drain(s.iterable);
    expect(s.dropped()).toBe(1);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "run_ended" });
  });

  it("a terminal notice can itself evict a buffered item — dropped() must be read after that push, not before", async () => {
    const s = createEventStream<RunEvent>({
      maxBuffered: 2,
      coalesce: coalesceRunEvents,
      droppable: (e) => e.type !== "run_ended" && e.type !== "events_dropped",
    });
    s.push({ type: "run_started", at: 1 });
    s.push({ type: "iteration_started", at: 2, agent: "lead", iteration: 1 });
    s.push({
      type: "iteration_completed",
      at: 3,
      agent: "lead",
      iteration: 1,
      response: "ok",
      input_tokens: 1,
      output_tokens: 1,
    });
    s.push(RUN_ENDED);
    // Mirrors run-service.ts's endStream: snapshot, push the terminal
    // notice, then re-read — the push above already forced one eviction
    // (a droppable item, to make room for run_ended), so the buffer is
    // still exactly at capacity and pushing a further non-droppable notice
    // must evict one more droppable victim.
    const snapshot = s.dropped();
    const notice: Extract<RunEvent, { type: "events_dropped" }> = {
      type: "events_dropped",
      at: 9,
      dropped: snapshot,
    };
    s.push(notice);
    notice.dropped = s.dropped();
    s.close();

    const items = await drain(s.iterable);
    const delivered = items.find((e) => e.type === "events_dropped") as
      Extract<RunEvent, { type: "events_dropped" }> | undefined;
    expect(delivered).toBeDefined();
    expect(delivered!.dropped).toBe(s.dropped());
    expect(delivered!.dropped).toBeGreaterThan(snapshot);
  });
});
