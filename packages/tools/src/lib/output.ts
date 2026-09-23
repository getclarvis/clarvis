function cutPoint(buf: Buffer, maxBytes: number): number {
  let end = maxBytes;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return end;
}

function truncate(
  text: string,
  maxBytes: number,
): { shown: string; end: number; total: number } | null {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return null;
  const end = cutPoint(buf, maxBytes);
  return { shown: buf.subarray(0, end).toString("utf8"), end, total: buf.length };
}

function truncateTail(
  text: string,
  maxBytes: number,
): { shown: string; shownBytes: number; total: number } | null {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return null;
  let start = buf.length - maxBytes;
  while (start < buf.length && ((buf[start] ?? 0) & 0xc0) === 0x80) start++;
  return {
    shown: buf.subarray(start).toString("utf8"),
    shownBytes: buf.length - start,
    total: buf.length,
  };
}

function truncationMarker(end: number, total: number): string {
  return `\n[... output truncated: ${end} of ${total} bytes shown ...]`;
}

/**
 * Cap `text` to a byte ceiling, appending a marker that notes how much was cut.
 *
 * @param text - the output to bound.
 * @param maxBytes - the maximum number of head bytes to keep.
 * @returns `text` unchanged when it fits, otherwise its leading bytes (cut on a
 *   UTF-8 boundary) followed by a truncation marker.
 * @remarks This keeps the head; session output has its own bounded byte window.
 */
export function bound(text: string, maxBytes: number): string {
  const t = truncate(text, maxBytes);
  if (t === null) return text;
  return t.shown + truncationMarker(t.end, t.total);
}

const OUTPUT_COALESCE_INTERVAL_MS = 200;
const MAX_COALESCED_FLUSH_BYTES = 8192;

/** A sink that batches pushed output and flushes it on an interval; see {@link createOutputCoalescer}. */
export interface OutputCoalescer {
  /** Append a chunk to the pending batch; no-op once {@link OutputCoalescer.settle} has run. */
  push(chunk: string): void;
  /** Flush the pending tail synchronously; later pushes are ignored. */
  settle(): void;
  /** Pending UTF-8 bytes, exposed to verify the live-output memory bound. */
  readonly residentBytes: number;
}

/**
 * Batches a live output stream into at most one emit per interval, so a chatty
 * producer cannot flood the event channel. An oversized batch keeps only its
 * tail (the consumer renders a tail anyway), and emit errors never propagate
 * back into the producer.
 *
 * @param emit - the callback invoked with each coalesced chunk.
 * @param intervalMs - the minimum gap between emits (default 200ms).
 * @returns an {@link OutputCoalescer}; `push` accumulates, `settle` flushes the
 *   final tail synchronously and disables further pushes.
 * @remarks A batch exceeding `MAX_COALESCED_FLUSH_BYTES` is trimmed to its tail
 *   on a UTF-8 boundary, and any throw from `emit` is swallowed.
 */
export function createOutputCoalescer(
  emit: (chunk: string) => void,
  intervalMs: number = OUTPUT_COALESCE_INTERVAL_MS,
): OutputCoalescer {
  let pending = "";
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = (): void => {
    timer = undefined;
    if (pending === "") return;
    const t = truncateTail(pending, MAX_COALESCED_FLUSH_BYTES);
    const chunk = t === null ? pending : t.shown;
    pending = "";
    try {
      emit(chunk);
    } catch {}
  };

  return {
    push(chunk: string): void {
      if (settled || chunk === "") return;
      const next = pending + chunk;
      pending = truncateTail(next, MAX_COALESCED_FLUSH_BYTES)?.shown ?? next;
      timer ??= setTimeout(flush, intervalMs);
    },
    settle(): void {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      flush();
    },
    get residentBytes(): number {
      return Buffer.byteLength(pending, "utf8");
    },
  };
}

/**
 * Split a shared byte budget between two streams, favoring an even split only
 * when both would otherwise overflow.
 *
 * @param aBytes - the first stream's desired size.
 * @param bBytes - the second stream's desired size.
 * @param total - the combined budget to stay within.
 * @returns a `[a, b]` allocation whose sum never exceeds `total`.
 * @remarks If both fit, each keeps its full size. Otherwise the smaller stream is
 *   granted in full and the other takes the remainder; if both exceed half, each
 *   gets half (with the odd byte going to the first).
 */
export function allocateBudget(aBytes: number, bBytes: number, total: number): [number, number] {
  if (aBytes + bBytes <= total) return [aBytes, bBytes];
  const half = Math.floor(total / 2);
  if (aBytes <= half) return [aBytes, total - aBytes];
  if (bBytes <= half) return [total - bBytes, bBytes];
  return [total - half, half];
}
