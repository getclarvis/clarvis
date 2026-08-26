import { promises as fs, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { readLogSlice } from "../../src/lib/logslice.ts";
import { makeWorkspace, cleanup } from "../helpers/fixtures.ts";

describe("readLogSlice", () => {
  let root: string;
  beforeEach(() => {
    root = makeWorkspace();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup(root);
  });

  function log(rel: string, content: string | Buffer): string {
    const p = path.join(root, rel);
    writeFileSync(p, content);
    return p;
  }

  it("returns empty for a missing file", async () => {
    const r = await readLogSlice(path.join(root, "nope.log"), 0, 1000);
    expect(r).toEqual({ text: "", nextOffset: 0, total: 0, more: false });
  });

  it("reads the whole file when it fits the budget", async () => {
    const p = log("a.log", "hello\nworld\n");
    const r = await readLogSlice(p, 0, 1000);
    expect(r.text).toBe("hello\nworld\n");
    expect(r.total).toBe(12);
    expect(r.nextOffset).toBe(12);
    expect(r.more).toBe(false);
  });

  it("takes size and bytes from the same descriptor after a pathname race", async () => {
    const target = log("a.log", "old");
    const replacement = log("replacement.log", "replacement");
    const originalOpen = fs.open;
    vi.spyOn(fs, "open").mockImplementationOnce(async (file, flags, mode) => {
      renameSync(replacement, target);
      return originalOpen(file, flags, mode);
    });

    const r = await readLogSlice(target, 0, 1000);
    expect(r).toEqual({ text: "replacement", nextOffset: 11, total: 11, more: false });
  });

  it("reads from an offset to EOF", async () => {
    const p = log("a.log", "hello\nworld\n");
    const r = await readLogSlice(p, 6, 1000);
    expect(r.text).toBe("world\n");
    expect(r.nextOffset).toBe(12);
    expect(r.more).toBe(false);
  });

  it("returns empty and clamps when the offset is at or past EOF", async () => {
    const p = log("a.log", "abc");
    const at = await readLogSlice(p, 3, 1000);
    expect(at).toEqual({ text: "", nextOffset: 3, total: 3, more: false });
    const past = await readLogSlice(p, 99, 1000);
    expect(past.nextOffset).toBe(3);
    expect(past.text).toBe("");
  });

  it("clamps a negative offset to zero", async () => {
    const p = log("a.log", "abc");
    const r = await readLogSlice(p, -5, 1000);
    expect(r.text).toBe("abc");
    expect(r.nextOffset).toBe(3);
  });

  it("truncates to maxBytes and reports more", async () => {
    const p = log("a.log", "0123456789");
    const r = await readLogSlice(p, 0, 4);
    expect(r.text).toBe("0123");
    expect(r.nextOffset).toBe(4);
    expect(r.more).toBe(true);
    expect(r.total).toBe(10);
  });

  it("does not split a multibyte char at the budget boundary", async () => {
    const p = log("u.log", Buffer.from("aé", "utf8"));
    const r = await readLogSlice(p, 0, 2);
    expect(r.text).toBe("a");
    expect(r.nextOffset).toBe(1);
    expect(r.more).toBe(true);
  });

  it("keeps a complete multibyte char that ends exactly at the boundary", async () => {
    const p = log("u.log", Buffer.from("aé", "utf8"));
    const r = await readLogSlice(p, 0, 3);
    expect(r.text).toBe("aé");
    expect(r.nextOffset).toBe(3);
    expect(r.more).toBe(false);
  });

  it("backs off a 3-byte char cut mid-sequence to the previous complete char", async () => {
    const p = log("u.log", Buffer.from("a€b", "utf8"));
    const r = await readLogSlice(p, 0, 3);
    expect(r.text).toBe("a");
    expect(r.nextOffset).toBe(1);
    expect(r.more).toBe(true);
  });

  it("backs off a 4-byte char cut mid-sequence", async () => {
    const p = log("u.log", Buffer.from("a😀", "utf8"));
    const r = await readLogSlice(p, 0, 3);
    expect(r.text).toBe("a");
    expect(r.nextOffset).toBe(1);
    expect(r.more).toBe(true);
  });

  it("still makes progress when a single char is larger than the budget", async () => {
    const p = log("u.log", Buffer.from("éz", "utf8"));
    const r = await readLogSlice(p, 0, 1);
    expect(r.nextOffset).toBe(1);
    expect(r.more).toBe(true);
  });

  it("makes progress when the read starts on orphaned continuation bytes", async () => {
    const p = log("u.log", Buffer.from([0x80, 0x81, 0x82, 0x41]));
    const r = await readLogSlice(p, 0, 3);
    expect(r.nextOffset).toBe(3);
    expect(r.more).toBe(true);
  });
});
