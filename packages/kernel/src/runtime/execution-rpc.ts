import type { Readable, Writable } from "node:stream";
import { NOOP_LOGGER, type Logger } from "@clarvis/capability";

/** Closed host-to-guest execution vocabulary. */
export const HOST_EXECUTION_METHODS = [
  "runtime.bootstrap",
  "runtime.start",
  "runtime.steer",
  "runtime.cancel",
  "runtime.shutdown",
] as const;

/** Closed guest-to-host authority and persistence vocabulary. */
export const GUEST_EXECUTION_METHODS = [
  "host.model",
  "host.capability",
  "host.event",
  "host.checkpoint",
] as const;

export type HostExecutionMethod = (typeof HOST_EXECUTION_METHODS)[number];
export type GuestExecutionMethod = (typeof GUEST_EXECUTION_METHODS)[number];
export type ExecutionMethod = HostExecutionMethod | GuestExecutionMethod;
export type ExecutionPeerRole = "host" | "guest";

/** Identity fence carried on every private execution frame. */
export interface ExecutionIdentity {
  readonly generation: string;
  readonly runId?: string;
  readonly callId?: string;
}

/** A received request after strict wire validation. */
export interface ExecutionRequest extends ExecutionIdentity {
  readonly method: ExecutionMethod;
  readonly payload?: unknown;
  readonly signal: AbortSignal;
  /** Incremental, ordered model events; the handler's return value remains terminal. */
  readonly emit?: (event: unknown) => Promise<void>;
}

/** Local cancellation and incremental delivery for one private RPC call. */
export interface ExecutionRequestOptions {
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: unknown) => void;
}

/** Handler for one admitted private execution method. */
export type ExecutionRequestHandler = (request: ExecutionRequest) => Promise<unknown>;

/** Private, generation-fenced bidirectional execution channel. */
export interface ExecutionPeer {
  request<T>(
    method: ExecutionMethod,
    identity: ExecutionIdentity,
    payload?: unknown,
    options?: ExecutionRequestOptions,
  ): Promise<T>;
  close(reason?: Error): void;
  readonly closed: boolean;
}

interface RequestFrame extends ExecutionIdentity {
  readonly type: "request";
  readonly id: number;
  readonly method: ExecutionMethod;
  readonly payload?: unknown;
}

