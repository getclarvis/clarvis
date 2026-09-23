import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { makeWorkspace, cleanup, makeConfig, callTool, write } from "../helpers/fixtures.ts";
import { allocateBudget, bound, createOutputCoalescer } from "../../src/lib/output.ts";
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

  it("bounds pending live output across a continuous burst", () => {
    const emitted: string[] = [];
    const c = createOutputCoalescer((chunk) => emitted.push(chunk), 60_000);
    for (let i = 0; i < 1000; i++) {
      c.push("x".repeat(1024));
      expect(c.residentBytes).toBeLessThanOrEqual(8192);
    }
    c.settle();
    expect(emitted).toHaveLength(1);
    expect(Buffer.byteLength(emitted[0]!, "utf8")).toBe(8192);
  });

  it("swallows a throwing emit instead of breaking the producer", () => {
    const c = createOutputCoalescer(() => {
      throw new Error("consumer broke");
    }, 60_000);
    c.push("data");
    expect(() => c.settle()).not.toThrow();
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
