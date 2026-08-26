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
 * not either ratio: with one threshold, RSS oscillating around it would trip and
 * re-arm on alternating samples, aborting runs on noise. Ten points of the limit
 * is wider than the sampling jitter of a process doing ordinary work and
 * narrower than the growth of a real leak, so a genuine climb crosses it once.
 *
 * The warning ratio sits where there is still room to act — cancelling a run and
 * rebuilding the backend both allocate — rather than at the limit itself, where
 * the recovery would be the allocation that fails.
 * {@link MEMORY_PRESSURE_REARM_SAMPLES} consecutive samples below the lower
 * ratio are required for the same reason the gap exists: one sample is noise.
 */
const MEMORY_PRESSURE_WARNING_RATIO = 0.8;
const MEMORY_PRESSURE_REARM_RATIO = 0.7;
const MEMORY_PRESSURE_REARM_SAMPLES = 3;
/**
 * Maximum wait for a cancelled run to report itself inactive.
 *
 * @remarks Both of these bound a *cooperative* step whose failure is already
 * handled: exceeding either proceeds anyway, so the budget only decides how long
 * the TUI waits for a clean outcome before taking the abrupt one. They are equal
 * because they are consecutive stages of one recovery and there is no reason to
 * be more patient with either. Ten seconds is past the tail of an in-flight
 * provider call — the slowest thing a cancel has to unwind — and short enough
 * that a wedged backend does not read as a frozen terminal.
 */
export const MEMORY_PRESSURE_ABORT_GRACE_MS = 10_000;
/** Maximum wait before a non-cooperative backend rebuild returns control to the TUI. */
export const MEMORY_PRESSURE_RECOVERY_TIMEOUT_MS = 10_000;

export type MemoryPressurePhase =
  "disabled" | "armed" | "warning" | "aborting" | "tripped" | "recovering" | "cooling";

