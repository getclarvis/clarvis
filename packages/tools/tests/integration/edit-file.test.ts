import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applyEdit } from "../../src/tools/edit-file.ts";
import { ToolError } from "../../src/errors.ts";
import {
  makeWorkspace,
  cleanup,
  makeConfig,
  callTool,
  write,
  read,
  writeUtf16,
  chmod,
  mode,
  modeBitsEnforced,
} from "../helpers/fixtures.ts";
import type { ServerConfig } from "../../src/config.ts";

function toolError(fn: () => unknown): ToolError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ToolError) return e;
    throw e;
  }
  throw new Error("expected applyEdit to throw a ToolError");
}

describe("edit_file", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root);
  });
  afterEach(() => cleanup(root));

  it("refuses to edit a file larger than maxFileBytes (finding 5.1)", async () => {
    write(root, "big.txt", "beta ".repeat(500));
    const small = makeConfig(root, { maxFileBytes: 1024 });
    const r = await callTool(
      "edit_file",
      { path: "big.txt", old_string: "beta", new_string: "BETA" },
      small,
    );
    expect(r.json.error).toBe("too_large");
    expect(read(root, "big.txt")).toBe("beta ".repeat(500));
  });

  it("refuses to edit a UTF-16 file (no silent transcode to UTF-8)", async () => {
    writeUtf16(root, "u16.txt", "alpha beta gamma\n");
    const r = await callTool(
      "edit_file",
      { path: "u16.txt", old_string: "beta", new_string: "BETA" },
      config,
    );
    expect(r.json.error).toBe("is_binary");
  });

  it("replaces a unique occurrence", async () => {
    write(root, "f.txt", "alpha beta gamma");
    const r = await callTool(
      "edit_file",
      { path: "f.txt", old_string: "beta", new_string: "BETA" },
      config,
    );
    expect(r.text).toBe("Replaced 1 occurrence in f.txt.");
    expect(read(root, "f.txt")).toBe("alpha BETA gamma");
  });

  it("replaces all occurrences with replace_all", async () => {
    write(root, "f.txt", "x x x");
    const r = await callTool(
      "edit_file",
      { path: "f.txt", old_string: "x", new_string: "y", replace_all: true },
      config,
    );
    expect(r.text).toBe("Replaced 3 occurrences in f.txt.");
    expect(read(root, "f.txt")).toBe("y y y");
  });

  it("matches an LF old_string against a CRLF file and preserves CRLF on disk", async () => {
    write(root, "win.txt", "alpha\r\nbeta\r\ngamma\r\n");
    const r = await callTool(
      "edit_file",
      { path: "win.txt", old_string: "beta\ngamma", new_string: "BETA\nGAMMA" },
      config,
    );
    expect(r.isError).toBe(false);
    expect(read(root, "win.txt")).toBe("alpha\r\nBETA\r\nGAMMA\r\n");
  });

  it("rejects an empty old_string with invalid_input (BUG-14)", async () => {
    write(root, "f.txt", "hello");
    const r = await callTool(
      "edit_file",
      { path: "f.txt", old_string: "", new_string: "x" },
      config,
    );
    expect(r.json.error).toBe("invalid_input");
  });

  it("edits a mixed-EOL file without rewriting untouched lines (BUG-07)", async () => {
    write(root, "mixed.txt", "alpha\r\nbeta\r\ngamma\ndelta\r\n");
    const r = await callTool(
      "edit_file",
      { path: "mixed.txt", old_string: "alpha", new_string: "ALPHA" },
      config,
    );
    expect(r.isError).toBe(false);
    expect(read(root, "mixed.txt")).toBe("ALPHA\r\nbeta\r\ngamma\ndelta\r\n");
  });

  it("preserves a UTF-8 BOM through an edit", async () => {
    write(root, "bom.txt", "﻿alpha beta");
    const r = await callTool(
      "edit_file",
      { path: "bom.txt", old_string: "alpha", new_string: "ALPHA" },
      config,
    );
    expect(r.isError).toBe(false);
    expect(read(root, "bom.txt")).toBe("﻿ALPHA beta");
  });

  it("errors no_match when old_string is absent, teaching the remedy", async () => {
    write(root, "f.txt", "hello");
    const r = await callTool(
      "edit_file",
      { path: "f.txt", old_string: "zzz", new_string: "y" },
      config,
    );
    expect(r.json.error).toBe("no_match");
    expect(r.json.message).toContain("byte-for-byte");
  });

  it("errors ambiguous_match and leaves the file unchanged", async () => {
    write(root, "f.txt", "dup dup");
    const r = await callTool(
      "edit_file",
      { path: "f.txt", old_string: "dup", new_string: "x" },
      config,
    );
    expect(r.json.error).toBe("ambiguous_match");
    expect(read(root, "f.txt")).toBe("dup dup");
  });

  it("errors invalid_input when old_string == new_string", async () => {
    write(root, "f.txt", "abc");
    const r = await callTool(
      "edit_file",
      { path: "f.txt", old_string: "abc", new_string: "abc" },
      config,
    );
    expect(r.json.error).toBe("invalid_input");
  });

  it("errors is_binary for a binary file", async () => {
    write(root, "bin", "a\0b");
    const r = await callTool(
      "edit_file",
      { path: "bin", old_string: "a", new_string: "c" },
      config,
    );
    expect(r.json.error).toBe("is_binary");
  });

  it("errors not_found for a missing file", async () => {
    const r = await callTool(
      "edit_file",
      { path: "nope", old_string: "a", new_string: "b" },
      config,
    );
    expect(r.json.error).toBe("not_found");
  });

  it("serializes concurrent edits to the same file without lost updates", async () => {
    write(root, "c.txt", "one two");
    const [a, b] = await Promise.all([
      callTool("edit_file", { path: "c.txt", old_string: "one", new_string: "ONE" }, config),
      callTool("edit_file", { path: "c.txt", old_string: "two", new_string: "TWO" }, config),
    ]);
    expect(a.isError).toBe(false);
    expect(b.isError).toBe(false);

    expect(read(root, "c.txt")).toBe("ONE TWO");
  });

  it("ignores out-of-schema extra fields", async () => {
    write(root, "f.txt", "x");
    const r = await callTool(
      "edit_file",
      { path: "f.txt", old_string: "x", new_string: "y", bogus: 1 },
      config,
    );
    expect(r.isError).toBe(false);
    expect(read(root, "f.txt")).toBe("y");
  });

  it("on no_match, flags a pasted read_file line-number prefix", async () => {
    write(root, "a.ts", "function foo() {\n  return 1;\n}\n");
    const r = await callTool(
      "edit_file",
      { path: "a.ts", old_string: "     2\t  return 1;", new_string: "  return 2;" },
      config,
    );
    expect(r.json.error).toBe("no_match");
    expect(r.json.message).toContain("line-number prefixes");
  });

  it("recovers from an indentation mismatch via the whitespace-tolerant cascade", async () => {
    write(root, "a.ts", "function foo() {\n  return 1;\n}\n");

    const r = await callTool(
      "edit_file",
      { path: "a.ts", old_string: "    return 1;", new_string: "    return 9;" },
      config,
    );
    expect(r.isError).toBe(false);
    expect(r.text).toContain("whitespace-tolerant");
    expect(read(root, "a.ts")).toBe("function foo() {\n    return 9;\n}\n");
  });

  it("keeps the whitespace-differs diagnostic on no_match under replace_all (cascade skipped)", async () => {
    write(root, "a.ts", "function foo() {\n  return 1;\n}\n");

    const r = await callTool(
      "edit_file",
      { path: "a.ts", old_string: "    return 1;", new_string: "    return 9;", replace_all: true },
      config,
    );
    expect(r.json.error).toBe("no_match");
    expect(r.json.message).toMatch(/whitespace.*differs/);
    expect(r.json.message).toContain("line 2");
  });

  it("on ambiguous_match, lists the occurrence line numbers", async () => {
    write(root, "c.txt", "dup\nx\ndup\ny\ndup\n");
    const r = await callTool(
      "edit_file",
      { path: "c.txt", old_string: "dup", new_string: "z" },
      config,
    );
    expect(r.json.error).toBe("ambiguous_match");
    expect(r.json.message).toContain("lines 1, 3, 5");
  });

  it("normalizes a CR in new_string so an LF file stays pure LF", async () => {
    write(root, "lf.txt", "line1\nline2\nline3\n");
    const r = await callTool(
      "edit_file",
      { path: "lf.txt", old_string: "line2", new_string: "alpha\r\nbeta" },
      config,
    );
    expect(r.isError).toBe(false);
    expect(read(root, "lf.txt")).toBe("line1\nalpha\nbeta\nline3\n");
  });

  it.skipIf(!modeBitsEnforced)("preserves the executable bit of the edited file", async () => {
    write(root, "s.sh", "echo hi\n");
    chmod(root, "s.sh", 0o755);
    const r = await callTool(
      "edit_file",
      { path: "s.sh", old_string: "hi", new_string: "hello" },
      config,
    );
    expect(r.isError).toBe(false);
    expect(mode(root, "s.sh")).toBe(0o755);
  });
});

