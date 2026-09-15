import { Readable, Writable } from "node:stream";
import { MAX_WIRE_FRAME_BYTES } from "../transport/stdio.ts";

/** The physical Container wire is independent of the JSON codec on each logical stream. */
export const CONTAINER_CHANNEL_PREFIX = "CLARVIS-CONTAINER/1\n";
/** Maximum payload of one physical frame; logical JSON messages retain their own larger limit. */
export const CONTAINER_FRAME_BYTES = 65_536;
/** Aggregate physical backlog, separate from the logical JSON message queues. */
const CONTAINER_QUEUE_BYTES = 32 * 1024 * 1024;
/** Physical frame-count ceiling, independent of the aggregate byte ceiling. */
const CONTAINER_QUEUE_FRAMES = 1_024;

/** One ordered byte stream pair, suitable for the existing stdio client or server codec. */
export interface ContainerLogicalChannel {
  readonly input: Readable;
  readonly output: Writable;
}

/** Owns the sole physical pair and all three virtual stream lifetimes. */
export interface ContainerChannel {
  readonly kernel: ContainerLogicalChannel;
  readonly control: ContainerLogicalChannel;
  readonly model: ContainerLogicalChannel;
  /** Resolves only after both physical prefixes have been exchanged. */
  readonly ready: Promise<void>;
  /** Resolves on physical teardown; failure is separately observable through ready and streams. */
  readonly closed: Promise<void>;
  close(): void;
}

interface PendingWrite {
  bytes: Buffer;
  offset: number;
  complete(error?: Error | null): void;
}

interface Lane {
  input: Readable;
  output: Writable;
  pending?: PendingWrite;
  received: Buffer[];
  readable: boolean;
}

/**
 * Multiplex three ordered stream pairs over process pipes, without interpreting their payloads.
 *
 * @remarks Each output admits one codec write at a time and slices it lazily into physical frames.
 * Only one physical write is in flight; arbitration advances round-robin after every frame.
 * The caller must use the shared stdio codec, whose writes are at most one bounded JSON line.
 * Inbound backpressure is aggregate, allowing another lane to progress while one reader is slow.
 * Corruption, partial EOF, or either physical stream failing tears down all lanes together.
 * Method/direction admission and the initialize/hello gates belong above this byte-only layer.
 */
