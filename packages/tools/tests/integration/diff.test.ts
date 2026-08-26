import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  makeWorkspace,
  cleanup,
  makeConfig,
  callTool,
  write,
  writeBinary,
} from "../helpers/fixtures.ts";
import type { ServerConfig } from "../../src/config.ts";

let root: string;
let config: ServerConfig;

beforeEach(() => {
  root = makeWorkspace();
  config = makeConfig(root);
});
afterEach(() => cleanup(root));

describe("diff — two-file unified diff", () => {
  it("emits unified-diff hunks for differing files", async () => {
    write(root, "a.ts", "x\ny\nz\n");
    write(root, "b.ts", "x\nY\nz\n");
    const r = await callTool("diff", { from: "a.ts", to: "b.ts" }, config);
    expect(r.isError).toBe(false);
    expect(r.text).toContain("--- a.ts");
    expect(r.text).toContain("+++ b.ts");
    expect(r.text).toContain("@@");
    expect(r.text).toContain("-y");
    expect(r.text).toContain("+Y");
  });

  it("reports no differences for identical content", async () => {
    write(root, "a.ts", "same\n");
    write(root, "b.ts", "same\n");
    const r = await callTool("diff", { from: "a.ts", to: "b.ts" }, config);
    expect(r.text).toBe("(no differences)");
  });

  it("treats CRLF vs LF as identical after normalization", async () => {
    write(root, "lf.txt", "a\nb\n");
    write(root, "crlf.txt", "a\r\nb\r\n");
    const r = await callTool("diff", { from: "lf.txt", to: "crlf.txt" }, config);
    expect(r.text).toBe("(no differences)");
  });

  it("returns not_found for a missing operand", async () => {
    write(root, "a.ts", "x\n");
    const r = await callTool("diff", { from: "a.ts", to: "missing.ts" }, config);
    expect(r.isError).toBe(true);
    expect(r.json).toMatchObject({ error: "not_found" });
  });

  it("refuses a binary operand", async () => {
    write(root, "a.ts", "x\n");
    writeBinary(root, "b.dat");
    const r = await callTool("diff", { from: "a.ts", to: "b.dat" }, config);
    expect(r.isError).toBe(true);
    expect(r.json).toMatchObject({ error: "is_binary" });
  });

  it("rejects an operand exceeding maxFileBytes", async () => {
    write(root, "a.ts", "x\n");
    write(root, "big.ts", "y\n".repeat(50));
    const tiny = makeConfig(root, { maxFileBytes: 10 });
    const r = await callTool("diff", { from: "a.ts", to: "big.ts" }, tiny);
    expect(r.isError).toBe(true);
    expect(r.json).toMatchObject({ error: "too_large" });
  });

  it("is bounded by the dispatcher for a huge diff", async () => {
    write(root, "a.ts", "");
    write(root, "b.ts", `${Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n")}\n`);
    const small = makeConfig(root, { maxOutputBytes: 500 });
    const r = await callTool("diff", { from: "a.ts", to: "b.ts" }, small);
    expect(r.isError).toBe(false);
    expect(r.text).toContain("output truncated");
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThan(700);
  });

  it("rejects combined inputs above the dedicated diff budget", async () => {
    write(root, "a.ts", "a".repeat(700));
    write(root, "b.ts", "b".repeat(700));
    const small = makeConfig(root, { maxDiffInputBytes: 1024 });

    const result = await callTool("diff", { from: "a.ts", to: "b.ts" }, small);

    expect(result.isError).toBe(true);
    expect(result.json).toMatchObject({ error: "too_large", limit: 1024 });
  });
});
