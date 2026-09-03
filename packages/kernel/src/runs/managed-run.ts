import type { CompactionSource, Elicit, SteerSource } from "@clarvis/loop";
import { suppressSecondaryRejection } from "@clarvis/capability";
import type { RunEvent, RunHandle, RunResult } from "@clarvis/protocol";
import type { KernelLifecycle } from "../application/lifecycle.ts";
import { createEventStream, type EventStreamOptions } from "../core/event-stream.ts";
import { kernelError, toKernelError } from "../core/errors.ts";
import {
  coalesceRunEvents,
  DEFAULT_RUN_EVENT_BUFFER,
  DEFAULT_RUN_EVENT_BUFFER_BYTES,
  isDroppableRunEvent,
  sizeOfCoalescedRunEvent,
  sizeOfRunEvent,
} from "./coalesce-events.ts";
import { createElicitBridge } from "./elicit-bridge.ts";
import {
  DEFAULT_INGEST_CLOSE_GRACE_MS,
  DEFAULT_INGEST_CLOSE_MAX_WAIT_MS,
  ingestPendingAfter,
  MAX_INGEST_CLOSE_WAIT_MS,
} from "./memory-ingest-phase.ts";
import { failedResult } from "./map-result.ts";
import { protoSteerToEngineContent } from "./map-message.ts";
import { createSteerQueue } from "./steer-queue.ts";
import { createCompactionQueue } from "./compaction-queue.ts";

/** Collaborators exposed to one managed execution function. */
export interface ManagedRunContext {
  /** Stable execution id assigned before any assembly or execution work. */
  readonly executionId: string;
  /** Cancellation signal controlled by the returned run handle. */
  readonly signal: AbortSignal;
  /** Engine-facing elicitation function bridged to the protocol handle. */
  readonly elicit: Elicit;
  /** Engine-facing source of queued steering messages. */
  readonly steer: SteerSource;
  /** Engine-facing source of explicit entry-agent compaction requests. */
  readonly compaction: CompactionSource;
  /** Emits one protocol event through buffering, observation, and ingest tracking. */
  emit(this: void, event: RunEvent): void;
}

/** Execution-specific behavior plugged into the shared managed-run lifecycle. */
export interface ManagedRunSpec {
  /** Stable execution id exposed by the returned handle. */
  executionId: string;
  /** Runs the engine-specific work and returns its protocol terminal result. */
  execute(context: ManagedRunContext): Promise<RunResult>;
  /** Observes emitted events for execution-specific projections such as workflow records. */
  observe?(event: RunEvent): void;
  /** Records execution-specific terminal state before the result settles. */
  settle?(result: RunResult): void | Promise<void>;
  /** Event-stream backpressure overrides merged over kernel defaults. */
  eventBuffer?: EventStreamOptions<RunEvent>;
  /** Sliding memory-ingest close grace in milliseconds. */
  ingestGraceMs?: number;
  /**
   * Absolute wait across sliding renewals; internal deterministic-test seam.
   *
   * @remarks `@internal` by convention only — nothing stops a host from setting
   * it, and that is deliberate rather than an oversight. The value is clamped
   * against the sliding grace before use, so the worst a host can do is shorten
   * or lengthen how long a settled run's stream waits for a memory-ingest
   * notice; it cannot make the wait unbounded and cannot affect the run itself.
   * Hiding it behind a private construction path would cost the one thing it
   * buys — a test that observes the absolute deadline without waiting out the
   * real one.
   * @internal
   */
  ingestMaxWaitMs?: number;
  /** Kernel lifecycle that owns and cancels this run. */
  lifecycle?: KernelLifecycle;
}

/** Cancelable timer owned by the managed-run scheduler. @internal */
export interface ManagedRunTimer {
  cancel(): void;
}

/**
 * Time seam used by managed-run state-machine tests. It is intentionally
 * package-internal: hosts configure policy through {@link ManagedRunSpec}, not
 * by replacing the kernel's clock.
 *
 * @internal
 */
export interface ManagedRunRuntime {
  now(): number;
  schedule(task: () => void, delayMs: number): ManagedRunTimer;
}

/** Best-effort timer unref without depending on an engine-internal helper. */
function unrefTimer(timer: unknown): void {
  (timer as { unref?: () => void }).unref?.();
}