export function createContainerChannel(io: {
  input: Readable;
  output: Writable;
}): ContainerChannel {
  let stopped = false;
  let prefixReceived = false;
  let prefixWritten = false;
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => undefined);
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let queuedBytes = 0;
  let queuedFrames = 0;
  let nextLane = 0;
  let writing = true;
  let reading = false;
  let prefixOffset = 0;
  let headerOffset = 0;
  const prefix = Buffer.from(CONTAINER_CHANNEL_PREFIX, "ascii");
  const header = Buffer.alloc(5);
  let payload: Buffer | undefined;
  let payloadOffset = 0;
  let payloadLane = 0;

  const finish = (error?: Error): void => {
    if (stopped) return;
    stopped = true;
    if (!readySettled) {
      readySettled = true;
      rejectReady(error ?? new Error("Container channel closed before prefix exchange"));
    }
    io.input.removeListener("readable", read);
    for (const lane of lanes) {
      const pending = lane.pending;
      delete lane.pending;
      pending?.complete(error ?? new Error("Container channel closed"));
      lane.received.length = 0;
      lane.input.destroy(error);
      lane.output.destroy(error);
    }
    queuedBytes = 0;
    queuedFrames = 0;
    payload = undefined;
    io.input.destroy();
    io.output.destroy();
    resolveClosed();
  };
  const fail = (): void => finish(new Error("Invalid or interrupted Container channel"));
  const markReady = (): void => {
    if (!stopped && prefixReceived && prefixWritten && !readySettled) {
      readySettled = true;
      resolveReady();
    }
  };

  const drain = (lane: Lane): void => {
    while (!stopped && lane.readable && lane.received.length > 0) {
      const bytes = lane.received.shift()!;
      queuedBytes -= bytes.length;
      queuedFrames -= 1;
      lane.readable = lane.input.push(bytes);
    }
  };
  const createLane = (): Lane => {
    const lane: Lane = {
      input: new Readable({
        highWaterMark: 1,
        read() {
          lane.readable = true;
          drain(lane);
          read();
        },
      }),
      output: new Writable({
        highWaterMark: CONTAINER_FRAME_BYTES,
        write(chunk: Buffer, _encoding, callback) {
          if (stopped) {
            callback(new Error("Container channel closed"));
            return;
          }
          if (chunk.length > MAX_WIRE_FRAME_BYTES) {
            callback(new Error("Container logical write exceeds the stdio line bound"));
            return;
          }
          if (chunk.length === 0) {
            callback();
            return;
          }
          lane.pending = { bytes: chunk, offset: 0, complete: callback };
          queueMicrotask(writeNext);
        },
      }),
      received: [],
      readable: true,
    };
    lane.input.on("error", () => undefined);
    lane.output.on("error", fail);
    lane.output.on("finish", () => finish());
    lane.output.on("close", () => finish());
    lane.input.on("close", () => finish());
    return lane;
  };
  const lanes: [Lane, Lane, Lane] = [createLane(), createLane(), createLane()];
  const laneAt = (index: number): Lane => {
    const lane = lanes[index];
    if (lane === undefined) throw new RangeError("Container channel lane is invalid");
    return lane;
  };

  function writeNext(): void {
    if (stopped || writing || !prefixWritten) return;
    for (let offset = 0; offset < lanes.length; offset += 1) {
      const index = (nextLane + offset) % lanes.length;
      const lane = laneAt(index);
      const pending = lane.pending;
      if (pending === undefined) continue;
      const count = Math.min(CONTAINER_FRAME_BYTES, pending.bytes.length - pending.offset);
      const frame = Buffer.allocUnsafe(5 + count);
      frame[0] = index + 1;
      frame.writeUInt32BE(count, 1);
      pending.bytes.copy(frame, 5, pending.offset, pending.offset + count);
      writing = true;
      nextLane = (index + 1) % lanes.length;
      io.output.write(frame, (error?: Error | null) => {
        writing = false;
        if (stopped) return;
        if (error) {
          fail();
          return;
        }
        pending.offset += count;
        if (pending.offset === pending.bytes.length) {
          delete lane.pending;
          pending.complete();
        }
        queueMicrotask(writeNext);
      });
      return;
    }
  }

  function take(maximum: number): Buffer | undefined {
    const available = io.input.readableLength;
    if (available === 0) {
      io.input.read(0);
      return undefined;
    }
    const chunk: unknown = io.input.read(Math.min(maximum, available));
    if (!Buffer.isBuffer(chunk)) {
      fail();
      return undefined;
    }
    return chunk;
  }

  function read(): void {
    if (stopped || reading) return;
    reading = true;
    try {
      while (!stopped) {
        if (!prefixReceived) {
          const chunk = take(prefix.length - prefixOffset);
          if (chunk === undefined) break;
          if (!chunk.equals(prefix.subarray(prefixOffset, prefixOffset + chunk.length))) {
            fail();
            break;
          }
          prefixOffset += chunk.length;
          if (prefixOffset === prefix.length) {
            prefixReceived = true;
            markReady();
          }
          continue;
        }
        if (payload === undefined) {
          if (
            queuedFrames >= CONTAINER_QUEUE_FRAMES - 4 ||
            queuedBytes + 4 * CONTAINER_FRAME_BYTES > CONTAINER_QUEUE_BYTES
          )
            break;
          const chunk = take(header.length - headerOffset);
          if (chunk === undefined) break;
          chunk.copy(header, headerOffset);
          headerOffset += chunk.length;
          if (headerOffset < header.length) continue;
          payloadLane = header.readUInt8(0) - 1;
          const length = header.readUInt32BE(1);
          if (
            payloadLane < 0 ||
            payloadLane >= lanes.length ||
            length === 0 ||
            length > CONTAINER_FRAME_BYTES
          ) {
            fail();
            break;
          }
          payload = Buffer.allocUnsafe(length);
          payloadOffset = 0;
        }
        const chunk = take(payload.length - payloadOffset);
        if (chunk === undefined) break;
        chunk.copy(payload, payloadOffset);
        payloadOffset += chunk.length;
        if (payloadOffset === payload.length) {
          const lane = laneAt(payloadLane);
          lane.received.push(payload);
          queuedBytes += payload.length;
          queuedFrames += 1;
          payload = undefined;
          headerOffset = 0;
          drain(lane);
        }
      }
    } finally {
      reading = false;
    }
  }

  io.input.on("readable", read);
  io.input.on("end", () => {
    if (!prefixReceived || headerOffset !== 0 || payload !== undefined) fail();
    else finish();
  });
  io.input.on("error", fail);
  io.output.on("error", fail);
  io.input.on("close", () => finish());
  io.output.on("close", () => finish());
  io.output.write(prefix, (error?: Error | null) => {
    writing = false;
    if (error) {
      fail();
      return;
    }
    prefixWritten = true;
    markReady();
    writeNext();
  });
  return {
    kernel: lanes[0],
    control: lanes[1],
    model: lanes[2],
    ready,
    closed,
    close: () => finish(),
  };
}
