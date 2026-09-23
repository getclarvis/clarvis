import { describe, expect, it } from "bun:test";
import { SessionWindow, decodeCursor, encodeCursor } from "../../src/lib/session-window.ts";

describe("SessionWindow", () => {
  it("replays retained UTF-8 bytes from an opaque two-stream cursor", () => {
    const stdout = new SessionWindow(8);
    const stderr = new SessionWindow(8);
    stdout.push("aé");
    stderr.push("err");
    const initial = decodeCursor(undefined);
    const out = stdout.read(initial.stdout, 1);
    const err = stderr.read(initial.stderr, 8);
    expect(out).toMatchObject({ text: "a", nextOffset: 1, omittedBefore: 0 });
    expect(err.text).toBe("err");
    const cursor = encodeCursor({ stdout: out.nextOffset, stderr: err.nextOffset });
    expect(decodeCursor(cursor)).toEqual({ stdout: 1, stderr: 3 });
    expect(stdout.read(decodeCursor(cursor).stdout, 1).text).toBe("é");
    expect(stdout.read(0, 8).text).toBe("aé");
  });

  it("reports expired bytes without splitting the retained codepoint", () => {
    const window = new SessionWindow(4);
    window.push("123456é");
    expect(window.read(0, 5)).toMatchObject({
      text: "56é",
      omittedBefore: 4,
      nextOffset: 8,
    });
    expect(window.read(4, 1)).toMatchObject({ text: "5", nextOffset: 5 });
  });

  it("rejects a malformed or future cursor", () => {
    const window = new SessionWindow(8);
    window.push("x");
    expect(() => decodeCursor("invalid")).toThrow("Invalid session output cursor");
    expect(() => window.read(2, 8)).toThrow("Invalid session output cursor");
  });
});
