/**
 * The per-child activity ring: a bounded, line-granular buffer over one child's
 * projected event stream, paged by absolute byte offsets.
 *
 * @remarks Line granularity is the load-bearing choice. Because a line is never
 * split, a page boundary can never land inside a UTF-8 sequence and there is no
 * partial-line hold-back to get wrong (which is the one piece of `monitor_poll`'s
 * contract this does *not* need to mirror). Offsets are absolute over everything
 * the child has ever emitted, not over what the ring currently holds, so they
 * stay monotonic across a head drop: dropping the oldest lines raises `head` and
 * never rewinds `tail`.
 */

import { AGENTS_MAX_BUFFER_BYTES, AGENTS_MAX_BUFFER_LINES } from "./settings.ts";

/** One page of a child's buffer, in the shape `agent_poll` reports. */
export interface AgentBufferRead {
  /** The retained lines in this page, newline-joined (no trailing newline). */
  text: string;
  /** Absolute offset to pass back to page forward. */
  nextOffset: number;
  /** True when content past `nextOffset` is still buffered. */
  more: boolean;
  /** Bytes the caller asked for that had already been dropped, `0` when none. */
  truncatedHead: number;
}

/** Bounds on one child's ring. */
export interface AgentBufferLimits {
  maxLines: number;
  maxBytes: number;
}

function finiteIntAtMost(value: number, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(0, Math.floor(value)));
}

/**
 * A bounded ring over one child's projected lines.
 */
export interface AgentBuffer {
  /** Append one projected line (without its newline). */
  append(line: string): void;
  /** Absolute offset of the oldest retained byte. */
  head(): number;
  /** Absolute offset one past the newest retained byte. */
  tail(): number;
  /**
   * Read a page starting at `offset`.
   *
   * @param match - when given, only matching lines appear in `text`; `nextOffset`
   *   still advances over the *unfiltered* cursor, so paging with a filter never
   *   skips the lines it hid. A `g`/`y`-flagged pattern is applied statelessly —
   *   its `lastIndex` is reset per line, or every other line would be skipped.
   */
  read(offset: number, maxBytes: number, match?: RegExp): AgentBufferRead;
  /** Stop accepting appends; existing content stays readable (D9). */
  freeze(): void;
}

/** One retained line and where it sits in the absolute stream. */
interface Line {
  text: string;
  /** Byte length including the trailing newline — the unit offsets count in. */
  bytes: number;
  start: number;
}

/**
 * Keep the newest `maxBytes` UTF-8 bytes without splitting a code point.
 *
 * @returns the retained tail and the number of text bytes dropped from its head.
 */
function retainUtf8Tail(text: string, maxBytes: number): { text: string; droppedBytes: number } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, droppedBytes: 0 };
  let start = Math.max(0, buf.length - maxBytes);
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start += 1;
  return { text: buf.subarray(start).toString("utf8"), droppedBytes: start };
}

/**
 * Truncate to at most `maxBytes` UTF-8 bytes without splitting a code point.
 *
 * @returns the truncated prefix; whole when it already fits.
 */
function truncateUtf8Prefix(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf8");
}

/**
 * Create a bounded, line-granular {@link AgentBuffer}.
 *
 * @param limits - the per-child ceilings; whichever binds first drops the oldest
 *   lines. The bound protects the *parent's* process, which is where a noisy
 *   child (a shell loop) would otherwise grow without limit.
 */
export function createAgentBuffer(limits: AgentBufferLimits): AgentBuffer {
  const maxLines = Math.max(
    1,
    finiteIntAtMost(limits.maxLines, AGENTS_MAX_BUFFER_LINES, AGENTS_MAX_BUFFER_LINES),
  );
  const maxBytes = finiteIntAtMost(limits.maxBytes, 0, AGENTS_MAX_BUFFER_BYTES);
  const lines: Array<Line | undefined> = [];
  let first = 0;
  let head = 0;
  let tail = 0;
  let held = 0;
  let frozen = false;

  const evict = (): void => {
    while (lines.length - first > maxLines || held > maxBytes) {
      const dropped = lines[first];
      if (dropped === undefined) break;
      lines[first] = undefined;
      first += 1;
      held -= dropped.bytes;
    }
    head = lines[first]?.start ?? tail;

    // A head index makes steady-state eviction O(1). Compact only
    // occasionally so dropped strings do not remain referenced and the backing
    // array itself cannot grow with the lifetime of a noisy child.
    if (first >= 1024 && first * 2 >= lines.length) {
      lines.splice(0, first);
      first = 0;
    }
  };

  return {
    append(line: string): void {
      if (frozen) return;
      const text = line.replace(/\n+$/, "");
      const originalTextBytes = Buffer.byteLength(text, "utf8");
      const originalBytes = originalTextBytes + 1;
      const originalStart = tail;
      tail += originalBytes;

      if (maxBytes === 0) {
        lines.length = 0;
        first = 0;
        held = 0;
        head = tail;
        return;
      }

      // The newline belongs to the absolute offset contract even though reads
      // omit it. Give the text the remaining budget and keep its newest tail;
      // a single oversized line can therefore never punch through maxBytes.
      const retained = retainUtf8Tail(text, Math.max(0, maxBytes - 1));
      const bytes = Buffer.byteLength(retained.text, "utf8") + 1;
      if (retained.droppedBytes > 0) {
        // Do not leave the dropped prefix as an interior hole behind an older
        // retained line. Clearing the older lines makes the new start the ring
        // head, so truncatedHead accounts for every unavailable byte.
        lines.length = 0;
        first = 0;
        held = 0;
      }
      lines.push({ text: retained.text, bytes, start: originalStart + retained.droppedBytes });
      held += bytes;
      evict();
    },
    head: () => head,
    tail: () => tail,
    read(offset: number, budget: number, match?: RegExp): AgentBufferRead {
      const want = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
      const cap = Math.max(1, finiteIntAtMost(budget, 1, 65_536));
      const from = Math.max(want, head);
      const truncatedHead = Math.max(0, head - want);
      let firstVisible = -1;
      for (let at = first; at < lines.length; at += 1) {
        const line = lines[at];
        if (line !== undefined && line.start >= from) {
          firstVisible = at;
          break;
        }
      }
      if (firstVisible === -1) {
        return { text: "", nextOffset: tail, more: false, truncatedHead };
      }

      const page: string[] = [];
      let spent = 0;
      let i = firstVisible;
      for (; i < lines.length; i += 1) {
        const line = lines[i]!;
        if (spent > 0 && spent + line.bytes > cap) break;
        page.push(spent === 0 && line.bytes > cap ? truncateUtf8Prefix(line.text, cap) : line.text);
        spent += line.bytes;
        if (spent >= cap) {
          i += 1;
          break;
        }
      }
      const nextOffset = i < lines.length ? lines[i]!.start : tail;
      const shown =
        match === undefined
          ? page
          : page.filter((l) => {
              match.lastIndex = 0;
              return match.test(l);
            });
      return { text: shown.join("\n"), nextOffset, more: nextOffset < tail, truncatedHead };
    },
    freeze(): void {
      frozen = true;
    },
  };
}