const DEFAULT_MANAGED_RUN_RUNTIME: ManagedRunRuntime = {
  now: Date.now,
  schedule(task, delayMs): ManagedRunTimer {
    const timer = setTimeout(task, delayMs);
    unrefTimer(timer);
    return { cancel: () => clearTimeout(timer) };
  },
};

/** A stable emitter whose heavyweight run target can be disconnected on close. */
function createEmitRelay<T>(): {
  emit(this: void, value: T): void;
  connect(target: (value: T) => void): void;
  disconnect(): void;
} {
  let target: ((value: T) => void) | undefined;
  return {
    emit(value): void {
      target?.(value);
    },
    connect(next): void {
      target = next;
    },
    disconnect(): void {
      target = undefined;
    },
  };
}

/** Resolve the effective event buffer while protecting the terminal drop notice. */
function resolveEventBuffer(
  supplied: EventStreamOptions<RunEvent> | undefined,
): EventStreamOptions<RunEvent> {
  const configured: EventStreamOptions<RunEvent> = {
    maxBuffered: supplied?.maxBuffered ?? DEFAULT_RUN_EVENT_BUFFER,
    maxBufferedBytes: supplied?.maxBufferedBytes ?? DEFAULT_RUN_EVENT_BUFFER_BYTES,
    sizeOf: supplied?.sizeOf ?? sizeOfRunEvent,
    ...(supplied?.sizeOfCoalesced !== undefined
      ? { sizeOfCoalesced: supplied.sizeOfCoalesced }
      : supplied?.sizeOf === undefined && supplied?.coalesce === undefined
        ? { sizeOfCoalesced: sizeOfCoalescedRunEvent }
        : {}),
    coalesce: supplied?.coalesce ?? coalesceRunEvents,
    droppable: supplied?.droppable ?? isDroppableRunEvent,
  };
  return {
    ...configured,
    droppable: (event) =>
      event.type !== "events_dropped" && (configured.droppable?.(event) ?? true),
  };
}

/**
 * Create a protocol run handle around one execution function.
 *
 * @param spec - execution callback, observers, and lifecycle policy.
 * @returns a live handle immediately; execution and assembly failures settle
 *   {@link RunHandle.done} as failed results instead of rejecting handle creation.
 * @remarks This is the sole owner of buffering, steering, cancellation,
 *   elicitation, memory-ingest close grace, drop reporting, and stream disposal
 *   for ordinary and workflow-manager runs.
 */
export function createManagedRun(spec: ManagedRunSpec): RunHandle {
  return createManagedRunWithRuntime(spec, DEFAULT_MANAGED_RUN_RUNTIME);
}

/**
 * Deterministic construction seam for the package-owned managed-run state
 * machine. Kept out of the public entrypoint; production callers use
 * {@link createManagedRun}.
 *
 * @internal
 */
