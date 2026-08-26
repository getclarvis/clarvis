import type { Readable, Writable } from "node:stream";
import { NOOP_LOGGER, sanitizeDeep, sanitizeErrorMessage, type Logger } from "@clarvis/capability";
import type { KernelError, KernelErrorCode, KernelTransport } from "@clarvis/protocol";
import { boundJsonValue } from "../core/bounded-json.ts";
import type { KernelServer } from "./server.ts";

/** A {@link KernelError} flattened into a JSON-safe shape for the `res` frame. */
interface ErrorEnvelope {
  code: KernelErrorCode;
  message: string;
  details?: unknown;
}
/** A request frame: a client call awaiting a matching `res` with the same {@link ReqFrame.id | id}. */
interface ReqFrame {
  t: "req";
  id: number;
  method: string;
  params?: unknown;
}
/** A response frame: carries either a `result` or an `error`, keyed to its request `id`. */
interface ResFrame {
  t: "res";
  id: number;
  result?: unknown;
  error?: ErrorEnvelope;
}
/** A notification frame: a one-way server→client push, with no `id` and no response. */
interface NoteFrame {
  t: "note";
  method: string;
  params?: unknown;
}
/** Cancels one in-flight request without closing the connection. */
interface CancelFrame {
  t: "cancel";
  id: number;
}
/** The frame shapes carried over the newline-delimited JSON wire. */
type Frame = ReqFrame | ResFrame | NoteFrame | CancelFrame;

/** Maximum bytes in one newline-delimited frame (large enough for inline images). */
export const MAX_WIRE_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_WRITER_QUEUE_FRAMES = 1_024;
const MAX_WRITER_QUEUE_BYTES = 16 * 1024 * 1024;
const WRITER_TIMEOUT_MS = 30_000;
const MAX_ERROR_MESSAGE_CHARS = 16_384;
const MAX_ERROR_DETAILS_BYTES = 64 * 1024;
const MAX_CLASSIFICATION_VALUE_CHARS = 1_024;
const ERROR_CODE_MEMBERS = {
  unauthorized: true,
  not_found: true,
  invalid_request: true,
  conflict: true,
  unavailable: true,
  unsupported: true,
  cancelled: true,
  capability_disabled: true,
  continuation_unavailable: true,
  resource_exhausted: true,
  internal: true,
} satisfies Record<KernelErrorCode, true>;
const ERROR_CODES = new Set<KernelErrorCode>(Object.keys(ERROR_CODE_MEMBERS) as KernelErrorCode[]);

// eslint-disable-next-line no-control-regex -- the wire is a terminal-facing trust boundary.
const ANSI_ESCAPE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/gu;
// eslint-disable-next-line no-control-regex -- preserve ordinary whitespace, remove terminal controls.
const TERMINAL_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

function terminalSafe(text: string): string {
  return sanitizeErrorMessage(text).replace(ANSI_ESCAPE, "").replace(TERMINAL_CONTROL, "");
}

const PRESERVED_ERROR_STRING_DETAILS = [
  "task_code",
  "memory_code",
  "current_revision",
  "expectedRevision",
  "actualRevision",
] as const;

