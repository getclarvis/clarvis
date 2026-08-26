import { describe, expect, it } from "../helpers/bun-test.ts";
import {
  MALFORMED_ARGUMENTS_PREVIEW_CHARS,
  malformedArgumentsMessage,
  normalizeToolArguments,
} from "../../src/tool-arguments.ts";

/**
 * These pin the one decision the whole defect turned on: which shapes are a
 * legitimate "no arguments" and which are a payload that did not survive the
 * provider round-trip. Collapsing the second group into the first is what let a
 * truncated `shell` call be reported to the model as a missing property.
 */
describe("normalizeToolArguments", () => {
  it("accepts an absent payload as no arguments", () => {
    expect(normalizeToolArguments(undefined)).toEqual({ ok: true, args: {} });
    expect(normalizeToolArguments(null)).toEqual({ ok: true, args: {} });
  });

  it("accepts an empty or whitespace-only string as no arguments", () => {
    expect(normalizeToolArguments("")).toEqual({ ok: true, args: {} });
    expect(normalizeToolArguments("   \n ")).toEqual({ ok: true, args: {} });
  });

  it("passes a plain object through untouched", () => {
    const args = { command: "bun test", timeout_ms: 5 };
    const out = normalizeToolArguments(args);
    expect(out.ok).toBe(true);
    expect(out.ok && out.args).toBe(args);
  });

  it("parses a provider that hands back already-serialized arguments", () => {
    expect(normalizeToolArguments('{"command":"bun test"}')).toEqual({
      ok: true,
      args: { command: "bun test" },
    });
  });

  // The real payload from the run that exposed this: cut at the `&` of `2>&1`.
  it("rejects a truncated JSON payload and keeps what arrived", () => {
    const out = normalizeToolArguments('{"command":"npm test 2>');
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toBe("unparsable");
    expect(out.ok === false && out.preview).toBe('{"command":"npm test 2>');
  });

  it("rejects a payload that parses but is not an argument record", () => {
    for (const raw of ["[1,2]", '"just a string"', "42", "true"]) {
      const out = normalizeToolArguments(raw);
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toBe("not_an_object");
    }
  });

  it("rejects a non-string, non-object payload", () => {
    expect(normalizeToolArguments(42).ok).toBe(false);
    expect(normalizeToolArguments(true).ok).toBe(false);
    expect(normalizeToolArguments(["a"]).ok).toBe(false);
  });

  it("bounds the preview so a large mangled blob cannot re-enter the context", () => {
    const out = normalizeToolArguments(`{"command":"${"x".repeat(5000)}`);
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.preview.length).toBeLessThanOrEqual(
      MALFORMED_ARGUMENTS_PREVIEW_CHARS + 1,
    );
  });
});

describe("malformedArgumentsMessage", () => {
  it("states the transport fault and shows where the payload was cut", () => {
    const norm = normalizeToolArguments('{"command":"npm test 2>');
    expect(norm.ok).toBe(false);
    if (norm.ok) throw new Error("unreachable");
    const text = malformedArgumentsMessage("shell", norm);
    expect(text).toContain("shell");
    expect(text).toContain('{"command":"npm test 2>');
    expect(text).toContain("truncated");
  });

  // The old message named a property the model had in fact sent, so re-sending
  // the identical call was the only reading of it. The replacement has to say
  // the call was not run and that the fault is in transport.
  it("never claims the model omitted an argument", () => {
    const norm = normalizeToolArguments('{"command":"npm test 2>');
    if (norm.ok) throw new Error("unreachable");
    const text = malformedArgumentsMessage("shell", norm);
    expect(text).not.toContain("required property");
    expect(text).toContain("not run");
  });
});
