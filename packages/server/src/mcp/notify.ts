import {
  coalesceRunEvents,
  RUN_EVENT_POLICY,
  sizeOfCoalescedRunEvent,
  sizeOfRunEvent,
} from "@clarvis/kernel/policy";
import type { RunEvent } from "@clarvis/protocol";
import { scheduleSystemTimeout, type ScheduleTimeout } from "../timing.ts";
import { meetsThreshold, mergeKeyOf, viewOf, type LogLevel } from "./event-view.ts";
import { NOOP_LOGGER, suppressSecondaryRejection, type Logger } from "@clarvis/capability";

/** Live-stream fidelity counters for one run. */
export interface SinkStats {
  events_sent: number;
  deltas_coalesced: number;
  events_dropped: number;
  wedged: boolean;
  /** Event iterator did not close within the post-result grace. */
  truncated: boolean;
}

/** Sends one notification down the caller's stream. */
export type SendNotification = (notification: {
  method: string;
  params: Record<string, unknown>;
}) => Promise<void>;

/** Buffers, coalesces and delivers a run's events as MCP notifications. */
export interface NotificationSink {
  /** Queue an event. Never throws and never blocks the producer. */
  onEvent(event: RunEvent): void;
  /** Queue a structural notification on the same serialized transport lane. */
  notify(notification: Notification): void;
  /** Emit a keepalive so a client's request timeout does not fire mid-run. */
  heartbeat(): void;
  /** Drain, then report any drops. Resolves once the queue is empty or wedged. */
  flush(): Promise<void>;
  /** Stop accepting producer events while allowing the existing queue to drain. */
  seal(truncated?: boolean): void;
  stats(): SinkStats;
}

/** Configuration for {@link createNotificationSink}. */
export interface NotificationSinkOptions {
  sendNotification: SendNotification;
  /** Progress notifications are emitted only when the caller supplied a token. */
  progressToken?: string | number;
  /** The session's current `logging/setLevel` threshold. */
  getLevel: () => string;
  /** Queue cap past which the oldest droppable entry is discarded. */
  bufferMax: number;
  /** Retained-byte cap for queued run events and facade notifications. */
  bufferMaxBytes: number;
  /** Per-send bound; exceeding it wedges the sink rather than stalling the run. */
  sendTimeoutMs: number;
  /** Internal deterministic-test seam; production uses the host timer API. */
  scheduleTimeout?: ScheduleTimeout;
  /** Internal deterministic-test seam for one detached drain observation. */
  observeDrain?: (drain: Promise<void>) => void;
  /** Internal deterministic-test seam at the empty-queue/finally handoff. */
  onDrainIdle?: () => void;
  /** The run-bound diagnostic channel; already carries `execution_id`. */
  logger?: Logger;
}

/** Why a sink stopped delivering. */
type WedgeReason = "send_timeout" | "send_failed" | "buffer_full";

/**
 * Record a sink that has stopped delivering.
 *
 * @param logger - the run-bound diagnostic channel.
 * @param reason - what stopped it.
 * @param stats - the counters as they stood when it wedged.
 * @param queuedBytes - bytes still queued at that moment.
 * @param sendTimeoutMs - the per-send bound that produced a timeout.
 * @remarks Emitted once per run, not per dropped event. Everything after a
 * wedge is counted rather than logged, and the total is reported at `seal`.
 */
function reportWedged(
  logger: Logger,
  reason: WedgeReason,
  stats: SinkStats,
  queuedBytes: number,
  sendTimeoutMs: number,
): void {
  logger.warn(
    {
      event: "stream.wedged",
      reason,
      sent: stats.events_sent,
      dropped: stats.events_dropped,
      queued_bytes: queuedBytes,
      send_timeout_ms: sendTimeoutMs,
    },
    "the notification stream stopped delivering; the run continues and its tool result reports the truncation",
  );
}

/**
 * Report a run's total live-stream losses, once, when the sink is sealed.
 *
 * @param logger - the run-bound diagnostic channel.
 * @param droppedTotal - how many notifications never reached the caller.
 */
function reportDropped(logger: Logger, droppedTotal: number): void {
  logger.debug(
    { event: "stream.dropped", dropped_total: droppedTotal },
    "notifications were dropped from this run's live stream; the persisted trace is unaffected",
  );
}

/** One notification accepted by the sink's single serialized transport lane. */
export interface Notification {
  method: string;
  params: Record<string, unknown>;
}

/** One queued run event, carrying the key it may merge with its successor on. */
interface EventEntry {
  kind: "event";
  event: RunEvent;
  mergeKey: string | undefined;
  bytes: number;
}

/** One queued facade notification that did not originate as a run event. */
interface NotificationEntry {
  kind: "notification";
  notification: Notification;
  bytes: number;
  droppable: boolean;
  key?: "heartbeat";
}