/** Keep small machine classifications available when the diagnostic body is truncated. */
function preservedErrorDetails(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const preserved: Record<string, unknown> = {};
  try {
    const outcome = Object.getOwnPropertyDescriptor(value, "outcome_unknown");
    if (outcome !== undefined && "value" in outcome && typeof outcome.value === "boolean") {
      preserved.outcome_unknown = outcome.value;
    }
    for (const key of PRESERVED_ERROR_STRING_DETAILS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "string"
      ) {
        continue;
      }
      preserved[key] = terminalSafe(descriptor.value).slice(0, MAX_CLASSIFICATION_VALUE_CHARS);
    }
  } catch {
    return {};
  }
  return preserved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnly(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function validId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validMethod(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

/** Strict runtime decoder for the untrusted NDJSON boundary. */
export function decodeFrame(value: unknown): Frame | null {
  if (!isRecord(value) || typeof value.t !== "string") return null;
  if (value.t === "req") {
    return hasOnly(value, ["t", "id", "method", "params"]) &&
      validId(value.id) &&
      validMethod(value.method)
      ? (value as unknown as ReqFrame)
      : null;
  }
  if (value.t === "cancel") {
    return hasOnly(value, ["t", "id"]) && validId(value.id)
      ? (value as unknown as CancelFrame)
      : null;
  }
  if (value.t === "note") {
    return hasOnly(value, ["t", "method", "params"]) && validMethod(value.method)
      ? (value as unknown as NoteFrame)
      : null;
  }
  if (value.t !== "res" || !hasOnly(value, ["t", "id", "result", "error"]) || !validId(value.id)) {
    return null;
  }
  const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
  const hasError = Object.prototype.hasOwnProperty.call(value, "error");
  if (hasResult === hasError) return null;
  if (!hasError) return value as unknown as ResFrame;
  if (
    !isRecord(value.error) ||
    !hasOnly(value.error, ["code", "message", "details"]) ||
    !ERROR_CODES.has(value.error.code as KernelErrorCode) ||
    typeof value.error.message !== "string" ||
    value.error.message.length > 16_384
  ) {
    return null;
  }
  return value as unknown as ResFrame;
}

/**
 * Read newline-delimited JSON frames off `input`, invoking `onFrame` per frame.
 *
 * @remarks Reassembles across chunk boundaries with an internal buffer. Blank
 *   lines are ignored; malformed, oversized, or structurally invalid frames
 *   terminate the connection so an untrusted peer cannot desynchronize it.
 */
function readFrames(
  input: Readable,
  onFrame: (frame: Frame) => void,
  onInvalid: (error: Error) => void,
  logger: Logger,
): void {
  let buffer = "";
  let bufferBytes = 0;
  let invalid = false;
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    if (invalid) return;
    buffer += chunk;
    bufferBytes += Buffer.byteLength(chunk, "utf8");
    if (bufferBytes > MAX_WIRE_FRAME_BYTES && !buffer.includes("\n")) {
      invalid = true;
      reportFrameDropped(logger, "inbound", "oversize_unterminated", bufferBytes);
      onInvalid(new Error(`wire frame exceeds ${MAX_WIRE_FRAME_BYTES} bytes`));
      return;
    }
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const lineBytes = Buffer.byteLength(line, "utf8");
      bufferBytes -= lineBytes + 1;
      if (line.trim().length === 0) continue;
      if (lineBytes > MAX_WIRE_FRAME_BYTES) {
        invalid = true;
        reportFrameDropped(logger, "inbound", "oversize", lineBytes);
        onInvalid(new Error(`wire frame exceeds ${MAX_WIRE_FRAME_BYTES} bytes`));
        return;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(line) as unknown;
      } catch {
        invalid = true;
        reportFrameDropped(logger, "inbound", "invalid_json", lineBytes);
        onInvalid(new Error("wire frame is not valid JSON"));
        return;
      }
      const frame = decodeFrame(decoded);
      if (frame === null) {
        invalid = true;
        reportFrameDropped(logger, "inbound", "invalid_shape", lineBytes);
        onInvalid(new Error("wire frame has an invalid shape"));
        return;
      }
      onFrame(frame);
    }
  });
}

/**
 * Report a wire frame that never crossed the transport.
 *
 * @param logger - the transport component's logger.
 * @param direction - `inbound` for a frame this process refused to read,
 *   `outbound` for one it refused to write.
 * @param reason - the specific bound that was hit.
 * @param bytes - the frame's size, or the buffered size for an unterminated one.
 * @remarks Every one of these also terminates the connection, so the peer sees
 *   *something*. What it never sees is which of five bounds was hit, and on the
 *   outbound side neither does the caller — a saturated writer rejects one
 *   `send` with a sentence nobody reads.
 */
