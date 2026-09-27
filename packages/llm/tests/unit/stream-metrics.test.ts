import { expect, test } from "../helpers/bun-test.ts";
import { selectStreamMetrics as selectStreamMetricsEntry } from "@clarvis/llm/metrics";
import {
  createStreamMetrics,
  createStreamMetricsCounter,
  selectStreamMetrics,
  streamMetrics,
} from "#src/stream-metrics.ts";

test("an absent debug path selects an inert sink without process resources", () => {
  expect(selectStreamMetricsEntry).toBe(selectStreamMetrics);
  const metrics = selectStreamMetrics(undefined, "loop");
  expect(() => {
    metrics.count("delta");
    metrics.dispose();
    metrics.dispose();
  }).not.toThrow();
  expect(streamMetrics("loop", () => undefined)).toBe(metrics);
});

test("stream metrics calculate windows and a final total from explicit samples", () => {
  let now = 10;
  const lines: Array<Record<string, unknown>> = [];
  const metrics = createStreamMetricsCounter("loop", {
    now: () => now,
    memoryUsage: () => ({ rss: 1, heapUsed: 2, external: 3 }),
    emit: (line) => lines.push(line as Record<string, unknown>),
  });
  metrics.count("delta", 2);
  now = 1_010;
  metrics.flushWindow();
  expect(lines[0]).toMatchObject({
    window_ms: 1000,
    counts: { delta: 2 },
    rates: { delta: 2 },
    rss: 1,
    heap_used: 2,
    external: 3,
  });
  metrics.finish();
  metrics.finish();
  expect(lines).toHaveLength(3);
  expect(lines[1]).toMatchObject({ counts: {}, rates: {} });
  expect(lines[2]).toMatchObject({ totals: { delta: 2 } });
});

test("stream metrics dispose cancels its timer and listener once", () => {
  let exit = (): void => undefined;
  let tick = (): void => undefined;
  let cancellations = 0;
  let removals = 0;
  const lines: object[] = [];
  const metrics = createStreamMetrics("unused", "loop", {
    now: () => 1,
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
  expect(cancellations).toBe(1);
  expect(removals).toBe(1);
  expect(lines).toHaveLength(3);
});
