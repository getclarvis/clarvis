import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";
import { allocateShortTemporaryRoot } from "@clarvis/paths";
import { ToolError } from "../errors.ts";
import type { RuntimeConfig } from "../config.ts";
import type { OutputSlice } from "./session-window.ts";

/** Output retained independently of the size of model-facing pages. */
export interface SessionLogStream {
  readonly totalBytes: number;
  push(text: string): void;
  read(offset: number, limit: number): OutputSlice;
}

/** Private run-owned archive; disposal is allowed only after capture stops. */
export interface SessionLog {
  readonly stdout: SessionLogStream;
  readonly stderr: SessionLogStream;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  dispose(): void;
}

const LOG_CAPACITY = 16 * 1024 * 1024;

/** A capped plain-text log that preserves early diagnostics and UTF-8 pages. */
class FileLogStream implements SessionLogStream {
  totalBytes = 0;
  private saturated = false;

  constructor(
    private readonly fd: number,
    private readonly capacity: number,
  ) {}

  push(text: string): void {
    if (this.saturated) return;
    const bytes = Buffer.from(text, "utf8");
    let length = Math.min(bytes.length, this.capacity - this.totalBytes);
    while (length > 0 && length < bytes.length && (bytes[length]! & 0xc0) === 0x80) length--;
    this.saturated = length < bytes.length;
    let offset = 0;
    while (offset < length) {
      const written = writeSync(this.fd, bytes, offset, length - offset, this.totalBytes + offset);
      if (written === 0) throw new Error("Session log write made no progress");
      offset += written;
    }
    this.totalBytes += length;
  }

  read(offset: number, limit: number): OutputSlice {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.totalBytes)
      throw new ToolError("invalid_input", "Invalid session output cursor");
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new ToolError("invalid_input", "Invalid session output limit");
    const first = offset;
    const bytes = Buffer.alloc(Math.min(this.totalBytes - first, limit + 4));
    let copied = 0;
    while (copied < bytes.length) {
      const position = first + copied;
      const count = readSync(this.fd, bytes, copied, bytes.length - copied, position);
      if (count === 0) throw new Error("Session log read made no progress");
      copied += count;
    }
    let start = 0;
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
    let end = Math.min(bytes.length, start + limit);
    while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    if (end === start && start < bytes.length) {
      end++;
      while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end++;
    }
    return {
      text: bytes.subarray(start, end).toString("utf8"),
      nextOffset: first + end,
      omittedBefore: first + start - offset,
      more: first + end < this.totalBytes,
    };
  }
}

/** Allocate two private bounded logs, never accepting a caller-supplied path. */
export function createSessionLog(
  logger: RuntimeConfig["logger"],
  capacity = LOG_CAPACITY,
): SessionLog {
  const root = allocateShortTemporaryRoot({ label: "shell-session-log", logger });
  const descriptors = new Set<number>();
  const dispose = () => {
    for (const fd of descriptors) {
      closeSync(fd);
      descriptors.delete(fd);
    }
    root.remove();
  };
  try {
    const stream = (name: string) => {
      const fd = openSync(join(root.path, name), "wx+", 0o600);
      descriptors.add(fd);
      return new FileLogStream(fd, capacity);
    };
    return {
      stdout: stream("stdout.log"),
      stderr: stream("stderr.log"),
      stdoutPath: join(root.path, "stdout.log"),
      stderrPath: join(root.path, "stderr.log"),
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
