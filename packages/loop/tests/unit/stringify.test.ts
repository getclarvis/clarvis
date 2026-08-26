import { describe, it, expect } from "../bun-test.ts";
import { safeStringify } from "../../src/runtime/support/index.ts";

describe("safeStringify", () => {
  it("returns strings verbatim", () => {
    expect(safeStringify("hello")).toBe("hello");
  });

  it("JSON-encodes plain values", () => {
    expect(safeStringify({ a: 1 })).toBe('{"a":1}');
    expect(safeStringify([1, 2])).toBe("[1,2]");
    expect(safeStringify(42)).toBe("42");
  });

  it("always returns a string for values JSON.stringify maps to undefined", () => {
    expect(typeof safeStringify(undefined)).toBe("string");
    expect(safeStringify(undefined)).toBe("undefined");
    expect(typeof safeStringify(() => 1)).toBe("string");
  });

  it("falls back to String() on a cyclic value instead of throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(typeof safeStringify(cyclic)).toBe("string");
  });

  it("falls back to String() on a bigint instead of throwing", () => {
    expect(safeStringify(10n)).toBe("10");
  });
});