function reportFrameDropped(
  logger: Logger,
  direction: "inbound" | "outbound",
  reason: string,
  bytes: number,
): void {
  logger.warn(
    { event: "transport.frame_dropped", direction, reason, bytes },
    "a wire frame was refused and the connection is terminating; in-flight requests settle as unavailable",
  );
}

interface FrameWriter {
  send(frame: Frame): Promise<void>;
  close(): void;
}

/**
 * Serialize writes in order and wait for the writable callback as backpressure.
 *
 * @remarks Each caller receives its own write failure while the internal tail
 * settles either outcome, allowing later queued sends to make progress.
 */
function createFrameWriter(
  output: Writable,
  onFailure: (error: Error) => void,
  logger: Logger,
): FrameWriter {
  let tail = Promise.resolve();
  let queuedFrames = 0;
  let queuedBytes = 0;
  let closed = false;
  let failure: Error | undefined;
  const closedError = new Error("wire writer is closed");

  const fail = (error: Error): void => {
    if (failure !== undefined) return;
    failure = error;
    onFailure(error);
  };

  return {
    send(frame): Promise<void> {
      if (closed) return Promise.reject(closedError);
      if (failure !== undefined) return Promise.reject(failure);
      let line: string;
      try {
        line = `${JSON.stringify(frame)}\n`;
      } catch (error) {
        const serializationError =
          error instanceof Error ? error : new Error("wire frame serialization failed");
        reportFrameDropped(logger, "outbound", "serialization", 0);
        fail(serializationError);
        return Promise.reject(serializationError);
      }
      const bytes = Buffer.byteLength(line, "utf8");
      if (bytes > MAX_WIRE_FRAME_BYTES) {
        const error = new Error(`wire frame exceeds ${MAX_WIRE_FRAME_BYTES} bytes`);
        reportFrameDropped(logger, "outbound", "oversize", bytes);
        fail(error);
        return Promise.reject(error);
      }
      if (queuedFrames >= MAX_WRITER_QUEUE_FRAMES || queuedBytes + bytes > MAX_WRITER_QUEUE_BYTES) {
        const error = new Error("wire writer backpressure queue is full");
        reportFrameDropped(logger, "outbound", "queue_full", bytes);
        fail(error);
        return Promise.reject(error);
      }
      queuedFrames += 1;
      queuedBytes += bytes;
      const write = tail.then(
        () =>
          new Promise<void>((resolve, reject) => {
            if (closed) {
              reject(closedError);
              return;
            }
            if (failure !== undefined) {
              reject(failure);
              return;
            }
            const timer = setTimeout(() => {
              const error = new Error(`wire writer stalled for ${WRITER_TIMEOUT_MS}ms`);
              fail(error);
              reject(error);
            }, WRITER_TIMEOUT_MS);
            timer.unref?.();
            output.write(line, (error?: Error | null) => {
              clearTimeout(timer);
              if (error !== undefined && error !== null) {
                fail(error);
                reject(error);
              } else resolve();
            });
          }),
      );
      tail = write.then(
        () => undefined,
        () => undefined,
      );
      return write.finally(() => {
        queuedFrames -= 1;
        queuedBytes -= bytes;
      });
    },
    close(): void {
      closed = true;
    },
  };
}

/** Convert arbitrary details to a bounded, redacted JSON value or omit them. */
function safeErrorDetails(value: unknown): unknown {
  try {
    const preserved = preservedErrorDetails(value);
    const bounded = boundJsonValue(value, {
      maxDepth: 16,
      maxNodes: 1_024,
      maxChars: MAX_ERROR_DETAILS_BYTES,
      transformKey: terminalSafe,
    });
    const sanitized = sanitizeDeep(bounded.value, terminalSafe);
    if (
      bounded.truncated ||
      Buffer.byteLength(JSON.stringify(sanitized), "utf8") > MAX_ERROR_DETAILS_BYTES
    ) {
      return { ...preserved, truncated: true };
    }
    return sanitized;
  } catch {
    return undefined;
  }
}

