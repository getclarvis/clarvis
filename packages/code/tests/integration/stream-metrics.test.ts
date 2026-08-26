import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStreamMetrics, streamMetrics } from "../../src/adapters/stream-metrics.ts";

process.setMaxListeners(0);

// The sink is reached through the static import above rather than through a
// cache-busted copy of the module. Bun keeps one coverage record per source
// file, not the union of an original and its `?bust=` copy, so which lines read
// as dead depended on which instance won -- the arrangement that reported the
// twin file in @clarvis/llm 100% covered locally and entirely dead on
// ubuntu-latest, failing that package's line floor three runs in a row.
//
// The cost is that `streamMetrics`' own default source and its
// CLARVIS_STREAM_DEBUG branch go unasserted: both sit behind a memo that can be
// observed once per process, and `blocks.tsx` claims it at import time.

function readLines(file: string): Record<string, never>[] {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, never>);
}

function withoutListener<T>(before: number, run: () => T): T {
  const result = run();
  const added = process.listeners("exit").slice(before);
  for (const l of added) process.removeListener("exit", l as never);
  return result;
}

function logFile(): string {
  return join(mkdtempSync(join(tmpdir(), "clarvis-stream-metrics-")), "metrics.jsonl");
}

afterEach(() => {
  delete process.env.CLARVIS_STREAM_DEBUG;
});

test("streamMetrics: with the env var unset, returns a memoized no-op sink that never throws", () => {
  delete process.env.CLARVIS_STREAM_DEBUG;
  const m = streamMetrics();
  expect(() => m.count("x")).not.toThrow();
  expect(() => m.count("x", 5)).not.toThrow();
  expect(streamMetrics("other-source")).toBe(m);
});

test("createStreamMetrics: count() accumulates and exit flushes window + totals as JSONL", async () => {
  const file = logFile();
  const before = process.listeners("exit").length;
  const m = createStreamMetrics(file, "test-source");
  m.count("tokens", 3);
  m.count("tokens");
  m.count("chars", 10);
  await new Promise((r) => setTimeout(r, 5));

  withoutListener(before, () => process.emit("exit", 0));

  const lines = readLines(file);
  expect(lines.length).toBe(2);
  const [windowLine, totalsLine] = lines as unknown as [
    { source: string; counts: unknown; rates: { tokens: number }; window_ms: number },
    { totals: unknown },
  ];
  expect(windowLine.source).toBe("test-source");
  expect(windowLine.counts).toEqual({ tokens: 4, chars: 10 });
  expect(windowLine.rates.tokens).toBeGreaterThanOrEqual(0);
  expect(windowLine.window_ms).toBeGreaterThanOrEqual(0);
  expect(totalsLine.totals).toEqual({ tokens: 4, chars: 10 });
});

test("createStreamMetrics: every window line carries an rss/heap_used/external sample", () => {
  const file = logFile();
  const before = process.listeners("exit").length;
  createStreamMetrics(file, "mem-source").count("tokens");

  withoutListener(before, () => process.emit("exit", 0));

  const [windowLine] = readLines(file) as unknown as [
    { rss: number; heap_used: number; external: number },
  ];
  expect(windowLine.rss).toBeGreaterThan(0);
  expect(windowLine.heap_used).toBeGreaterThan(0);
  expect(typeof windowLine.external).toBe("number");
});

test("createStreamMetrics: stamps every record with the source it was given", () => {
  const file = logFile();
  const before = process.listeners("exit").length;
  createStreamMetrics(file, "code").count("x");

  withoutListener(before, () => process.emit("exit", 0));

  const [windowLine] = readLines(file) as unknown as [{ source: string }];
  expect(windowLine.source).toBe("code");
});

test("createStreamMetrics: an idle window still writes a memory sample, with empty counts and no totals line", () => {
  const file = logFile();
  const before = process.listeners("exit").length;
  createStreamMetrics(file, "idle-source");

  withoutListener(before, () => process.emit("exit", 0));

  const lines = readLines(file);
  expect(lines.length).toBe(1);
  const [windowLine] = lines as unknown as [
    { source: string; counts: unknown; rates: unknown; rss: number },
  ];
  expect(windowLine.source).toBe("idle-source");
  expect(windowLine.counts).toEqual({});
  expect(windowLine.rates).toEqual({});
  expect(windowLine.rss).toBeGreaterThan(0);
});

test("createStreamMetrics: an unwritable path swallows the appendFileSync failure instead of throwing", () => {
  const badPath = join(mkdtempSync(join(tmpdir(), "clarvis-stream-metrics-")), "gone", "m.jsonl");
  const before = process.listeners("exit").length;
  createStreamMetrics(badPath, "code").count("x");

  expect(() => withoutListener(before, () => process.emit("exit", 0))).not.toThrow();
  expect(existsSync(badPath)).toBe(false);
});