type Entry = EventEntry | NotificationEntry;

/**
 * Whether a full live buffer may discard `event` rather than deliver it.
 *
 * @param event - the queued event.
 * @returns kernel's {@link RUN_EVENT_POLICY} verdict for `event.type`.
 */
export const isDroppable = (event: RunEvent): boolean => RUN_EVENT_POLICY[event.type].droppable;

/**
 * Build a coalescing notification sink.
 *
 * @param opts - transport, progress token, level source and limits.
 * @returns the sink; exactly one exists per run.
 * @remarks Complements the kernel's own event-stream backpressure rather than
 *   duplicating it: the kernel bounds the *buffer* a slow consumer creates, while
 *   this bounds a slow *transport*. Adjacent deltas merge losslessly, so a delta
 *   storm costs event count, never characters. A send that exceeds
 *   `sendTimeoutMs` marks the sink wedged and everything after it is counted as
 *   dropped instead of stalling the run behind a dead socket. If structural
 *   events alone fill the buffer, selective dropping is impossible: the sink
 *   wedges, clears the queue and leaves the final tool result to report the
 *   truncation and drop count.
 */
export function createNotificationSink(opts: NotificationSinkOptions): NotificationSink {
  const logger = opts.logger ?? NOOP_LOGGER;
  const queue: Entry[] = [];
  const stats: SinkStats = {
    events_sent: 0,
    deltas_coalesced: 0,
    events_dropped: 0,
    wedged: false,
    truncated: false,
  };
  let progress = 0;
  let draining: Promise<void> | undefined;
  let sealed = false;
  let queuedBytes = 0;
  let heartbeatOutstanding = false;

  const markWedged = (reason: WedgeReason): void => {
    if (stats.wedged) return;
    stats.wedged = true;
    reportWedged(logger, reason, stats, queuedBytes, opts.sendTimeoutMs);
  };

  const entryDroppable = (entry: Entry): boolean =>
    entry.kind === "event" ? isDroppable(entry.event) : entry.droppable;

  const releaseEntry = (entry: Entry): void => {
    if (entry.kind === "notification" && entry.key === "heartbeat") {
      heartbeatOutstanding = false;
    }
  };

  const dropAt = (index: number): void => {
    const [removed] = queue.splice(index, 1);
    if (removed !== undefined) {
      queuedBytes -= removed.bytes;
      releaseEntry(removed);
    }
  };

  const clearQueue = (): number => {
    const count = queue.length;
    for (const entry of queue) releaseEntry(entry);
    queue.length = 0;
    queuedBytes = 0;
    return count;
  };

  const sizeOfNotification = (notification: Notification): number => {
    try {
      return Buffer.byteLength(JSON.stringify(notification), "utf8");
    } catch {
      return Number.MAX_SAFE_INTEGER;
    }
  };

  const send = async (method: string, params: Record<string, unknown>): Promise<void> => {
    if (stats.wedged) return;
    let cancelTimeout: (() => void) | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      cancelTimeout = (opts.scheduleTimeout ?? scheduleSystemTimeout)(
        () => resolve("timeout"),
        opts.sendTimeoutMs,
      );
    });
    try {
      const outcome = await Promise.race([
        opts.sendNotification({ method, params }).then(() => "sent" as const),
        timeout,
      ]);
      if (outcome === "timeout") markWedged("send_timeout");
      else stats.events_sent += 1;
    } catch {
      markWedged("send_failed");
    } finally {
      cancelTimeout?.();
    }
  };

  const deliver = async (entry: Entry): Promise<void> => {
    try {
      if (entry.kind === "notification") {
        if (entry.key === "heartbeat") {
          progress += 1;
          await send(entry.notification.method, {
            ...entry.notification.params,
            progress,
          });
        } else {
          await send(entry.notification.method, entry.notification.params);
        }
        return;
      }
      const view = viewOf(entry.event);
      if (meetsThreshold(view.level, opts.getLevel())) {
        await send("notifications/message", {
          level: view.level,
          logger: view.logger,
          data: entry.event,
        });
      }
      if (opts.progressToken !== undefined) {
        progress += 1;
        await send("notifications/progress", {
          progressToken: opts.progressToken,
          progress,
          message: view.label,
        });
      }
    } finally {
      releaseEntry(entry);
    }
  };

  const runDrain = async (): Promise<void> => {
    while (queue.length > 0) {
      const entry = queue.shift();
      if (entry === undefined) break;
      queuedBytes -= entry.bytes;
      await deliver(entry);
      if (stats.wedged) {
        stats.events_dropped += clearQueue();
        break;
      }
    }
    opts.onDrainIdle?.();
  };

  const drain = (): Promise<void> => {
    if (draining !== undefined) return draining;
    if (queue.length === 0) return Promise.resolve();
    const active = runDrain().finally(() => {
      if (draining !== active) return;
      draining = undefined;
      // A producer can append after runDrain observed an empty queue but before
      // this reaction clears `draining`. Its kick saw the old generation and
      // deliberately did nothing, so this handoff owns starting the successor.
      if (queue.length > 0 && !stats.wedged) kickDrain();
    });
    draining = active;
    return active;
  };

  const kickDrain = (): void => {
    // Promise reactions are retained until their source settles. Observing the
    // same blocked drain per delta therefore bypasses every queue byte cap.
    if (draining !== undefined) return;
    const active = drain();
    if (opts.observeDrain !== undefined) {
      opts.observeDrain(active);
    } else {
      suppressSecondaryRejection(active, "the notification sink wedge state");
    }
  };

  const enqueueNotification = (
    notification: Notification,
    options: { droppable: boolean; key?: NotificationEntry["key"] },
  ): boolean => {
    if (sealed) {
      stats.events_dropped += 1;
      stats.truncated = true;
      return false;
    }
    if (stats.wedged) {
      stats.events_dropped += 1;
      return false;
    }
    const bytes = sizeOfNotification(notification);
    while (queue.length >= opts.bufferMax || queuedBytes + bytes > opts.bufferMaxBytes) {
      const victim = queue.findIndex(entryDroppable);
      if (victim !== -1) {
        dropAt(victim);
        stats.events_dropped += 1;
        continue;
      }
      if (options.droppable) return false;
      markWedged("buffer_full");
      stats.truncated = true;
      stats.events_dropped += clearQueue() + 1;
      return false;
    }
    const entry: NotificationEntry = {
      kind: "notification",
      notification,
      bytes,
      droppable: options.droppable,
      ...(options.key === undefined ? {} : { key: options.key }),
    };
    queue.push(entry);
    queuedBytes += bytes;
    kickDrain();
    return true;
  };

  return {
    onEvent(event): void {
      if (sealed) {
        stats.events_dropped += 1;
        stats.truncated = true;
        return;
      }
      if (stats.wedged) {
        stats.events_dropped += 1;
        return;
      }
      const eventBytes = sizeOfRunEvent(event);
      const mergeKey = mergeKeyOf(event);
      const tail = queue.at(-1);
      if (mergeKey !== undefined && tail?.kind === "event" && tail.mergeKey === mergeKey) {
        const merged = coalesceRunEvents(tail.event, event);
        if (merged !== undefined) {
          const mergedBytes = sizeOfCoalescedRunEvent(
            tail.event,
            event,
            merged,
            tail.bytes,
            eventBytes,
          );
          const retainedBytes = queuedBytes - tail.bytes + mergedBytes;
          if (retainedBytes > opts.bufferMaxBytes) {
            dropAt(queue.length - 1);
            stats.events_dropped += 1;
            return;
          }
          queuedBytes = retainedBytes;
          tail.event = merged;
          tail.bytes = mergedBytes;
          stats.deltas_coalesced += 1;
          kickDrain();
          return;
        }
      }
      while (queue.length >= opts.bufferMax || queuedBytes + eventBytes > opts.bufferMaxBytes) {
        const victim = queue.findIndex(entryDroppable);
        if (victim === -1) {
          if (isDroppable(event)) {
            stats.events_dropped += 1;
            return;
          }
          markWedged("buffer_full");
          stats.truncated = true;
          stats.events_dropped += clearQueue() + 1;
          return;
        } else {
          dropAt(victim);
          stats.events_dropped += 1;
        }
      }
      queue.push({ kind: "event", event, mergeKey, bytes: eventBytes });
      queuedBytes += eventBytes;
      kickDrain();
    },

    notify(notification): void {
      enqueueNotification(notification, { droppable: false });
    },

    heartbeat(): void {
      if (sealed || opts.progressToken === undefined || stats.wedged || heartbeatOutstanding) {
        return;
      }
      heartbeatOutstanding = true;
      const enqueued = enqueueNotification(
        {
          method: "notifications/progress",
          params: {
            progressToken: opts.progressToken,
            message: "working",
          },
        },
        { droppable: true, key: "heartbeat" },
      );
      if (!enqueued) heartbeatOutstanding = false;
    },

    async flush(): Promise<void> {
      do {
        await drain();
      } while (draining !== undefined || queue.length > 0);
      if (stats.events_dropped > 0 && !stats.wedged) {
        await send("notifications/message", {
          level: "warning" satisfies LogLevel,
          logger: "clarvis.stream",
          data: { type: "notifications_dropped", dropped: stats.events_dropped },
        });
      }
    },

    seal(truncated = false): void {
      sealed = true;
      if (truncated) stats.truncated = true;
      if (stats.events_dropped > 0) reportDropped(logger, stats.events_dropped);
    },

    stats(): SinkStats {
      return { ...stats };
    },
  };
}
