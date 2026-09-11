import { randomUUID } from "node:crypto";
import { NOOP_LOGGER, suppressSecondaryRejection, type Logger } from "@clarvis/capability";
import type {
  ElicitationRequest,
  HostedRunAttachment,
  HostedRunFrame,
  RunHandle,
  RunResult,
} from "@clarvis/protocol";
import { createEventStream, type EventStream } from "../core/event-stream.ts";
import { kernelError, toKernelError } from "../core/errors.ts";
import {
  coalesceRunEvents,
  sizeOfCoalescedRunEvent,
  sizeOfRunEvent,
} from "../runs/coalesce-events.ts";
import type { HostedProjection } from "./projection.ts";

type Observation = Omit<HostedRunAttachment, "run">;
type Controls = Pick<RunHandle, "steer" | "compact" | "cancel" | "respond">;

/** One live subscriber; its failure must never become abandonment of the execution's source. */
interface Subscriber {
  id: string;
  cut?: number;
  snapshotId?: string;
  stream: EventStream<HostedRunFrame>;
  result: PromiseWithResolvers<RunResult>;
  closed: PromiseWithResolvers<void>;
  questions: Set<(request: ElicitationRequest) => void>;
  settlements: Set<(id: string) => void>;
  retired: boolean;
}

/** Host-owned run pump; observation, semantic result and physical closure have separate lifetimes. */
export interface HostedExecution {
  readonly executionId: string;
  /** Settles after physical closure, reconciliation and the owning host's terminal transaction. */
  readonly settled: Promise<void>;
  observe(controls: Controls): Promise<Observation>;
  releaseObservation(id: string): void;
  /** Stable terminal projection remains readable until the registry evicts this execution. */
  dispose(): Promise<void>;
  state(): {
    attention: "none" | "waiting_user";
    physicalClosed: boolean;
    reconciled: boolean;
    terminalCommitted: boolean;
    result?: RunResult;
    recoveryError?: Error;
    subscribers: number;
  };
}

