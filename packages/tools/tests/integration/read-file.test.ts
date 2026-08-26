import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { executableOnPath } from "@clarvis/paths";
import {
  makeWorkspace,
  cleanup,
  makeConfig,
  callTool,
  write,
  writeUtf16,
} from "../helpers/fixtures.ts";
import type { ServerConfig } from "../../src/config.ts";

const mkfifo = process.platform === "win32" ? undefined : executableOnPath("mkfifo");

describe("read_file", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root);
  });
  afterEach(() => cleanup(root));

  it("reads a UTF-16LE (BOM) file as text (BUG-19 fixed)", async () => {
    writeUtf16(root, "utf16.txt", "hello\nworld\n");
    const r = await callTool("read_file", { path: "utf16.txt" }, config);
    expect(r.isError).toBe(false);
    expect(r.text).toBe("     1\thello\n     2\tworld");
  });

  it("reads a UTF-16BE (BOM) file as text", async () => {
    writeUtf16(root, "utf16be.txt", "hello\nworld\n", true);
    const r = await callTool("read_file", { path: "utf16be.txt" }, config);
    expect(r.isError).toBe(false);
    expect(r.text).toBe("     1\thello\n     2\tworld");
  });

  it("rejects a file larger than maxFileBytes with too_large (finding 5.1)", async () => {
    write(root, "big.txt", "x".repeat(2048));
    const small = makeConfig(root, { maxFileBytes: 1024 });
    const r = await callTool("read_file", { path: "big.txt" }, small);
    expect(r.json.error).toBe("too_large");
    expect(r.json.size).toBe(2048);
    expect(r.json.limit).toBe(1024);
  });

  it("reads a file at exactly maxFileBytes (boundary)", async () => {
    write(root, "edge.txt", "x".repeat(1024));
    const r = await callTool(
      "read_file",
      { path: "edge.txt" },
      makeConfig(root, { maxFileBytes: 1024 }),
    );
    expect(r.isError).toBe(false);
  });

  it("byte-budgets output and keeps the continuation footer (finding 5.4)", async () => {
    const small = makeConfig(root, { maxOutputBytes: 200 });
    const lines = Array.from({ length: 50 }, (_, i) => `line number ${i + 1} with text`).join("\n");
    write(root, "many.txt", lines + "\n");
    const r = await callTool("read_file", { path: "many.txt" }, small);
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/lines shown; continue with offset=\d+ \.\.\.\]$/);
    expect(r.text).not.toContain("line number 50");
  });

  it("does not split a surrogate pair when truncating a long line (BUG-17)", async () => {
    write(root, "long.txt", "a".repeat(1999) + "😀" + "b".repeat(3000) + "\n");
    const r = await callTool("read_file", { path: "long.txt" }, config);
    expect(r.isError).toBe(false);
    expect(r.text).not.toContain("�");
    expect(r.text).toContain("line truncated");
  });

  it("returns content with 1-indexed line-number prefixes", async () => {
    write(root, "a.txt", "alpha\nbeta\ngamma\n");
    const r = await callTool("read_file", { path: "a.txt" }, config);
    expect(r.isError).toBe(false);
    expect(r.text).toBe("     1\talpha\n     2\tbeta\n     3\tgamma");
  });

  it("honors offset and limit, appending a continuation footer when more remains", async () => {
    write(root, "a.txt", "l1\nl2\nl3\nl4\nl5\n");
    const r = await callTool("read_file", { path: "a.txt", offset: 2, limit: 2 }, config);
    expect(r.text).toBe(
      "     2\tl2\n     3\tl3\n[... 2 of 5 lines shown; continue with offset=4 ...]",
    );
  });

  it("appends no footer when the slice reaches the end of the file", async () => {
    write(root, "a.txt", "l1\nl2\nl3\n");
    const r = await callTool("read_file", { path: "a.txt", offset: 2 }, config);
    expect(r.text).toBe("     2\tl2\n     3\tl3");
  });

  it("appends a continuation footer when the default 2000-line limit truncates", async () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
    write(root, "big.txt", lines);
    const r = await callTool("read_file", { path: "big.txt" }, config);
    expect(r.text).toContain("\tline2000");
    expect(r.text).not.toContain("\tline2001");
    expect(r.text).toContain("[... 2000 of 2500 lines shown; continue with offset=2001 ...]");
  });

  it("strips a UTF-8 BOM and normalizes CRLF in the displayed content", async () => {
    write(root, "win.txt", "﻿alpha\r\nbeta\r\n");
    const r = await callTool("read_file", { path: "win.txt" }, config);
    expect(r.text).toBe("     1\talpha\n     2\tbeta");
    expect(r.text).not.toContain("﻿");
    expect(r.text).not.toContain("\r");
  });

  it("truncates lines longer than 2000 chars", async () => {
    write(root, "long.txt", "x".repeat(2500) + "\n");
    const r = await callTool("read_file", { path: "long.txt" }, config);
    expect(r.text).toContain(" [... line truncated ...]");
    expect(r.text).toContain("x".repeat(2000));
    expect(r.text).not.toContain("x".repeat(2001));
  });

  it("errors not_found for a missing file", async () => {
    const r = await callTool("read_file", { path: "missing.txt" }, config);
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe("not_found");
  });

  it("errors not_a_file for a directory", async () => {
    write(root, "dir/inner.txt", "x");
    const r = await callTool("read_file", { path: "dir" }, config);
    expect(r.json.error).toBe("not_a_file");
  });

  it.skipIf(mkfifo === undefined)("rejects a FIFO without waiting for a writer", async () => {
    const fifo = path.join(root, "input.pipe");
    const created = spawnSync(mkfifo!, [fifo], { stdio: "ignore" });
    expect(created.status).toBe(0);

    const r = await callTool("read_file", { path: "input.pipe" }, config);
    expect(r.isError).toBe(true);
    expect(r.json).toMatchObject({ error: "not_a_file", path: "input.pipe" });
  });

  it("errors is_binary for a file with a NUL byte", async () => {
    write(root, "bin", "abc\0def");
    const r = await callTool("read_file", { path: "bin" }, config);
    expect(r.json.error).toBe("is_binary");
  });

  it("errors invalid_input when offset is past EOF", async () => {
    write(root, "a.txt", "one\ntwo\n");
    const r = await callTool("read_file", { path: "a.txt", offset: 99 }, config);
    expect(r.json.error).toBe("invalid_input");
    expect(r.json.line_count).toBe(2);
  });

  it("reads the tail with a negative offset", async () => {
    write(root, "a.txt", "l1\nl2\nl3\nl4\nl5\n");
    const r = await callTool("read_file", { path: "a.txt", offset: -2 }, config);
    expect(r.text).toBe("     4\tl4\n     5\tl5");
  });

  it("clamps a negative offset larger than the file to the first line", async () => {
    write(root, "a.txt", "l1\nl2\nl3\n");
    const r = await callTool("read_file", { path: "a.txt", offset: -100 }, config);
    expect(r.text).toBe("     1\tl1\n     2\tl2\n     3\tl3");
  });

  it("rejects offset 0 with invalid_input", async () => {
    write(root, "a.txt", "l1\nl2\n");
    const r = await callTool("read_file", { path: "a.txt", offset: 0 }, config);
    expect(r.json.error).toBe("invalid_input");
  });

  it("ignores out-of-schema extra fields", async () => {
    write(root, "a.txt", "x\n");
    const r = await callTool("read_file", { path: "a.txt", bogus: 1 }, config);
    expect(r.isError).toBe(false);
    expect(r.text).toBe("     1\tx");
  });

  it("rejects missing required field with invalid_input", async () => {
    const r = await callTool("read_file", {}, config);
    expect(r.json.error).toBe("invalid_input");
  });

  it("byte-caps an over-long line so no emitted line exceeds maxOutputBytes", async () => {
    const small = makeConfig(root, { maxOutputBytes: 1024 });
    write(root, "big.txt", "x".repeat(1900) + "\n" + "y\n");
    const r = await callTool("read_file", { path: "big.txt" }, small);
    expect(r.isError).toBe(false);
    for (const line of r.text.split("\n")) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(1024);
    }
    expect(r.text).toContain("[... line truncated ...]");
  });

  it("reports a zero-byte file as (empty file), distinct from a one-newline file", async () => {
    write(root, "empty.txt", "");
    write(root, "nl.txt", "\n");
    const empty = await callTool("read_file", { path: "empty.txt" }, config);
    const nl = await callTool("read_file", { path: "nl.txt" }, config);
    expect(empty.isError).toBe(false);
    expect(empty.text).toBe("(empty file)");

    expect(nl.text).not.toBe("(empty file)");
  });

  describe("multibyte byte-capping", () => {
    it("keeps a multibyte line under a 100-byte cap without splitting a character", async () => {
      const small = makeConfig(root, { maxOutputBytes: 100 });
      write(root, "euro.txt", "€".repeat(300) + "\n");
      const r = await callTool("read_file", { path: "euro.txt" }, small);
      expect(r.isError).toBe(false);
      expect(r.text).toContain("line truncated");
      expect(r.text).not.toContain("�");
      for (const line of r.text.split("\n")) {
        expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(100);
      }
    });

    it("keeps a multibyte line under a 101-byte cap without splitting a character", async () => {
      const small = makeConfig(root, { maxOutputBytes: 101 });
      write(root, "euro2.txt", "€".repeat(300) + "\n");
      const r = await callTool("read_file", { path: "euro2.txt" }, small);
      expect(r.isError).toBe(false);
      expect(r.text).toContain("line truncated");
      expect(r.text).not.toContain("�");
      for (const line of r.text.split("\n")) {
        expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(101);
      }
    });
  });
});
