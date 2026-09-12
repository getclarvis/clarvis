import { diagnosticCount, diagnosticEvent } from "../core/diagnostic-events.ts";

export const MIB = 1024 * 1024;
export const DEFAULT_TUI_RSS_LIMIT_BYTES = 2048 * MIB;
export const MIN_TUI_RSS_LIMIT_BYTES = 512 * MIB;
export const MEMORY_PRESSURE_SAMPLE_MS = 500;
const MEMORY_EFFICIENCY_ABSOLUTE_BYTES = 512 * MIB;
const MEMORY_EFFICIENCY_GROWTH_BYTES = 256 * MIB;
const MEMORY_EFFICIENCY_SLOPE_BYTES = 64 * MIB;
const MEMORY_EFFICIENCY_WINDOW_SAMPLES = 20;
const MEMORY_LEDGER_SAMPLE_INTERVAL = 20;
/**
 * The warning and re-arm fractions of {@link DEFAULT_TUI_RSS_LIMIT_BYTES}.
 *
 * @remarks A hysteresis pair, and the *gap* between them is what is being set,
 * not either ratio: with one threshold, RSS oscillating around it would start
 * and end episodes on alternating samples. Ten points of the limit is wider
 * than ordinary sampling jitter and narrower than a real climb, so a genuine
 * climb crosses it once.
 *
 * The warning ratio is the preventive band: local maintenance still has room
 * to run before the limit. {@link MEMORY_PRESSURE_SUSTAINED_SAMPLES} consecutive
 * samples are required before that band starts an episode, and
 * {@link MEMORY_PRESSURE_REARM_SAMPLES} consecutive samples below the lower
 * ratio are required to leave one, so one noisy sample is not a transition.
 */
const MEMORY_PRESSURE_WARNING_RATIO = 0.8;
const MEMORY_PRESSURE_REARM_RATIO = 0.7;
const MEMORY_PRESSURE_SUSTAINED_SAMPLES = 3;
const MEMORY_PRESSURE_REARM_SAMPLES = 3;
/** Maximum wait for one local maintenance callback before it is treated as pending. */
export const MEMORY_PRESSURE_STEP_TIMEOUT_MS = 10_000;
/** Maximum time a blocking critical episode may wait before it fails closed. */
export const MEMORY_PRESSURE_EPISODE_TIMEOUT_MS = 30_000;

export const MEMORY_PRESSURE_STATUS_RESTORING = "Restoring the interface…";
export const MEMORY_PRESSURE_STATUS_FAILED =
  "New work is paused because the interface is out of memory.";

export type MemoryPressurePhase =
  "disabled" | "armed" | "maintaining" | "critical" | "cooling" | "failed";

export interface ProcessMemorySample {
  rss: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

export interface MemoryMaintenanceReport {
  attempted: readonly string[];
  completed: boolean;
  pending: boolean;
  before: Readonly<Record<string, number>>;
  after: Readonly<Record<string, number>>;
}

export interface MemoryPressureSnapshot extends ProcessMemorySample {
  phase: MemoryPressurePhase;
  advisory: boolean;
  blocked: boolean;
  status: string | null;
  limitBytes: number;
  warningBytes: number;
  rearmBytes: number;
  sampledAt: number;
}

interface TimerHandle {
  unref?: () => void;
}

export interface MemoryPressureDeps {
  limitBytes?: number;
  sample?: () => ProcessMemorySample;
  now?: () => number;
  /** Drop reconstructible local caches. One in-flight call is kept even after timeout. */
  maintain?: () => MemoryMaintenanceReport | Promise<MemoryMaintenanceReport>;
  /** True only when TUI-owned work that would make a synchronous GC unsafe is idle. */
  canCollect?: () => boolean;
  gc?: () => void;
  /** Bounded application counters sampled every ten seconds and at state changes. */
  ledger?: () => Readonly<Record<string, string | number | boolean | null | undefined>>;
  /** Prevent ledger collection itself from doing work unless diagnostics can consume it. */
  ledgerEnabled?: () => boolean;
  stepTimeoutMs?: number;
  episodeTimeoutMs?: number;
  setAfter?: (callback: () => void, delayMs: number) => TimerHandle;
  clearAfter?: (handle: TimerHandle) => void;
  setEvery?: (callback: () => void, delayMs: number) => TimerHandle;
  clearEvery?: (handle: TimerHandle) => void;
}

export interface MemoryPressureController {
  state(): MemoryPressureSnapshot;
  blocked(): boolean;
  start(): void;
  stop(): void;
  sampleNow(): MemoryPressureSnapshot;
  subscribe(listener: (snapshot: MemoryPressureSnapshot) => void): () => void;
}

const SAFE_PRESSURE_SLASHES = new Set(["clear", "quit", "exit"]);

/** Slash commands that remain usable after the fuse blocks model/tool work. */
export function memoryPressureAllowsSlash(name: string): boolean {
  return SAFE_PRESSURE_SLASHES.has(name);
}

/** Compact status shown only while admission is blocked. */
export function memoryPressureStatus(phase: MemoryPressurePhase): string | null {
  if (phase === "critical" || phase === "cooling") return MEMORY_PRESSURE_STATUS_RESTORING;
  if (phase === "failed") return MEMORY_PRESSURE_STATUS_FAILED;
  return null;
}

/** Parse the TUI-only RSS fuse. `0` disables it; positive values have a 512 MiB floor. */
export function tuiRssLimitBytes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_TUI_RSS_LIMIT_BYTES;
  const mb = Number(raw);
  if (!Number.isFinite(mb) || mb < 0) return DEFAULT_TUI_RSS_LIMIT_BYTES;
  if (mb === 0) return 0;
  return Math.max(MIN_TUI_RSS_LIMIT_BYTES, Math.floor(mb * MIB));
}

