import { describe, it, expect } from "bun:test";
import { assertOwnerId, resolveOwnerId } from "../../src/config/owner.ts";

describe("assertOwnerId", () => {
  it("accepts ordinary ids and lowercases them", () => {
    expect(assertOwnerId("alice")).toBe("alice");
    expect(assertOwnerId("Med-Records_1")).toBe("med-records_1");
    expect(assertOwnerId("  bob  ")).toBe("bob");
  });

  it("rejects every path-traversal shape before anything touches disk", () => {
    for (const bad of ["", ".", "..", "../alice", "a/b", "a\\b", "a\0b", "/alice", "alice/"]) {
      expect(() => assertOwnerId(bad)).toThrow();
    }
  });

  it("rejects an id longer than 64 characters", () => {
    expect(() => assertOwnerId("a".repeat(65))).toThrow(/at most 64/);
    expect(assertOwnerId("a".repeat(64))).toHaveLength(64);
  });

  it("rejects leading or trailing punctuation", () => {
    expect(() => assertOwnerId("-alice")).toThrow();
    expect(() => assertOwnerId("alice-")).toThrow();
    expect(() => assertOwnerId("_alice")).toThrow();
  });
});

describe("resolveOwnerId", () => {
  const base = { header: "x-clarvis-owner", fixed: "default", allowlist: new Set(["alice"]) };

  it("ignores the header entirely in fixed mode", () => {
    const owner = resolveOwnerId({
      ...base,
      mode: "fixed",
      headers: new Headers({ "x-clarvis-owner": "mallory" }),
    });
    expect(owner).toBe("default");
  });

  it("reads and validates the header in header mode", () => {
    expect(
      resolveOwnerId({
        ...base,
        mode: "header",
        headers: new Headers({ "x-clarvis-owner": "Bob" }),
      }),
    ).toBe("bob");
    expect(() => resolveOwnerId({ ...base, mode: "header", headers: new Headers() })).toThrow(
      /missing owner header/,
    );
    expect(() =>
      resolveOwnerId({
        ...base,
        mode: "header",
        headers: new Headers({ "x-clarvis-owner": "../x" }),
      }),
    ).toThrow();
  });

  it("rejects an unregistered owner in allowlist mode", () => {
    expect(
      resolveOwnerId({
        ...base,
        mode: "allowlist",
        headers: new Headers({ "x-clarvis-owner": "alice" }),
      }),
    ).toBe("alice");
    expect(() =>
      resolveOwnerId({
        ...base,
        mode: "allowlist",
        headers: new Headers({ "x-clarvis-owner": "mallory" }),
      }),
    ).toThrow(/is not registered/);
  });
});
