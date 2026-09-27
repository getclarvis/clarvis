import { expect, test } from "bun:test";
import {
  createStreamMetrics,
  createStreamMetricsCounter,
  selectStreamMetrics,
  streamMetrics,
} from "#src/adapters/stream-metrics.ts";

test("an absent debug path selects an inert sink without process resources", () => {
  const metrics = selectStreamMetrics(undefined, "code");
  expect(() => {
    metrics.count("delta");
    metrics.dispose();
    metrics.dispose();
  }).not.toThrow();
  expect(streamMetrics("code", () => undefined)).toBe(metrics);
});

test("stream metrics calculate independent windows and one final total from explicit samples", () => {
  let now = 100;
  const lines: Array<Record<string, unknown>> = [];
  const metrics = createStreamMetricsCounter("code", {
    now: () => now,
    memoryUsage: () => ({ rss: 10, heapUsed: 20, external: 30 }),
    emit: (line) => lines.push(line as Record<string, unknown>),
  });
  metrics.flushWindow();
  expect(lines[0]).toMatchObject({
    source: "code",
    window_ms: 0,
    counts: {},
    rates: {},
    rss: 10,
    heap_used: 20,
    external: 30,
  });
  metrics.count("delta", 3);
  now = 1_100;
  metrics.flushWindow();
  expect(lines[1]).toMatchObject({
    at: 1_100,
    window_ms: 1_000,
    counts: { delta: 3 },
    rates: { delta: 3 },
  });
  metrics.count("delta", 2);
  metrics.finish();
  metrics.finish();
  expect(lines).toHaveLength(4);
  expect(lines[2]).toMatchObject({ counts: { delta: 2 }, rates: { delta: 0 } });
  expect(lines[3]).toMatchObject({ totals: { delta: 5 } });
});

test("stream metrics dispose cancels its timer and listener once", () => {
  const lines: object[] = [];
  let tick = (): void => undefined;
  let exit = (): void => undefined;
  let cancellations = 0;
  let removals = 0;
  const metrics = createStreamMetrics("unused", "code", {
    now: () => 100,
    memoryUsage: () => ({ rss: 1, heapUsed: 2, external: 3 }),
    emit: (line) => lines.push(line),
    schedule: (callback) => {
      tick = callback;
      return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>;
    },
    cancel: () => {
      cancellations++;
    },
    onExit: (callback) => {
      exit = callback;
    },
    offExit: () => {
      removals++;
    },
  });
  metrics.count("x");
  tick();
  exit();
  metrics.dispose();
  tick();
  expect(cancellations).toBe(1);
  expect(removals).toBe(1);
  expect(lines).toHaveLength(3);
});

test("stream metrics tolerate a failing emission without losing the next total", () => {
  let writes = 0;
  const metrics = createStreamMetricsCounter("code", {
    now: () => 1,
    memoryUsage: () => ({ rss: 1, heapUsed: 2, external: 3 }),
    emit: () => {
      if (writes++ === 0) throw new Error("unwritable");
    },
  });
  metrics.count("x");
  expect(() => metrics.finish()).not.toThrow();
  expect(writes).toBe(2);
});