interface ResultFrame extends ExecutionIdentity {
  readonly type: "result";
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

interface CancelFrame extends ExecutionIdentity {
  readonly type: "cancel";
  readonly id: number;
}

interface EventFrame extends ExecutionIdentity {
  readonly type: "event";
  readonly id: number;
  readonly sequence: number;
  readonly event: unknown;
}

type ExecutionFrame = RequestFrame | ResultFrame | CancelFrame | EventFrame;

export const MAX_EXECUTION_FRAME_BYTES = 4 * 1024 * 1024;
export const MAX_EXECUTION_QUEUE_FRAMES = 256;
export const MAX_EXECUTION_QUEUE_BYTES = 8 * 1024 * 1024;
const WRITER_TIMEOUT_MS = 30_000;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const HOST_METHOD_SET = new Set<string>(HOST_EXECUTION_METHODS);
const GUEST_METHOD_SET = new Set<string>(GUEST_EXECUTION_METHODS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function only(value: Record<string, unknown>, names: readonly string[]): boolean {
  const allowed = new Set(names);
  return Object.keys(value).every((name) => allowed.has(name));
}

function validId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validIdentity(value: Record<string, unknown>): boolean {
  return (
    typeof value.generation === "string" &&
    IDENTIFIER.test(value.generation) &&
    (value.runId === undefined ||
      (typeof value.runId === "string" && IDENTIFIER.test(value.runId))) &&
    (value.callId === undefined ||
      (typeof value.callId === "string" && IDENTIFIER.test(value.callId)))
  );
}

function validMethodIdentity(method: ExecutionMethod, value: Record<string, unknown>): boolean {
  if (method === "runtime.bootstrap" || method === "runtime.shutdown") {
    return value.runId === undefined && value.callId === undefined;
  }
  if (method === "host.model" || method === "host.capability") {
    return value.runId !== undefined && value.callId !== undefined;
  }
  return value.runId !== undefined && value.callId === undefined;
}

/** Decode a private frame and reject additional fields, unknown methods, or missing identity. */
export function decodeExecutionFrame(value: unknown): ExecutionFrame | null {
  if (!isRecord(value) || !validIdentity(value) || typeof value.type !== "string") return null;
  if (value.type === "request") {
    if (
      !only(value, ["type", "id", "method", "generation", "runId", "callId", "payload"]) ||
      !validId(value.id) ||
      typeof value.method !== "string" ||
      (!HOST_METHOD_SET.has(value.method) && !GUEST_METHOD_SET.has(value.method))
    ) {
      return null;
    }
    const method = value.method as ExecutionMethod;
    return validMethodIdentity(method, value) ? (value as unknown as RequestFrame) : null;
  }
  if (value.type === "cancel") {
    return only(value, ["type", "id", "generation", "runId", "callId"]) && validId(value.id)
      ? (value as unknown as CancelFrame)
      : null;
  }
  if (value.type === "event") {
    return only(value, ["type", "id", "generation", "runId", "callId", "sequence", "event"]) &&
      validId(value.id) &&
      validId(value.sequence) &&
      validMethodIdentity("host.model", value) &&
      Object.hasOwn(value, "event")
      ? (value as unknown as EventFrame)
      : null;
  }
  if (
    value.type !== "result" ||
    !only(value, ["type", "id", "generation", "runId", "callId", "result", "error"]) ||
    !validId(value.id)
  ) {
    return null;
  }
  const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
  const hasError = Object.prototype.hasOwnProperty.call(value, "error");
  if (hasResult === hasError) return null;
  if (
    hasError &&
    (!isRecord(value.error) ||
      !only(value.error, ["code", "message"]) ||
      typeof value.error.code !== "string" ||
      !IDENTIFIER.test(value.error.code) ||
      typeof value.error.message !== "string" ||
      value.error.message.length > 16_384)
  ) {
    return null;
  }
  return value as unknown as ResultFrame;
}

function sameIdentity(left: ExecutionIdentity, right: ExecutionIdentity): boolean {
  return (
    left.generation === right.generation &&
    left.runId === right.runId &&
    left.callId === right.callId
  );
}

function executionError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Create one side of the attached stdio private execution RPC. */
export function createExecutionPeer(options: {
  readonly role: ExecutionPeerRole;
  readonly generation: string;
  readonly input: Readable;
  readonly output: Writable;
  readonly handlers: Readonly<Partial<Record<ExecutionMethod, ExecutionRequestHandler>>>;
  readonly logger?: Logger;
}): ExecutionPeer {
  if (!IDENTIFIER.test(options.generation)) throw new Error("invalid execution generation");
  const logger = options.logger ?? NOOP_LOGGER;
  const outboundMethods = options.role === "host" ? HOST_METHOD_SET : GUEST_METHOD_SET;
  const inboundMethods = options.role === "host" ? GUEST_METHOD_SET : HOST_METHOD_SET;
  let sequence = 0;
  let ended = false;
  let buffer = "";
  let bufferedBytes = 0;
  let writeTail = Promise.resolve();
  let queuedFrames = 0;
  let queuedBytes = 0;
  const pending = new Map<
    number,
    ExecutionIdentity & {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: unknown) => void;
      readonly detach: () => void;
      readonly onEvent?: (event: unknown) => void;
      readonly method: ExecutionMethod;
      eventSequence: number;
    }
  >();
  const cancelled = new Map<number, ExecutionIdentity>();
  const controllers = new Map<
    number,
    { readonly identity: ExecutionIdentity; readonly value: AbortController }
  >();

  const close = (reason = new Error("execution channel closed")): void => {
    if (ended) return;
    ended = true;
    for (const request of pending.values()) {
      request.detach();
      request.reject(executionError("unavailable", reason.message));
    }
    pending.clear();
    cancelled.clear();
    for (const controller of controllers.values()) controller.value.abort(reason);
    controllers.clear();
    options.input.destroy();
    options.output.destroy();
  };

  const send = (frame: ExecutionFrame): Promise<void> => {
    if (ended) return Promise.reject(executionError("unavailable", "execution channel closed"));
    let line: string;
    try {
      line = `${JSON.stringify(frame)}\n`;
    } catch {
      close(new Error("execution frame serialization failed"));
      return Promise.reject(executionError("invalid_request", "frame is not serializable"));
    }
    const bytes = Buffer.byteLength(line, "utf8");
    if (
      bytes > MAX_EXECUTION_FRAME_BYTES ||
      queuedFrames >= MAX_EXECUTION_QUEUE_FRAMES ||
      queuedBytes + bytes > MAX_EXECUTION_QUEUE_BYTES
    ) {
      logger.warn(
        { event: "runtime.execution_frame_refused", bytes },
        "private execution channel exceeded a transport bound",
      );
      close(new Error("execution channel bound exceeded"));
      return Promise.reject(
        executionError("resource_exhausted", "execution channel bound exceeded"),
      );
    }
    queuedFrames += 1;
    queuedBytes += bytes;
    const write = writeTail.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (ended) {
            reject(executionError("unavailable", "execution channel closed"));
            return;
          }
          const timer = setTimeout(
            () => reject(new Error("execution writer stalled")),
            WRITER_TIMEOUT_MS,
          );
          timer.unref?.();
          options.output.write(line, (error?: Error | null) => {
            clearTimeout(timer);
            if (error !== undefined && error !== null) reject(error);
            else resolve();
          });
        }),
    );
    writeTail = write.then(
      () => undefined,
      (error: unknown) =>
        close(error instanceof Error ? error : new Error("execution write failed")),
    );
    return write.finally(() => {
      queuedFrames -= 1;
      queuedBytes -= bytes;
    });
  };

  const receive = (frame: ExecutionFrame): void => {
    if (frame.generation !== options.generation) {
      close(new Error("execution generation mismatch"));
      return;
    }
    if (frame.type === "result" || frame.type === "event") {
      const request = pending.get(frame.id);
      if (request === undefined) {
        const tombstone = cancelled.get(frame.id);
        if (tombstone !== undefined && sameIdentity(tombstone, frame)) {
          if (frame.type === "result") cancelled.delete(frame.id);
          return;
        }
        close(new Error("unexpected execution result"));
        return;
      }
      if (!sameIdentity(request, frame)) {
        close(new Error("unexpected execution result"));
        return;
      }
      if (frame.type === "event") {
        if (request.method !== "host.model" || frame.sequence !== request.eventSequence + 1) {
          close(new Error("unexpected execution event"));
          return;
        }
        request.eventSequence = frame.sequence;
        try {
          request.onEvent?.(frame.event);
        } catch {
          close(new Error("execution event consumer failed"));
        }
        return;
      }
      pending.delete(frame.id);
      request.detach();
      if (frame.error !== undefined)
        request.reject(executionError(frame.error.code, frame.error.message));
      else request.resolve(frame.result);
      return;
    }
    if (frame.type === "cancel") {
      const active = controllers.get(frame.id);
      if (active === undefined || !sameIdentity(active.identity, frame)) {
        close(new Error("unexpected execution cancellation"));
        return;
      }
      active.value.abort(new Error("execution request cancelled"));
      return;
    }
    if (!inboundMethods.has(frame.method) || controllers.has(frame.id)) {
      close(new Error("execution method or request identity refused"));
      return;
    }
    const handler = options.handlers[frame.method];
    if (handler === undefined) {
      void send({
        type: "result",
        id: frame.id,
        generation: frame.generation,
        ...(frame.runId === undefined ? {} : { runId: frame.runId }),
        ...(frame.callId === undefined ? {} : { callId: frame.callId }),
        error: { code: "method_unavailable", message: "execution method is not admitted" },
      }).catch(close);
      return;
    }
    const controller = new AbortController();
    let eventSequence = 0;
    controllers.set(frame.id, { identity: frame, value: controller });
    void handler({
      method: frame.method,
      generation: frame.generation,
      ...(frame.runId === undefined ? {} : { runId: frame.runId }),
      ...(frame.callId === undefined ? {} : { callId: frame.callId }),
      ...(Object.prototype.hasOwnProperty.call(frame, "payload") ? { payload: frame.payload } : {}),
      signal: controller.signal,
      ...(frame.method !== "host.model"
        ? {}
        : {
            emit: (event: unknown) => {
              controller.signal.throwIfAborted();
              return send({
                type: "event",
                id: frame.id,
                generation: frame.generation,
                runId: frame.runId!,
                callId: frame.callId!,
                sequence: ++eventSequence,
                event,
              });
            },
          }),
    })
      .then(
        (result) =>
          send({
            type: "result",
            id: frame.id,
            generation: frame.generation,
            ...(frame.runId === undefined ? {} : { runId: frame.runId }),
            ...(frame.callId === undefined ? {} : { callId: frame.callId }),
            result: result ?? null,
          }),
        (error: unknown) =>
          send({
            type: "result",
            id: frame.id,
            generation: frame.generation,
            ...(frame.runId === undefined ? {} : { runId: frame.runId }),
            ...(frame.callId === undefined ? {} : { callId: frame.callId }),
            error: {
              code:
                typeof (error as { code?: unknown })?.code === "string"
                  ? String((error as { code: string }).code).slice(0, 256)
                  : "internal",
              message:
                error instanceof Error
                  ? error.message.slice(0, 16_384)
                  : "execution request failed",
            },
          }),
      )
      .catch(close)
      .finally(() => controllers.delete(frame.id));
  };

  options.input.setEncoding("utf8");
  options.input.on("data", (chunk: string) => {
    if (ended) return;
    buffer += chunk;
    bufferedBytes += Buffer.byteLength(chunk, "utf8");
    if (bufferedBytes > MAX_EXECUTION_FRAME_BYTES && !buffer.includes("\n")) {
      close(new Error("execution frame exceeds size bound"));
      return;
    }
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      bufferedBytes -= Buffer.byteLength(line, "utf8") + 1;
      if (line.trim().length === 0) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_EXECUTION_FRAME_BYTES) {
        close(new Error("execution frame exceeds size bound"));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        close(new Error("execution frame is not valid JSON"));
        return;
      }
      const frame = decodeExecutionFrame(parsed);
      if (frame === null) {
        close(new Error("execution frame has an invalid shape"));
        return;
      }
      receive(frame);
    }
  });
  options.input.once("end", () => close(new Error("execution input ended")));
  options.input.once("close", () => close(new Error("execution input closed")));
  options.input.once("error", close);
  options.output.once("error", close);

  return {
    get closed() {
      return ended;
    },
    request<T>(
      method: ExecutionMethod,
      identity: ExecutionIdentity,
      payload?: unknown,
      requestOptions?: ExecutionRequestOptions,
    ): Promise<T> {
      if (!outboundMethods.has(method) || identity.generation !== options.generation) {
        return Promise.reject(
          executionError("unauthorized", "execution method or generation refused"),
        );
      }
      const candidate = { ...identity } as Record<string, unknown>;
      if (!validIdentity(candidate) || !validMethodIdentity(method, candidate)) {
        return Promise.reject(executionError("invalid_request", "invalid execution identity"));
      }
      if (ended) return Promise.reject(executionError("unavailable", "execution channel closed"));
      if (requestOptions?.signal?.aborted === true) {
        return Promise.reject(executionError("cancelled", "execution request cancelled"));
      }
      const id = ++sequence;
      return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => {
          const current = pending.get(id);
          if (current === undefined) return;
          pending.delete(id);
          current.detach();
          if (cancelled.size >= MAX_EXECUTION_QUEUE_FRAMES) {
            close(new Error("execution cancellation bound exceeded"));
            reject(executionError("cancelled", "execution request cancelled"));
            return;
          }
          cancelled.set(id, identity);
          void send({ type: "cancel", id, ...identity }).catch(close);
          reject(executionError("cancelled", "execution request cancelled"));
        };
        const detach = (): void => requestOptions?.signal?.removeEventListener("abort", onAbort);
        requestOptions?.signal?.addEventListener("abort", onAbort, { once: true });
        pending.set(id, {
          ...identity,
          resolve: resolve as (value: unknown) => void,
          reject,
          detach,
          method,
          eventSequence: 0,
          ...(requestOptions?.onEvent === undefined ? {} : { onEvent: requestOptions.onEvent }),
        });
        void send({ type: "request", id, method, ...identity, payload }).catch(close);
      });
    },
    close,
  };
}
