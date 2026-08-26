import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  makeWorkspace,
  cleanup,
  makeConfig,
  callTool,
  write,
  exists,
  read,
  modeBitsEnforced,
} from "../helpers/fixtures.ts";
import {
  allocateBudget,
  bound,
  boundOrSpill,
  createOutputCoalescer,
} from "../../src/lib/output.ts";
import type { ServerConfig } from "../../src/config.ts";

describe("bound()", () => {
  it("returns the input unchanged when it fits", () => {
    expect(bound("short", 1000)).toBe("short");
  });

  it("appends the truncation marker when oversized", () => {
    const out = bound("x".repeat(200), 50);
    expect(out).toMatch(/\[\.\.\. output truncated: \d+ of 200 bytes shown \.\.\.\]$/);
    expect(out.startsWith("x".repeat(50))).toBe(true);
  });

  it("never splits a multibyte character at the cut boundary", () => {
    for (const ch of ["😀", "中"]) {
      const out = bound(ch.repeat(50), 10);
      expect(out).not.toContain("�");
      const shown = out.split("\n[...")[0]!;
      expect(Buffer.from(shown, "utf8").toString("utf8")).toBe(shown);
    }
  });
});

describe("allocateBudget()", () => {
  it("keeps both when they fit within total", () => {
    expect(allocateBudget(10, 20, 100)).toEqual([10, 20]);
  });

  it("gives a its ask and the rest to b when a is within half", () => {
    expect(allocateBudget(20, 200, 100)).toEqual([20, 80]);
  });

  it("gives b its ask and the rest to a when b is within half", () => {
    expect(allocateBudget(200, 20, 100)).toEqual([80, 20]);
  });

  it("splits evenly when both exceed half", () => {
    expect(allocateBudget(200, 200, 100)).toEqual([50, 50]);
  });
});

describe("createOutputCoalescer()", () => {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it("batches pushes within one interval into a single emit", async () => {
    const emitted: string[] = [];
    const c = createOutputCoalescer((chunk) => emitted.push(chunk), 20);
    c.push("one\n");
    c.push("two\n");
    expect(emitted).toEqual([]);
    await sleep(40);
    expect(emitted).toEqual(["one\ntwo\n"]);
  });

  it("starts a fresh batch after each flush, keeping chunks incremental", async () => {
    const emitted: string[] = [];
    const c = createOutputCoalescer((chunk) => emitted.push(chunk), 20);
    c.push("one");
    await sleep(40);
    c.push("two");
    c.push("three");
    await sleep(40);
    expect(emitted).toEqual(["one", "twothree"]);
  });

  it("flushes the pending tail synchronously on settle and ignores later pushes", () => {
    const emitted: string[] = [];
    const c = createOutputCoalescer((chunk) => emitted.push(chunk), 60_000);
    c.push("last words");
    c.settle();
    expect(emitted).toEqual(["last words"]);
    c.push("after death");
    c.settle();
    expect(emitted).toEqual(["last words"]);
  });

  it("keeps only the tail of an oversized batch (the consumer renders a tail)", () => {
    const emitted: string[] = [];
    const c = createOutputCoalescer((chunk) => emitted.push(chunk), 60_000);
    c.push("HEAD" + "x".repeat(10_000) + "TAIL");
    c.settle();
    expect(emitted).toHaveLength(1);
    expect(Buffer.byteLength(emitted[0]!, "utf8")).toBeLessThanOrEqual(8192);
    expect(emitted[0]!.endsWith("TAIL")).toBe(true);
    expect(emitted[0]!.includes("HEAD")).toBe(false);
  });

  it("swallows a throwing emit instead of breaking the producer", () => {
    const c = createOutputCoalescer(() => {
      throw new Error("consumer broke");
    }, 60_000);
    c.push("data");
    expect(() => c.settle()).not.toThrow();
  });
});