export function createManagedRunWithRuntime(
  spec: ManagedRunSpec,
  runtime: ManagedRunRuntime,
): RunHandle {
  const abort = new AbortController();
  const buffer = resolveEventBuffer(spec.eventBuffer);
  const stream = createEventStream<RunEvent>({
    ...buffer,
    onSaturated: (event) => {
      buffer.onSaturated?.(event);
      abort.abort(kernelError("unavailable", "run event consumer stopped draining"));
    },
    onAbandoned: () => {
      buffer.onAbandoned?.();
      abort.abort(kernelError("cancelled", "run event consumer abandoned the stream"));
    },
  });
  const steer = createSteerQueue();
  const compaction = createCompactionQueue();
  const bridge = createElicitBridge(spec.executionId);
  const boundedIngestWait = (value: number, fallback: number): number =>
    Number.isFinite(value)
      ? Math.min(MAX_INGEST_CLOSE_WAIT_MS, Math.max(0, Math.floor(value)))
      : fallback;
  const ingestGraceMs = boundedIngestWait(
    spec.ingestGraceMs ?? DEFAULT_INGEST_CLOSE_GRACE_MS,
    DEFAULT_INGEST_CLOSE_GRACE_MS,
  );
  const ingestMaxWaitMs = Math.max(
    ingestGraceMs,
    boundedIngestWait(
      spec.ingestMaxWaitMs ?? DEFAULT_INGEST_CLOSE_MAX_WAIT_MS,
      DEFAULT_INGEST_CLOSE_MAX_WAIT_MS,
    ),
  );

  let ingestPending = false;
  let settleIngest: (() => void) | undefined;
  let renewIngestWait: (() => void) | undefined;
  let releaseLifecycle: (() => void) | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const emitRelay = createEmitRelay<RunEvent>();

  emitRelay.connect((event) => {
    stream.push(event);
    spec.observe?.(event);
    const pending = ingestPendingAfter(event);
    if (pending === undefined) return;
    ingestPending = pending;
    if (pending) renewIngestWait?.();
    else settleIngest?.();
  });

  const endStream = (): void => {
    const dropped = stream.dropped();
    if (dropped > 0) {
      const notice: Extract<RunEvent, { type: "events_dropped" }> = {
        type: "events_dropped",
        at: runtime.now(),
        dropped,
      };
      stream.push(notice);
      notice.dropped = stream.dropped();
    }
    // Async capability listeners may retain `context.emit` beyond the ingest
    // grace window. Leave them only the tiny relay after closure, not this
    // target's stream, observer, timers, and full ManagedRunSpec graph.
    emitRelay.disconnect();
    stream.close();
    releaseLifecycle?.();
    releaseLifecycle = undefined;
    resolveClosed();
  };

  const closeStream = (): void => {
    if (!ingestPending) {
      endStream();
      return;
    }
    const noticeOrTimeout = new Promise<void>((resolve) => {
      const absoluteDeadline = runtime.now() + ingestMaxWaitMs;
      const schedule = (): ManagedRunTimer =>
        runtime.schedule(
          resolve,
          Math.max(0, Math.min(ingestGraceMs, absoluteDeadline - runtime.now())),
        );
      let timer = schedule();
      renewIngestWait = () => {
        timer.cancel();
        timer = schedule();
      };
      settleIngest = () => {
        timer.cancel();
        resolve();
      };
    });
    suppressSecondaryRejection(
      noticeOrTimeout.then(() => {
        renewIngestWait = undefined;
        settleIngest = undefined;
        endStream();
      }),
      "the memory ingest notice and timeout inputs",
    );
  };

  const context: ManagedRunContext = {
    executionId: spec.executionId,
    signal: abort.signal,
    elicit: bridge.elicit,
    steer,
    compaction,
    emit: emitRelay.emit,
  };

  let resolveExecutionStarted!: () => void;
  const executionStarted = new Promise<void>((resolve) => {
    resolveExecutionStarted = resolve;
  });
  releaseLifecycle = spec.lifecycle?.register({
    async close(): Promise<void> {
      abort.abort();
      await executionStarted;
      await done;
      settleIngest?.();
      await closed;
    },
  });

  const done = (async (): Promise<RunResult> => {
    let result: RunResult;
    try {
      if (spec.lifecycle !== undefined && spec.lifecycle.state !== "open") {
        throw kernelError("unavailable", "kernel is closing");
      }
      result = await spec.execute(context);
    } catch (error) {
      result = failedResult(spec.executionId, toKernelError(error));
    }
    try {
      await spec.settle?.(result);
      return result;
    } catch (error) {
      return failedResult(spec.executionId, toKernelError(error));
    } finally {
      steer.close();
      compaction.close();
      closeStream();
    }
  })();
  resolveExecutionStarted();

  return {
    execution_id: spec.executionId,
    events: stream.iterable,
    async steer(message) {
      if (await steer.push({ content: protoSteerToEngineContent(message) })) return;
      throw kernelError("not_found", `run '${spec.executionId}' is no longer accepting steering`);
    },
    async compact(request) {
      if (!compaction.push(request === undefined ? {} : { request })) {
        throw kernelError("not_found", `run '${spec.executionId}' is no longer active`);
      }
    },
    async cancel() {
      abort.abort();
    },
    async respond(response) {
      bridge.respond(response);
    },
    onElicit(handler) {
      bridge.onElicit(handler);
    },
    buffered: () => {
      const stats = stream.stats();
      return {
        buffered_items: stats.bufferedItems,
        buffered_bytes: stats.bufferedBytes,
        dropped: stats.dropped,
      };
    },
    done,
    closed,
  };
}
