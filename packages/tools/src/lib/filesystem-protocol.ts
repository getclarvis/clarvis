import type { Readable, Writable } from "node:stream";
import { deserialize, serialize } from "node:v8";
import type { FileOperation } from "../agent-filesystem.ts";
import type { DispatchResult } from "../core.ts";
import { isFileOperation } from "../agent-filesystem.ts";
import { isErrorCode, type ErrorCode } from "../errors.ts";

/** Maximum length of a filesystem service frame. */
export const MAX_FILESYSTEM_FRAME_BYTES = 96 * 1024 * 1024;

export interface FilesystemWireContext {
  readonly workspaceRoot: string;
  readonly stateRoot: string;
  readonly temporaryRoots: readonly string[];
  readonly skillExecutionRoots: readonly string[];
  readonly readOnly: boolean;
  readonly ripgrepAvailable: boolean;
  readonly maxOutputBytes: number;
  readonly maxFileBytes: number;
  readonly maxImageBytes: number;
  readonly maxTraversalEntries: number;
  readonly maxMutationBytes: number;
  readonly maxDiffInputBytes: number;
  readonly maxToolMetaBytes: number;
  readonly regexScanBudgetMs: number;
}

export type FilesystemParentMessage =
  | { readonly kind: "init"; readonly nonce: string; readonly policyIdentity: string }
  | {
      readonly kind: "invoke";
      readonly id: string;
      readonly policyIdentity: string;
      readonly operation: FileOperation;
      readonly args: Readonly<Record<string, unknown>>;
      readonly context: FilesystemWireContext;
    }
  | { readonly kind: "cancel"; readonly id: string }
  | { readonly kind: "close" };

export type FilesystemChildMessage =
  | { readonly kind: "ready"; readonly nonce: string; readonly policyIdentity: string }
  | {
      readonly kind: "result";
      readonly id: string;
      readonly result: DispatchResult;
    }
  | {
      readonly kind: "failure";
      readonly version: 1;
      readonly id: string;
      readonly code: ErrorCode;
      readonly message: string;
      readonly phase: "execute";
      readonly operation: FileOperation;
      readonly path_role: "source" | "destination" | "target" | "none";
      readonly retryable: boolean;
      readonly source_exists?: boolean;
      readonly destination_committed?: boolean;
    };

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Filesystem service message must be an object");
  return value as Record<string, unknown>;
}

function fields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  )
    throw new Error("Filesystem service message has unknown or missing fields");
}

function string(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(string);
}

function context(value: unknown): value is FilesystemWireContext {
  const item = record(value);
  const names = [
    "workspaceRoot",
    "stateRoot",
    "temporaryRoots",
    "skillExecutionRoots",
    "readOnly",
    "ripgrepAvailable",
    "maxOutputBytes",
    "maxFileBytes",
    "maxImageBytes",
    "maxTraversalEntries",
    "maxMutationBytes",
    "maxDiffInputBytes",
    "maxToolMetaBytes",
    "regexScanBudgetMs",
  ] as const;
  fields(item, names);
  return (
    string(item.workspaceRoot) &&
    string(item.stateRoot) &&
    stringArray(item.temporaryRoots) &&
    stringArray(item.skillExecutionRoots) &&
    ["readOnly", "ripgrepAvailable"].every((key) => typeof item[key] === "boolean") &&
    names.slice(6).every((key) => Number.isSafeInteger(item[key]) && (item[key] as number) > 0)
  );
}

function dispatchResult(value: unknown): value is DispatchResult {
  const item = record(value);
  fields(item, ["isError", "content"], ["meta"]);
  return (
    typeof item.isError === "boolean" &&
    Array.isArray(item.content) &&
    item.content.every((part: unknown) => {
      const content = record(part);
      return content.type === "text"
        ? typeof content.text === "string"
        : content.type === "image" && typeof content.data === "string" && string(content.mimeType);
    }) &&
    (item.meta === undefined || record(item.meta) !== undefined)
  );
}