describe("edit_file whitespace-tolerant cascade", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root);
  });
  afterEach(() => cleanup(root));

  it("indentation-flexible: matches a uniformly-indented block", async () => {
    write(root, "f.txt", "  a\n  b\n  c\n");
    const r = await callTool(
      "edit_file",
      { path: "f.txt", old_string: "a\nb", new_string: "X" },
      config,
    );
    expect(r.isError).toBe(false);
    expect(read(root, "f.txt")).toBe("X\n  c\n");
  });

  it("honors a trailing newline in old_string (eats no extra line break)", async () => {
    write(root, "f.txt", "  a\n  b\n  c\n");
    const r = await callTool(
      "edit_file",
      { path: "f.txt", old_string: "a\nb\n", new_string: "X" },
      config,
    );
    expect(r.isError).toBe(false);
    expect(read(root, "f.txt")).toBe("X  c\n");
  });

  it("line-trimmed: matches when relative indentation differs", async () => {
    write(root, "f.txt", "if (x) {\n        doThing();\n}\n");
    const r = await callTool(
      "edit_file",
      {
        path: "f.txt",
        old_string: "if (x) {\n  doThing();\n}",
        new_string: "if (x) {\n    doThing2();\n}",
      },
      config,
    );
    expect(r.isError).toBe(false);
    expect(read(root, "f.txt")).toBe("if (x) {\n    doThing2();\n}\n");
  });

  it("whitespace-normalized: matches collapsed internal spacing (loosest tier)", async () => {
    write(root, "f.txt", "a   +   b\n");
    const r = await callTool(
      "edit_file",
      { path: "f.txt", old_string: "a + b", new_string: "SUM" },
      config,
    );
    expect(r.isError).toBe(false);
    expect(read(root, "f.txt")).toBe("SUM\n");
  });

  it("trimmed-boundary: matches a sub-line fragment as a last resort", async () => {
    write(root, "f.txt", "  result = foo(a, b);\n");
    const r = await callTool(
      "edit_file",
      { path: "f.txt", old_string: "  foo(a, b)  ", new_string: "bar(c)" },
      config,
    );
    expect(r.isError).toBe(false);
    expect(read(root, "f.txt")).toBe("  result = bar(c);\n");
  });

  it("refuses an ambiguous tolerant match and writes nothing", async () => {
    const original = "  a\n    b\nx\n  a\n    b\n";
    write(root, "f.txt", original);
    const r = await callTool(
      "edit_file",
      { path: "f.txt", old_string: "a\nb", new_string: "Q" },
      config,
    );
    expect(r.json.error).toBe("ambiguous_match");
    expect(r.json.message).toContain("whitespace-tolerant");
    expect(read(root, "f.txt")).toBe(original);
  });

  it("a genuine miss still returns no_match", async () => {
    write(root, "f.txt", "alpha\nbeta\n");
    const r = await callTool(
      "edit_file",
      { path: "f.txt", old_string: "zzz\nyyy", new_string: "Q" },
      config,
    );
    expect(r.json.error).toBe("no_match");
  });

  it("an exact match is unaffected and not disclosed as tolerant", async () => {
    write(root, "f.txt", "alpha\nbeta\n");
    const r = await callTool(
      "edit_file",
      { path: "f.txt", old_string: "beta", new_string: "BETA" },
      config,
    );
    expect(r.text).toBe("Replaced 1 occurrence in f.txt.");
    expect(read(root, "f.txt")).toBe("alpha\nBETA\n");
  });
});