export interface ProcessMemorySample {
  rss: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

export interface MemoryPressureSnapshot extends ProcessMemorySample {
  phase: MemoryPressurePhase;
  advisory: boolean;
  limitBytes: number;
  warningBytes: number;
  rearmBytes: number;
  sampledAt: number;
}

export interface MemoryRecoveryResult {
  ok: boolean;
  message: string;
}

interface TimerHandle {
  unref?: () => void;
}

export interface MemoryPressureDeps {
  limitBytes?: number;
  sample?: () => ProcessMemorySample;
  now?: () => number;
  isRunActive: () => boolean;
  cancelRun: () => boolean;
  /** Detach a run that ignored cancellation before backend recovery. */
  forceStopRun?: () => void;
  reconnect: () => Promise<MemoryRecoveryResult>;
  /** Recovery deadline and timer seams; production uses a 10-second one-shot timer. */
  recoveryTimeoutMs?: number;
  setAfter?: (callback: () => void, delayMs: number) => TimerHandle;
  clearAfter?: (handle: TimerHandle) => void;
  /** True only after every physical run handle and local process has settled. */
  canCollect?: () => boolean;
  gc?: () => void;
  /** Bounded application counters sampled every ten seconds and at state changes. */
  ledger?: () => Readonly<Record<string, string | number | boolean | null | undefined>>;
  /** Prevent ledger collection itself from doing work unless diagnostics can consume it. */
  ledgerEnabled?: () => boolean;
  setEvery?: (callback: () => void, delayMs: number) => TimerHandle;
  clearEvery?: (handle: TimerHandle) => void;
}

export interface MemoryPressureController {
  state(): MemoryPressureSnapshot;
  blocked(): boolean;
  start(): void;
  stop(): void;
  sampleNow(): MemoryPressureSnapshot;
  recover(): Promise<MemoryRecoveryResult>;
  subscribe(listener: (snapshot: MemoryPressureSnapshot) => void): () => void;
}

const SAFE_PRESSURE_SLASHES = new Set(["clear", "quit", "exit", "recover-memory"]);

/** Slash commands that remain usable after the fuse blocks model/tool work. */
export function memoryPressureAllowsSlash(name: string): boolean {
  return SAFE_PRESSURE_SLASHES.has(name);
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
  return ["aborting", "tripped", "recovering", "cooling"].includes(phase);
}

/**
 * Run-scoped RSS circuit breaker for the interactive Code host.
 *
 * It deliberately never exits the process. A trip aborts once, waits for the
 * run to become inactive, then leaves the TUI in an explicit recoverable state.
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
  const recoveryTimeoutMs =
    deps.recoveryTimeoutMs !== undefined && Number.isFinite(deps.recoveryTimeoutMs)
      ? Math.max(1, Math.floor(deps.recoveryTimeoutMs))
      : MEMORY_PRESSURE_RECOVERY_TIMEOUT_MS;
  let timer: TimerHandle | null = null;
  let coolSamples = 0;
  let abortStartedAt: number | null = null;
  let forcedStop = false;
  let recoveryAttempt: Promise<MemoryRecoveryResult> | null = null;
  let sampleCount = 0;
  let baselineRss = Number.POSITIVE_INFINITY;
  const rssWindow: number[] = [];
  let snapshot: MemoryPressureSnapshot = {
    phase: limitBytes === 0 ? "disabled" : "armed",
    advisory: false,
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
    snapshot = { ...snapshot, ...memory, phase, advisory, sampledAt: now() };
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
        phase === "aborting" || phase === "tripped" ? "warn" : "info",
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

  const sampleNow = (): MemoryPressureSnapshot => {
    if (limitBytes === 0) return publish("disabled", sample());
    const memory = sample();

    if (snapshot.phase === "recovering" || snapshot.phase === "tripped")
      return publish(snapshot.phase, memory);

    if (snapshot.phase === "aborting") {
      const elapsed = abortStartedAt === null ? 0 : now() - abortStartedAt;
      if (deps.isRunActive() && elapsed >= MEMORY_PRESSURE_ABORT_GRACE_MS && !forcedStop) {
        forcedStop = true;
        deps.forceStopRun?.();
      }
      return publish(
        deps.isRunActive() && elapsed < MEMORY_PRESSURE_ABORT_GRACE_MS ? "aborting" : "tripped",
        memory,
      );
    }

    if (snapshot.phase === "cooling") {
      coolSamples = memory.rss < rearmBytes ? coolSamples + 1 : 0;
      if (coolSamples >= MEMORY_PRESSURE_REARM_SAMPLES) {
        coolSamples = 0;
        return publish("armed", memory);
      }
      return publish("cooling", memory);
    }

    if (memory.rss >= limitBytes) {
      abortStartedAt = now();
      forcedStop = false;
      publish("aborting", memory);
      deps.cancelRun();
      return publish(deps.isRunActive() ? "aborting" : "tripped", memory);
    }
    return publish(memory.rss >= warningBytes ? "warning" : "armed", memory);
  };

  const finishRecovery = (): MemoryRecoveryResult => {
    if (deps.canCollect?.() !== false) {
      try {
        deps.gc?.();
        diagnosticEvent("memory.gc.completed", { mode: "synchronous", reason: "recovery" }, "info");
      } catch (error) {
        diagnosticEvent(
          "memory.gc.failed",
          { mode: "synchronous", reason: "recovery", error },
          "warn",
        );
      }
    } else {
      diagnosticEvent(
        "memory.gc.skipped",
        { mode: "synchronous", reason: "physical_work_active" },
        "info",
      );
    }
    coolSamples = 0;
    abortStartedAt = null;
    publish("cooling");
    sampleNow();
    return {
      ok: true,
      message: "backend rebuilt; monitoring memory before resuming new work",
    };
  };

  return {
    state: () => snapshot,
    blocked: () => isBlockedPhase(snapshot.phase),
    start: () => {
      if (timer !== null || limitBytes === 0) return;
      sampleNow();
      timer = setEvery(sampleNow, MEMORY_PRESSURE_SAMPLE_MS);
      timer.unref?.();
    },
    stop: () => {
      if (timer === null) return;
      clearEvery(timer);
      timer = null;
    },
    sampleNow,
    recover: async () => {
      if (recoveryAttempt !== null) {
        return {
          ok: false,
          message:
            snapshot.phase === "recovering"
              ? "memory recovery is already in progress"
              : "backend recovery is still pending after its timeout; restart clarvis if it does not finish",
        };
      }
      if (snapshot.phase !== "tripped") {
        return {
          ok: false,
          message:
            snapshot.phase === "aborting"
              ? "waiting for the active run to stop"
              : snapshot.phase === "cooling"
                ? "backend rebuilt; waiting for memory to fall below the safe threshold"
                : "memory recovery is not required",
        };
      }
      publish("recovering");
      const attempt = Promise.resolve().then(deps.reconnect);
      recoveryAttempt = attempt;
      let timeout: TimerHandle | undefined;
      const outcome = await new Promise<
        | { kind: "result"; result: MemoryRecoveryResult }
        | { kind: "error"; error: unknown }
        | { kind: "timeout" }
      >((resolve) => {
        let settled = false;
        const finish = (
          value:
            | { kind: "result"; result: MemoryRecoveryResult }
            | { kind: "error"; error: unknown }
            | { kind: "timeout" },
        ): void => {
          if (settled) return;
          settled = true;
          if (value.kind !== "timeout" && timeout !== undefined) clearAfter(timeout);
          resolve(value);
        };
        void attempt.then(
          (result) => finish({ kind: "result", result }),
          (error: unknown) => finish({ kind: "error", error }),
        );
        timeout = setAfter(() => finish({ kind: "timeout" }), recoveryTimeoutMs);
        timeout.unref?.();
      });

      if (outcome.kind === "timeout") {
        publish("tripped");
        // The reconnect API cannot abort a kernel close. Keep this physical
        // attempt single-flight after returning control to the UI; if it does
        // eventually rebuild successfully, advance through the normal cooling
        // gate instead of requiring a second concurrent rebuild.
        void attempt.then(
          (result) => {
            if (recoveryAttempt !== attempt) return;
            recoveryAttempt = null;
            if (result.ok && snapshot.phase === "tripped") finishRecovery();
          },
          () => {
            if (recoveryAttempt === attempt) recoveryAttempt = null;
          },
        );
        return {
          ok: false,
          message: `memory recovery timed out after ${String(recoveryTimeoutMs)}ms; backend shutdown is still pending`,
        };
      }

      recoveryAttempt = null;
      if (outcome.kind === "error") {
        publish("tripped");
        return {
          ok: false,
          message: `memory recovery failed: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`,
        };
      }
      if (!outcome.result.ok) {
        publish("tripped");
        return outcome.result;
      }
      return finishRecovery();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