/** Reject unknown parent operations and policy-bearing fields at the process boundary. */
export function parseFilesystemParentMessage(value: unknown): FilesystemParentMessage {
  const item = record(value);
  switch (item.kind) {
    case "init":
      fields(item, ["kind", "nonce", "policyIdentity"]);
      if (string(item.nonce) && string(item.policyIdentity))
        return item as unknown as FilesystemParentMessage;
      break;
    case "invoke":
      fields(item, ["kind", "id", "policyIdentity", "operation", "args", "context"]);
      if (
        string(item.id) &&
        string(item.policyIdentity) &&
        isFileOperation(item.operation) &&
        context(item.context)
      ) {
        record(item.args);
        return item as unknown as FilesystemParentMessage;
      }
      break;
    case "cancel":
      fields(item, ["kind", "id"]);
      if (string(item.id)) return item as unknown as FilesystemParentMessage;
      break;
    case "close":
      fields(item, ["kind"]);
      return { kind: "close" };
  }
  throw new Error("Filesystem service parent operation is invalid");
}

/** Validate every child event before it can enter a tool result. */
export function parseFilesystemChildMessage(value: unknown): FilesystemChildMessage {
  const item = record(value);
  switch (item.kind) {
    case "ready":
      fields(item, ["kind", "nonce", "policyIdentity"]);
      if (string(item.nonce) && string(item.policyIdentity))
        return item as unknown as FilesystemChildMessage;
      break;
    case "result":
      fields(item, ["kind", "id", "result"]);
      if (string(item.id) && dispatchResult(item.result))
        return item as unknown as FilesystemChildMessage;
      break;
    case "failure":
      fields(
        item,
        [
          "kind",
          "version",
          "id",
          "code",
          "message",
          "phase",
          "operation",
          "path_role",
          "retryable",
        ],
        ["source_exists", "destination_committed"],
      );
      if (
        item.version === 1 &&
        string(item.id) &&
        isErrorCode(item.code) &&
        typeof item.message === "string" &&
        item.message.length > 0 &&
        item.message.length <= 1024 &&
        item.phase === "execute" &&
        isFileOperation(item.operation) &&
        ["source", "destination", "target", "none"].includes(item.path_role as string) &&
        typeof item.retryable === "boolean" &&
        (item.source_exists === undefined || typeof item.source_exists === "boolean") &&
        (item.destination_committed === undefined ||
          typeof item.destination_committed === "boolean") &&
        (item.code === "commit_partial"
          ? typeof item.source_exists === "boolean" && item.destination_committed === true
          : item.source_exists === undefined && item.destination_committed === undefined)
      )
        return item as unknown as FilesystemChildMessage;
      break;
  }
  throw new Error("Filesystem service child operation is invalid");
}

/** Encode a single bounded, length-prefixed typed message onto an owned pipe. */
export async function writeFilesystemFrame(
  stream: Writable,
  message: FilesystemParentMessage | FilesystemChildMessage,
): Promise<void> {
  const data = serialize(message);
  if (data.length > MAX_FILESYSTEM_FRAME_BYTES)
    throw new Error("Filesystem service message exceeds the frame limit");
  const frame = Buffer.allocUnsafe(data.length + 4);
  frame.writeUInt32BE(data.length, 0);
  data.copy(frame, 4);
  await new Promise<void>((resolve, reject) => {
    stream.write(frame, (error?: Error | null) => (error ? reject(error) : resolve()));
  });
}

/** Decode complete frames; a truncated or oversized channel fails closed. */
export async function* readFilesystemFrames(stream: Readable): AsyncGenerator<unknown> {
  const header = Buffer.alloc(4);
  let headerBytes = 0;
  let payload: Buffer | undefined;
  let payloadBytes = 0;
  for await (const part of stream) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part as string);
    let offset = 0;
    while (offset < chunk.length) {
      if (payload === undefined) {
        const count = Math.min(4 - headerBytes, chunk.length - offset);
        chunk.copy(header, headerBytes, offset, offset + count);
        headerBytes += count;
        offset += count;
        if (headerBytes < 4) continue;
        const size = header.readUInt32BE(0);
        if (size === 0 || size > MAX_FILESYSTEM_FRAME_BYTES)
          throw new Error("Filesystem service frame length is invalid");
        payload = Buffer.allocUnsafe(size);
        payloadBytes = 0;
      }
      const count = Math.min(payload.length - payloadBytes, chunk.length - offset);
      chunk.copy(payload, payloadBytes, offset, offset + count);
      payloadBytes += count;
      offset += count;
      if (payloadBytes === payload.length) {
        yield deserialize(payload) as unknown;
        payload = undefined;
        headerBytes = 0;
      }
    }
  }
  if (headerBytes !== 0 || payload !== undefined)
    throw new Error("Filesystem service channel ended mid-frame");
}
