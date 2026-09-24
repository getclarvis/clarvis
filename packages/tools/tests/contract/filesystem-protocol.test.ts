import { PassThrough } from "node:stream";
import { expect, test } from "bun:test";
import { isFileOperation, FILE_OPERATIONS } from "../../src/agent-filesystem.ts";
import type { DispatchResult } from "../../src/core.ts";
import {
  MAX_FILESYSTEM_FRAME_BYTES,
  mutationDigest,
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
  reviewMutation: true,
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

test("the filesystem port has one closed file-tool catalog and no command operation", () => {
  expect(FILE_OPERATIONS).toContain("read_image");
  expect(FILE_OPERATIONS).toContain("apply_patch");
  expect(FILE_OPERATIONS).not.toContain("shell" as never);
  expect(isFileOperation("shell")).toBe(false);
  expect(isFileOperation("unknown_file_tool")).toBe(false);
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

test("wire framing preserves large prepared text without charging JSON escapes", async () => {
  const stream = new PassThrough();
  const content = "\n".repeat(1024 * 1024);
  const message = {
    kind: "prepare" as const,
    id: "call",
    batchId: "batch",
    digest: "digest",
    operations: [{ type: "modify" as const, path: "/tmp/file", content }],
  };
  let bytes = 0;
  stream.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
  });
  const collecting = Array.fromAsync(readFilesystemFrames(stream));
  await writeFilesystemFrame(stream, message);
  stream.end();
  expect(await collecting).toEqual([message]);
  expect(bytes).toBeLessThan(2 * 1024 * 1024);
});

test("filesystem frames reject an oversized declaration before allocating its body", async () => {
  const stream = new PassThrough();
  const header = Buffer.alloc(4);
  header.writeUInt32BE(MAX_FILESYSTEM_FRAME_BYTES + 1);
  stream.end(header);
  await expect(Array.fromAsync(readFilesystemFrames(stream))).rejects.toThrow("frame length");
});

test("the wire rejects unknown operations, policy selectors and malformed review batches", () => {
  expect(() =>
    parseFilesystemParentMessage({ kind: "shell", command: "cat /etc/passwd" }),
  ).toThrow();
  expect(() =>
    parseFilesystemParentMessage({
      kind: "init",
      nonce: "nonce",
      policyIdentity: "policy",
      mount: "/",
    }),
  ).toThrow("unknown or missing fields");
  expect(() =>
    parseFilesystemChildMessage({
      kind: "prepare",
      id: "call",
      batchId: "batch",
      digest: "digest",
      operations: [{ type: "modify", path: "/tmp/file", command: "rm -rf /" }],
    }),
  ).toThrow();
  expect(() =>
    parseFilesystemChildMessage({
      kind: "prepare",
      id: "call",
      batchId: "batch",
      digest: "digest",
      operations: [{ type: "rmtree", path: "/workspace/tree", treeEntries: ["."] }],
    }),
  ).toThrow();
  expect(
    parseFilesystemChildMessage({
      kind: "prepare",
      id: "call",
      batchId: "batch",
      digest: "digest",
      operations: [
        {
          type: "rmtree",
          path: "/workspace/tree",
          treeEntries: [".", "file.txt"],
          treeRevision: "a".repeat(64),
        },
      ],
    }),
  ).toMatchObject({ kind: "prepare" });
});

test("parent messages carry bounded file calls and closed review receipts", () => {
  const invoke: Extract<FilesystemParentMessage, { kind: "invoke" }> = {
    kind: "invoke",
    id: "request",
    policyIdentity: "policy",
    operation: "read_file",
    args: { path: "file.txt" },
    context,
  };
  expect(parseFilesystemParentMessage(invoke)).toEqual(invoke);
  expect(
    parseFilesystemParentMessage({
      ...invoke,
      context: { ...context, configurationRoots: { global_clarvis: "/global" } },
    }),
  ).toHaveProperty("kind", "invoke");
  const messages: FilesystemParentMessage[] = [
    { kind: "commit", id: "request", batchId: "batch", digest: "digest", route: "worker" },
    {
      kind: "commit",
      id: "request",
      batchId: "batch",
      digest: "digest",
      route: "classified-host",
    },
    { kind: "reject", id: "request", batchId: "batch" },
    { kind: "cancel", id: "request" },
    { kind: "close" },
  ];
  for (const message of messages) {
    expect(parseFilesystemParentMessage(message)).toEqual(message);
  }
  for (const invalid of [
    { ...invoke, args: ["file.txt"] },
    { ...invoke, policyIdentity: "" },
    { ...invoke, context: { ...context, temporaryRoots: [42] } },
    { ...invoke, context: { ...context, maxFileBytes: 0 } },
    { ...invoke, context: { ...context, extraMount: "/" } },
    { kind: "commit", id: "request", batchId: "batch", digest: "digest", route: "host" },
    { kind: "reject", id: "request", batchId: "" },
    { kind: "cancel", id: "" },
    { kind: "close", path: "/" },
  ]) {
    expect(() => parseFilesystemParentMessage(invalid)).toThrow();
  }
});

test("child events validate results and prepared mutations before host review", () => {
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
      phase: "review",
      operation: "write_file",
      path_role: "target",
      retryable: false,
    },
    {
      kind: "prepare",
      id: "request",
      batchId: "batch",
      digest: "digest",
      operations: [{ type: "modify", path: "/workspace/file", content: "fixed" }],
    },
  ];
  for (const message of messages) {
    expect(parseFilesystemChildMessage(message)).toEqual(message);
  }
  for (const invalid of [
    { kind: "result", id: "request", result: { isError: false, content: ["raw"] } },
    { kind: "result", id: "request", result: { isError: false, content: [] }, policy: "host" },
    {
      kind: "failure",
      version: 1,
      id: "request",
      code: "unknown",
      message: "refused",
      phase: "review",
      operation: "write_file",
      path_role: "target",
      retryable: false,
    },
    {
      kind: "failure",
      version: 2,
      id: "request",
      code: "denied",
      message: "refused",
      phase: "review",
      operation: "write_file",
      path_role: "target",
      retryable: false,
    },
    { kind: "prepare", id: "request", batchId: "batch", digest: "digest", operations: [] },
    {
      kind: "prepare",
      id: "request",
      batchId: "batch",
      digest: "digest",
      operations: [{ type: "modify", path: "/workspace/file", overwrite: "yes" }],
    },
  ]) {
    expect(() => parseFilesystemChildMessage(invalid)).toThrow();
  }
});

test("a mutation decision binds prepared bytes, request and policy", () => {
  const operations = [{ type: "modify" as const, path: "/tmp/file", content: "one" }];
  const digest = mutationDigest("policy-a", "request-a", operations);
  expect(digest).toBe(mutationDigest("policy-a", "request-a", operations));
  expect(digest).not.toBe(
    mutationDigest("policy-a", "request-a", [{ ...operations[0]!, content: "two" }]),
  );
  expect(digest).not.toBe(mutationDigest("policy-b", "request-a", operations));
  expect(digest).not.toBe(mutationDigest("policy-a", "request-b", operations));
});
