import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** Read one regular-file snapshot without permitting a stat/read allocation race. */
export function readBoundedUtf8Sync(file: string, maxBytes: number): string {
  const fd = openSync(file, "r");
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error("not a regular file");
    if (info.size > maxBytes) throw new Error(`file exceeds ${String(maxBytes)} bytes`);
    const buffer = Buffer.allocUnsafe(Math.min(info.size + 1, maxBytes + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > maxBytes) throw new Error(`file exceeds ${String(maxBytes)} bytes`);
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
