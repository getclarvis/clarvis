import { randomUUID } from "node:crypto";
import { MAX_PLAN_DOCUMENT_BYTES, MAX_PLAN_LIST_PAGE_BYTES } from "@clarvis/plan";
import type { HostCapabilityGrant } from "./authority-brokers.ts";

/** Base64-encoded chunks stay below the shared 256 KiB capability message ceiling. */
export const PLAN_TRANSFER_CHUNK_BYTES = 128 * 1024;

/** JSON escaping can expand each canonical source byte sixfold, plus bounded metadata. */
export const PLAN_DOCUMENT_WIRE_BYTES = 6 * MAX_PLAN_DOCUMENT_BYTES + 1024 * 1024;
const PLAN_LIST_WIRE_BYTES = 6 * MAX_PLAN_LIST_PAGE_BYTES + 1024 * 1024;

type WireCall = (request: unknown, signal?: AbortSignal) => Promise<unknown>;
type TransferOperation =
  "transfer_start" | "transfer_append" | "transfer_commit" | "transfer_read" | "transfer_release";
interface TransferRequest {
  readonly operation: TransferOperation;
  readonly input: {
    readonly id?: string;
    readonly bytes?: number;
    readonly offset?: number;
    readonly data?: string;
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function integer(value: unknown, maximum: number, minimum = 0): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
  );
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9-]{36}$/u.test(value);
}

function encodedChunk(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4 * Math.ceil(PLAN_TRANSFER_CHUNK_BYTES / 3) &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  );
}

function invalid(message = "runtime plan transfer is invalid"): never {
  throw Object.assign(new Error(message), { code: "invalid_request" });
}

function decodeChunk(value: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.length > PLAN_TRANSFER_CHUNK_BYTES || decoded.toString("base64") !== value) invalid();
  return decoded;
}

function validTransfer(value: unknown): value is TransferRequest {
  const request = object(value);
  const input = object(request?.input);
  if (request === undefined || input === undefined || !exact(request, ["operation", "input"]))
    return false;
  if (request.operation === "transfer_start") {
    return exact(input, ["bytes"]) && integer(input.bytes, PLAN_DOCUMENT_WIRE_BYTES, 1);
  }
  if (!identifier(input.id)) return false;
  switch (request.operation) {
    case "transfer_append":
      return (
        exact(input, ["id", "offset", "data"]) &&
        integer(input.offset, PLAN_DOCUMENT_WIRE_BYTES) &&
        encodedChunk(input.data)
      );
    case "transfer_read":
      return exact(input, ["id", "offset"]) && integer(input.offset, PLAN_LIST_WIRE_BYTES);
    case "transfer_commit":
    case "transfer_release":
      return exact(input, ["id"]);
    default:
      return false;
  }
}

interface Reservation {
  release(): void;
  shrink(bytes: number): void;
}
type Transfer = {
  readonly reservation: Reservation;
} & (
  | {
      kind: "upload";
      readonly bytes: number;
      chunks: Buffer[];
      offset: number;
      committing: boolean;
    }
  | { kind: "download"; readonly buffer: Buffer; offset: number }
);

/**
 * Bound uploads, response snapshots and pending provider calls before invoking the plan store.
 * Mutation responses reserve their full supported result size before any host effect occurs.
 * Transfers are opaque, run-local, sequential, explicitly released and revoked with the grant.
 */
