import { createHash } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { deserialize, serialize } from "node:v8";
import type { ConfigurationRoot } from "@clarvis/paths";
import type { FileOp } from "./atomic.ts";
import type { FileOperation } from "../agent-filesystem.ts";
import type { DispatchResult } from "../core.ts";
import { isFileOperation } from "../agent-filesystem.ts";

/** Bound a full prepared batch without charging JSON escape expansion to mutation bytes. */
export const MAX_FILESYSTEM_FRAME_BYTES = 96 * 1024 * 1024;

export interface FilesystemWireContext {
  readonly workspaceRoot: string;
  readonly stateRoot: string;
  readonly temporaryRoots: readonly string[];
  readonly skillExecutionRoots: readonly string[];
  readonly configurationRoots?: Readonly<Record<ConfigurationRoot, string>>;
  readonly readOnly: boolean;
  readonly reviewMutation: boolean;
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
      readonly operation: FileOperation;
      readonly args: Readonly<Record<string, unknown>>;
      readonly context: FilesystemWireContext;
    }
  | {
      readonly kind: "commit";
      readonly id: string;
      readonly batchId: string;
      readonly digest: string;
      readonly route: "worker" | "classified-host";
    }
  | { readonly kind: "reject"; readonly id: string; readonly batchId: string }
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
      readonly id: string;
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly kind: "prepare";
      readonly id: string;
      readonly batchId: string;
      readonly digest: string;
      readonly operations: readonly FileOp[];
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
    "reviewMutation",
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
  fields(item, names, ["configurationRoots"]);
  return (
    string(item.workspaceRoot) &&
    string(item.stateRoot) &&
    stringArray(item.temporaryRoots) &&
    stringArray(item.skillExecutionRoots) &&
    (item.configurationRoots === undefined ||
      Object.values(record(item.configurationRoots)).every(string)) &&
    ["readOnly", "reviewMutation", "ripgrepAvailable"].every(
      (key) => typeof item[key] === "boolean",
    ) &&
    names.slice(7).every((key) => Number.isSafeInteger(item[key]) && (item[key] as number) > 0)
  );
}

function fileOperations(value: unknown): value is FileOp[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50_000) return false;
  return value.every((raw) => {
    const item = record(raw);
    fields(item, ["type", "path"], ["from", "content", "intent", "mode", "dirMode", "overwrite"]);
    return (
      ["create", "modify", "delete", "rename"].includes(item.type as string) &&
      string(item.path) &&
      (item.from === undefined || string(item.from)) &&
      (item.content === undefined || typeof item.content === "string") &&
      (item.intent === undefined || item.intent === "write" || item.intent === "edit") &&
      (item.mode === undefined || Number.isSafeInteger(item.mode)) &&
      (item.dirMode === undefined || Number.isSafeInteger(item.dirMode)) &&
      (item.overwrite === undefined || typeof item.overwrite === "boolean")
    );
  });
}

function dispatchResult(value: unknown): value is DispatchResult {
  const item = record(value);
  fields(item, ["isError", "content"], ["meta", "guard"]);
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
      fields(item, ["kind", "id", "operation", "args", "context"]);
      if (string(item.id) && isFileOperation(item.operation) && context(item.context)) {
        record(item.args);
        return item as unknown as FilesystemParentMessage;
      }
      break;
    case "commit":
      fields(item, ["kind", "id", "batchId", "digest", "route"]);
      if (
        string(item.id) &&
        string(item.batchId) &&
        string(item.digest) &&
        (item.route === "worker" || item.route === "classified-host")
      )
        return item as unknown as FilesystemParentMessage;
      break;
    case "reject":
      fields(item, ["kind", "id", "batchId"]);
      if (string(item.id) && string(item.batchId))
        return item as unknown as FilesystemParentMessage;
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

/** Validate every child event before it can enter host review or a tool result. */
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
      fields(item, ["kind", "id", "code", "message"]);
      if (string(item.id) && string(item.code) && typeof item.message === "string")
        return item as unknown as FilesystemChildMessage;
      break;
    case "prepare":
      fields(item, ["kind", "id", "batchId", "digest", "operations"]);
      if (
        string(item.id) &&
        string(item.batchId) &&
        string(item.digest) &&
        fileOperations(item.operations)
      )
        return item as unknown as FilesystemChildMessage;
      break;
  }
  throw new Error("Filesystem service child operation is invalid");
}

/** Digest the prepared bytes and authority binding without serializing a callback. */
export function mutationDigest(
  policyIdentity: string,
  requestId: string,
  operations: readonly FileOp[],
): string {
  return createHash("sha256")
    .update(JSON.stringify({ policyIdentity, requestId, operations }))
    .digest("hex");
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