/** Flatten any thrown value into an {@link ErrorEnvelope}, defaulting the code to `internal`. */
function toEnvelope(err: unknown): ErrorEnvelope {
  const e = err as Partial<KernelError> & { message?: string };
  const rawMessage = typeof e.message === "string" ? e.message : String(err);
  const details = e.details === undefined ? undefined : safeErrorDetails(e.details);
  return {
    code: e.code !== undefined && ERROR_CODES.has(e.code) ? e.code : "internal",
    message: terminalSafe(rawMessage).slice(0, MAX_ERROR_MESSAGE_CHARS),
    ...(details === undefined ? {} : { details }),
  };
}

/** Rebuild a rejectable {@link KernelError} (an `Error` carrying `code`/`details`) from an envelope. */
function fromEnvelope(env: ErrorEnvelope): Error & KernelError {
  const err = new Error(env.message) as Error & { code: KernelErrorCode; details?: unknown };
  err.code = env.code;
  if (env.details !== undefined) err.details = env.details;
  return err;
}

/**
 * Build a client-side {@link KernelTransport} over a pair of streams carrying
 * newline-delimited JSON frames (`req` / `res` / `note`).
 *
 * @param io - the duplex stream pair to speak over: `input` is read for `res` and
 *   `note` frames, `output` is written with `req` frames.
 * @returns a {@link KernelTransport} the client programs against — the swap-in for
 *   a hosted kernel, where the same client code runs unchanged over a real pipe.
 * @remarks Requests are matched to responses by a monotonic sequence id; a `res`
 *   with an `error` rejects the pending promise with a rebuilt
 *   {@link KernelError}. Input EOF, an input error, or an output error all
 *   terminate the transport once: every pending request rejects with
 *   `unavailable` and every `onClose` listener fires. After close, `request`
 *   rejects immediately and `notify` is a no-op.
 */
export function createStdioTransport(
  io: { input: Readable; output: Writable },
  logger: Logger = NOOP_LOGGER,
): KernelTransport {
  let seq = 0;
  let closed = false;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void; offAbort: () => void }
  >();
  const handlers = new Map<string, ((params: unknown) => void)[]>();
  const closeHandlers = new Set<(reason?: unknown) => void>();
  const terminate = (reason?: unknown): void => {
    if (closed) return;
    closed = true;
    const error = fromEnvelope({
      code: "unavailable",
      message: reason instanceof Error ? reason.message : "transport closed",
    });
    for (const p of pending.values()) {
      p.offAbort();
      p.reject(error);
    }
    pending.clear();
    writer.close();
    for (const handler of closeHandlers) handler(reason);
    closeHandlers.clear();
  };

  const writer = createFrameWriter(io.output, terminate, logger);
  readFrames(
    io.input,
    (frame) => {
      if (closed) return;
      if (frame.t === "res") {
        const p = pending.get(frame.id);
        if (p === undefined) return;
        pending.delete(frame.id);
        p.offAbort();
        if (frame.error !== undefined) p.reject(fromEnvelope(frame.error));
        else p.resolve(frame.result);
      } else if (frame.t === "note") {
        for (const h of handlers.get(frame.method) ?? []) h(frame.params);
      }
    },
    terminate,
    logger,
  );
  io.input.once("end", () => terminate(new Error("transport input ended")));
  io.input.once("error", terminate);
  io.input.once("close", () => terminate(new Error("transport input closed")));
  io.output.once("error", terminate);

  return {
    request<T = unknown>(
      method: string,
      params?: unknown,
      options?: Parameters<KernelTransport["request"]>[2],
    ): Promise<T> {
      if (closed) {
        return Promise.reject(fromEnvelope({ code: "unavailable", message: "transport closed" }));
      }
      if (options?.signal?.aborted === true) {
        return Promise.reject(fromEnvelope({ code: "cancelled", message: "request cancelled" }));
      }
      const id = ++seq;
      return new Promise<T>((resolve, reject) => {
        const signal = options?.signal;
        const onAbort = (): void => {
          const request = pending.get(id);
          if (request === undefined) return;
          pending.delete(id);
          request.offAbort();
          void writer.send({ t: "cancel", id }).catch(terminate);
          reject(fromEnvelope({ code: "cancelled", message: "request cancelled" }));
        };
        const offAbort = (): void => signal?.removeEventListener("abort", onAbort);
        signal?.addEventListener("abort", onAbort, { once: true });
        pending.set(id, {
          resolve: resolve as (v: unknown) => void,
          reject,
          offAbort,
        });
        void writer.send({ t: "req", id, method, params }).catch(terminate);
      });
    },
    notify(method: string, params?: unknown): void {
      if (closed) return;
      void writer.send({ t: "note", method, params }).catch(terminate);
    },
    onNotification(method: string, handler: (params: unknown) => void): () => void {
      const list = handlers.get(method) ?? [];
      list.push(handler);
      handlers.set(method, list);
      return () =>
        handlers.set(
          method,
          (handlers.get(method) ?? []).filter((h) => h !== handler),
        );
    },
    onClose(handler: (reason?: unknown) => void): () => void {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    async close(): Promise<void> {
      terminate();
    },
  };
}

