import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  type Dirent,
  type Dir,
  promises as fs,
} from "node:fs";

import { MemoryStorageLimitError, type MemoryStorageKind } from "./storage-limits.ts";

function boundedMaximum(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

export interface BoundedText {
  text: string;
  /** Bytes decoded into `text`. */
  bytes: number;
  /** The file had more bytes than were returned, or changed during the read. */
  truncated: boolean;
}

interface ReadOptions {
  maxBytes: number;
  kind: Extract<MemoryStorageKind, "document" | "revision body" | "metadata">;
  /** Return a prefix instead of throwing when the file is larger than `maxBytes`. */
  truncate?: boolean;
  /** Deterministic race injection for this internal helper's growth tests. */
  afterStat?: () => void | Promise<void>;
}

/**
 * Descriptor-backed UTF-8 read with a pre-allocation stat and one-byte growth
 * probe. Missing files return null; an oversized strict read throws before its
 * body is allocated.
 */
export async function readUtf8FileBounded(
  file: string,
  options: ReadOptions,
): Promise<BoundedText | null> {
  const maximum = boundedMaximum(options.maxBytes);
  let handle;
  try {
    handle = await fs.open(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      const error = new Error(`memory: path is not a regular file: ${file}`);
      error.name = "MemoryStorageReadError";
      throw error;
    }
    if (before.size > maximum && options.truncate !== true) {
      throw new MemoryStorageLimitError({
        kind: options.kind,
        identifier: file,
        actual: before.size,
        maximum,
      });
    }
    await options.afterStat?.();

    const wanted = Math.min(before.size, maximum);
    // One extra byte proves growth/overflow without following it into an
    // unbounded allocation. Empty files still need a one-byte probe.
    const buffer = Buffer.allocUnsafe(Math.max(1, wanted + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    const changed = after.size !== before.size;
    const oversized = before.size > maximum || offset > maximum;
    if ((changed || oversized) && options.truncate !== true) {
      const actual = Math.max(after.size, offset);
      if (actual > maximum) {
        throw new MemoryStorageLimitError({
          kind: options.kind,
          identifier: file,
          actual,
          maximum,
        });
      }
      throw new Error(`memory: file changed while it was being read: ${file}`);
    }
    const bytes = Math.min(offset, maximum);
    return {
      text: buffer.subarray(0, bytes).toString("utf8"),
      bytes,
      truncated: changed || before.size > maximum || offset > maximum,
    };
  } finally {
    await handle.close();
  }
}

/** Synchronous bounded prefix for the synchronous recording-policy API. */
export function readUtf8PrefixSync(file: string, maxBytes: number): string | undefined {
  const maximum = boundedMaximum(maxBytes);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, "r");
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) return undefined;
    const wanted = Math.min(stat.size, maximum);
    const buffer = Buffer.allocUnsafe(Math.max(1, wanted + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, Math.min(offset, maximum)).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {}
    }
  }
}

/** Stream no more than `maximum` directory entries, including ignored ones. */
export async function scanDirectoryBounded(
  directory: string,
  maximum: number,
  visit: (entry: Dirent) => void | boolean | Promise<void | boolean>,
): Promise<{ inspected: number; truncated: boolean }> {
  const bounded = boundedMaximum(maximum);
  let handle: Dir;
  try {
    handle = await fs.opendir(directory);
  } catch {
    return { inspected: 0, truncated: false };
  }
  let inspected = 0;
  let truncated = false;
  try {
    for await (const entry of handle) {
      inspected += 1;
      if (inspected > bounded) {
        truncated = true;
        break;
      }
      if ((await visit(entry)) === false) break;
    }
  } catch (error) {
    // Bun may defer ENOENT from opendir() to the first iterator read.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    await Promise.resolve(handle.close()).catch(() => undefined);
  }
  return { inspected, truncated };
}