describe("edit_file no-match and ambiguous diagnostics", () => {
  it("returns no_match when the search string is empty", () => {
    const e = toolError(() => applyEdit("hello world", { old_string: "", new_string: "x" }));
    expect(e.code).toBe("no_match");
  });

  it("names the one line whose whitespace differs, in the singular", () => {
    const e = toolError(() =>
      applyEdit("foo\n", { old_string: "  foo", new_string: "X", replace_all: true }),
    );
    expect(e.code).toBe("no_match");
    expect(e.message).toContain("line 1 but");
  });

  it("lists every whitespace-differing line, pluralized, when there are only a few", () => {
    const e = toolError(() =>
      applyEdit("foo\nfoo\nfoo\n", { old_string: "  foo", new_string: "X", replace_all: true }),
    );
    expect(e.code).toBe("no_match");
    expect(e.message).toContain("lines 1, 2, 3 but");
    expect(e.message).not.toContain("…");
  });

  it("caps the whitespace-differing line list at five with a trailing ellipsis", () => {
    const e = toolError(() =>
      applyEdit("foo\nfoo\nfoo\nfoo\nfoo\nfoo\nfoo\n", {
        old_string: "  foo",
        new_string: "X",
        replace_all: true,
      }),
    );
    expect(e.code).toBe("no_match");
    expect(e.message).toContain("lines 1, 2, 3, 4, 5, …");
  });

  it("lists every ambiguous occurrence line when there are only a few", () => {
    const e = toolError(() => applyEdit("x\nx\n", { old_string: "x", new_string: "y" }));
    expect(e.code).toBe("ambiguous_match");
    expect(e.message).toContain("at lines 1, 2)");
    expect(e.message).not.toContain("…");
  });

  it("caps the ambiguous occurrence list with a trailing ellipsis beyond twenty", () => {
    const text = Array.from({ length: 21 }, () => "x").join("\n");
    const e = toolError(() => applyEdit(text, { old_string: "x", new_string: "y" }));
    expect(e.code).toBe("ambiguous_match");
    expect(e.message).toContain("21 times");
    expect(e.message).toContain(", …)");
  });
});
