import { appendFileSync } from "node:fs";

/**
 * Streaming instrumentation for tuning the delta pipeline.
 *
 * Off — and free — unless `CLARVIS_STREAM_DEBUG` names a file to append to.
 * When it does, counters are sampled once a second and written as JSONL, one
 * line per window, plus a totals line at exit. Rates are what matters:
 * the pipeline's job is to keep UI updates per second low enough that the
 * terminal is not re-laying-out mid-token, and the only honest way to pick the
 * batcher's thresholds is to watch the counts under a real stream.
 *
 * Each line also carries an `rss`/`heap_used`/`external` sample, and a window
 * with no counters still emits one — carrying empty `counts`/`rates` so the
 * record shape never varies. An idle stretch is exactly where a memory series
 * has to be dense: a hole wherever nothing streamed is a hole over the only
 * evidence that separates "grows with history and stays" from "spikes and
 * returns to baseline", which is the question the series exists to answer.
 *
 * A file, not stderr: the TUI owns the terminal, and a stray write corrupts it.
 * `@clarvis/code` carries its own copy of this — the packages do not share a
 * dependency edge, and a debug counter is not worth minting one.
 */
export interface StreamMetrics {
  /** Adds to a named counter. */
  count(name: string, n?: number): void;
}

const NOOP: StreamMetrics = { count: () => {} };

/**
 * Builds the file-backed {@link StreamMetrics} sink for a given debug log
 * path: counts accumulate into a totals map and a rolling one-second window,
 * flushed to `path` as JSONL, plus a final totals line on process exit.
 *
 * @param path - the file to append JSONL records to.
 * @param source - the `source` tag stamped on every written record.
 * @remarks Exported rather than kept private because {@link streamMetrics}
 *   memoizes **process-wide** on its first call, so the only way a test could
 *   reach this factory was a cache-busting dynamic import — and whether Bun's
 *   coverage attributes a query-suffixed specifier back to this file turned out
 *   to differ between a developer machine and CI. It did locally and did not on
 *   `ubuntu-latest`, which reported this factory's body as dead and failed the
 *   package's line floor on three consecutive runs while every one of its 229 tests
 *   passed. The sink is the unit under test; reaching it directly is what makes
 *   that measurement the same everywhere.
 */
export function createStreamMetrics(path: string, source: string): StreamMetrics {
  const totals = new Map<string, number>();
  const window = new Map<string, number>();
  let windowStart = Date.now();

  const write = (line: object): void => {
    try {
      appendFileSync(path, JSON.stringify(line) + "\n");
    } catch {
      // Instrumentation must never take the run down with it.
    }
  };

  const flushWindow = (): void => {
    const elapsed = Date.now() - windowStart;
    windowStart = Date.now();
    const counts = Object.fromEntries(window);
    const rates = Object.fromEntries(
      [...window].map(([k, v]) => [k, elapsed > 0 ? Math.round((v * 1000) / elapsed) : 0]),
    );
    window.clear();
    const mem = process.memoryUsage();
    write({
      at: Date.now(),
      source,
      window_ms: elapsed,
      counts,
      rates,
      rss: mem.rss,
      heap_used: mem.heapUsed,
      external: mem.external,
    });
  };

  const timer = setInterval(flushWindow, 1000);
  (timer as unknown as { unref?: () => void }).unref?.();
  process.on("exit", () => {
    flushWindow();
    if (totals.size > 0) write({ at: Date.now(), source, totals: Object.fromEntries(totals) });
  });

  return {
    count(name, n = 1) {
      totals.set(name, (totals.get(name) ?? 0) + n);
      window.set(name, (window.get(name) ?? 0) + n);
    },
  };
}

let cached: StreamMetrics | undefined;

/** The process-wide metrics sink; a no-op when the env var is unset. */
export function streamMetrics(source = "loop"): StreamMetrics {
  if (cached === undefined) {
    const path = process.env["CLARVIS_STREAM_DEBUG"];
    cached = path && path.length > 0 ? createStreamMetrics(path, source) : NOOP;
  }
  return cached;
}