/** Ports and finite budgets of one host-owned root execution. */
export interface HostedExecutionOptions {
  handle: RunHandle;
  projection: HostedProjection;
  /** Persist the owning conversation after physical closure, exactly once per execution. */
  reconcile(result: RunResult): Promise<void>;
  /** Commit the terminal registry state and release admission before observers become ready. */
  commitTerminal?: () => Promise<void>;
  changed?: () => void;
  logger?: Logger;
  maxSubscribers?: number;
  maxBuffered?: number;
  maxBufferedBytes?: number;
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

/**
 * Own the sole source consumer from admission through physical settlement, even with no UI.
 *
 * Subscribe before cutting a projection snapshot. Buffered events at or below that cut are excluded;
 * coalescing never crosses it. Slow or abandoned observers lose only their bounded copies. Storage
 * failure cancels execution, keeps draining its source and prevents another recoverable handoff.
 */
export function createHostedExecution(options: HostedExecutionOptions): HostedExecution {
  const { handle, projection } = options;
  if (handle.onElicitSettled === undefined) {
    throw kernelError("invalid_request", "hosted runs require observable elicitation settlement");
  }
  const maxSubscribers = positive(options.maxSubscribers ?? 4, "maxSubscribers");
  const maxBuffered = positive(options.maxBuffered ?? 1024, "maxBuffered");
  const maxBufferedBytes = positive(
    options.maxBufferedBytes ?? 16 * 1024 * 1024,
    "maxBufferedBytes",
  );
  const logger = options.logger ?? NOOP_LOGGER;
  const subscribers = new Map<string, Subscriber>();
  const questions = new Map<string, ElicitationRequest>();
  let streamEnded = false;
  let physicalClosed = false;
  let reconciled = false;
  let settlementComplete = false;
  let disposed = false;
  let result: RunResult | undefined;
  let recoveryError: Error | undefined;

  const changed = (): void => {
    try {
      options.changed?.();
    } catch {
      logger.warn({ event: "hosting.observation.callback_failed" }, "hosted state observer failed");
    }
  };

  const retire = (subscriber: Subscriber, error?: Error): void => {
    if (subscriber.retired) return;
    subscriber.retired = true;
    subscribers.delete(subscriber.id);
    if (subscriber.snapshotId !== undefined) projection.releaseSnapshot(subscriber.snapshotId);
    subscriber.questions.clear();
    subscriber.settlements.clear();
    const failure =
      error ??
      kernelError(
        "unavailable",
        "run observation closed; execution state must be reconciled with the host",
      );
    subscriber.stream.fail(failure);
    subscriber.result.reject(failure);
    subscriber.closed.resolve();
  };

  const failRecovery = (error: unknown): void => {
    if (recoveryError !== undefined) return;
    recoveryError = toKernelError(error);
    for (const subscriber of subscribers.values()) retire(subscriber, recoveryError);
    void handle.cancel().catch(() => {
      logger.warn(
        { event: "hosting.execution.cancel_failed", execution_id: handle.execution_id },
        "hosted recovery failure could not cancel execution",
      );
    });
    changed();
  };

  const deliver = <T>(listeners: ReadonlySet<(value: T) => void>, value: T): void => {
    for (const listener of listeners) {
      try {
        listener(value);
      } catch {
        logger.warn(
          { event: "hosting.elicitation.observer_failed" },
          "hosted elicitation observer failed",
        );
      }
    }
  };

  const unsubscribeSettled = handle.onElicitSettled((id) => {
    if (!questions.delete(id)) return;
    for (const subscriber of subscribers.values()) deliver(subscriber.settlements, id);
    changed();
  });
  const unsubscribeQuestions = handle.onElicit((request) => {
    questions.set(request.id, request);
    for (const subscriber of subscribers.values()) deliver(subscriber.questions, request);
    changed();
  });

  const outcome = handle.done.then((value) => {
    result = value;
    for (const subscriber of subscribers.values()) subscriber.result.resolve(value);
    changed();
  }, failRecovery);

  const pump = (async () => {
    try {
      for await (const event of handle.events) {
        if (recoveryError !== undefined) continue;
        try {
          const cursor = await projection.append(event);
          for (const subscriber of subscribers.values()) {
            subscriber.stream.push({
              first_sequence: cursor.sequence,
              last_sequence: cursor.sequence,
              event: { ...event },
            });
          }
        } catch (error) {
          failRecovery(error);
        }
      }
    } catch (error) {
      failRecovery(error);
    } finally {
      streamEnded = true;
      for (const subscriber of subscribers.values()) subscriber.stream.close();
    }
  })();

  const physical = handle.closed.then(() => {
    physicalClosed = true;
  }, failRecovery);
  const settled = Promise.all([outcome, pump, physical]).then(async () => {
    if (typeof unsubscribeQuestions === "function") unsubscribeQuestions();
    unsubscribeSettled();
    for (const id of questions.keys()) {
      for (const subscriber of subscribers.values()) deliver(subscriber.settlements, id);
    }
    questions.clear();
    if (result !== undefined && physicalClosed) {
      try {
        await options.reconcile(result);
        reconciled = true;
        if (recoveryError === undefined) {
          await options.commitTerminal?.();
          settlementComplete = true;
        }
      } catch (error) {
        for (const subscriber of subscribers.values())
          subscriber.closed.reject(toKernelError(error));
        failRecovery(error);
      }
    }
    for (const subscriber of subscribers.values()) subscriber.closed.resolve();
    changed();
  });

  return {
    executionId: handle.execution_id,
    settled,
    async observe(controls) {
      if (disposed || recoveryError !== undefined)
        throw recoveryError ?? kernelError("not_found", "hosted observation was retired");
      if (subscribers.size >= maxSubscribers)
        throw kernelError("resource_exhausted", "hosted observer limit reached");
      const stream = createEventStream<HostedRunFrame>({
        maxBuffered,
        maxBufferedBytes,
        sizeOf: (frame) => sizeOfRunEvent(frame.event) + 128,
        coalesce: (previous, incoming) => {
          if (subscriber.cut === undefined || previous.first_sequence <= subscriber.cut)
            return undefined;
          const event = coalesceRunEvents(previous.event, incoming.event);
          return event === undefined
            ? undefined
            : {
                first_sequence: previous.first_sequence,
                last_sequence: incoming.last_sequence,
                event,
              };
        },
        sizeOfCoalesced: (previous, incoming, merged, previousBytes, incomingBytes) =>
          sizeOfCoalescedRunEvent(
            previous.event,
            incoming.event,
            merged.event,
            previousBytes - 128,
            incomingBytes - 128,
          ) + 128,
        droppable: () => false,
        onSaturated: () =>
          retire(
            subscriber,
            kernelError("resource_exhausted", "run observer fell behind; reconnect by snapshot"),
          ),
        onAbandoned: () => retire(subscriber),
      });
      const subscriber: Subscriber = {
        id: randomUUID(),
        stream,
        result: Promise.withResolvers<RunResult>(),
        closed: Promise.withResolvers<void>(),
        questions: new Set(),
        settlements: new Set(),
        retired: false,
      };
      suppressSecondaryRejection(
        subscriber.result.promise,
        "the attachment's done promise or failed observation stream",
      );
      suppressSecondaryRejection(
        subscriber.closed.promise,
        "the attachment's terminal transaction or failed observation stream",
      );
      subscribers.set(subscriber.id, subscriber);
      try {
        const snapshot = await projection.snapshot();
        subscriber.snapshotId = snapshot.snapshot_id;
        if (subscriber.retired || disposed) {
          projection.releaseSnapshot(snapshot.snapshot_id);
          throw kernelError("unavailable", "observation ended during snapshot preparation");
        }
        subscriber.cut = snapshot.cursor.sequence;
        if (result !== undefined) subscriber.result.resolve(result);
        if (streamEnded) stream.close();
        if (settlementComplete) subscriber.closed.resolve();
        const assertObserver = (): void => {
          if (subscriber.retired) throw kernelError("not_found", "run observation is closed");
        };
        const subscribe = <T>(listeners: Set<T>, listener: T): (() => void) => {
          assertObserver();
          if (listeners.size >= 16)
            throw kernelError("resource_exhausted", "too many observation callbacks");
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        };
        return {
          observation_id: subscriber.id,
          snapshot,
          pending_elicitations: [...questions.values()],
          handle: {
            execution_id: handle.execution_id,
            events: {
              async *[Symbol.asyncIterator]() {
                for await (const frame of stream.iterable) {
                  if (frame.last_sequence > snapshot.cursor.sequence) yield frame;
                }
              },
            },
            done: subscriber.result.promise,
            closed: subscriber.closed.promise,
            buffered: () => ({
              buffered_items: stream.stats().bufferedItems,
              buffered_bytes: stream.stats().bufferedBytes,
              dropped: 0,
            }),
            async steer(message) {
              assertObserver();
              await controls.steer(message);
            },
            async compact(request) {
              assertObserver();
              await controls.compact(request);
            },
            async cancel() {
              assertObserver();
              await controls.cancel();
            },
            async respond(response) {
              assertObserver();
              if (!questions.has(response.id))
                throw kernelError("not_found", "elicitation has already settled");
              await controls.respond(response);
            },
            onElicit(listener) {
              const stop = subscribe(subscriber.questions, listener);
              for (const question of questions.values()) deliver(new Set([listener]), question);
              return stop;
            },
            onElicitSettled: (listener) => subscribe(subscriber.settlements, listener),
          },
        };
      } catch (error) {
        const failure = projection.failure();
        if (failure !== undefined) failRecovery(failure);
        retire(subscriber, toKernelError(error));
        throw error;
      }
    },
    releaseObservation(id) {
      const subscriber = subscribers.get(id);
      if (subscriber !== undefined) retire(subscriber);
    },
    async dispose() {
      if (!physicalClosed)
        throw kernelError("conflict", "cannot dispose a physically active hosted execution");
      await settled;
      disposed = true;
      for (const subscriber of subscribers.values()) retire(subscriber);
      await projection.close();
    },
    state: () => ({
      attention: questions.size === 0 ? "none" : "waiting_user",
      physicalClosed,
      reconciled,
      terminalCommitted: settlementComplete,
      result,
      recoveryError,
      subscribers: subscribers.size,
    }),
  };
}
