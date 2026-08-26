import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { multiEdit } from "../../src/tools/multi-edit.ts";
import {
  makeWorkspace,
  cleanup,
  makeConfig,
  callTool,
  handlerText,
  write,
  read,
} from "../helpers/fixtures.ts";
import type { ServerConfig } from "../../src/config.ts";

describe("multi_edit", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root);
  });
  afterEach(() => cleanup(root));

  it("applies edits sequentially (each on the previous result)", async () => {
    write(root, "f.txt", "foo");
    const r = await callTool(
      "multi_edit",
      {
        path: "f.txt",
        edits: [
          { old_string: "foo", new_string: "bar" },
          { old_string: "bar", new_string: "baz" },
        ],
      },
      config,
    );
    expect(r.text).toBe("Applied 2 edits to f.txt.");
    expect(read(root, "f.txt")).toBe("baz");
  });

  it("is all-or-nothing: a failing edit reverts everything and reports its index", async () => {
    write(root, "f.txt", "hello world");
    const r = await callTool(
      "multi_edit",
      {
        path: "f.txt",
        edits: [
          { old_string: "hello", new_string: "hi" },
          { old_string: "zzz", new_string: "x" },
        ],
      },
      config,
    );
    expect(r.json.error).toBe("no_match");
    expect(r.json.index).toBe(1);
    expect(read(root, "f.txt")).toBe("hello world");
  });

  it("rejects an empty old_string with invalid_input, naming the edit index", async () => {
    write(root, "f.txt", "hello world");
    const r = await callTool(
      "multi_edit",
      {
        path: "f.txt",
        edits: [
          { old_string: "hello", new_string: "hi" },
          { old_string: "", new_string: "x" },
        ],
      },
      config,
    );
    expect(r.json.error).toBe("invalid_input");
    expect(r.json.index).toBe(1);
    expect(read(root, "f.txt")).toBe("hello world");
  });

  it("rejects an empty edits array with invalid_input", async () => {
    write(root, "f.txt", "x");
    const r = await callTool("multi_edit", { path: "f.txt", edits: [] }, config);
    expect(r.json.error).toBe("invalid_input");
  });

  it("ignores out-of-schema extra fields", async () => {
    write(root, "f.txt", "x");
    const r = await callTool(
      "multi_edit",
      { path: "f.txt", edits: [{ old_string: "x", new_string: "y" }], bogus: 1 },
      config,
    );
    expect(r.isError).toBe(false);
    expect(read(root, "f.txt")).toBe("y");
  });

  it("flows a whitespace-tolerant edit through and discloses it", async () => {
    write(root, "f.txt", "  a\n  b\n");
    const r = await callTool(
      "multi_edit",
      { path: "f.txt", edits: [{ old_string: "a\nb", new_string: "X" }] },
      config,
    );
    expect(r.isError).toBe(false);
    expect(r.text).toContain("whitespace-tolerant");
    expect(read(root, "f.txt")).toBe("X\n");
  });

  it("reports the failing index when a tolerant edit is ambiguous", async () => {
    const original = "  a\n    b\nx\n  a\n    b\n";
    write(root, "f.txt", original);
    const r = await callTool(
      "multi_edit",
      {
        path: "f.txt",
        edits: [
          { old_string: "x", new_string: "Y" },
          { old_string: "a\nb", new_string: "Q" },
        ],
      },
      config,
    );
    expect(r.json.error).toBe("ambiguous_match");
    expect(r.json.index).toBe(1);
    expect(read(root, "f.txt")).toBe(original);
  });
});

describe("multi_edit edge cases", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root);
  });
  afterEach(() => cleanup(root));

  it("surfaces a TypeError when an edit entry is malformed", async () => {
    write(root, "f.txt", "hello world");
    expect(multiEdit.handler({ path: "f.txt", edits: [null] }, config)).rejects.toThrow(TypeError);
  });

  it("skips an undefined edit slot yet still counts it as applied", async () => {
    write(root, "f.txt", "hello world");
    const msg = await multiEdit.handler({ path: "f.txt", edits: [undefined] }, config);
    expect(handlerText(msg)).toContain("Applied 1 edit to");
    expect(read(root, "f.txt")).toBe("hello world");
  });

  it("continues past an undefined slot and still applies a later real edit", async () => {
    write(root, "f.txt", "alpha beta");
    const msg = await multiEdit.handler(
      { path: "f.txt", edits: [undefined, { old_string: "beta", new_string: "gamma" }] },
      config,
    );
    expect(handlerText(msg)).toContain("Applied 2 edits to");
    expect(read(root, "f.txt")).toBe("alpha gamma");
  });
});
