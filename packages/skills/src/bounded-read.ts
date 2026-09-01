import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import type { Logger } from "@clarvis/capability";
import { SkillError, fsError } from "./errors.ts";
import { closeQuietly } from "./lib/log.ts";

export interface BoundedReadOptions {
  maxBytes: number;
  /** Complete-file cap when a smaller prefix allocation is requested. */
  maxFileBytes?: number;
  maxChars?: number;
  code: "invalid_skill" | "invalid_input";
  label: string;
  /** Receives a record when the descriptor cannot be closed after the read. */
  logger: Logger;
}

export type DescriptorReader = (
  descriptor: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
) => number;

/** One bounded page of a larger UTF-8 resource. */
export interface BoundedTextChunk {
  text: string;
  offset: number;
  nextOffset?: number;
  totalBytes: number;
}

/** Limits and cursor for {@link readBoundedTextChunk}. */
export interface BoundedTextChunkOptions extends BoundedReadOptions {
  offset: number;
  maxFileBytes: number;
  maxChars: number;
}

/** Exact raw-byte identity of one bounded regular file. */
export interface BoundedFileDigest {
  digest: string;
  bytes: number;
  mode: number;
}

function requireIntegerBound(
  value: number,
  minimum: number,
  field: string,
  options: Pick<BoundedReadOptions, "code" | "label">,
): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new SkillError(
      options.code,
      `${options.label} ${field} must be an integer of at least ${String(minimum)}`,
      { field, value },
    );
  }
}

function tooLarge(
  file: string,
  dimension: "bytes" | "characters",
  actual: number,
  maximum: number,
  options: BoundedReadOptions,
): SkillError {
  return new SkillError(
    options.code,
    `${options.label} '${file}' exceeds the maximum ${dimension} (${String(maximum)})`,
    { path: file, dimension, actual, maximum },
  );
}

/**
 * Read at most `maxBytes` from the beginning of a regular file after checking
 * its complete size. The fixed allocation and positional reads remain bounded
 * even if another process grows the file after `fstat`.
 */
export function readBoundedPrefix(file: string, options: BoundedReadOptions): string {
  return decodeBoundedText(file, readFromFile(file, options, options.maxBytes), options);
}

/**
 * Read a complete UTF-8 regular file behind byte and character bounds.
 *
 * @param file - regular file to read.
 * @param options - byte, character, diagnostic, and error bounds.
 * @param reader - positional descriptor reader; injectable for a deterministic concurrent-growth
 *   canary on hosts without procfs.
 */
export function readBoundedText(
  file: string,
  options: BoundedReadOptions,
  reader: DescriptorReader = readSync,
): string {
  return decodeBoundedText(file, readFromFile(file, options, undefined, reader), options);
}

function decodeBoundedText(file: string, bytes: Buffer, options: BoundedReadOptions): string {
  const text = bytes.toString("utf8");
  if (options.maxChars !== undefined && text.length > options.maxChars) {
    throw tooLarge(file, "characters", text.length, options.maxChars, options);
  }
  return text;
}

/**
 * Read complete regular-file bytes behind a descriptor-owned allocation bound.
 *
 * @param file - Regular file to read.
 * @param options - Complete-file byte bound and diagnostic classification.
 * @param reader - Positional descriptor reader; injectable for concurrent-change tests.
 * @returns The exact bytes read from the opened descriptor.
 */
export function readBoundedBytes(
  file: string,
  options: BoundedReadOptions,
  reader: DescriptorReader = readSync,
): Buffer {
  const bytes = readFromFile(file, options, undefined, reader);
  if (options.maxChars !== undefined) {
    const chars = bytes.toString("utf8").length;
    if (chars > options.maxChars) {
      throw tooLarge(file, "characters", chars, options.maxChars, options);
    }
  }
  return bytes;
}

/**
 * Read one UTF-8 page without allocating or decoding the complete resource.
 *
 * @remarks The cursor is a byte offset returned by the preceding page. An authored
 * cursor that starts inside a UTF-8 sequence is rejected, and the page ends only
 * after a complete sequence so chaining cursors never corrupts a character.
 */