/** Read only process counters; no allocation is performed to test the fuse. */
function processMemorySample(): ProcessMemorySample {
  const memory = process.memoryUsage();
  return {
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
  };
}

function isBlockedPhase(phase: MemoryPressurePhase): boolean {
  return phase === "critical" || phase === "cooling" || phase === "failed";
}

function emptyMaintenanceReport(): MemoryMaintenanceReport {
  return { attempted: [], completed: true, pending: false, before: {}, after: {} };
}

/**
 * Run-scoped RSS controller for the interactive Code host.
 *
 * It never exits the process, never restarts the workspace host, and never
 * cancels independent work. Sustained pressure starts one local maintenance
 * pass; only the critical band blocks expensive new admissions.
 */
export function createMemoryPressureController(deps: MemoryPressureDeps): MemoryPressureController {
  const limitBytes = Math.max(0, deps.limitBytes ?? DEFAULT_TUI_RSS_LIMIT_BYTES);
  const warningBytes = Math.floor(limitBytes * MEMORY_PRESSURE_WARNING_RATIO);
  const rearmBytes = Math.floor(limitBytes * MEMORY_PRESSURE_REARM_RATIO);
  const now = deps.now ?? Date.now;
  const sample = deps.sample ?? processMemorySample;
  const listeners = new Set<(snapshot: MemoryPressureSnapshot) => void>();
  const setEvery =
    deps.setEvery ??
    ((callback: () => void, delayMs: number): TimerHandle => setInterval(callback, delayMs));
  const clearEvery =
    deps.clearEvery ?? ((handle: TimerHandle): void => clearInterval(handle as Timer));
  const setAfter =
    deps.setAfter ??
    ((callback: () => void, delayMs: number): TimerHandle => setTimeout(callback, delayMs));
  const clearAfter =
    deps.clearAfter ?? ((handle: TimerHandle): void => clearTimeout(handle as Timer));
  const stepTimeoutMs =
    deps.stepTimeoutMs !== undefined && Number.isFinite(deps.stepTimeoutMs)
      ? Math.max(1, Math.floor(deps.stepTimeoutMs))
      : MEMORY_PRESSURE_STEP_TIMEOUT_MS;
  const episodeTimeoutMs =
    deps.episodeTimeoutMs !== undefined && Number.isFinite(deps.episodeTimeoutMs)
      ? Math.max(1, Math.floor(deps.episodeTimeoutMs))
      : MEMORY_PRESSURE_EPISODE_TIMEOUT_MS;
  let timer: TimerHandle | null = null;
  let generation = 0;
  let warningSamples = 0;
  let coolSamples = 0;
  let sampleCount = 0;
  let baselineRss = Number.POSITIVE_INFINITY;
  const rssWindow: number[] = [];
  let episodeStartedAt: number | null = null;
  let maintainUsed = false;
  let gcUsed = false;
  let integrityFailed = false;
  let maintainAttempt: Promise<MemoryMaintenanceReport> | null = null;
  let snapshot: MemoryPressureSnapshot = {
    phase: limitBytes === 0 ? "disabled" : "armed",
    advisory: false,
    blocked: false,
    status: null,
    limitBytes,
    warningBytes,
    rearmBytes,
    rss: 0,
    heapUsed: 0,
    external: 0,
    arrayBuffers: 0,
    sampledAt: now(),
  };

  const publish = (
    phase: MemoryPressurePhase,
    memory: ProcessMemorySample = snapshot,
  ): MemoryPressureSnapshot => {
    const previousPhase = snapshot.phase;
    const previousAdvisory = snapshot.advisory;
    baselineRss = Math.min(baselineRss, memory.rss);
    rssWindow.push(memory.rss);
    if (rssWindow.length > MEMORY_EFFICIENCY_WINDOW_SAMPLES) rssWindow.shift();
    const slope = memory.rss - (rssWindow[0] ?? memory.rss);
    const advisory =
      memory.rss >= MEMORY_EFFICIENCY_ABSOLUTE_BYTES &&
      memory.rss - baselineRss >= MEMORY_EFFICIENCY_GROWTH_BYTES &&
      slope >= MEMORY_EFFICIENCY_SLOPE_BYTES;
    sampleCount += 1;
    snapshot = {
      ...snapshot,
      ...memory,
      phase,
      advisory,
      blocked: isBlockedPhase(phase),
      status: memoryPressureStatus(phase),
      sampledAt: now(),
    };
    diagnosticCount("memory.sample", {
      phase,
      rss: snapshot.rss,
      heapUsed: snapshot.heapUsed,
      external: snapshot.external,
      arrayBuffers: snapshot.arrayBuffers,
      limitBytes,
    });
    if (phase !== previousPhase)
      diagnosticEvent(
        "memory.phase",
        { from: previousPhase, to: phase, rss: snapshot.rss, limitBytes },
        phase === "critical" || phase === "failed" ? "warn" : "info",
      );
    if (advisory !== previousAdvisory)
      diagnosticEvent(
        "memory.efficiency",
        { advisory, rss: snapshot.rss, baseline_rss: baselineRss, slope_bytes: slope },
        advisory ? "warn" : "info",
      );
    if (
      deps.ledger !== undefined &&
      (deps.ledgerEnabled?.() ?? true) &&
      (sampleCount % MEMORY_LEDGER_SAMPLE_INTERVAL === 1 ||
        phase !== previousPhase ||
        advisory !== previousAdvisory)
    ) {
      try {
        diagnosticEvent(
          "memory.ledger",
          { ...deps.ledger(), rss: snapshot.rss, heap_used: snapshot.heapUsed },
          "debug",
        );
      } catch (error) {
        diagnosticEvent("memory.ledger.failed", { error }, "warn");
      }
    }
    for (const listener of listeners) listener(snapshot);
    return snapshot;
  };

  const resetEpisode = (): void => {
    episodeStartedAt = null;
    maintainUsed = false;
    gcUsed = false;
    integrityFailed = false;
    warningSamples = 0;
    coolSamples = 0;
  };

  const collectOnce = (reason: string): void => {
    if (gcUsed) return;
    gcUsed = true;
    if (deps.canCollect?.() === false) {
      diagnosticEvent(
        "memory.gc.skipped",
        { mode: "synchronous", reason: "tui_work_active" },
        "info",
      );
      return;
    }
    try {
      deps.gc?.();
      diagnosticEvent("memory.gc.completed", { mode: "synchronous", reason }, "info");
    } catch (error) {
      diagnosticEvent("memory.gc.failed", { mode: "synchronous", reason, error }, "warn");
    }
  };

  const finishMaintain = (report: MemoryMaintenanceReport, attemptGeneration: number): void => {
    if (attemptGeneration !== generation) return;
    maintainAttempt = null;
    diagnosticEvent(
      "memory.maintain.completed",
      {
        attempted: report.attempted.join(","),
        completed: report.completed,
        pending: report.pending,
        ...report.after,
      },
      "debug",
    );
    collectOnce("maintenance");
    const memory = sample();
    if (snapshot.phase === "critical" && memory.rss < rearmBytes) publish("cooling", memory);
  };

  const startMaintain = (): void => {
    if (maintainUsed || maintainAttempt !== null) return;
    maintainUsed = true;
    const attemptGeneration = generation;
    const attempt = Promise.resolve()
      .then(() => deps.maintain?.() ?? emptyMaintenanceReport())
      .then((report) => {
        if (attemptGeneration !== generation) return report;
        finishMaintain(report, attemptGeneration);
        return report;
      })
      .catch((error: unknown) => {
        if (attemptGeneration !== generation) return emptyMaintenanceReport();
        maintainAttempt = null;
        diagnosticEvent("memory.maintain.failed", { error }, "warn");
        if (isBlockedPhase(snapshot.phase)) {
          integrityFailed = true;
          publish("failed", sample());
        }
        return emptyMaintenanceReport();
      });
    maintainAttempt = attempt;
    const timeout = setAfter(() => {
      if (attemptGeneration !== generation || maintainAttempt !== attempt) return;
      diagnosticEvent("memory.maintain.timeout", { step_timeout_ms: stepTimeoutMs }, "warn");
      // Keep the attempt identity; a late result still finishes this episode's
      // single pass instead of starting another on the same resources.
    }, stepTimeoutMs);
    timeout.unref?.();
    void attempt.then(
      () => {
        if (attemptGeneration === generation) clearAfter(timeout);
      },
      () => {
        if (attemptGeneration === generation) clearAfter(timeout);
      },
    );
  };

  const rearmIfSafe = (
    memory: ProcessMemorySample,
    phase: MemoryPressurePhase,
  ): MemoryPressurePhase => {
    if (maintainAttempt !== null || integrityFailed) {
      coolSamples = 0;
      return phase;
    }
    if (memory.rss < rearmBytes) {
      coolSamples += 1;
      if (coolSamples >= MEMORY_PRESSURE_REARM_SAMPLES) {
        resetEpisode();
        return "armed";
      }
      return phase === "armed" ? "armed" : phase === "maintaining" ? "maintaining" : "cooling";
    }
    coolSamples = 0;
    return phase;
  };

  const sampleNow = (): MemoryPressureSnapshot => {
    if (limitBytes === 0) return publish("disabled", sample());
    const memory = sample();
    const sampledAt = now();

    if (snapshot.phase === "failed") {
      if (integrityFailed || maintainAttempt !== null) return publish("failed", memory);
      return publish(rearmIfSafe(memory, "failed") === "armed" ? "armed" : "failed", memory);
    }

    if (
      snapshot.phase === "critical" &&
      episodeStartedAt !== null &&
      sampledAt - episodeStartedAt >= episodeTimeoutMs &&
      memory.rss >= rearmBytes
    ) {
      return publish("failed", memory);
    }

    if (snapshot.phase === "cooling" || snapshot.phase === "critical") {
      if (memory.rss >= limitBytes) {
        if (snapshot.phase !== "critical") episodeStartedAt = sampledAt;
        startMaintain();
        return publish("critical", memory);
      }
      const next = rearmIfSafe(memory, snapshot.phase === "cooling" ? "cooling" : "critical");
      if (next === "armed") return publish("armed", memory);
      if (next === "cooling") return publish("cooling", memory);
      return publish("critical", memory);
    }

    if (snapshot.phase === "maintaining") {
      if (memory.rss >= limitBytes) {
        episodeStartedAt = sampledAt;
        startMaintain();
        return publish("critical", memory);
      }
      const next = rearmIfSafe(memory, "maintaining");
      return publish(next === "armed" ? "armed" : "maintaining", memory);
    }

    if (memory.rss >= limitBytes) {
      warningSamples = 0;
      episodeStartedAt = sampledAt;
      publish("critical", memory);
      startMaintain();
      return snapshot;
    }
    if (memory.rss >= warningBytes) {
      warningSamples += 1;
      if (warningSamples >= MEMORY_PRESSURE_SUSTAINED_SAMPLES) {
        publish("maintaining", memory);
        startMaintain();
        return snapshot;
      }
      return publish("armed", memory);
    }
    warningSamples = 0;
    return publish("armed", memory);
  };

  return {
    state: () => snapshot,
    blocked: () => snapshot.blocked,
    start: () => {
      if (timer !== null || limitBytes === 0) return;
      sampleNow();
      timer = setEvery(sampleNow, MEMORY_PRESSURE_SAMPLE_MS);
      timer.unref?.();
    },
    stop: () => {
      generation += 1;
      maintainAttempt = null;
      if (timer === null) return;
      clearEvery(timer);
      timer = null;
    },
    sampleNow,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