export function createPlanTransferGrant(
  grant: HostCapabilityGrant,
  options: { readonly maxTransfers?: number; readonly maxBufferedBytes?: number } = {},
): HostCapabilityGrant {
  const maxTransfers = options.maxTransfers ?? 4;
  const maxBufferedBytes =
    options.maxBufferedBytes ?? PLAN_DOCUMENT_WIRE_BYTES + PLAN_LIST_WIRE_BYTES;
  if (
    !Number.isSafeInteger(maxTransfers) ||
    maxTransfers < 1 ||
    !Number.isSafeInteger(maxBufferedBytes) ||
    maxBufferedBytes < 1
  )
    throw new RangeError("invalid plan transfer limits");
  const transfers = new Map<string, Transfer>();
  let reservedBytes = 0;
  let reservedCount = 0;
  let revoked = false;

  const reserve = (bytes: number): Reservation => {
    if (revoked)
      throw Object.assign(new Error("runtime plan transfer authority was revoked"), {
        code: "unauthorized",
      });
    if (reservedCount >= maxTransfers || bytes > maxBufferedBytes - reservedBytes) {
      throw Object.assign(new Error("runtime plan transfer budget exhausted"), {
        code: "resource_exhausted",
      });
    }
    reservedCount += 1;
    reservedBytes += bytes;
    let held = bytes;
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        reservedCount -= 1;
        reservedBytes -= held;
      },
      shrink(actual) {
        reservedBytes -= held - actual;
        held = actual;
      },
    };
  };
  const release = (id: string): void => {
    const transfer = transfers.get(id);
    if (transfer === undefined) return;
    transfers.delete(id);
    transfer.reservation.release();
  };
  const execute = async (request: unknown, signal: AbortSignal): Promise<unknown> => {
    if (!grant.validateArguments(request)) invalid();
    const operation = object(request)?.operation;
    const resultLimit =
      operation === "list"
        ? PLAN_LIST_WIRE_BYTES
        : operation === "resolve" || operation === "delete"
          ? PLAN_TRANSFER_CHUNK_BYTES
          : PLAN_DOCUMENT_WIRE_BYTES;
    const reservation = reserve(resultLimit);
    let retained = false;
    try {
      signal.throwIfAborted();
      const result = await grant.invoke(request, signal);
      signal.throwIfAborted();
      if (revoked)
        throw Object.assign(new Error("runtime plan transfer authority was revoked"), {
          code: "unauthorized",
        });
      const json = JSON.stringify(result);
      const bytes = Buffer.byteLength(json);
      if (bytes > resultLimit)
        throw Object.assign(new Error("runtime plan result exceeds its canonical wire bound"), {
          code: "resource_exhausted",
        });
      if (bytes <= PLAN_TRANSFER_CHUNK_BYTES) return result;
      const id = randomUUID();
      reservation.shrink(bytes);
      transfers.set(id, { kind: "download", buffer: Buffer.from(json), offset: 0, reservation });
      retained = true;
      return { kind: "runtime_plan_transfer", id, bytes };
    } finally {
      if (!retained) reservation.release();
    }
  };
  return {
    ...grant,
    validateArguments: (value) => validTransfer(value) || grant.validateArguments(value),
    async invoke(request, signal) {
      signal.throwIfAborted();
      if (revoked)
        throw Object.assign(new Error("runtime plan transfer authority was revoked"), {
          code: "unauthorized",
        });
      if (!validTransfer(request)) return execute(request, signal);
      const { operation, input } = request;
      if (operation === "transfer_start") {
        const reservation = reserve(input.bytes!);
        const id = randomUUID();
        transfers.set(id, {
          kind: "upload",
          bytes: input.bytes!,
          chunks: [],
          offset: 0,
          committing: false,
          reservation,
        });
        return { id };
      }
      const id = input.id!;
      const transfer = transfers.get(id);
      if (operation === "transfer_release") {
        if (transfer?.kind === "upload" && transfer.committing)
          invalid("runtime plan upload is committing");
        release(id);
        return null;
      }
      if (transfer === undefined) invalid("runtime plan transfer does not exist");
      if (operation === "transfer_read") {
        if (transfer.kind !== "download" || input.offset !== transfer.offset) invalid();
        const offset = transfer.offset;
        const chunk = transfer.buffer.subarray(offset, offset + PLAN_TRANSFER_CHUNK_BYTES);
        transfer.offset += chunk.length;
        const done = transfer.offset === transfer.buffer.length;
        if (done) release(id);
        return { offset, data: chunk.toString("base64"), done };
      }
      if (transfer.kind !== "upload" || transfer.committing) invalid();
      if (operation === "transfer_append") {
        const chunk = decodeChunk(input.data!);
        if (
          input.offset !== transfer.offset ||
          chunk.length !== Math.min(PLAN_TRANSFER_CHUNK_BYTES, transfer.bytes - transfer.offset)
        )
          invalid();
        transfer.chunks.push(chunk);
        transfer.offset += chunk.length;
        return { offset: transfer.offset };
      }
      if (transfer.offset !== transfer.bytes) invalid("runtime plan upload is incomplete");
      transfer.committing = true;
      try {
        const buffer = Buffer.concat(transfer.chunks, transfer.bytes);
        transfer.chunks = [];
        let decoded: unknown;
        try {
          decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
        } catch {
          invalid("runtime plan upload is not valid UTF-8 JSON");
        }
        return await execute(decoded, signal);
      } finally {
        release(id);
      }
    },
    revoke() {
      revoked = true;
      for (const id of transfers.keys()) release(id);
      grant.revoke?.();
    },
  };
}

