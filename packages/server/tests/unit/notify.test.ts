import { describe, it, expect, mock } from "bun:test";
import { RUN_EVENT_POLICY, sizeOfRunEvent } from "@clarvis/kernel/policy";
import type { RunEvent } from "@clarvis/protocol";
import {
  createNotificationSink,
  isDroppable,
  type NotificationSinkOptions,
  type SendNotification,
} from "../../src/mcp/notify.ts";
import { createManualTimeouts } from "../helpers/manual-timeouts.ts";
import { recordingLoggers } from "../helpers/harness.ts";

type NotifArg = Parameters<SendNotification>[0];

function textDelta(overrides: Partial<Extract<RunEvent, { type: "text_delta" }>> = {}): RunEvent {
  return {
    type: "text_delta",
    at: 1,
    agent: "lead",
    iteration: 1,
    channel: "text",
    text: "hi",
    reset: false,
    ...overrides,
  };
}

function toolOutputDelta(
  overrides: Partial<Extract<RunEvent, { type: "tool_output_delta" }>> = {},
): RunEvent {
  return {
    type: "tool_output_delta",
    at: 1,
    agent: "lead",
    call_id: "call-1",
    chunk: "chunk",
    ...overrides,
  };
}

function runStarted(): RunEvent {
  return { type: "run_started", at: 1 };
}

function toolCallStarted(callId: string): RunEvent {
  return {
    type: "tool_call_started",
    at: 1,
    agent: "lead",
    call_id: callId,
    tool: "bash",
    server: "clarvis",
  };
}

function baseOptions(overrides: Partial<NotificationSinkOptions> = {}): NotificationSinkOptions {
  return {
    sendNotification: mock(async (_n: NotifArg) => {}),
    getLevel: () => "info",
    bufferMax: 10,
    bufferMaxBytes: 1024 * 1024,
    sendTimeoutMs: 1000,
    ...overrides,
  };
}

/** A send port held until the test has asserted the buffer state. */
function deferredSender(): { send: SendNotification; release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { send: () => held, release };
}

describe("isDroppable", () => {
  it("agrees with kernel's RUN_EVENT_POLICY for every run event type", () => {
    for (const type of Object.keys(RUN_EVENT_POLICY) as (keyof typeof RUN_EVENT_POLICY)[]) {
      const event = { type } as unknown as RunEvent;
      expect(isDroppable(event)).toBe(RUN_EVENT_POLICY[type].droppable);
    }
  });
});

