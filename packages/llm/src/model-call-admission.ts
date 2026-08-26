import {
  CodedError,
  NOOP_LOGGER,
  unref,
  type LLMCallParams,
  type LLMCallResult,
  type LLMProvider,
  type Logger,
} from "@clarvis/capability";
import { bridgeModelCallTimeout } from "./model-call-timeout-bridge.ts";

export const DEFAULT_MAX_ACTIVE_MODEL_CALLS = 4;
export const DEFAULT_MAX_QUEUED_MODEL_CALLS = 8;
export const DEFAULT_MODEL_CALL_ABORT_SETTLE_MS = 250;

export type ModelCallAdmissionState = "open" | "quarantined" | "closed";
export type ModelCallUnavailableReason = "queue_full" | "quarantined" | "closed";

export interface ModelCallAdmissionSnapshot {
  state: ModelCallAdmissionState;
  active: number;
  queued: number;
  quarantined: number;
  maxActive: number;
  maxQueued: number;
}

export interface ModelCallAdmissionOptions {
  maxActive?: number;
  maxQueued?: number;
  abortSettleMs?: number;
  onStateChange?: (snapshot: ModelCallAdmissionSnapshot) => void;
  /**
   * Where the gate reports a transport that would not settle; defaults to
   * discarding it.
   *
   * @remarks Normalized at construction, so no call site here is optionally
   *   chained. Only the quarantine is logged from inside the controller —
   *   ordinary state movement goes out through {@link ModelCallAdmissionOptions.onStateChange},
   *   which a host wires to {@link admissionStateLogger}.
   */
  logger?: Logger;
}

/**
 * Turns admission snapshots into one `info` per state *transition*.
 *
 * @param logger - where the transitions go.
 * @returns a handler for {@link ModelCallAdmissionOptions.onStateChange}.
 * @remarks The dedupe is the whole point. `onStateChange` fires on every
 *   acquire, release, enqueue and dequeue — several times per model call — and
 *   `open → open` is not news. The three states are, because each one changes
 *   what happens to the next call: `quarantined` and `closed` refuse it
 *   outright.
 *
 *   An instance per controller, so two gates do not dedupe against each other.
 */
export function admissionStateLogger(
  logger: Logger,
): (snapshot: ModelCallAdmissionSnapshot) => void {
  let previous: ModelCallAdmissionState | undefined;
  return (snapshot: ModelCallAdmissionSnapshot): void => {
    if (snapshot.state === previous) return;
    previous = snapshot.state;
    logger.info(
      {
        event: "llm.admission.state",
        state: snapshot.state,
        active: snapshot.active,
        queued: snapshot.queued,
        quarantined: snapshot.quarantined,
        max_active: snapshot.maxActive,
        max_queued: snapshot.maxQueued,
      },
      snapshot.state === "open"
        ? "the model-call gate is admitting work again"
        : "the model-call gate stopped admitting work; queued and new calls are refused",
    );
  };
}

export class ModelCallUnavailableError extends CodedError {
  readonly code = "model_call_unavailable" as const;
  readonly reason: ModelCallUnavailableReason;

  constructor(reason: ModelCallUnavailableReason) {
    super(
      reason === "queue_full"
        ? "The model-call queue is full. Wait for an active call to finish before retrying."
        : reason === "quarantined"
          ? "Model calls are paused because an aborted transport has not settled."
          : "The model-call admission controller is closed.",
      { reason },
    );
    this.reason = reason;
  }
}

export class ModelCallStuckError extends CodedError {
  readonly code = "model_call_stuck" as const;

  constructor(settleMs: number) {
    super(
      `The provider transport did not settle within ${String(settleMs)}ms after cancellation; ` +
        "new model calls are paused until it exits.",
      { settle_ms: settleMs },
    );
  }
}

interface Waiter {
  resolve: () => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

type CallOutcome =
  { status: "fulfilled"; value: LLMCallResult } | { status: "rejected"; reason: unknown };
type CallInterrupt = { status: "interrupted"; error: Error };

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return resolved;
}

function nonnegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new TypeError(`${name} must be a non-negative integer.`);
  }
  return resolved;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Model call aborted.", "AbortError");
}

/** Host-owned FIFO gate shared by every physical provider call. */
export class ModelCallAdmissionController {
  readonly maxActive: number;
  readonly maxQueued: number;
  readonly abortSettleMs: number;
  private activeCount = 0;
  private quarantinedCount = 0;
  private closed = false;
  private readonly queue: Waiter[] = [];
  private readonly onStateChange?: (snapshot: ModelCallAdmissionSnapshot) => void;
  private readonly logger: Logger;

