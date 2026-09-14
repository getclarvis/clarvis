/**
 * Identify a raster image format from its leading magic bytes.
 *
 * @param buf - the file bytes to inspect.
 * @returns the MIME type (`image/png`, `image/jpeg`, `image/gif`, or
 *   `image/webp`) when the signature matches, or `null` for anything else.
 * @remarks Detection is by header signature only - content is not validated,
 *   and formats without a signature here (e.g. BMP, TIFF, SVG) return `null`.
 */
export function sniffImageMime(buf: Buffer): string | null {
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buf.length >= 6 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validPng(buf: Buffer): boolean {
  let offset = 8;
  let chunks = 0;
  let hasImageData = false;
  while (offset <= buf.length - 12) {
    const length = buf.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > buf.length) return false;
    const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
    if (
      crc32(buf.subarray(offset + 4, offset + 8 + length)) !== buf.readUInt32BE(offset + 8 + length)
    )
      return false;
    if (chunks === 0 && (type !== "IHDR" || length !== 13)) return false;
    if (type === "IDAT") hasImageData = true;
    chunks += 1;
    offset = end;
    if (type === "IEND") return length === 0 && hasImageData && offset === buf.length;
  }
  return false;
}

/**
 * Reject image bytes whose recognized container is structurally corrupt.
 *
 * @remarks PNG validation walks the complete chunk stream and verifies every
 * CRC so a signature-only file cannot enter model history and poison later
 * provider calls. The other admitted formats retain their existing signature
 * contract until their decoders are owned here.
 */
export function imageBytesAreValid(buf: Buffer, mimeType: string): boolean {
  return mimeType !== "image/png" || validPng(buf);
}
