import { describe, expect, it } from "bun:test";
import { fsError, serializeError, ToolError } from "../../src/errors.ts";

function errno(code: string | undefined, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code }) as NodeJS.ErrnoException;
}

describe("fsError code mapping", () => {
  it("maps ENOENT to not_found", () => {
    const e = fsError(errno("ENOENT", "no such"), "/w/a.txt");
    expect(e).toBeInstanceOf(ToolError);
    expect(e.code).toBe("not_found");
    expect(e.fields).toMatchObject({ path: "/w/a.txt" });
    expect(e.message).toContain("/w/a.txt");
  });

  it("maps EISDIR to not_a_file (is a directory)", () => {
    const e = fsError(errno("EISDIR", "illegal operation on a directory"), "/w/dir");
    expect(e.code).toBe("not_a_file");
    expect(e.message).toBe("Path is a directory: /w/dir");
    expect(e.fields).toMatchObject({ path: "/w/dir" });
  });

  it("maps ENOTDIR to not_a_file (not a directory)", () => {
    const e = fsError(errno("ENOTDIR", "not a directory"), "/w/file/child");
    expect(e.code).toBe("not_a_file");
    expect(e.message).toBe("Not a directory: /w/file/child");
    expect(e.fields).toMatchObject({ path: "/w/file/child" });
  });

  it("falls back to io_error for other codes, preserving the code", () => {
    const e = fsError(errno("EACCES", "permission denied"), "/w/locked");
    expect(e.code).toBe("io_error");
    expect(e.message).toBe("EACCES: permission denied");
    expect(e.fields).toMatchObject({ path: "/w/locked" });
  });

  it("falls back to EIO label when the errno has no code", () => {
    const e = fsError(errno(undefined, "boom"), "/w/x");
    expect(e.code).toBe("io_error");
    expect(e.message).toBe("EIO: boom");
  });
});

describe("serializeError", () => {
  it("serializes a ToolError with its code, message and fields", () => {
    const s = serializeError(new ToolError("no_match", "nothing here", { pattern: "x" }));
    expect(JSON.parse(s)).toEqual({ error: "no_match", message: "nothing here", pattern: "x" });
  });

  it("collapses a plain Error (with stack) into a generic internal error", () => {
    const s = serializeError(new Error("kaboom"));
    expect(JSON.parse(s)).toEqual({ error: "internal", message: "internal error" });
  });

  it("collapses an Error whose stack is absent into a generic internal error", () => {
    const e = new Error("stackless");
    delete e.stack;
    const s = serializeError(e);
    expect(JSON.parse(s)).toEqual({ error: "internal", message: "internal error" });
  });

  it("collapses a non-Error throwable via String() coercion", () => {
    const s = serializeError("just a string");
    expect(JSON.parse(s)).toEqual({ error: "internal", message: "internal error" });
  });
});
