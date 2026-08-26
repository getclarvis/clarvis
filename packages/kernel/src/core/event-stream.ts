/**
 * Merges `next` into `prev` when the two are adjacent slices of one logical
 * stream — successive text deltas of a turn, say.
 *
 * @typeParam T - the item type being merged.
 * @param prev - the item currently at the buffer tail.
 * @param next - the item being pushed.
 * @returns the merged item to replace the tail with, or `undefined` when the two
 *   must stay separate.
 */
export type Coalescer<T> = (prev: T, next: T) => T | undefined;

/**
 * Backpressure policy for {@link createEventStream}.
 *
 * @typeParam T - the item type the policy inspects.
 */
export interface EventStreamOptions<T> {
  /**
   * Buffered-item cap before the drop policy engages. `0` (the default) is
   * unbounded, preserving the pre-backpressure behaviour exactly.
   */
  maxBuffered?: number;
  /**
   * Buffered-byte cap. `0` (the default) leaves byte accounting disabled.
   * Callers enabling this cap must also provide {@link sizeOf}.
   */
  maxBufferedBytes?: number;
  /** Returns the retained byte cost of one buffered item. */
  sizeOf?: (item: T) => number;
  /**
   * Computes a merged tail's retained size from already measured inputs.
   * Use this when re-serializing an ever-growing coalesced value would be
   * quadratic. Absent, the merged item is measured with {@link sizeOf}.
   */
  sizeOfCoalesced?: (
    previous: T,
    incoming: T,
    merged: T,
    previousBytes: number,
    incomingBytes: number,
  ) => number;
  /**
   * Merges an incoming item into the buffer tail.
   *
   * @remarks Engages only while the consumer is behind — the generator parks
   *   only on an empty buffer, so a non-empty buffer *means* backpressure. A
   *   consumer that keeps up therefore still receives every item verbatim, and
   *   no timer or coalescing window is needed.
   */
  coalesce?: Coalescer<T>;
  /**
   * Whether an item may be discarded once the buffer is full. An item that
   * answers `false` is always kept, even past `maxBuffered`.
   */
  droppable?: (item: T) => boolean;
  /** Called when a full buffer contains only structural (non-droppable) items. */
  onSaturated?: (item: T) => void;
  /** Called once when the sole consumer returns before the stream terminates. */
  onAbandoned?: () => void;
}

/**
 * Push-based async iterable used to fan run events to a single consumer.
 *
 * @typeParam T - the item type buffered and yielded.
 * @remarks Buffered items always drain before the terminal signal: after
 *   {@link EventStream.close} the iterator returns, and after
 *   {@link EventStream.fail} it throws — but only once the buffer is empty. Push
 *   after either terminal call is a no-op.
 */
export interface EventStream<T> {
  /** Enqueues an item; ignored after close/fail. */
  push(item: T): void;
  /** Ends the stream after buffered items are drained. */
  close(): void;
  /** Fails the iterable with `err` after buffered items are drained. */
  fail(err: unknown): void;
  /** Items discarded by the backpressure policy so far. */
  dropped(): number;
  /** Current retained queue counters without copying or serializing buffered items. */
  stats(): { bufferedItems: number; bufferedBytes: number; dropped: number };
  /** Async iterable of pushed items. */
  readonly iterable: AsyncIterable<T>;
}

/**
 * Creates a buffered {@link EventStream}.
 *
 * @typeParam T - the item type to buffer and yield.
 * @param opts - the backpressure policy; an empty policy leaves the buffer
 *   unbounded and never merges or drops. See {@link EventStreamOptions}.
 * @returns a fresh stream; callers push items while a single consumer iterates
 *   `iterable`.
 * @remarks Single-consumer by design — the returned `iterable` is meant to be
 *   iterated once. Items pushed before iteration starts are buffered and
 *   delivered in order.
 *
 *   The policy applies coalesce-before-drop: merging into the tail is lossless,
 *   so a delta storm is absorbed as O(1) buffer growth and the drop path only
 *   runs on a heterogeneous one. Locating the drop victim is O(n) in the buffer
 *   once full, which the coalescer keeps rare.
 */