/**
 * Host a {@link KernelServer} on a stream pair: read `req` frames, dispatch them,
 * and write `res` (and pushed `note`) frames.
 *
 * @param server - the server to open one connection on.
 * @param io - the duplex stream pair: `input` is read for `req` frames, `output`
 *   is written with `res` and `note` frames.
 * @returns a handle whose `close` closes the underlying connection.
 * @remarks A request whose dispatch rejects is answered with a `res` carrying the
 *   error envelope, never left unanswered. Non-`req` frames on the input are
 *   ignored. Input EOF or error closes the connection; `close` only tears down the
 *   connection and does not end the streams themselves, and is idempotent.
 */
export function serveKernelOverStdio(
  server: KernelServer,
  io: { input: Readable; output: Writable },
  logger: Logger = NOOP_LOGGER,
): { close(): void } {
  let closed = false;
  const controllers = new Map<number, AbortController>();
  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const controller of controllers.values()) controller.abort(new Error("transport closed"));
    controllers.clear();
    writer.close();
    conn.close();
  };
  const disconnect = (_reason?: unknown): void => {
    close();
    // Normal `close()` leaves caller-owned streams alone. A failed wire cannot:
    // closing both sides is what makes the peer's `onClose` settle live handles.
    io.input.destroy();
    io.output.destroy();
  };
  const writer = createFrameWriter(io.output, disconnect, logger);
  const conn = server.connect(
    (method, params) => writer.send({ t: "note", method, params }),
    disconnect,
  );
  readFrames(
    io.input,
    (frame) => {
      if (closed) return;
      if (frame.t === "cancel") {
        controllers.get(frame.id)?.abort(new Error("request cancelled"));
        return;
      }
      if (frame.t !== "req") return;
      if (controllers.has(frame.id)) {
        close();
        return;
      }
      const controller = new AbortController();
      controllers.set(frame.id, controller);
      void conn
        .handle(frame.method, frame.params, controller.signal)
        .then(
          (result) => writer.send({ t: "res", id: frame.id, result }),
          (err) => writer.send({ t: "res", id: frame.id, error: toEnvelope(err) }),
        )
        .catch(close)
        .finally(() => controllers.delete(frame.id));
    },
    disconnect,
    logger,
  );
  io.input.once("end", disconnect);
  io.input.once("error", disconnect);
  return { close };
}