  constructor(options: ModelCallAdmissionOptions = {}) {
    this.maxActive = positiveInteger(
      options.maxActive,
      DEFAULT_MAX_ACTIVE_MODEL_CALLS,
      "maxActive",
    );
    this.maxQueued = nonnegativeInteger(
      options.maxQueued,
      DEFAULT_MAX_QUEUED_MODEL_CALLS,
      "maxQueued",
    );
    this.abortSettleMs = nonnegativeInteger(
      options.abortSettleMs,
      DEFAULT_MODEL_CALL_ABORT_SETTLE_MS,
      "abortSettleMs",
    );
    this.onStateChange = options.onStateChange;
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  snapshot(): ModelCallAdmissionSnapshot {
    return {
      state: this.closed ? "closed" : this.quarantinedCount > 0 ? "quarantined" : "open",
      active: this.activeCount,
      queued: this.queue.length,
      quarantined: this.quarantinedCount,
      maxActive: this.maxActive,
      maxQueued: this.maxQueued,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectQueue(new ModelCallUnavailableError("closed"));
    this.changed();
  }

  async call(inner: LLMProvider, params: LLMCallParams): Promise<LLMCallResult> {
    await this.acquire(params.signal);
    const bridged = bridgeModelCallTimeout(params);
    try {
      let onStreamDelta = params.onStreamDelta;
      let onToolInputDelta = params.onToolInputDelta;
      let onRetry = params.onRetry;
      const forwarded: LLMCallParams = {
        ...bridged.params,
        ...(onStreamDelta !== undefined
          ? { onStreamDelta: (delta) => onStreamDelta?.(delta) }
          : {}),
        ...(onToolInputDelta !== undefined
          ? { onToolInputDelta: (delta) => onToolInputDelta?.(delta) }
          : {}),
        ...(onRetry !== undefined ? { onRetry: (info) => onRetry?.(info) } : {}),
      };
      const clearCallbacks = (): void => {
        onStreamDelta = undefined;
        onToolInputDelta = undefined;
        onRetry = undefined;
      };

      let innerPromise: Promise<LLMCallResult>;
      try {
        innerPromise = Promise.resolve(inner.call(forwarded));
      } catch (error) {
        clearCallbacks();
        this.release(false);
        throw error;
      }
      const outcome: Promise<CallOutcome> = innerPromise.then(
        (value) => ({ status: "fulfilled", value }),
        (reason: unknown) => ({ status: "rejected", reason }),
      );

      const signal = params.signal;
      let removeAbort = (): void => {};
      const aborted = new Promise<CallInterrupt>((resolve) => {
        if (signal === undefined) return;
        const onAbort = (): void => resolve({ status: "interrupted", error: abortError(signal) });
        if (signal.aborted) onAbort();
        else {
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbort = () => signal.removeEventListener("abort", onAbort);
        }
      });
      const timedOut = bridged.bridge.timeout.then((error): CallInterrupt => ({
        status: "interrupted",
        error,
      }));

      const first = await Promise.race([outcome, aborted, timedOut]);
      removeAbort();
      if (first.status !== "interrupted") {
        clearCallbacks();
        this.release(false);
        if (first.status === "rejected") throw first.reason;
        return first.value;
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      const afterAbort = await Promise.race([
        outcome,
        new Promise<"stuck">((resolve) => {
          timer = setTimeout(() => resolve("stuck"), this.abortSettleMs);
          unref(timer);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      clearCallbacks();

      if (afterAbort !== "stuck") {
        this.release(false);
        if (afterAbort.status === "rejected") throw afterAbort.reason;
        throw first.error;
      }

      this.quarantinedCount += 1;
      this.rejectQueue(new ModelCallUnavailableError("quarantined"));
      this.changed();
      this.logger.warn(
        {
          event: "llm.admission.stuck",
          settle_ms: this.abortSettleMs,
          quarantined: this.quarantinedCount,
        },
        "a cancelled provider transport has not exited; model calls stay paused until it does",
      );
      const releaseQuarantine = (): void => {
        this.quarantinedCount -= 1;
        this.release(true);
      };
      void outcome.then(releaseQuarantine, releaseQuarantine);
      throw new ModelCallStuckError(this.abortSettleMs);
    } finally {
      bridged.bridge.cleanup();
    }
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    if (this.closed) throw new ModelCallUnavailableError("closed");
    if (this.quarantinedCount > 0) throw new ModelCallUnavailableError("quarantined");
    if (signal?.aborted === true) throw abortError(signal);
    if (this.activeCount < this.maxActive && this.queue.length === 0) {
      this.activeCount += 1;
      this.changed();
      return;
    }
    if (this.queue.length >= this.maxQueued) {
      throw new ModelCallUnavailableError("queue_full");
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, ...(signal !== undefined ? { signal } : {}) };
      if (signal !== undefined) {
        waiter.onAbort = (): void => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(abortError(signal));
          this.changed();
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
      this.changed();
    });
  }

  private release(fromQuarantine: boolean): void {
    this.activeCount -= 1;
    if (this.activeCount < 0) this.activeCount = 0;
    if (!fromQuarantine || this.quarantinedCount === 0) this.drain();
    this.changed();
  }

  private drain(): void {
    if (this.closed || this.quarantinedCount > 0) return;
    while (this.activeCount < this.maxActive && this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      if (waiter.signal?.aborted === true) {
        waiter.signal.removeEventListener("abort", waiter.onAbort!);
        waiter.reject(abortError(waiter.signal));
        continue;
      }
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      this.activeCount += 1;
      waiter.resolve();
    }
  }

  private rejectQueue(error: Error): void {
    for (const waiter of this.queue.splice(0)) {
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.reject(error);
    }
  }

  private changed(): void {
    try {
      this.onStateChange?.(this.snapshot());
    } catch {
      // Diagnostics are observers, never part of admission ownership. A broken
      // metrics sink must not strand an active permit or reject healthy work.
    }
  }
}

export function createModelCallAdmissionController(
  options: ModelCallAdmissionOptions = {},
): ModelCallAdmissionController {
  return new ModelCallAdmissionController(options);
}

/** Decorate one physical provider attempt with the host-owned admission gate. */
export function withModelCallAdmission(
  inner: LLMProvider,
  controller: ModelCallAdmissionController,
): LLMProvider {
  return { call: (params) => controller.call(inner, params) };
}
