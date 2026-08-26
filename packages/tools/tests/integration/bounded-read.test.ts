import { afterEach, describe, expect, it, vi } from "bun:test";
import { promises as fs, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { ToolError } from "../../src/errors.ts";
import { readRawFile } from "../../src/lib/files.ts";

afterEach(() => vi.restoreAllMocks());

describe("bounded descriptor reads", () => {
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
