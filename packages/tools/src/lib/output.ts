import { promises as fs } from "node:fs";
import path from "node:path";
import { DIR_MODE, FILE_MODE } from "@clarvis/paths";
import { NOOP_TOOLS_LOGGER, type ToolsLogger } from "./log.ts";

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
 * @remarks This keeps the head; use {@link boundOrSpill} when the tail is the
 *   interesting part.
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
      pending += chunk;
      timer ??= setTimeout(flush, intervalMs);
    },
    settle(): void {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      flush();
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

function tailMarker(shownBytes: number, total: number, spillPath?: string): string {
  const where = spillPath !== undefined ? `; full output written to ${spillPath}` : "";
  return `[... earlier output truncated: last ${shownBytes} of ${total} bytes shown${where} ...]\n`;
}

/**
 * Take the trailing `maxBytes` of a buffer, moving the cut forward off any UTF-8
 * continuation byte so the result never opens mid-codepoint.
 *
 * @param buf - the bytes to take a tail of.
 * @param maxBytes - the maximum number of trailing bytes to keep.
 * @returns the decoded tail and how many bytes it actually spans.
 * @remarks Unlike {@link truncateTail} this also repairs a buffer whose *first*
 *   byte is already a continuation — the case a byte-trimmed ring buffer
 *   produces — because the scan runs even when the whole buffer fits.
 */
function bufferTail(buf: Buffer, maxBytes: number): { shown: string; shownBytes: number } {
  let start = Math.max(0, buf.length - maxBytes);
  while (start < buf.length && ((buf[start] ?? 0) & 0xc0) === 0x80) start++;
  return { shown: buf.subarray(start).toString("utf8"), shownBytes: buf.length - start };
}

/** The smallest tail a {@link CaptureSink} keeps resident once it starts spilling. */
export const CAPTURE_INLINE_FLOOR = 64 * 1024;

/**
 * An accumulator for one captured child stream that keeps only a bounded tail
 * resident once the output outgrows what any caller will read.
 *
 * @remarks Reported `bytes` is everything observed, not everything retained —
 *   it is the figure the truncation marker and the shared stdout/stderr budget
 *   are computed from.
 */
export interface CaptureSink {
  /** Append one decoded chunk; ignored once the sink has {@link CaptureSink.capped}. */
  push(chunk: string): void;
  /**
   * Settle the sink and render the inline result.
   *
   * @param budgetBytes - the byte share this stream may occupy inline; must not
   *   exceed the `inlineLimit` the sink was built with, or the retained tail
   *   cannot satisfy it.
   * @returns the text to report: unchanged when it fits, otherwise a marker
   *   (naming the spill file when one was written) followed by the tail.
   */
  finish(budgetBytes: number): Promise<string>;
  /**
   * Release the spill handle without producing a result.
   *
   * @remarks For the paths that abandon a capture rather than report it — a
   *   spawn that errors after output has already been observed reaches its
   *   rejection without ever calling {@link CaptureSink.finish}, and the handle
   *   would otherwise stay open for the life of the process. Idempotent, and
   *   safe to call after `finish`.
   */
  dispose(): Promise<void>;
  /** Total UTF-8 bytes observed, including any already written to the spill file. */
  readonly bytes: number;
  /** True once {@link bytes} passed the capture cap; further pushes are dropped. */
  readonly capped: boolean;
  /** Bytes currently held in memory — the sink's own bound, exposed for tests. */
  readonly residentBytes: number;
}

/**
 * Build a {@link CaptureSink} that holds small output in memory and switches to
 * writing straight through to a spill file once it grows past `inlineLimit`.
 *
 * @param opts - `inlineLimit` is the resident ceiling (and must be at least the
 *   largest `budgetBytes` {@link CaptureSink.finish} will be asked for);
 *   `captureCap` is the observed-byte ceiling past which the sink reports itself
 *   capped; `spill` is called at most once, lazily, to name the spill file.
 * @returns the sink.
 * @remarks Below `inlineLimit` this is byte-for-byte the old behaviour — the
 *   text is buffered whole and handed to {@link boundOrSpill}, so a small command
 *   still never touches the disk. Above it, the accumulated text is flushed to
 *   the file, every later chunk is appended to it, and memory holds only a
 *   trailing `inlineLimit` bytes. That is the whole point: the previous sink
 *   grew a JS string to the 8 MiB capture floor on *each* of the two streams in
 *   order to return at most 16 KiB, and the floor existed only so the spill file
 *   could be complete — a trade of RAM for completeness that write-through makes
 *   unnecessary, since the file is complete either way.
 *
 *   A failed spill degrades exactly as {@link boundOrSpill} does: the tail is
 *   still returned and the marker simply omits the file reference. Writes are
 *   serialized through a single handle and coalesced while one is in flight, so
 *   ordering is preserved and a fast producer cannot queue one buffer per chunk.
 *
 *   That queue is the one place residency is not bounded by `inlineLimit`:
 *   {@link CaptureSink.push} is driven from a stream `data` callback and cannot
 *   apply backpressure, so chunks pushed without yielding to the event loop pile
 *   up until a write drains them. A real child interleaves its chunks with I/O
 *   turns and the queue stays at roughly one chunk deep; a synchronous burst is
 *   bounded only by `captureCap`, which is where the old whole-string sink sat
 *   permanently. Dropping queued bytes instead would make the spill file
 *   incomplete, which is the one property it exists to have.
 */
export function createCaptureSink(opts: {
  inlineLimit: number;
  captureCap: number;
  spill: () => { absPath: string; displayPath: string };
  /** Which stream this sink backs, named in a spill-failure record. */
  stream?: string;
  /** Where a failed spill is reported; defaults to {@link NOOP_TOOLS_LOGGER}. */
  logger?: ToolsLogger;
}): CaptureSink {
  const { inlineLimit, captureCap } = opts;
  const logger = opts.logger ?? NOOP_TOOLS_LOGGER;
  let bytes = 0;
  let capped = false;
  let inline = "";
  let target: { absPath: string; displayPath: string } | undefined;
  let handle: fs.FileHandle | undefined;
  let failed = false;
  let tail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let pending: Buffer<ArrayBufferLike>[] = [];
  let draining: Promise<void> | undefined;

  const spillFailed = (cause: unknown): void => {
    logger.warn(
      {
        event: "tools.spill_failed",
        stream: opts.stream ?? "unknown",
        target: target?.displayPath ?? null,
        cause: cause instanceof Error ? cause.message : String(cause),
      },
      "the overflow of this stream could not be written; the tail is still returned but the truncation marker names no file",
    );
  };

  const drain = async (): Promise<void> => {
    while (pending.length > 0 && !failed) {
      const batch = pending.length === 1 ? pending[0]! : Buffer.concat(pending);
      pending = [];
      try {
        if (handle === undefined) {
          const dir = path.dirname(target!.absPath);
          await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
          handle = await fs.open(target!.absPath, "w", FILE_MODE);
        }
        await handle.write(batch);
      } catch (err) {
        failed = true;
        pending = [];
        spillFailed(err);
      }
    }
    draining = undefined;
  };

  const enqueue = (buf: Buffer): void => {
    if (failed) return;
    pending.push(buf);
    draining ??= drain();
  };

  const appendTail = (buf: Buffer): void => {
    const merged = tail.length === 0 ? buf : Buffer.concat([tail, buf]);
    tail =
      merged.length > inlineLimit
        ? Buffer.from(merged.subarray(merged.length - inlineLimit))
        : merged;
  };

  const closeHandle = async (): Promise<void> => {
    if (handle === undefined) return;
    const open = handle;
    handle = undefined;
    try {
      await open.close();
    } catch (err) {
      failed = true;
      spillFailed(err);
    }
  };

  return {
    push(chunk: string): void {
      if (capped || chunk === "") return;
      const buf = Buffer.from(chunk, "utf8");
      bytes += buf.length;
      if (target === undefined) {
        if (bytes <= inlineLimit) {
          inline += chunk;
        } else {
          target = opts.spill();
          const carried = Buffer.from(inline, "utf8");
          inline = "";
          enqueue(carried);
          enqueue(buf);
          appendTail(carried);
          appendTail(buf);
        }
      } else {
        enqueue(buf);
        appendTail(buf);
      }
      if (bytes > captureCap) capped = true;
    },
    async finish(budgetBytes: number): Promise<string> {
      if (target === undefined) {
        return boundOrSpill(inline, budgetBytes, opts.spill(), logger, opts.stream ?? "unknown");
      }
      await draining;
      await closeHandle();
      const { shown, shownBytes } = bufferTail(tail, budgetBytes);
      tail = Buffer.alloc(0);
      return tailMarker(shownBytes, bytes, failed ? undefined : target.displayPath) + shown;
    },
    async dispose(): Promise<void> {
      pending = [];
      await draining;
      await closeHandle();
      tail = Buffer.alloc(0);
      inline = "";
    },
    get bytes(): number {
      return bytes;
    },
    get capped(): boolean {
      return capped;
    },
    get residentBytes(): number {
      return (
        Buffer.byteLength(inline, "utf8") + tail.length + pending.reduce((n, b) => n + b.length, 0)
      );
    },
  };
}

/**
 * Cap `text` to its last `maxBytes`, first writing the full output to a spill file
 * so nothing is lost.
 *
 * @param text - the output to bound.
 * @param maxBytes - the maximum number of tail bytes to keep inline.
 * @param spill - `absPath` is where the full output is written; `displayPath` is
 *   the path named in the truncation marker.
 * @returns `text` unchanged when it fits, otherwise a marker (naming the spill
 *   file) followed by the trailing bytes, cut on a UTF-8 boundary.
 * @remarks This keeps the tail (the opposite of {@link bound}). The spill lands
 *   in the workspace's state tree under the user's global root, so it is outside
 *   every repository and needs no ignore rule to keep it out of a commit. If the
 *   spill write fails the marker simply omits the file reference and the tail is
 *   still returned.
 */
export async function boundOrSpill(
  text: string,
  maxBytes: number,
  spill: { absPath: string; displayPath: string },
  logger: ToolsLogger = NOOP_TOOLS_LOGGER,
  stream = "unknown",
): Promise<string> {
  const t = truncateTail(text, maxBytes);
  if (t === null) return text;

  try {
    const dir = path.dirname(spill.absPath);
    await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
    await fs.writeFile(spill.absPath, text, { encoding: "utf8", mode: FILE_MODE });
    return tailMarker(t.shownBytes, t.total, spill.displayPath) + t.shown;
  } catch (err) {
    logger.warn(
      {
        event: "tools.spill_failed",
        stream,
        target: spill.displayPath,
        cause: err instanceof Error ? err.message : String(err),
      },
      "the full output could not be written to its spill file; the tail is still returned but the truncation marker names no file",
    );
    return tailMarker(t.shownBytes, t.total) + t.shown;
  }
}
