import { randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { DIR_MODE, FILE_MODE, fsyncDir } from "@clarvis/paths";
import type {
  HostedRunCursor,
  HostedRunFrame,
  HostedRunSnapshot,
  HostedRunSnapshotPage,
  RunEvent,
} from "@clarvis/protocol";
import { kernelError } from "../core/errors.ts";
import {
  coalesceRunEvents,
  sizeOfCoalescedRunEvent,
  sizeOfRunEvent,
} from "../runs/coalesce-events.ts";
import { RUN_EVENT_POLICY } from "../runs/event-policy.ts";

/** File port owned exclusively by one hosted run's observation pump. */
export interface ProjectionStorage {
  /** Write the complete buffer at the supplied byte offset or reject. */
  write(bytes: Uint8Array, offset: number): Promise<void>;
  /** Read exactly the requested range or reject; an EOF inside a snapshot is corruption. */
  read(offset: number, bytes: number): Promise<Uint8Array>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** Finite observation budgets, independent of the provider's run budgets. */
export interface HostedProjectionOptions {
  /** Total encoded projection bytes; exhaustion is an explicit recovery failure. */
  maxBytes?: number;
  /** Flush adjacent deltas at this size, instead of writing each provider token. */
  chunkBytes?: number;
  /** Raw bytes per page, before base64 encoding. */
  pageBytes?: number;
  maxSnapshots?: number;
  snapshotLifetimeMs?: number;
  maxPendingOperations?: number;
  maxPendingBytes?: number;
  now?: () => number;
}

/** Host-owned observation history; snapshots are immutable prefixes of an append-only file. */
export interface HostedProjection {
  /** Append one event without ever dropping structural state. */
  append(event: RunEvent): Promise<HostedRunCursor>;
  /** Flush and sync a prefix; subscribing after its cursor is the registry's atomic operation. */
  snapshot(): Promise<HostedRunSnapshot>;
  /** Flush and sync a handoff boundary without allocating another reader snapshot. */
  sync(): Promise<HostedRunCursor>;
  readPage(snapshotId: string, offset: number): Promise<HostedRunSnapshotPage>;
  releaseSnapshot(snapshotId: string): void;
  stats(): { bytes: number; pending_bytes: number; snapshots: number; sequence: number };
  /** Sticky storage failure, distinct from a rejected client's queue or snapshot admission. */
  failure(): Error | undefined;
  /** Flush accepted writes and release the file, without deleting historical bytes. */
  close(): Promise<void>;
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function storageFailure(error: unknown): Error {
  return error instanceof Error
    ? error
    : kernelError("unavailable", "hosted observation storage failed");
}

/**
 * Maintain bounded observation history without tying its progress to a UI subscriber.
 *
 * Only adjacent deltas coalesce, using the ordinary run event policy. Historical bytes are never
 * rewritten: a snapshot records an immutable prefix length, so later appends cannot change a
 * page already read. Requests and their retained input bytes are bounded before queue allocation.
 * A storage failure is sticky; already-issued prefixes remain readable, but no new handoff can
 * mistake a failed projection for recoverable state.
 */
export function createHostedProjection(
  storage: ProjectionStorage,
  identity: Omit<HostedRunCursor, "sequence">,
  options: HostedProjectionOptions = {},
): HostedProjection {
  const maxBytes = positive(options.maxBytes ?? 64 * 1024 * 1024, "maxBytes");
  const chunkBytes = positive(options.chunkBytes ?? 64 * 1024, "chunkBytes");
  const pageBytes = positive(options.pageBytes ?? 256 * 1024, "pageBytes");
  const maxSnapshots = positive(options.maxSnapshots ?? 4, "maxSnapshots");
  const snapshotLifetimeMs = positive(options.snapshotLifetimeMs ?? 120_000, "snapshotLifetimeMs");
  const maxPendingOperations = positive(options.maxPendingOperations ?? 32, "maxPendingOperations");
  const maxPendingBytes = positive(options.maxPendingBytes ?? 16 * 1024 * 1024, "maxPendingBytes");
  if (pageBytes > 1024 * 1024) throw new RangeError("snapshot pages cannot exceed 1 MiB");
  const now = options.now ?? Date.now;
  const snapshots = new Map<string, { ref: HostedRunSnapshot; expires: number }>();
  let sequence = 0;
  let writtenBytes = 0;
  let pending: { frame: HostedRunFrame; bytes: number } | undefined;
  let queuedOperations = 0;
  let queuedBytes = 0;
  let tail: Promise<void> = Promise.resolve();
  let failure: Error | undefined;
  let closing: Promise<void> | undefined;

  const cursor = (): HostedRunCursor => ({ ...identity, sequence });

  const expireSnapshots = (): void => {
    const stamp = now();
    for (const [id, value] of snapshots) {
      if (value.expires <= stamp) snapshots.delete(id);
    }
  };

  const enqueue = <T>(operation: () => Promise<T>, bytes = 0): Promise<T> => {
    if (closing !== undefined)
      return Promise.reject(kernelError("unavailable", "projection is closed"));
    if (queuedOperations >= maxPendingOperations || queuedBytes + bytes > maxPendingBytes) {
      return Promise.reject(kernelError("conflict", "projection request budget is exhausted"));
    }
    queuedOperations += 1;
    queuedBytes += bytes;
    const result = tail.then(operation).finally(() => {
      queuedOperations -= 1;
      queuedBytes -= bytes;
    });
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const assertHealthy = (): void => {
    if (failure !== undefined) throw failure;
  };

  const flush = async (): Promise<void> => {
    if (pending === undefined) return;
    const bytes = Buffer.from(`${JSON.stringify(pending.frame)}\n`, "utf8");
    if (writtenBytes + bytes.length > maxBytes) {
      throw kernelError("unavailable", "hosted observation history reached its byte quota");
    }
    await storage.write(bytes, writtenBytes);
    writtenBytes += bytes.length;
    pending = undefined;
  };

  return {
    failure: () => failure,
    append(event) {
      const bytes = sizeOfRunEvent(event);
      return enqueue(async () => {
        assertHealthy();
        try {
          if (writtenBytes + (pending?.bytes ?? 0) + bytes + 128 > maxBytes) {
            throw kernelError("unavailable", "hosted observation history reached its byte quota");
          }
          if (!Number.isSafeInteger(sequence + 1)) {
            throw kernelError("unavailable", "hosted observation sequence is exhausted");
          }
          const nextSequence = sequence + 1;
          const previous = pending;
          const merged =
            previous === undefined ? undefined : coalesceRunEvents(previous.frame.event, event);
          if (previous !== undefined && merged !== undefined) {
            pending = {
              frame: { ...previous.frame, last_sequence: nextSequence, event: merged },
              bytes: sizeOfCoalescedRunEvent(
                previous.frame.event,
                event,
                merged,
                previous.bytes,
                bytes,
              ),
            };
          } else {
            await flush();
            pending = {
              frame: {
                first_sequence: nextSequence,
                last_sequence: nextSequence,
                event: { ...event },
              },
              bytes,
            };
          }
          sequence = nextSequence;
          if (pending.bytes >= chunkBytes || RUN_EVENT_POLICY[event.type].coalesce === false)
            await flush();
          return cursor();
        } catch (error) {
          failure = storageFailure(error);
          throw failure;
        }
      }, bytes);
    },
    snapshot() {
      return enqueue(async () => {
        assertHealthy();
        expireSnapshots();
        if (snapshots.size >= maxSnapshots) {
          throw kernelError("conflict", "too many outstanding observation snapshots");
        }
        try {
          await flush();
          await storage.sync();
        } catch (error) {
          failure = storageFailure(error);
          throw failure;
        }
        const ref: HostedRunSnapshot = {
          snapshot_id: randomUUID(),
          cursor: cursor(),
          bytes: writtenBytes,
        };
        snapshots.set(ref.snapshot_id, { ref, expires: now() + snapshotLifetimeMs });
        return structuredClone(ref);
      });
    },
    sync() {
      return enqueue(async () => {
        assertHealthy();
        try {
          await flush();
          await storage.sync();
          return cursor();
        } catch (error) {
          failure = storageFailure(error);
          throw failure;
        }
      });
    },
    readPage(snapshotId, offset) {
      return enqueue(async () => {
        expireSnapshots();
        const snapshot = snapshots.get(snapshotId)?.ref;
        if (snapshot === undefined)
          throw kernelError("not_found", "observation snapshot expired or unknown");
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.bytes) {
          throw kernelError("invalid_request", "snapshot offset is outside its immutable prefix");
        }
        const length = Math.min(pageBytes, snapshot.bytes - offset);
        let bytes: Uint8Array;
        try {
          bytes = await storage.read(offset, length);
          if (bytes.length !== length)
            throw kernelError("unavailable", "observation snapshot is incomplete");
        } catch (error) {
          failure = storageFailure(error);
          throw failure;
        }
        return {
          snapshot_id: snapshotId,
          offset,
          data_base64: Buffer.from(bytes).toString("base64"),
          ...(offset + length < snapshot.bytes ? { next_offset: offset + length } : {}),
        };
      }, pageBytes);
    },
    releaseSnapshot(snapshotId) {
      snapshots.delete(snapshotId);
    },
    stats: () => ({
      bytes: writtenBytes,
      pending_bytes: pending?.bytes ?? 0,
      snapshots: snapshots.size,
      sequence,
    }),
    close() {
      closing ??= tail.then(async () => {
        try {
          if (failure === undefined) {
            await flush();
            await storage.sync();
          }
        } finally {
          snapshots.clear();
          await storage.close();
        }
      });
      return closing;
    },
  };
}

/** Open a new private projection file; an existing execution is never silently overwritten. */
export async function openHostedProjection(
  file: string,
  identity: Omit<HostedRunCursor, "sequence">,
  options?: HostedProjectionOptions,
): Promise<HostedProjection> {
  await mkdir(dirname(file), { recursive: true, mode: DIR_MODE });
  const handle = await open(file, "wx+", FILE_MODE);
  await fsyncDir(dirname(file));
  try {
    return createHostedProjection(
      {
        async write(bytes, offset) {
          let written = 0;
          while (written < bytes.length) {
            const result = await handle.write(
              bytes,
              written,
              bytes.length - written,
              offset + written,
            );
            if (result.bytesWritten === 0)
              throw kernelError("unavailable", "observation write made no progress");
            written += result.bytesWritten;
          }
        },
        async read(offset, length) {
          const bytes = Buffer.alloc(length);
          let received = 0;
          while (received < length) {
            const result = await handle.read(bytes, received, length - received, offset + received);
            if (result.bytesRead === 0)
              throw kernelError("unavailable", "observation file ended inside a snapshot");
            received += result.bytesRead;
          }
          return bytes;
        },
        sync: () => handle.sync(),
        close: () => handle.close(),
      },
      identity,
      options,
    );
  } catch (error) {
    await handle.close();
    throw error;
  }
}
