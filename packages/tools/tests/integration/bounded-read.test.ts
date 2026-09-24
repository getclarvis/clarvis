import { afterEach, describe, expect, it, vi } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  promises as fs,
  rmSync,
  symlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileHandle } from "node:fs/promises";
import { ToolError } from "../../src/errors.ts";
import { listFiles, readRawFile } from "../../src/lib/files.ts";

afterEach(() => vi.restoreAllMocks());

describe("bounded descriptor reads", () => {
  it("verifies a Goal artifact against its opened workspace root", async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-artifact-root-"));
    const outside = mkdtempSync(join(tmpdir(), "clarvis-artifact-outside-"));
    try {
      const owned = join(root, "owned.txt");
      const external = join(outside, "external.txt");
      writeFileSync(owned, "owned");
      writeFileSync(external, "external");
      symlinkSync(external, join(root, "redirect.txt"));
      expect(
        (
          await readRawFile(owned, "owned.txt", 64, undefined, { expectedArtifactRoot: root })
        ).toString(),
      ).toBe("owned");
      await expect(
        readRawFile(join(root, "redirect.txt"), "redirect.txt", 64, undefined, {
          expectedArtifactRoot: root,
        }),
      ).rejects.toMatchObject({ code: "path_escape" });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reports a close failure after a successful descriptor read", async () => {
    let reads = 0;
    const handle = {
      async stat() {
        return { isFile: () => true, size: 2 } as Stats;
      },
      async read(buffer: Buffer) {
        if (reads++ === 0) {
          buffer.write("ok");
          return { bytesRead: 2, buffer };
        }
        return { bytesRead: 0, buffer };
      },
      async close() {
        throw Object.assign(new Error("close failed"), { code: "EIO" });
      },
    } as unknown as FileHandle;
    vi.spyOn(fs, "open").mockResolvedValue(handle);
    await expect(readRawFile("/fixture/read.txt", "read.txt", 2)).rejects.toMatchObject({
      code: "io_error",
    });
  });

  it("bounds a growing read even when its follow-up stat fails", async () => {
    let stats = 0;
    const handle = {
      async stat() {
        if (stats++ === 0) return { isFile: () => true, size: 4 } as Stats;
        throw Object.assign(new Error("stat failed"), { code: "EIO" });
      },
      async read(buffer: Buffer, _offset: number, length: number) {
        buffer.fill(0x61, 0, length);
        return { bytesRead: length, buffer };
      },
      async close() {},
    } as unknown as FileHandle;
    vi.spyOn(fs, "open").mockResolvedValue(handle);
    await expect(readRawFile("/fixture/growing.txt", "growing.txt", 8)).rejects.toMatchObject({
      code: "too_large",
      fields: { size: 9 },
    });
  });

  it("reports a failed canonical lookup for an opened Goal artifact", async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-artifact-root-"));
    try {
      const file = join(root, "owned.txt");
      writeFileSync(file, "owned");
      vi.spyOn(fs, "realpath").mockRejectedValueOnce(
        Object.assign(new Error("canonical lookup failed"), { code: "EIO" }),
      );
      await expect(
        readRawFile(file, "owned.txt", 64, undefined, { expectedArtifactRoot: root }),
      ).rejects.toMatchObject({ code: "io_error" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects growth while reading no more than maxBytes + 1 from one handle", async () => {
    const requested: number[] = [];
    let statCalls = 0;
    let closeCalls = 0;
    const handle = {
      async stat() {
        statCalls++;
        return {
          isFile: () => true,
          isDirectory: () => false,
          size: statCalls === 1 ? 4 : 32,
        } as Stats;
      },
      async read(buffer: Buffer, offset: number, length: number) {
        requested.push(length);
        buffer.fill(0x61, offset, offset + length);
        return { bytesRead: length, buffer };
      },
      async close() {
        closeCalls++;
      },
    } as unknown as FileHandle;
    const open = vi.spyOn(fs, "open").mockResolvedValue(handle);

    let failure: unknown;
    try {
      await readRawFile("/ignored/growing.txt", "growing.txt", 8, "MAX_FILE_BYTES");
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ToolError);
    expect(failure).toMatchObject({
      code: "too_large",
      fields: { path: "growing.txt", size: 32, limit: 8 },
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(requested).toEqual([9]);
    expect(statCalls).toBe(2);
    expect(closeCalls).toBe(1);
  });
});

describe("bounded file listing", () => {
  it("reports traversal truncation before entering a queued directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-list-bound-"));
    try {
      mkdirSync(join(root, "nested"));
      expect(
        await listFiles(root, root, { pattern: "**/*", respectGitignore: false, maxEntries: 1 }),
      ).toMatchObject({ files: [], truncated: true });
      expect(
        await listFiles(join(root, "missing"), root, {
          pattern: "**/*",
          respectGitignore: false,
        }),
      ).toMatchObject({ files: [], truncated: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