describe("boundOrSpill()", () => {
  let root: string;

  beforeEach(() => {
    root = makeWorkspace();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup(root);
  });

  it("returns the text unchanged when it fits within maxBytes", async () => {
    const text = "small";
    const out = await boundOrSpill(text, 1000, {
      absPath: path.join(root, ".clarvis", "bash-stdout.txt"),
      displayPath: ".clarvis/bash-stdout.txt",
    });
    expect(out).toBe(text);
    expect(exists(root, ".clarvis/bash-stdout.txt")).toBe(false);
  });

  it("spills the full output and keeps the TAIL inline", async () => {
    const text = "HEAD" + "A".repeat(500) + "TAIL";
    const out = await boundOrSpill(text, 50, {
      absPath: path.join(root, ".clarvis", "bash-stdout.txt"),
      displayPath: ".clarvis/bash-stdout.txt",
    });
    expect(out).toContain("full output written to .clarvis/bash-stdout.txt");
    expect(out.endsWith("TAIL")).toBe(true);
    expect(out).not.toContain("HEAD");
    expect(out.startsWith("[... earlier output truncated")).toBe(true);
    expect(read(root, ".clarvis/bash-stdout.txt")).toBe(text);
  });

  it.skipIf(!modeBitsEnforced)("writes the spill owner-only", async () => {
    const text = "A".repeat(500);
    const absPath = path.join(root, ".clarvis", "bash-stdout.txt");

    await boundOrSpill(text, 50, { absPath, displayPath: ".clarvis/bash-stdout.txt" });

    expect(statSync(absPath).mode & 0o777).toBe(0o600);
  });

  it("cuts the tail on a valid UTF-8 boundary (no broken multibyte char)", async () => {
    const text = "x".repeat(20) + "é".repeat(20);
    const out = await boundOrSpill(text, 15, {
      absPath: path.join(root, ".clarvis", "bash-stdout.txt"),
      displayPath: ".clarvis/bash-stdout.txt",
    });
    expect(out).not.toContain("�");
    expect(out.endsWith("é")).toBe(true);
    expect(read(root, ".clarvis/bash-stdout.txt")).toBe(text);
  });

  it("writes into a directory it does not itself have to ignore", async () => {
    const dir = path.join(root, ".clarvis");
    mkdirSync(dir, { recursive: true });

    const text = "B".repeat(400);
    const out = await boundOrSpill(text, 40, {
      absPath: path.join(dir, "bash-stderr.txt"),
      displayPath: ".clarvis/bash-stderr.txt",
    });
    expect(out).toContain("full output written to .clarvis/bash-stderr.txt");
    expect(read(root, ".clarvis/bash-stderr.txt")).toBe(text);
    expect(existsSync(path.join(dir, ".gitignore"))).toBe(false);
  });

  it("falls back to the plain truncation marker when the spill write fails", async () => {
    const blocker = path.join(root, "blk");
    writeFileSync(blocker, "not a dir");

    const text = "C".repeat(300);
    const out = await boundOrSpill(text, 30, {
      absPath: path.join(blocker, "sub", "bash-stdout.txt"),
      displayPath: "blk/sub/bash-stdout.txt",
    });
    expect(out).toMatch(
      /^\[\.\.\. earlier output truncated: last \d+ of \d+ bytes shown \.\.\.\]\n/,
    );
    expect(out).not.toContain("full output written");
  });
});

describe("tool-level output bounding", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root, { maxOutputBytes: 100, maxShellOutputBytes: 100 });
  });
  afterEach(() => cleanup(root));

  it("truncates an oversized tool result with the marker", async () => {
    for (let i = 0; i < 30; i++) write(root, `file-with-a-fairly-long-name-${i}.txt`, "x");
    const r = await callTool("list_dir", { path: "." }, config);
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/\[\.\.\. output truncated: \d+ of \d+ bytes shown \.\.\.\]$/);
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThan(300);
  });

  it("bounds bash stdout per stream", async () => {
    const r = await callTool("shell", { command: "printf 'B%.0s' $(seq 1 5000)" }, config);
    expect(r.isError).toBe(false);
    expect(r.json.stdout).toContain("output truncated:");
  });
});
