import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { Logger } from "@clarvis/capability";
import { SkillError, fsError } from "./errors.ts";
import { closeQuietly } from "./lib/log.ts";

interface BoundedReadOptions {
  maxBytes: number;
  /** Complete-file cap when a smaller prefix allocation is requested. */
  maxFileBytes?: number;
  maxChars?: number;
  code: "invalid_skill" | "invalid_input";
  label: string;
  /** Receives a record when the descriptor cannot be closed after the read. */
  logger: Logger;
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
  return readFromFile(file, options, options.maxBytes);
}

/** Read a complete UTF-8 regular file behind byte and character bounds. */
export function readBoundedText(file: string, options: BoundedReadOptions): string {
  return readFromFile(file, options);
}

function readFromFile(file: string, options: BoundedReadOptions, prefixBytes?: number): string {
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
      const count = readSync(descriptor, buffer, offset, requested - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (prefixBytes === undefined) {
      const probe = Buffer.allocUnsafe(1);
      if (readSync(descriptor, probe, 0, 1, offset) !== 0) {
        throw new SkillError(
          options.code,
          `${options.label} '${file}' changed while it was being read`,
          { path: file },
        );
      }
    }
    const text = buffer.subarray(0, offset).toString("utf8");
    if (options.maxChars !== undefined && text.length > options.maxChars) {
      throw tooLarge(file, "characters", text.length, options.maxChars, options);
    }
    return text;
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