describe("createNotificationSink state machine", () => {
  it("bounds a cyclic structural notification and rejects later work once wedged", () => {
    const params: Record<string, unknown> = {};
    params.self = params;
    const sink = createNotificationSink(baseOptions({ bufferMaxBytes: 1 }));

    sink.notify({ method: "notifications/cyclic", params });
    sink.notify({ method: "notifications/late", params: {} });

    expect(sink.stats()).toMatchObject({ wedged: true, truncated: true, events_dropped: 2 });
  });

  it("rejects structural notifications after the producer is sealed", () => {
    const sink = createNotificationSink(baseOptions());

    sink.seal();
    sink.notify({ method: "notifications/late", params: {} });

    expect(sink.stats()).toMatchObject({ truncated: true, events_dropped: 1 });
  });

  it("sends a message notification once the level threshold is met", async () => {
    const sendNotification = mock(async (_n: NotifArg) => {});
    const sink = createNotificationSink(baseOptions({ sendNotification }));
    sink.onEvent(runStarted());
    await sink.flush();

    expect(sendNotification).toHaveBeenCalledTimes(1);
    const [call] = sendNotification.mock.calls;
    expect(call?.[0]).toMatchObject({
      method: "notifications/message",
      params: { level: "info", logger: "clarvis.run" },
    });
    expect(sink.stats()).toMatchObject({ events_sent: 1, events_dropped: 0, wedged: false });
  });

  it("also emits a progress notification when a progressToken is configured", async () => {
    const sendNotification = mock(async (_n: NotifArg) => {});
    const sink = createNotificationSink(baseOptions({ sendNotification, progressToken: "tok" }));
    sink.onEvent(runStarted());
    await sink.flush();

    expect(sendNotification).toHaveBeenCalledTimes(2);
    const methods = sendNotification.mock.calls.map((c) => c[0]?.method);
    expect(methods).toEqual(["notifications/message", "notifications/progress"]);
    const progressCall = sendNotification.mock.calls[1]?.[0];
    expect(progressCall?.params).toMatchObject({ progressToken: "tok", progress: 1 });
  });

  it("skips the message notification below the level threshold", async () => {
    const sendNotification = mock(async (_n: NotifArg) => {});
    const sink = createNotificationSink(baseOptions({ sendNotification, getLevel: () => "error" }));
    sink.onEvent(runStarted());
    await sink.flush();

    expect(sendNotification).not.toHaveBeenCalled();
    expect(sink.stats().events_sent).toBe(0);
  });

  it("coalesces adjacent deltas sharing a merge key into one entry", async () => {
    let resolveFirstSend: (() => void) | undefined;
    let calls = 0;
    const sendNotification = mock(async (_n: NotifArg) => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve) => {
          resolveFirstSend = resolve;
        });
      }
    });
    const sink = createNotificationSink(baseOptions({ sendNotification, getLevel: () => "debug" }));

    sink.onEvent(textDelta({ iteration: 1, text: "unrelated" }));
    sink.onEvent(textDelta({ iteration: 2, text: "he" }));
    sink.onEvent(textDelta({ iteration: 2, text: "llo" }));
    expect(sink.stats().deltas_coalesced).toBe(1);

    resolveFirstSend?.();
    await sink.flush();

    expect(sendNotification).toHaveBeenCalledTimes(2);
    const merged = (sendNotification.mock.calls[1]?.[0]?.params as { data: RunEvent }).data;
    expect(merged).toMatchObject({ type: "text_delta", iteration: 2, text: "hello" });
  });

  it("coalesces a large stalled-transport delta storm without losing wire order", async () => {
    const sender = deferredSender();
    const sent: NotifArg[] = [];
    let first = true;
    const sink = createNotificationSink(
      baseOptions({
        getLevel: () => "debug",
        bufferMax: 25_000,
        sendTimeoutMs: 100_000,
        sendNotification: async (notification) => {
          sent.push(notification);
          if (first) {
            first = false;
            await sender.send(notification);
          }
        },
      }),
    );
    sink.onEvent(runStarted());
    const parts = Array.from({ length: 20_000 }, (_, index) => String(index % 10));
    for (const part of parts) sink.onEvent(textDelta({ text: part }));

    expect(sink.stats().deltas_coalesced).toBe(parts.length - 1);
    sender.release();
    await sink.flush();

    const delivered = sent.find(
      (notification) => (notification.params as { data?: RunEvent }).data?.type === "text_delta",
    );
    expect(
      (delivered?.params as { data: Extract<RunEvent, { type: "text_delta" }> }).data.text,
    ).toBe(parts.join(""));
  });

  it("attaches one drain observer for a stalled 100k-delta storm", async () => {
    const sender = deferredSender();
    const observed: Promise<void>[] = [];
    const sink = createNotificationSink(
      baseOptions({
        sendNotification: sender.send,
        getLevel: () => "debug",
        sendTimeoutMs: 100_000,
        observeDrain: (drain) => observed.push(drain),
      }),
    );

    sink.onEvent(runStarted());
    for (let index = 0; index < 100_000; index += 1) {
      sink.onEvent(textDelta({ text: "x" }));
    }

    // The old per-event observation attached 100,001 Promise reactions to this
    // one pending drain, retaining heap proportional to delta count despite the
    // queue's retained-byte cap.
    expect(observed).toHaveLength(1);
    expect(sink.stats()).toMatchObject({ deltas_coalesced: 99_999, events_dropped: 0 });

    sender.release();
    await observed[0];
    await sink.flush();
  });

  it("rearms once when a producer enters the empty-queue/finally handoff", async () => {
    const sent: RunEvent[] = [];
    const observed: Promise<void>[] = [];
    let idlePasses = 0;
    const sink = createNotificationSink(
      baseOptions({
        getLevel: () => "debug",
        sendNotification: async (notification) => {
          const event = (notification.params as { data?: RunEvent }).data;
          if (event !== undefined) sent.push(event);
        },
        observeDrain: (drain) => observed.push(drain),
        onDrainIdle: () => {
          idlePasses += 1;
          if (idlePasses === 1) {
            sink.onEvent(textDelta({ iteration: 2, text: "handoff" }));
          }
        },
      }),
    );

    sink.onEvent(textDelta({ iteration: 1, text: "first" }));
    await sink.flush();

    expect(observed).toHaveLength(2);
    expect(sent.map((event) => (event.type === "text_delta" ? event.text : event.type))).toEqual([
      "first",
      "handoff",
    ]);
  });

  it("marks the sink wedged and drops the remaining queue when a send throws", async () => {
    const sendNotification = mock(async (_n: NotifArg) => {
      throw new Error("boom");
    });
    const sink = createNotificationSink(baseOptions({ sendNotification, getLevel: () => "debug" }));
    sink.onEvent(textDelta({ iteration: 1 }));
    sink.onEvent(textDelta({ iteration: 2 }));
    sink.onEvent(textDelta({ iteration: 3 }));
    await sink.flush();

    const stats = sink.stats();
    expect(stats.wedged).toBe(true);
    expect(stats.events_dropped).toBeGreaterThan(0);
  });

  it("marks the sink wedged when a send exceeds the timeout", async () => {
    const timeouts = createManualTimeouts();
    const sender = deferredSender();
    const sendNotification = mock(sender.send);
    const sink = createNotificationSink(
      baseOptions({
        sendNotification,
        getLevel: () => "debug",
        sendTimeoutMs: 5,
        scheduleTimeout: timeouts.schedule,
      }),
    );
    sink.onEvent(runStarted());
    const flushing = sink.flush();
    expect(timeouts.pending).toBe(1);
    timeouts.fireNext();
    await flushing;

    expect(sink.stats().wedged).toBe(true);
    sender.release();
  });

  it("drops new events immediately once wedged, without calling sendNotification again", async () => {
    const sendNotification = mock(async (_n: NotifArg) => {
      throw new Error("boom");
    });
    const sink = createNotificationSink(baseOptions({ sendNotification, getLevel: () => "debug" }));
    sink.onEvent(runStarted());
    await sink.flush();
    expect(sink.stats().wedged).toBe(true);

    const callsBefore = sendNotification.mock.calls.length;
    const dropsBefore = sink.stats().events_dropped;
    sink.onEvent(runStarted());
    sink.onEvent(runStarted());
    await sink.flush();

    expect(sendNotification.mock.calls.length).toBe(callsBefore);
    expect(sink.stats().events_dropped).toBe(dropsBefore + 2);
  });

  it("drops the oldest droppable entry once the buffer is full", async () => {
    const sender = deferredSender();
    const sink = createNotificationSink(
      baseOptions({
        sendNotification: sender.send,
        getLevel: () => "debug",
        bufferMax: 2,
        sendTimeoutMs: 100_000,
      }),
    );

    sink.onEvent(toolOutputDelta({ call_id: "a" }));
    sink.onEvent(toolOutputDelta({ call_id: "b" }));
    sink.onEvent(toolOutputDelta({ call_id: "c" }));
    sink.onEvent(toolOutputDelta({ call_id: "d" }));

    expect(sink.stats().events_dropped).toBe(1);
    sender.release();
    await sink.flush();
  });

  it("drops queued deltas when the retained-byte budget fills before the count cap", async () => {
    const sender = deferredSender();
    const small = textDelta({ text: "small", iteration: 1 });
    const sink = createNotificationSink(
      baseOptions({
        sendNotification: sender.send,
        getLevel: () => "debug",
        bufferMax: 100,
        bufferMaxBytes: sizeOfRunEvent(small) + 8,
        sendTimeoutMs: 100_000,
      }),
    );

    sink.onEvent(runStarted()); // held in flight, outside the queued budget
    sink.onEvent(small);
    sink.onEvent(textDelta({ text: "another", iteration: 2 }));

    expect(sink.stats().events_dropped).toBe(1);
    sender.release();
    await sink.flush();
  });

  it("rejects a tail merge when the whole queued buffer would exceed its byte budget", async () => {
    const sender = deferredSender();
    const delivered: RunEvent[] = [];
    const unrelated = textDelta({ iteration: 1, text: "unrelated" });
    const tail = textDelta({ iteration: 2, text: "tail" });
    const sink = createNotificationSink(
      baseOptions({
        sendNotification: async (notification) => {
          const event = (notification.params as { data?: RunEvent }).data;
          if (event !== undefined) delivered.push(event);
          await sender.send(notification);
        },
        getLevel: () => "debug",
        bufferMax: 100,
        bufferMaxBytes: sizeOfRunEvent(unrelated) + sizeOfRunEvent(tail),
        sendTimeoutMs: 100_000,
      }),
    );

    sink.onEvent(runStarted()); // held in flight, outside the queued budget
    sink.onEvent(unrelated);
    sink.onEvent(tail);
    sink.onEvent(textDelta({ iteration: 2, text: "-would-overflow" }));

    expect(sink.stats()).toMatchObject({ events_dropped: 1, deltas_coalesced: 0 });
    sender.release();
    await sink.flush();

    expect(delivered.flatMap((event) => (event.type === "text_delta" ? [event.text] : []))).toEqual(
      ["unrelated"],
    );
  });

  it("wedges on one structural event larger than the byte budget", async () => {
    const sink = createNotificationSink(baseOptions({ bufferMaxBytes: 1 }));

    sink.onEvent(runStarted());

    expect(sink.stats()).toMatchObject({ wedged: true, truncated: true, events_dropped: 1 });
  });

  it("drops the incoming droppable event when no queued entry is droppable", async () => {
    const sender = deferredSender();
    const sink = createNotificationSink(
      baseOptions({
        sendNotification: sender.send,
        getLevel: () => "debug",
        bufferMax: 2,
        sendTimeoutMs: 100_000,
      }),
    );

    sink.onEvent(toolCallStarted("1"));
    sink.onEvent(toolCallStarted("2"));
    sink.onEvent(toolCallStarted("3"));
    sink.onEvent(toolOutputDelta({ call_id: "4" }));

    expect(sink.stats().events_dropped).toBe(1);
    sender.release();
    await sink.flush();
  });

  it("wedges instead of growing without bound when structural events saturate the buffer", async () => {
    const sender = deferredSender();
    const sink = createNotificationSink(
      baseOptions({
        sendNotification: sender.send,
        getLevel: () => "debug",
        bufferMax: 2,
        sendTimeoutMs: 100_000,
      }),
    );

    sink.onEvent(toolCallStarted("1"));
    sink.onEvent(toolCallStarted("2"));
    sink.onEvent(toolCallStarted("3"));
    sink.onEvent(toolCallStarted("4"));

    expect(sink.stats()).toMatchObject({
      wedged: true,
      truncated: true,
      events_dropped: 3,
    });
    sender.release();
    await sink.flush();
  });

  it("seals the producer after result grace while draining already queued events", async () => {
    const sender = deferredSender();
    const sink = createNotificationSink(
      baseOptions({
        sendNotification: sender.send,
        getLevel: () => "debug",
        sendTimeoutMs: 100_000,
      }),
    );
    sink.onEvent(runStarted());
    sink.onEvent(toolCallStarted("queued"));
    sink.seal(true);
    sink.onEvent(toolCallStarted("late"));

    expect(sink.stats()).toMatchObject({ truncated: true, events_dropped: 1 });
    sender.release();
    await sink.flush();
    // Two queued events drain, then flush reports the one post-seal drop.
    expect(sink.stats().events_sent).toBe(3);
  });

  it("heartbeat emits a progress notification when a progressToken is configured", async () => {
    const sendNotification = mock(async (_n: NotifArg) => {});
    const sink = createNotificationSink(baseOptions({ sendNotification, progressToken: 7 }));
    sink.heartbeat();
    await sink.flush();

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification.mock.calls[0]?.[0]).toMatchObject({
      method: "notifications/progress",
      params: { progressToken: 7, progress: 1, message: "working" },
    });
  });

  it("deduplicates a heartbeat while its transport send is still in flight", async () => {
    const sender = deferredSender();
    const sendNotification = mock(sender.send);
    const sink = createNotificationSink(
      baseOptions({
        sendNotification,
        progressToken: "tok",
        sendTimeoutMs: 100_000,
      }),
    );

    sink.heartbeat();
    sink.heartbeat();
    sink.heartbeat();
    expect(sendNotification).toHaveBeenCalledTimes(1);

    let flushed = false;
    const flushing = sink.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBeFalse();

    sender.release();
    await flushing;
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("serializes facade notifications, events and heartbeats with monotonic progress", async () => {
    const sender = deferredSender();
    const delivered: NotifArg[] = [];
    let first = true;
    const sink = createNotificationSink(
      baseOptions({
        progressToken: "tok",
        sendTimeoutMs: 100_000,
        sendNotification: async (notification) => {
          delivered.push(notification);
          if (first) {
            first = false;
            await sender.send(notification);
          }
        },
      }),
    );

    sink.notify({ method: "notifications/custom", params: { phase: "accepted" } });
    sink.onEvent(runStarted());
    sink.heartbeat();
    expect(delivered).toHaveLength(1);

    sender.release();
    await sink.flush();

    expect(delivered.map((notification) => notification.method)).toEqual([
      "notifications/custom",
      "notifications/message",
      "notifications/progress",
      "notifications/progress",
    ]);
    expect(
      delivered
        .filter((notification) => notification.method === "notifications/progress")
        .map((notification) => notification.params.progress),
    ).toEqual([1, 2]);
  });

  it("heartbeat is a no-op without a progressToken", () => {
    const sendNotification = mock(async (_n: NotifArg) => {});
    const sink = createNotificationSink(baseOptions({ sendNotification }));
    sink.heartbeat();

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("heartbeat is a no-op once wedged", async () => {
    const sendNotification = mock(async (_n: NotifArg) => {
      throw new Error("boom");
    });
    const sink = createNotificationSink(baseOptions({ sendNotification, progressToken: "tok" }));
    sink.onEvent(runStarted());
    await sink.flush();
    expect(sink.stats().wedged).toBe(true);

    const callsBefore = sendNotification.mock.calls.length;
    sink.heartbeat();

    expect(sendNotification.mock.calls.length).toBe(callsBefore);
  });

  it("flush reports a notifications_dropped warning once dropped events exist", async () => {
    const sendNotification = mock(async (_n: NotifArg) => {});
    const sink = createNotificationSink(
      baseOptions({
        sendNotification,
        getLevel: () => "debug",
        bufferMax: 1,
        sendTimeoutMs: 100_000,
      }),
    );

    sink.onEvent(toolOutputDelta({ call_id: "a" }));
    await sink.flush();
    sendNotification.mockClear();

    sink.onEvent(toolCallStarted("1"));
    sink.onEvent(toolOutputDelta({ call_id: "b" }));
    sink.onEvent(toolOutputDelta({ call_id: "c" }));
    await sink.flush();

    const warningCall = sendNotification.mock.calls.find(
      (c) => (c[0]?.params as { data?: { type?: string } })?.data?.type === "notifications_dropped",
    );
    expect(warningCall).toBeDefined();
    expect(warningCall?.[0]).toMatchObject({
      method: "notifications/message",
      params: { level: "warning", logger: "clarvis.stream" },
    });
  });

  it("flush does not report drops once the sink is wedged", async () => {
    const sendNotification = mock(async (_n: NotifArg) => {
      throw new Error("boom");
    });
    const sink = createNotificationSink(
      baseOptions({ sendNotification, getLevel: () => "debug", bufferMax: 1 }),
    );

    sink.onEvent(toolOutputDelta({ call_id: "a" }));
    sink.onEvent(toolOutputDelta({ call_id: "b" }));
    sink.onEvent(toolOutputDelta({ call_id: "c" }));
    await sink.flush();

    expect(sink.stats().wedged).toBe(true);
    const calls = sendNotification.mock.calls.length;

    await sink.flush();
    expect(sendNotification.mock.calls.length).toBe(calls);
  });

  it("stats returns a snapshot copy, not a live reference", async () => {
    const sink = createNotificationSink(baseOptions());
    const first = sink.stats();
    sink.onEvent(runStarted());
    await sink.flush();

    expect(first.events_sent).toBe(0);
    expect(sink.stats().events_sent).toBe(1);
  });

  it("reports a wedge once, with the counters as they stood", async () => {
    const logs = recordingLoggers();
    const timeouts = createManualTimeouts();
    const drains: Promise<void>[] = [];
    const sink = createNotificationSink(
      baseOptions({
        logger: logs.loggers.log,
        sendTimeoutMs: 50,
        scheduleTimeout: timeouts.schedule,
        sendNotification: () => new Promise<void>(() => {}),
        observeDrain: (drain) => drains.push(drain),
      }),
    );

    sink.onEvent(runStarted());
    await Bun.sleep(1);
    timeouts.fireNext();
    await Promise.allSettled(drains);
    sink.onEvent(runStarted());
    await Bun.sleep(1);

    const record = logs.one("stream.wedged");
    expect(record.level).toBe("warn");
    expect(record.fields).toMatchObject({ reason: "send_timeout", send_timeout_ms: 50, sent: 0 });
  });

  it("reports a wedge caused by a full buffer of undroppable entries", () => {
    const logs = recordingLoggers();
    const params: Record<string, unknown> = {};
    params.self = params;
    const sink = createNotificationSink(
      baseOptions({ logger: logs.loggers.log, bufferMaxBytes: 1 }),
    );

    sink.notify({ method: "notifications/cyclic", params });
    sink.notify({ method: "notifications/late", params: {} });

    expect(logs.one("stream.wedged").fields.reason).toBe("buffer_full");
  });

  it("reports the drop total once, at seal, never per dropped event", async () => {
    const logs = recordingLoggers();
    const sink = createNotificationSink(
      baseOptions({ logger: logs.loggers.log, bufferMax: 1, bufferMaxBytes: 1 }),
    );

    sink.onEvent(textDelta({ text: "a" }));
    sink.onEvent(toolCallStarted("call-1"));
    sink.seal();

    const record = logs.one("stream.dropped");
    expect(record.level).toBe("debug");
    expect(Number(record.fields.dropped_total)).toBeGreaterThan(0);
  });

  it("says nothing at seal for a run that lost nothing", async () => {
    const logs = recordingLoggers();
    const sink = createNotificationSink(baseOptions({ logger: logs.loggers.log }));
    sink.onEvent(runStarted());
    await sink.flush();
    sink.seal();
    expect(logs.find("stream.dropped")).toHaveLength(0);
    expect(logs.find("stream.wedged")).toHaveLength(0);
  });
});
