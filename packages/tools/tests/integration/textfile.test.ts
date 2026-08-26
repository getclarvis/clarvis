import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { makeWorkspace, cleanup, write, writeBinary } from "../helpers/fixtures.ts";
import { readTextBuffer } from "../../src/lib/textfile.ts";

describe("readTextBuffer", () => {
  let root: string;
  beforeEach(() => {
    root = makeWorkspace();
  });
  afterEach(() => cleanup(root));

  it("decodes a readable text file", async () => {
    const p = write(root, "ok.txt", "hello\nworld\n");
    const result = await readTextBuffer(p, 1_000_000);
    expect(result).not.toBeNull();
    expect(result?.content).toBe("hello\nworld\n");
  });

  it("returns null when the file exceeds the size limit", async () => {
    const p = write(root, "big.txt", "hello world\n");
    const result = await readTextBuffer(p, 0);
    expect(result).toBeNull();
  });

  it("returns null for a binary file", async () => {
    const p = writeBinary(root, "blob.bin");
    const result = await readTextBuffer(p, 1_000_000);
    expect(result).toBeNull();
  });

  it("returns null when the file does not exist", async () => {
    const result = await readTextBuffer(path.join(root, "does-not-exist.txt"), 1_000_000);
    expect(result).toBeNull();
  });

  it("returns null when the target is a directory", async () => {
    const dir = path.join(root, "a-directory");
    mkdirSync(dir);
    const result = await readTextBuffer(dir, 1_000_000);
    expect(result).toBeNull();
  });
});
