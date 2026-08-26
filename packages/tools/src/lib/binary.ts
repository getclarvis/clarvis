/** Number of bytes scanned from each end of the buffer when sniffing for NULs. */
const SCAN_BYTES = 8000;

/**
 * Heuristically decide whether a buffer holds binary (non-text) data by looking
 * for a NUL byte.
 *
 * @param buf - the file bytes to inspect.
 * @returns `true` if any NUL byte is found, which text files never contain.
 * @remarks Only the first and last {@link SCAN_BYTES} of a large buffer are
 *   scanned, so a NUL buried in the middle of a file larger than twice that
 *   window is not detected. This keeps the check O(1) on file size.
 */
export function isBinary(buf: Buffer): boolean {
  const head = Math.min(buf.length, SCAN_BYTES);
  for (let i = 0; i < head; i++) {
    if (buf[i] === 0) return true;
  }
  if (buf.length > SCAN_BYTES) {
    for (let i = Math.max(head, buf.length - SCAN_BYTES); i < buf.length; i++) {
      if (buf[i] === 0) return true;
    }
  }
  return false;
}

/**
 * Detect a UTF-16 byte-order mark at the start of a buffer.
 *
 * @param buf - the file bytes to inspect.
 * @returns `true` for a little-endian (`FF FE`) or big-endian (`FE FF`) BOM.
 * @remarks A UTF-16 file is full of NUL bytes and so reads as binary to
 *   {@link isBinary}; this lets callers recognize and decode it as text instead.
 */
export function isUtf16Bom(buf: Buffer): boolean {
  return (
    buf.length >= 2 &&
    ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))
  );
}
