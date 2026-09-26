import { appendFileSync } from "node:fs";

/** Optional JSONL streaming instrumentation. A disabled sink has no process resources. */
export interface StreamMetrics {
  /** Add to a named window and lifetime total until disposal. */
  count(name: string, n?: number): void;
  /** Flush once and release the interval and exit listener; repeated calls are inert. */
  dispose(): void;
}

interface CounterDependencies {
  now(): number;
  memoryUsage(): Pick<NodeJS.MemoryUsage, "rss" | "heapUsed" | "external">;
  emit(line: object): void;
}

interface MetricsRuntime extends CounterDependencies {
  schedule(callback: () => void): ReturnType<typeof setInterval>;
  cancel(timer: ReturnType<typeof setInterval>): void;
  onExit(callback: () => void): void;
  offExit(callback: () => void): void;
}

const NOOP: StreamMetrics = { count: () => {}, dispose: () => {} };

/** Calculate windows and final totals from explicit samples, without process resources or files. */
export function createStreamMetricsCounter(source: string, deps: CounterDependencies) {
  const totals = new Map<string, number>();
  const window = new Map<string, number>();
  let windowStart = deps.now();
  let finished = false;

  const write = (line: object): void => {
    try {
      deps.emit(line);
    } catch {}
  };

  const flushWindow = (): void => {
    if (finished) return;
    const at = deps.now();
    const elapsed = at - windowStart;
    windowStart = at;
    const counts = Object.fromEntries(window);
    const rates = Object.fromEntries(
      [...window].map(([name, value]) => [
        name,
        elapsed > 0 ? Math.round((value * 1000) / elapsed) : 0,
      ]),
    );
    window.clear();
    const memory = deps.memoryUsage();
    write({
      at,
      source,
      window_ms: elapsed,
      counts,
      rates,
      rss: memory.rss,
      heap_used: memory.heapUsed,
      external: memory.external,
    });
  };

  return {
    count(name: string, n = 1): void {
      if (finished) return;
      totals.set(name, (totals.get(name) ?? 0) + n);
      window.set(name, (window.get(name) ?? 0) + n);
    },
    flushWindow,
    finish(): void {
      if (finished) return;
      flushWindow();
      finished = true;
      if (totals.size > 0) write({ at: deps.now(), source, totals: Object.fromEntries(totals) });
    },
  };
}

/** Append one JSONL window each second and a final flush on exit or explicit disposal.
 * Debug-write failures are tolerated so instrumentation cannot interrupt the run.
 */
export function createStreamMetrics(
  path: string,
  source: string,
  overrides: Partial<MetricsRuntime> = {},
): StreamMetrics {
  const runtime: MetricsRuntime = {
    now: () => Date.now(),
    memoryUsage: () => process.memoryUsage(),
    emit: (line) => appendFileSync(path, JSON.stringify(line) + "\n"),
    schedule: (callback) => setInterval(callback, 1000),
    cancel: (timer) => clearInterval(timer),
    onExit: (callback) => process.on("exit", callback),
    offExit: (callback) => process.off("exit", callback),
    ...overrides,
  };
  const counter = createStreamMetricsCounter(source, runtime);
  let disposed = false;
  const timer = runtime.schedule(() => counter.flushWindow());
  timer.unref?.();
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    runtime.cancel(timer);
    runtime.offExit(dispose);
    counter.finish();
  };
  runtime.onExit(dispose);
  return { count: (name, n) => counter.count(name, n), dispose };
}

let cached: StreamMetrics | undefined;

/** Select an inert or file-backed sink from an explicit debug path. */
export function selectStreamMetrics(path: string | undefined, source: string): StreamMetrics {
  return path && path.length > 0 ? createStreamMetrics(path, source) : NOOP;
}

/** Select the process-wide sink once from `CLARVIS_STREAM_DEBUG`; an unset value is inert. */
export function streamMetrics(source = "loop", readPath?: () => string | undefined): StreamMetrics {
  if (cached === undefined) {
    cached = selectStreamMetrics(
      readPath === undefined ? process.env["CLARVIS_STREAM_DEBUG"] : readPath(),
      source,
    );
  }
  return cached;
}