/** Send a logical plan operation using bounded chunks without exposing any host path. */
export async function callPlanTransfer(
  request: unknown,
  call: WireCall,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  const json = JSON.stringify(request);
  const bytes = Buffer.byteLength(json);
  if (bytes > PLAN_DOCUMENT_WIRE_BYTES)
    invalid("runtime plan request exceeds its canonical wire bound");
  let uploadId: string | undefined;
  let downloadId: string | undefined;
  const send = (operation: TransferOperation, input: Record<string, unknown>) => {
    signal?.throwIfAborted();
    return call({ operation, input }, signal);
  };
  try {
    let result: unknown;
    if (bytes <= PLAN_TRANSFER_CHUNK_BYTES) result = await call(request, signal);
    else {
      const started = object(await send("transfer_start", { bytes }));
      if (started === undefined || !exact(started, ["id"]) || !identifier(started.id)) invalid();
      uploadId = started.id;
      const buffer = Buffer.from(json);
      for (let offset = 0; offset < buffer.length; offset += PLAN_TRANSFER_CHUNK_BYTES) {
        const chunk = buffer.subarray(offset, offset + PLAN_TRANSFER_CHUNK_BYTES);
        const ack = object(
          await send("transfer_append", { id: uploadId, offset, data: chunk.toString("base64") }),
        );
        if (ack === undefined || !exact(ack, ["offset"]) || ack.offset !== offset + chunk.length)
          invalid();
      }
      result = await send("transfer_commit", { id: uploadId });
    }
    const descriptor = object(result);
    if (descriptor?.kind !== "runtime_plan_transfer") return result;
    const resultLimit =
      object(request)?.operation === "list" ? PLAN_LIST_WIRE_BYTES : PLAN_DOCUMENT_WIRE_BYTES;
    if (
      !exact(descriptor, ["kind", "id", "bytes"]) ||
      !identifier(descriptor.id) ||
      !integer(descriptor.bytes, resultLimit, PLAN_TRANSFER_CHUNK_BYTES + 1)
    )
      invalid();
    downloadId = descriptor.id;
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < descriptor.bytes;) {
      const chunk = object(await send("transfer_read", { id: downloadId, offset }));
      if (
        chunk === undefined ||
        !exact(chunk, ["offset", "data", "done"]) ||
        chunk.offset !== offset ||
        !encodedChunk(chunk.data)
      )
        invalid();
      const data = decodeChunk(chunk.data);
      if (data.length !== Math.min(PLAN_TRANSFER_CHUNK_BYTES, descriptor.bytes - offset)) invalid();
      offset += data.length;
      if (offset > descriptor.bytes || chunk.done !== (offset === descriptor.bytes)) invalid();
      chunks.push(data);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, descriptor.bytes)),
    );
  } finally {
    for (const id of [uploadId, downloadId]) {
      if (id === undefined) continue;
      try {
        await call({ operation: "transfer_release", input: { id } });
      } catch {
        /* Run revocation releases transfers when the transport is no longer available. */
      }
    }
  }
}
