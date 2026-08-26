import { describe, it, expect, vi } from "../helpers/bun-test.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStreamMetrics, streamMetrics } from "../../src/stream-metrics.ts";

/**
 * Every module under test here is reached through the **static** import above,
 * and deliberately so.
 *
 * This file used to load a cache-busted copy (`../src/stream-metrics.js?fresh=…`)
 * to get past {@link streamMetrics}' process-wide memo. Bun then holds two
 * coverage records for one source file and its report keeps one of them rather
 * than their union — so which lines read as dead depended on which instance won.
 * Locally the fresh copy won and the file reported 100%; on `ubuntu-latest` the
 * static one did and the same commit reported the whole sink dead, failing the
 * package's line floor on three consecutive runs with all 229 tests passing.
 *
 * The process-wide selector is exercised in a child process, which gives it a
 * fresh module memo without creating a second query-suffixed coverage identity.
 */
function readLines(p: string): unknown[] {
  return readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe("createStreamMetrics", () => {
  it(
    "flushes windowed counts/rates plus a memory sample on the interval, emits " +
      "idle windows too, and writes accumulated totals plus the final window on " +
      "process exit, without throwing even once the log file's directory disappears",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "clarvis-stream-metrics-"));
      const logPath = join(dir, "metrics.jsonl");

      const realOn = process.on.bind(process);
      let exitHandler: (() => void) | undefined;
      (process as unknown as { on: typeof process.on }).on = ((
        event: string,
        cb: (...args: unknown[]) => void,
      ) => {
        if (event === "exit") exitHandler = cb as () => void;
        return process;
      }) as typeof process.on;

      vi.useFakeTimers();
      try {
        type WindowLine = {
          at: number;
          source: string;
          window_ms: number;
          counts: Record<string, number>;
          rates: Record<string, number>;
          rss: number;
          heap_used: number;
          external: number;
        };
        type TotalsLine = { at: number; source: string; totals: Record<string, number> };

        const metrics = createStreamMetrics(logPath, "test-source");
        expect(typeof exitHandler).toBe("function");

        exitHandler?.();
        expect(existsSync(logPath)).toBe(true);
        let lines = readLines(logPath) as (WindowLine | TotalsLine)[];
        expect(lines).toHaveLength(1);
        const idleWindow = lines[0] as WindowLine;
        expect(idleWindow.counts).toEqual({});
        expect(idleWindow.rates).toEqual({});
        expect(idleWindow.rss).toBeGreaterThan(0);
        expect(idleWindow.heap_used).toBeGreaterThan(0);
        expect(typeof idleWindow.external).toBe("number");

        metrics.count("delta");
        metrics.count("delta", 2);
        metrics.count("flush");

        exitHandler?.();
        lines = readLines(logPath) as (WindowLine | TotalsLine)[];
        expect(lines).toHaveLength(3);
        const zeroElapsedWindow = lines[1] as WindowLine;
        expect(zeroElapsedWindow.source).toBe("test-source");
        expect(zeroElapsedWindow.counts).toEqual({ delta: 3, flush: 1 });
        expect(zeroElapsedWindow.window_ms).toBe(0);
        expect(zeroElapsedWindow.rates).toEqual({ delta: 0, flush: 0 });
        expect(zeroElapsedWindow.rss).toBeGreaterThan(0);
        const firstTotals = lines[2] as TotalsLine;
        expect(firstTotals.totals).toEqual({ delta: 3, flush: 1 });

        await vi.advanceTimersByTimeAsync(1001);
        lines = readLines(logPath) as (WindowLine | TotalsLine)[];
        expect(lines).toHaveLength(4);
        const idleInterval = lines[3] as WindowLine;
        expect(idleInterval.counts).toEqual({});
        expect(idleInterval.window_ms).toBeGreaterThan(0);
        expect(idleInterval.rss).toBeGreaterThan(0);

        metrics.count("delta");
        await vi.advanceTimersByTimeAsync(1001);

        lines = readLines(logPath) as (WindowLine | TotalsLine)[];
        expect(lines).toHaveLength(5);
        const intervalWindow = lines[4] as WindowLine;
        expect(intervalWindow.counts).toEqual({ delta: 1 });
        expect(intervalWindow.window_ms).toBeGreaterThan(0);
        expect(intervalWindow.rates["delta"]).toBeGreaterThan(0);

        rmSync(dir, { recursive: true, force: true });
        metrics.count("delta");
        expect(() => exitHandler?.()).not.toThrow();
      } finally {
        vi.useRealTimers();
        (process as unknown as { on: typeof process.on }).on = realOn;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("streamMetrics", () => {
  it("selects the file sink when CLARVIS_STREAM_DEBUG is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "clarvis-stream-metrics-env-"));
    const logPath = join(dir, "metrics.jsonl");
    const moduleUrl = new URL("../../src/stream-metrics.ts", import.meta.url).href;
    const script = `const { streamMetrics } = await import(${JSON.stringify(moduleUrl)}); streamMetrics("env-test").count("delta", 2);`;
    try {
      const child = Bun.spawnSync([process.execPath, "-e", script], {
        env: { ...process.env, CLARVIS_STREAM_DEBUG: logPath },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode).toBe(0);
      const lines = readLines(logPath) as Array<{
        source?: string;
        totals?: Record<string, number>;
      }>;
      expect(lines.some((line) => line.source === "env-test" && line.totals?.delta === 2)).toBe(
        true,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op sink when CLARVIS_STREAM_DEBUG is unset, memoized and never throwing", () => {
    const previous = process.env.CLARVIS_STREAM_DEBUG;
    delete process.env.CLARVIS_STREAM_DEBUG;
    try {
      const metrics = streamMetrics();
      expect(() => metrics.count("delta", 3)).not.toThrow();
      expect(streamMetrics("ignored-source")).toBe(metrics);
    } finally {
      if (previous === undefined) delete process.env.CLARVIS_STREAM_DEBUG;
      else process.env.CLARVIS_STREAM_DEBUG = previous;
    }
  });
});