export function createEventStream<T>(opts: EventStreamOptions<T> = {}): EventStream<T> {
  const maxBuffered = opts.maxBuffered ?? 0;
  const maxBufferedBytes = opts.maxBufferedBytes ?? 0;
  if (maxBufferedBytes > 0 && opts.sizeOf === undefined) {
    throw new Error("event stream maxBufferedBytes requires sizeOf");
  }
  const { coalesce, droppable } = opts;
  const buffer: Array<{ item: T; bytes: number }> = [];
  let head = 0;
  let bufferedBytes = 0;
  let closed = false;
  let failed = false;
  let abandoned = false;
  let failure: unknown;
  let droppedCount = 0;
  let wake: (() => void) | undefined;
  let iteratorCreated = false;

  const signal = (): void => {
    const w = wake;
    wake = undefined;
    w?.();
  };

  const isDroppable = (item: T): boolean => droppable === undefined || droppable(item);

  const validSize = (measured: number): number => {
    if (maxBufferedBytes === 0) return 0;
    if (!Number.isFinite(measured) || measured < 0) {
      throw new Error("event stream sizeOf must return a finite non-negative number");
    }
    return Math.ceil(measured);
  };
  const sizeOf = (item: T): number => validSize(opts.sizeOf?.(item) ?? 0);

  const activeLength = (): number => buffer.length - head;

  const compact = (): void => {
    if (head === 0) return;
    if (head < 256 && head * 2 < buffer.length) return;
    buffer.splice(0, head);
    head = 0;
  };

  const removeAt = (index: number): void => {
    const [removed] = buffer.splice(index, 1);
    if (removed !== undefined) bufferedBytes -= removed.bytes;
  };

  const overLimit = (incomingBytes = 0, incomingCount = 0): boolean =>
    (maxBuffered > 0 && activeLength() + incomingCount > maxBuffered) ||
    (maxBufferedBytes > 0 && bufferedBytes + incomingBytes > maxBufferedBytes);

  const makeRoom = (item: T, bytes: number, incomingCount: number): boolean => {
    while (overLimit(bytes, incomingCount)) {
      const victim = buffer.findIndex((entry, index) => index >= head && isDroppable(entry.item));
      if (victim !== -1) {
        removeAt(victim);
        droppedCount += 1;
        compact();
        continue;
      }
      if (isDroppable(item)) {
        droppedCount += 1;
        return false;
      }
      const error = new Error(
        maxBufferedBytes > 0
          ? `event stream saturated with non-droppable items at ${maxBufferedBytes} buffered bytes`
          : `event stream saturated with ${maxBuffered} non-droppable items`,
      );
      try {
        opts.onSaturated?.(item);
      } finally {
        failed = true;
        failure = error;
        signal();
      }
      return false;
    }
    return true;
  };

  function iterator(): AsyncIterator<T> {
    let returned = false;
    let nextPending = false;
    const next = async (): Promise<IteratorResult<T>> => {
      if (nextPending) throw new Error("event stream supports only one pending next call");
      nextPending = true;
      try {
        for (;;) {
          if (returned) return { done: true, value: undefined };
          if (activeLength() > 0) {
            const entry = buffer[head++];
            if (entry === undefined) throw new Error("event stream buffer invariant violated");
            bufferedBytes -= entry.bytes;
            compact();
            return { done: false, value: entry.item };
          }
          if (failed) throw failure;
          if (closed) return { done: true, value: undefined };
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      } finally {
        nextPending = false;
      }
    };
    return {
      next,
      async return(): Promise<IteratorResult<T>> {
        returned = true;
        const notify = !closed && !failed && !abandoned;
        abandoned = true;
        buffer.length = 0;
        head = 0;
        bufferedBytes = 0;
        signal();
        if (notify) opts.onAbandoned?.();
        return { done: true, value: undefined };
      },
    };
  }

  return {
    push(item: T): void {
      if (closed || failed || abandoned) return;
      const incomingBytes = sizeOf(item);
      const tail = buffer.length - 1;
      const prev = tail >= head ? buffer[tail] : undefined;
      if (prev !== undefined && coalesce !== undefined) {
        const merged = coalesce(prev.item, item);
        if (merged !== undefined) {
          const mergedBytes =
            opts.sizeOfCoalesced === undefined
              ? sizeOf(merged)
              : validSize(opts.sizeOfCoalesced(prev.item, item, merged, prev.bytes, incomingBytes));
          removeAt(tail);
          if (!makeRoom(merged, mergedBytes, 1)) return;
          buffer.push({ item: merged, bytes: mergedBytes });
          bufferedBytes += mergedBytes;
          signal();
          return;
        }
      }
      if (!makeRoom(item, incomingBytes, 1)) return;
      buffer.push({ item, bytes: incomingBytes });
      bufferedBytes += incomingBytes;
      signal();
    },
    close(): void {
      if (abandoned) return;
      closed = true;
      signal();
    },
    fail(err: unknown): void {
      if (abandoned) return;
      failed = true;
      failure = err;
      signal();
    },
    dropped(): number {
      return droppedCount;
    },
    stats: () => ({
      bufferedItems: activeLength(),
      bufferedBytes,
      dropped: droppedCount,
    }),
    get iterable(): AsyncIterable<T> {
      return {
        [Symbol.asyncIterator]() {
          if (iteratorCreated) {
            throw new Error("event stream supports only one consumer");
          }
          iteratorCreated = true;
          return iterator();
        },
      };
    },
  };
}
