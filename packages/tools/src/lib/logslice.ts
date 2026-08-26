import { openReadHandle } from "./files.ts";

/** A byte-range slice of a log file plus the cursor to resume from (see {@link readLogSlice}). */
export interface LogSlice {
  /** The decoded text of this slice. */
  text: string;
  /** The byte offset to pass as the next `offset` to continue reading. */
  nextOffset: number;
  /** The file's total size in bytes at read time. */
  total: number;
  /** True when unread bytes remain past `nextOffset`. */
  more: boolean;
}

/**
 * Read up to `maxBytes` of a log file starting at `offset`, returning the text and
 * a cursor for the next read.
 *
 * @param logPath - the absolute path of the log file.
 * @param offset - the byte offset to start at; clamped to `[0, total]`.
 * @param maxBytes - the maximum number of bytes to read in this slice.
 * @returns a {@link LogSlice}; a missing file yields an empty slice with
 *   `total: 0`, and an offset at or past the end yields empty text with
 *   `more: false`.
 * @remarks When the read stops mid-file, a trailing partial UTF-8 sequence is
 *   trimmed so `text` decodes cleanly and `nextOffset` resumes exactly at the
 *   dropped byte; a slice whose entire window is one incomplete sequence keeps
 *   all bytes rather than returning nothing. Size and bytes come from one
 *   non-blocking regular-file descriptor, with no-follow semantics where the
 *   host supports them.
 */
export async function readLogSlice(
  logPath: string,
  offset: number,
  maxBytes: number,
): Promise<LogSlice> {
  let handle;
  try {
    handle = await openReadHandle(logPath, true);
  } catch {
    return { text: "", nextOffset: Math.max(0, offset), total: 0, more: false };
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return { text: "", nextOffset: Math.max(0, offset), total: 0, more: false };
    }
    const total = stat.size;
    const start = Math.min(Math.max(0, offset), total);
    const available = total - start;
    if (available <= 0) {
      return { text: "", nextOffset: start, total, more: false };
    }

    const want = Math.min(available, maxBytes);
    const buf = Buffer.alloc(want);
    const { bytesRead } = await handle.read(buf, 0, want, start);

    let consumed = bytesRead;
    const budgetCut = start + consumed < total;
    if (budgetCut && consumed > 0) {
      let i = consumed - 1;
      let cont = 0;
      while (i >= 0 && ((buf[i] ?? 0) & 0xc0) === 0x80) {
        i--;
        cont++;
      }
      if (i >= 0) {
        const lead = buf[i] ?? 0;
        let expected = 1;
        if ((lead & 0xe0) === 0xc0) expected = 2;
        else if ((lead & 0xf0) === 0xe0) expected = 3;
        else if ((lead & 0xf8) === 0xf0) expected = 4;
        if (cont + 1 < expected) consumed = i;
      }
      if (consumed === 0) consumed = bytesRead;
    }

    const text = buf.subarray(0, consumed).toString("utf8");
    const nextOffset = start + consumed;
    return { text, nextOffset, total, more: nextOffset < total };
  } finally {
    await handle.close();
  }
}
