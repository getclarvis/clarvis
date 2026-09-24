import { PassThrough } from "node:stream";
import { expect, test } from "bun:test";
import { isFileOperation, FILE_OPERATIONS } from "../../src/agent-filesystem.ts";
import type { DispatchResult } from "../../src/core.ts";
import {
  MAX_FILESYSTEM_FRAME_BYTES,
  parseFilesystemChildMessage,
  parseFilesystemParentMessage,
  readFilesystemFrames,
  writeFilesystemFrame,
  type FilesystemChildMessage,
  type FilesystemParentMessage,
  type FilesystemWireContext,
} from "../../src/lib/filesystem-protocol.ts";

const context: FilesystemWireContext = {
  workspaceRoot: "/workspace",
  stateRoot: "/state",
  temporaryRoots: ["/tmp"],
  skillExecutionRoots: [],
  readOnly: false,
  ripgrepAvailable: false,
  maxOutputBytes: 1024,
  maxFileBytes: 1024,
  maxImageBytes: 1024,
  maxTraversalEntries: 1024,
  maxMutationBytes: 1024,
  maxDiffInputBytes: 1024,
  maxToolMetaBytes: 1024,
  regexScanBudgetMs: 1024,
};

test("the filesystem port accepts only file tools", () => {
  expect(FILE_OPERATIONS).toContain("read_image");
  expect(FILE_OPERATIONS).toContain("apply_patch");
  expect(FILE_OPERATIONS).not.toContain("shell" as never);
  expect(isFileOperation("shell")).toBe(false);
});

test("filesystem frames survive partial pipe chunks and reject truncated input", async () => {
  const stream = new PassThrough();
  const message = { kind: "init", nonce: "owned-parent", policyIdentity: "pinned-policy" } as const;
  const collecting = Array.fromAsync(readFilesystemFrames(stream));
  await writeFilesystemFrame(stream, message);
  stream.end();
  expect(await collecting).toEqual([message]);

  const truncated = new PassThrough();
  truncated.end(Buffer.from([0, 0, 0, 9, 123]));
  await expect(Array.fromAsync(readFilesystemFrames(truncated))).rejects.toThrow("mid-frame");
});

test("filesystem frames reject oversized declarations before allocation", async () => {
  const stream = new PassThrough();
  const header = Buffer.alloc(4);
  header.writeUInt32BE(MAX_FILESYSTEM_FRAME_BYTES + 1);
  stream.end(header);
  await expect(Array.fromAsync(readFilesystemFrames(stream))).rejects.toThrow("frame length");
});

test("parent messages keep the sandbox policy identity and reject removed review operations", () => {
  const invoke: Extract<FilesystemParentMessage, { kind: "invoke" }> = {
    kind: "invoke",
    id: "request",
    policyIdentity: "policy",
    operation: "read_file",
    args: { path: "file.txt" },
    context,
  };
  expect(parseFilesystemParentMessage(invoke)).toEqual(invoke);
  expect(parseFilesystemParentMessage({ kind: "cancel", id: "request" })).toEqual({
    kind: "cancel",
    id: "request",
  });
  for (const invalid of [
    { ...invoke, args: ["file.txt"] },
    { ...invoke, policyIdentity: "" },
    { ...invoke, context: { ...context, temporaryRoots: [42] } },
    { ...invoke, context: { ...context, maxFileBytes: 0 } },
    { ...invoke, context: { ...context, reviewMutation: true } },
    { kind: "commit", id: "request", batchId: "batch", digest: "digest", route: "worker" },
    { kind: "reject", id: "request", batchId: "batch" },
  ])
    expect(() => parseFilesystemParentMessage(invalid)).toThrow();
});

test("child messages validate results and reject removed review events", () => {
  const result: DispatchResult = { isError: false, content: [{ type: "text", text: "ok" }] };
  const messages: FilesystemChildMessage[] = [
    { kind: "ready", nonce: "nonce", policyIdentity: "policy" },
    { kind: "result", id: "request", result },
    {
      kind: "failure",
      version: 1,
      id: "request",
      code: "denied",
      message: "refused",
      phase: "execute",
      operation: "write_file",
      path_role: "target",
      retryable: false,
    },
  ];
  for (const message of messages) expect(parseFilesystemChildMessage(message)).toEqual(message);
  for (const invalid of [
    { kind: "result", id: "request", result: { isError: false, content: ["raw"] } },
    { kind: "result", id: "request", result: { isError: false, content: [], guard: {} } },
    { kind: "prepare", id: "request", batchId: "batch", digest: "digest", operations: [] },
    { ...messages[2], phase: "review" },
  ])
    expect(() => parseFilesystemChildMessage(invalid)).toThrow();
});