export function readBoundedTextChunk(
  file: string,
  options: BoundedTextChunkOptions,
  reader: DescriptorReader = readSync,
): BoundedTextChunk {
  requireIntegerBound(options.offset, 0, "offset", options);
  requireIntegerBound(options.maxBytes, 4, "maxBytes", options);
  requireIntegerBound(options.maxFileBytes, 1, "maxFileBytes", options);
  requireIntegerBound(options.maxChars, 2, "maxChars", options);
  let descriptor: number | undefined;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    descriptor = openSync(
      realpathSync.native(file),
      constants.O_RDONLY | constants.O_NONBLOCK | noFollow,
    );
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new SkillError("not_a_file", `Path is not a regular file: ${file}`, { path: file });
    }
    if (stat.size > options.maxFileBytes) {
      throw tooLarge(file, "bytes", stat.size, options.maxFileBytes, options);
    }
    if (options.offset > stat.size) {
      throw new SkillError(
        options.code,
        `${options.label} '${file}' offset ${String(options.offset)} is past the end`,
        { path: file, offset: options.offset, total: stat.size },
      );
    }
    if (options.offset === stat.size) {
      const probe = Buffer.allocUnsafe(1);
      if (reader(descriptor, probe, 0, 1, stat.size) !== 0) {
        throw new SkillError(
          options.code,
          `${options.label} '${file}' changed while it was being read`,
          { path: file },
        );
      }
      return { text: "", offset: options.offset, totalBytes: stat.size };
    }
    const requested = Math.min(options.maxBytes, stat.size - options.offset);
    const buffer = Buffer.allocUnsafe(requested);
    let bytes = 0;
    while (bytes < requested) {
      const count = reader(descriptor, buffer, bytes, requested - bytes, options.offset + bytes);
      if (count === 0) break;
      bytes += count;
    }
    if (bytes !== requested) {
      throw new SkillError(
        options.code,
        `${options.label} '${file}' changed while it was being read`,
        { path: file },
      );
    }
    if ((buffer[0]! & 0xc0) === 0x80) {
      throw new SkillError(options.code, `${options.label} '${file}' has an invalid UTF-8 cursor`, {
        path: file,
        offset: options.offset,
      });
    }
    const reachesEnd = options.offset + requested === stat.size;
    let prefixBytes = requested;
    let decoded: string | undefined;
    for (let trim = 0; trim <= (reachesEnd ? 0 : 3); trim += 1) {
      try {
        decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          buffer.subarray(0, requested - trim),
        );
        prefixBytes = requested - trim;
        break;
      } catch {}
    }
    if (decoded === undefined) {
      throw new SkillError(options.code, `${options.label} '${file}' is not valid UTF-8`, {
        path: file,
      });
    }
    if (reachesEnd) {
      const probe = Buffer.allocUnsafe(1);
      if (reader(descriptor, probe, 0, 1, stat.size) !== 0) {
        throw new SkillError(
          options.code,
          `${options.label} '${file}' changed while it was being read`,
          { path: file },
        );
      }
    }
    let text = decoded.slice(0, options.maxChars);
    const tail = text.charCodeAt(text.length - 1);
    if (tail >= 0xd800 && tail <= 0xdbff) text = text.slice(0, -1);
    const consumedBytes =
      text.length === decoded.length ? prefixBytes : Buffer.byteLength(text, "utf8");
    const next = options.offset + consumedBytes;
    return {
      text,
      offset: options.offset,
      ...(next < stat.size ? { nextOffset: next } : {}),
      totalBytes: stat.size,
    };
  } catch (error) {
    if (error instanceof SkillError) throw error;
    throw fsError(error as NodeJS.ErrnoException, file);
  } finally {
    const opened = descriptor;
    if (opened !== undefined) {
      closeQuietly(
        () => {
          closeSync(opened);
        },
        options.logger,
        { path: file },
      );
    }
  }
}

/** Hash one regular file through a fixed buffer without decoding or retaining its contents. */
export function hashBoundedFile(
  file: string,
  options: Omit<BoundedReadOptions, "maxChars">,
  reader: DescriptorReader = readSync,
): BoundedFileDigest {
  requireIntegerBound(options.maxBytes, 1, "maxBytes", options);
  let descriptor: number | undefined;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    descriptor = openSync(
      realpathSync.native(file),
      constants.O_RDONLY | constants.O_NONBLOCK | noFollow,
    );
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new SkillError("not_a_file", `Path is not a regular file: ${file}`, { path: file });
    }
    if (stat.size > options.maxBytes) {
      throw tooLarge(file, "bytes", stat.size, options.maxBytes, options);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    for (;;) {
      const count = reader(descriptor, buffer, 0, buffer.length, bytes);
      if (count === 0) break;
      bytes += count;
      if (bytes > options.maxBytes) {
        throw tooLarge(file, "bytes", bytes, options.maxBytes, options);
      }
      hash.update(buffer.subarray(0, count));
    }
    if (bytes !== stat.size) {
      throw new SkillError(
        options.code,
        `${options.label} '${file}' changed while it was being read`,
        { path: file },
      );
    }
    return {
      digest: `sha256:${hash.digest("hex")}`,
      bytes,
      mode: stat.mode & 0o777,
    };
  } catch (error) {
    if (error instanceof SkillError) throw error;
    throw fsError(error as NodeJS.ErrnoException, file);
  } finally {
    const opened = descriptor;
    if (opened !== undefined) {
      closeQuietly(
        () => {
          closeSync(opened);
        },
        options.logger,
        { path: file },
      );
    }
  }
}

function readFromFile(
  file: string,
  options: BoundedReadOptions,
  prefixBytes?: number,
  reader: DescriptorReader = readSync,
): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, "r");
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new SkillError("not_a_file", `Path is not a regular file: ${file}`, { path: file });
    }
    const completeLimit = options.maxFileBytes ?? options.maxBytes;
    if (stat.size > completeLimit) {
      throw tooLarge(file, "bytes", stat.size, completeLimit, options);
    }

    const requested = Math.min(stat.size, prefixBytes ?? stat.size);
    const buffer = Buffer.allocUnsafe(requested);
    let offset = 0;
    while (offset < requested) {
      const count = reader(descriptor, buffer, offset, requested - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== requested) {
      throw new SkillError(
        options.code,
        `${options.label} '${file}' changed while it was being read`,
        { path: file },
      );
    }
    if (prefixBytes === undefined) {
      const probe = Buffer.allocUnsafe(1);
      if (reader(descriptor, probe, 0, 1, offset) !== 0) {
        throw new SkillError(
          options.code,
          `${options.label} '${file}' changed while it was being read`,
          { path: file },
        );
      }
    }
    return buffer;
  } catch (error) {
    if (error instanceof SkillError) throw error;
    throw fsError(error as NodeJS.ErrnoException, file);
  } finally {
    const opened = descriptor;
    if (opened !== undefined) {
      closeQuietly(
        () => {
          closeSync(opened);
        },
        options.logger,
        { path: file },
      );
    }
  }
}
