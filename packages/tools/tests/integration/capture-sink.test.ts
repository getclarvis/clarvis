import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fsp, existsSync, mkdtempSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCaptureSink, CAPTURE_INLINE_FLOOR } from "../../src/lib/output.ts";
import { modeBitsEnforced } from "../helpers/fixtures.ts";

let root: string;
let spillCalls: number;

const INLINE = 4096;
const CAP = 1024 * 1024;

function target(name = "out.log"): { absPath: string; displayPath: string } {
  spillCalls++;
  const absPath = path.join(root, ".clarvis", name);
  return { absPath, displayPath: path.posix.join(".clarvis", name) };
}

function sink(overrides: { inlineLimit?: number; captureCap?: number } = {}) {
  return createCaptureSink({
    inlineLimit: overrides.inlineLimit ?? INLINE,
    captureCap: overrides.captureCap ?? CAP,
    spill: () => target(),
  });
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "clarvis-capture-sink-"));
  spillCalls = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("createCaptureSink — inline regime (parity with boundOrSpill)", () => {
  it("returns the text unchanged and never touches the disk when it fits the budget", async () => {
    const s = sink();
    s.push("hello ");
    s.push("world");
    expect(await s.finish(1000)).toBe("hello world");
    expect(existsSync(path.join(root, ".clarvis"))).toBe(false);
    expect(spillCalls).toBe(1);
  });

  it("spills the whole text and keeps the tail when it is under the inline limit but over the budget", async () => {
    const s = sink();
    const text = "abcdefghij".repeat(100);
    s.push(text);

    const out = await s.finish(64);

    expect(out).toContain("earlier output truncated");
    expect(out).toContain("full output written to .clarvis/out.log");
    expect(out.endsWith(text.slice(-64))).toBe(true);
    expect(readFileSync(path.join(root, ".clarvis", "out.log"), "utf8")).toBe(text);
  });
});

describe("createCaptureSink — write-through regime", () => {
  it("writes every observed byte to the spill file while holding only a bounded tail", async () => {
    const s = sink();
    const chunk = "x".repeat(1000);
    let peak = 0;
    for (let i = 0; i < 40; i++) {
      s.push(chunk);
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
      peak = Math.max(peak, s.residentBytes);
    }

    expect(s.bytes).toBe(40_000);
    expect(peak).toBeLessThanOrEqual(INLINE * 2);
    expect(peak).toBeLessThan(40_000);

    const out = await s.finish(512);
    expect(out).toContain("last 512 of 40000 bytes shown");
    expect(out).toContain("full output written to .clarvis/out.log");
    expect(out.endsWith("x".repeat(512))).toBe(true);
    expect(readFileSync(path.join(root, ".clarvis", "out.log"), "utf8")).toBe(chunk.repeat(40));
  });

  it("queues rather than drops when a synchronous burst outruns the write", async () => {
    const s = sink();
    for (let i = 0; i < 40; i++) s.push("x".repeat(1000));
    expect(s.residentBytes).toBeGreaterThan(INLINE * 2);

    await s.finish(512);

    expect(readFileSync(path.join(root, ".clarvis", "out.log"), "utf8")).toHaveLength(40_000);
  });

  it("asks for the spill target exactly once, no matter how many chunks arrive", async () => {
    const s = sink();
    for (let i = 0; i < 20; i++) s.push("y".repeat(1000));
    await s.finish(256);
    expect(spillCalls).toBe(1);
  });

  it("preserves chunk order in the spill file under a fast producer", async () => {
    const s = sink();
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) {
      const line = `line${i}\n`.padEnd(40, ".");
      lines.push(line);
      s.push(line);
    }
    await s.finish(256);
    expect(readFileSync(path.join(root, ".clarvis", "out.log"), "utf8")).toBe(lines.join(""));
  });

  it("cuts the retained tail on a UTF-8 boundary, leaving no replacement character", async () => {
    const s = sink({ inlineLimit: 1024 });
    const chunk = "é".repeat(500);
    for (let i = 0; i < 10; i++) s.push(chunk);

    const out = await s.finish(101);

    const tail = out.slice(out.indexOf("]\n") + 2);
    expect(tail).not.toContain("�");
    expect(tail.endsWith("é")).toBe(true);
    expect([...tail].every((c) => c === "é")).toBe(true);
    expect(readFileSync(path.join(root, ".clarvis", "out.log"), "utf8")).toBe(chunk.repeat(10));
  });

  it.skipIf(!modeBitsEnforced)(
    "degrades to a marker without a path when the spill cannot be written",
    async () => {
      const dir = path.join(root, ".clarvis");
      await fsp.mkdir(dir, { recursive: true });
      chmodSync(dir, 0o500);
      try {
        const s = sink();
        for (let i = 0; i < 40; i++) s.push("z".repeat(1000));

        const out = await s.finish(64);

        expect(out).toContain("earlier output truncated");
        expect(out).not.toContain("full output written to");
        expect(out.endsWith("z".repeat(64))).toBe(true);
        expect(s.bytes).toBe(40_000);
      } finally {
        chmodSync(dir, 0o700);
      }
    },
  );
});

describe("createCaptureSink — capture cap", () => {
  it("reports itself capped past the cap and ignores everything after", async () => {
    const s = sink({ captureCap: 10_000 });
    for (let i = 0; i < 11; i++) s.push("q".repeat(1000));
    expect(s.capped).toBe(true);
    expect(s.bytes).toBe(11_000);

    s.push("q".repeat(1000));
    expect(s.bytes).toBe(11_000);

    await s.finish(64);
    expect(readFileSync(path.join(root, ".clarvis", "out.log"), "utf8")).toHaveLength(11_000);
  });

  it("stays uncapped exactly at the cap", () => {
    const s = sink({ captureCap: 4000 });
    s.push("w".repeat(4000));
    expect(s.capped).toBe(false);
  });
});

describe("CAPTURE_INLINE_FLOOR", () => {
  it("is large enough to satisfy any inline budget the shell allocates", () => {
    expect(CAPTURE_INLINE_FLOOR).toBe(64 * 1024);
  });
});

describe("createCaptureSink — disposal", () => {
  it("releases the spill handle for a capture that is abandoned rather than finished", async () => {
    const s = sink();
    for (let i = 0; i < 40; i++) s.push("k".repeat(1000));

    await s.dispose();

    expect(s.residentBytes).toBe(0);
    expect(existsSync(path.join(root, ".clarvis", "out.log"))).toBe(true);
  });

  it("is idempotent and safe after finish", async () => {
    const s = sink();
    for (let i = 0; i < 40; i++) s.push("k".repeat(1000));
    await s.finish(64);

    await s.dispose();
    await s.dispose();

    expect(s.residentBytes).toBe(0);
  });

  it("is a no-op for a sink that never spilled", async () => {
    const s = sink();
    s.push("small");
    await s.dispose();
    expect(existsSync(path.join(root, ".clarvis"))).toBe(false);
  });
});
