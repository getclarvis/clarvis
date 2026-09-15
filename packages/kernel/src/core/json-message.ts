import type { Writable } from "node:stream";

/** Shared logical JSON bound, including envelopes, image data, context and trace records. */
export const MAX_JSON_MESSAGE_BYTES = 64 * 1024 * 1024;
/** Aggregate serialized messages retained by either transport direction. */
export const MAX_JSON_QUEUE_BYTES = 128 * 1024 * 1024;
const PART_BYTES = 256 * 1024;
const TRANSFER_TIMEOUT_MS = 30_000;

/** Local refusal before any bytes are queued; it does not invalidate the connection. */
export class MessageAdmissionError extends Error {
  constructor(
    readonly code: "invalid_request" | "resource_exhausted",
    message: string,
  ) {
    super(message);
    this.name = "MessageAdmissionError";
  }
}

/** Reassembles one contiguous fragmented message per direction with an absolute deadline. */
export class JsonMessageDecoder {
  private assembly: Buffer | undefined;
  private offset = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly onTimeout: (error: Error) => void) {}

  /** Returns a complete JSON value, or undefined until all canonical fragments arrive. */
  accept(value: unknown, bytes: number): { value: unknown; bytes: number } | undefined {
    const record =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    if (record === undefined || !Object.hasOwn(record, "$clarvis_message")) {
      if (this.assembly !== undefined) throw new Error("interleaved JSON message transfer");
      if (bytes > MAX_JSON_MESSAGE_BYTES) throw new Error("JSON message exceeds size bound");
      return { value, bytes };
    }
    const part = record.$clarvis_message;
    if (
      Object.keys(record).length !== 1 ||
      typeof part !== "object" ||
      part === null ||
      Array.isArray(part)
    )
      throw new Error("invalid JSON message fragment");
    const fields = part as Record<string, unknown>;
    const total = fields.bytes;
    if (
      Object.keys(fields).length !== 3 ||
      !Number.isSafeInteger(total) ||
      (total as number) < 1 ||
      (total as number) > MAX_JSON_MESSAGE_BYTES ||
      fields.offset !== this.offset ||
      typeof fields.data !== "string" ||
      fields.data.length > Math.ceil(PART_BYTES / 3) * 4
    )
      throw new Error("invalid JSON message fragment bounds");
    const data = Buffer.from(fields.data, "base64");
    if (
      data.length !== Math.min(PART_BYTES, (total as number) - this.offset) ||
      data.toString("base64") !== fields.data
    )
      throw new Error("invalid JSON message fragment data");
    if (this.assembly === undefined) {
      this.assembly = Buffer.allocUnsafe(total as number);
      this.timer = setTimeout(() => {
        this.close();
        this.onTimeout(new Error("JSON message transfer timed out"));
      }, TRANSFER_TIMEOUT_MS);
      this.timer.unref?.();
    }
    if (total !== this.assembly.length) throw new Error("JSON message transfer size changed");
    data.copy(this.assembly, this.offset);
    this.offset += data.length;
    if (this.offset !== total) return undefined;
    const complete = this.assembly;
    this.close();
    return {
      value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(complete)),
      bytes: complete.length,
    };
  }

  /** Release partial content and its deadline on every connection teardown. */
  close(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.assembly = undefined;
    this.offset = 0;
  }
}

export interface JsonMessageWriter {
  /** Synchronously reserves a complete message or throws MessageAdmissionError before writing. */
  send(value: unknown): Promise<void>;
  /** Wait for already admitted messages; useful for a bounded refusal response. */
  drain(): Promise<void>;
  close(): void;
}

/** Serialize entire logical messages without interleaving their bounded physical fragments. */
export function createJsonMessageWriter(options: {
  readonly output: Writable;
  readonly frameBytes: number;
  readonly queueMessages: number;
  readonly onFailure: (error: Error) => void;
}): JsonMessageWriter {
  let tail = Promise.resolve();
  let count = 0;
  let retainedBytes = 0;
  let closed = false;
  let failure: Error | undefined;
  const fail = (error: Error): void => {
    if (failure !== undefined) return;
    failure = error;
    options.onFailure(error);
  };
  return {
    send(value): Promise<void> {
      if (closed || failure !== undefined)
        throw failure ?? new Error("JSON message writer is closed");
      let json: string;
      try {
        json = JSON.stringify(value);
        if (typeof json !== "string") throw new Error("missing JSON value");
      } catch {
        throw new MessageAdmissionError("invalid_request", "message is not serializable");
      }
      const bytes = Buffer.byteLength(json, "utf8");
      if (bytes > MAX_JSON_MESSAGE_BYTES) {
        throw new MessageAdmissionError(
          "resource_exhausted",
          `JSON message exceeds ${MAX_JSON_MESSAGE_BYTES} bytes`,
        );
      }
      if (count >= options.queueMessages || retainedBytes + bytes > MAX_JSON_QUEUE_BYTES) {
        throw new MessageAdmissionError(
          "resource_exhausted",
          "JSON message writer backpressure queue is full",
        );
      }
      count += 1;
      retainedBytes += bytes;
      const write = tail
        .then(async () => {
          if (closed || failure !== undefined)
            throw failure ?? new Error("JSON message writer is closed");
          const deadline = Date.now() + TRANSFER_TIMEOUT_MS;
          const writeLine = (line: string): Promise<void> =>
            new Promise((resolve, reject) => {
              if (closed || failure !== undefined) {
                reject(failure ?? new Error("JSON message writer is closed"));
                return;
              }
              const timer = setTimeout(
                () => reject(new Error("JSON message writer stalled")),
                Math.max(1, deadline - Date.now()),
              );
              timer.unref?.();
              options.output.write(line, (error?: Error | null) => {
                clearTimeout(timer);
                if (error !== undefined && error !== null) reject(error);
                else resolve();
              });
            });
          if (bytes + 1 <= options.frameBytes) {
            await writeLine(`${json}\n`);
          } else {
            const data = Buffer.from(json, "utf8");
            for (let offset = 0; offset < data.length; offset += PART_BYTES) {
              await writeLine(
                `${JSON.stringify({ $clarvis_message: { offset, bytes, data: data.subarray(offset, offset + PART_BYTES).toString("base64") } })}\n`,
              );
            }
          }
        })
        .finally(() => {
          count -= 1;
          retainedBytes -= bytes;
        });
      tail = write.catch((error: unknown) =>
        fail(error instanceof Error ? error : new Error("JSON message write failed")),
      );
      return write;
    },
    drain: () => tail,
    close: () => {
      closed = true;
    },
  };
}
