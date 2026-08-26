import { describe, it, expect, vi } from "../bun-test.ts";
import { createToolArgValidator } from "../../src/runtime/tools/index.ts";
import type { Logger } from "@clarvis/capability";

const schema = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
} as Record<string, unknown>;

describe("createToolArgValidator", () => {
  it("flags a missing required field with a didactic message", () => {
    const v = createToolArgValidator();
    const err = v.validate(schema, {});
    expect(err).not.toBeNull();
    expect(err).toContain("path");
    expect(err).toContain("InputValidationError");
  });

  it("flags a wrong-typed field", () => {
    const v = createToolArgValidator();
    const err = v.validate(schema, { path: 123 });
    expect(err).not.toBeNull();
    expect(err).toContain("path");
  });

  it("returns null for valid arguments", () => {
    const v = createToolArgValidator();
    expect(v.validate(schema, { path: "/etc/hostname" })).toBeNull();
  });

  it("skips an absent or empty schema (returns null)", () => {
    const v = createToolArgValidator();
    expect(v.validate(undefined, { anything: true })).toBeNull();
    expect(v.validate({}, { anything: true })).toBeNull();
    expect(v.validate({ type: "object", properties: {} }, { anything: true })).toBeNull();
  });

  it("treats malformed-JSON args (a raw string) as a schema violation", () => {
    const v = createToolArgValidator();
    const err = v.validate(schema, "not-an-object");
    expect(err).not.toBeNull();
  });

  it("skips a non-compilable schema instead of throwing (a tool's bad schema never blocks it)", () => {
    const v = createToolArgValidator();
    const bad = { type: "object", properties: { x: { type: "not-a-real-type" } } } as Record<
      string,
      unknown
    >;
    expect(() => v.validate(bad, { x: 1 })).not.toThrow();
    expect(v.validate(bad, { x: 1 })).toBeNull();
  });

  it("fails open on a malformed `properties` value (null/non-object) instead of throwing", () => {
    const v = createToolArgValidator();
    for (const props of [null, "oops", 42, true, []]) {
      const bad = { type: "object", properties: props } as Record<string, unknown>;
      expect(() => v.validate(bad, { x: 1 })).not.toThrow();
      expect(v.validate(bad, { x: 1 })).toBeNull();
    }
  });

  it("never throws on an exotic/malformed schema shape (total fail-open)", () => {
    const v = createToolArgValidator();
    const cases: Array<Record<string, unknown>> = [
      { type: "object", required: "path" },
      { type: "object", properties: { x: { type: "string" } }, items: null },
      { $async: true, type: "object", properties: { x: { type: "string" } } },
    ];
    for (const c of cases) {
      expect(() => v.validate(c, { x: 1 })).not.toThrow();
    }
  });

  it("validates a combinator-only schema instead of skipping it", () => {
    const v = createToolArgValidator();
    const oneOf = {
      oneOf: [{ type: "string" }, { type: "number" }],
    } as Record<string, unknown>;
    expect(v.validate(oneOf, { not: "string-or-number" })).not.toBeNull();
    expect(v.validate(oneOf, "a string")).toBeNull();
    expect(v.validate(oneOf, 42)).toBeNull();
  });

  it("enforces additionalProperties:false even with empty properties", () => {
    const v = createToolArgValidator();
    const closed = {
      type: "object",
      properties: {},
      additionalProperties: false,
    } as Record<string, unknown>;
    expect(v.validate(closed, { extra: 1 })).not.toBeNull();
    expect(v.validate(closed, {})).toBeNull();
  });

  it("caches by schema reference (repeated validate calls are stable)", () => {
    const v = createToolArgValidator();
    expect(v.validate(schema, {})).not.toBeNull();
    expect(v.validate(schema, { path: "ok" })).toBeNull();
    expect(v.validate(schema, {})).not.toBeNull();
  });

  it("warns once (cache-aware) when a schema fails to compile, then fails open", () => {
    const warn = vi.fn();
    const v = createToolArgValidator({ warn } as unknown as Logger);
    const bad = { type: "object", properties: { x: { type: "not-a-real-type" } } } as Record<
      string,
      unknown
    >;
    expect(v.validate(bad, { x: 1 })).toBeNull();
    expect(v.validate(bad, { x: 2 })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({
      event: "tool.args_validation_failed_open",
      reason: "compile_error",
    });
  });

  it("warns 'async_not_supported' for a $async schema, then fails open", () => {
    const warn = vi.fn();
    const v = createToolArgValidator({ warn } as unknown as Logger);
    const asyncSchema = {
      $async: true,
      type: "object",
      properties: { x: { type: "string" } },
    } as Record<string, unknown>;
    expect(v.validate(asyncSchema, { x: "ok" })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({
      event: "tool.args_validation_failed_open",
      reason: "async",
    });
  });

  it("does not warn for a compilable schema", () => {
    const warn = vi.fn();
    const v = createToolArgValidator({ warn } as unknown as Logger);
    v.validate(schema, { path: "/ok" });
    v.validate(schema, {});
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("createToolArgValidator edge fail-open", () => {
  it("returns null for a non-object schema value", () => {
    const v = createToolArgValidator();
    expect(v.validate("nope" as unknown as Record<string, unknown>, { x: 1 })).toBeNull();
    expect(v.validate(42 as unknown as Record<string, unknown>, { x: 1 })).toBeNull();
  });

  it("returns null when reading the schema throws (outer catch)", () => {
    const v = createToolArgValidator();
    const exploding = new Proxy(
      { type: "object", properties: {} },
      {
        get(target, prop, receiver) {
          if (prop === "properties") throw new Error("boom");
          return Reflect.get(target, prop, receiver);
        },
      },
    ) as unknown as Record<string, unknown>;
    expect(v.validate(exploding, { x: 1 })).toBeNull();
  });
});
