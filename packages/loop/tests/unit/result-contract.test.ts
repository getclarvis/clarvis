import { describe, it, expect } from "../bun-test.ts";
import { compileResultContract, OUTPUT_SCHEMA_LIMITS } from "../../src/runtime/tools/index.ts";
import { ValidationError } from "@clarvis/capability";
import { SUBMIT_RESULT_TOOL_NAME } from "../../src/runtime/tools/index.ts";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    age: { type: ["integer", "null"] },
  },
  required: ["name"],
};

describe("compileResultContract", () => {
  it("exposes the submit_result tool whose inputSchema IS the caller schema (by reference)", () => {
    const c = compileResultContract(SCHEMA);
    expect(c.tool.toolName).toBe(SUBMIT_RESULT_TOOL_NAME);
    expect(c.tool.wireName).toBe("submit_result");
    expect(c.tool.inputSchema).toBe(SCHEMA);
    const desc = (c.tool.description ?? "").toLowerCase();
    expect(desc).toContain("finalize");
    expect(desc).not.toMatch(/extract|plaintiff|cpf|legal|persona/);
  });

  it("validates conforming args and returns them verbatim (no coercion)", () => {
    const v = compileResultContract(SCHEMA).validate({ name: "Ada", age: 42 });
    expect(v.ok).toBe(true);
    expect(v.value).toEqual({ name: "Ada", age: 42 });
  });

  it("accepts a nullable field submitted as null", () => {
    const v = compileResultContract(SCHEMA).validate({ name: "Ada", age: null });
    expect(v.ok).toBe(true);
  });

  it("rejects a missing required field with a readable error", () => {
    const v = compileResultContract(SCHEMA).validate({ age: 42 });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/submit_result rejected/);
    expect(v.error).toMatch(/name/);
  });

  it("rejects a wrong type with a readable error", () => {
    const v = compileResultContract(SCHEMA).validate({ name: 123 });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/submit_result rejected/);
  });

  it("throws invalid_output_schema for a well-formed-but-invalid schema", () => {
    try {
      compileResultContract({ type: "banana" });
      throw new Error("expected ValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe("invalid_output_schema");
    }
  });

  it("throws invalid_output_schema for an async ($async) schema", () => {
    try {
      compileResultContract({
        $async: true,
        type: "object",
        properties: { name: { type: "string" } },
      });
      throw new Error("expected ValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe("invalid_output_schema");
    }
  });

  it.each([
    ["string", "not-a-schema"],
    ["array", [1, 2]],
    ["number", 5],
    ["boolean", true],
    ["null", null],
  ])("throws invalid_output_schema for a non-object schema (%s)", (_label, value) => {
    try {
      compileResultContract(value as unknown);
      throw new Error("expected ValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe("invalid_output_schema");
    }
  });

  it.each([
    ["string", { type: "string" }],
    ["number", { type: "number" }],
    ["array", { type: "array", items: { type: "string" } }],
    ["boolean", { type: "boolean" }],
  ])(
    "throws invalid_output_schema for a well-formed schema that describes a non-object value (%s)",
    (_label, schema) => {
      try {
        compileResultContract(schema);
        throw new Error("expected ValidationError");
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).code).toBe("invalid_output_schema");
      }
    },
  );

  it("accepts an object schema, a nullable-object union, and a type-less combinator schema", () => {
    expect(() =>
      compileResultContract({ type: "object", properties: { a: { type: "string" } } }),
    ).not.toThrow();
    expect(() => compileResultContract({ type: ["object", "null"] })).not.toThrow();
    expect(() =>
      compileResultContract({ oneOf: [{ type: "object" }, { type: "object" }] }),
    ).not.toThrow();
  });

  it("rejects schema graphs that exceed compiler working-set bounds before AJV sees them", () => {
    const tooWide = new Array(OUTPUT_SCHEMA_LIMITS.containerEntries + 1).fill({ type: "string" });
    const tooDeep: Record<string, unknown> = { type: "object" };
    let cursor = tooDeep;
    for (let depth = 0; depth <= OUTPUT_SCHEMA_LIMITS.depth; depth += 1) {
      const next: Record<string, unknown> = { type: "object" };
      cursor["properties"] = { child: next };
      cursor = next;
    }

    for (const schema of [
      { type: "object", allOf: tooWide },
      tooDeep,
      { type: "object", description: "x".repeat(OUTPUT_SCHEMA_LIMITS.singleStringChars + 1) },
    ]) {
      expect(() => compileResultContract(schema)).toThrow(ValidationError);
    }
  });

  it("rejects cyclic and accessor-backed schemas without recursively materializing them", () => {
    const cyclic: Record<string, unknown> = { type: "object" };
    cyclic["properties"] = cyclic;
    const accessor = { type: "object" } as Record<string, unknown>;
    Object.defineProperty(accessor, "properties", {
      enumerable: true,
      get: () => ({ value: { type: "string" } }),
    });

    expect(() => compileResultContract(cyclic)).toThrow(ValidationError);
    expect(() => compileResultContract(accessor)).toThrow(ValidationError);
  });
});

describe("compileResultContract non-Error compile failure", () => {
  it("coalesces a non-Error thrown during compile via String(err)", () => {
    const exploding = new Proxy(
      { type: "object" },
      {
        get() {
          throw "kaboom";
        },
        ownKeys() {
          throw "kaboom";
        },
      },
    );
    try {
      compileResultContract(exploding);
      throw new Error("expected ValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe("invalid_output_schema");
      expect((err as ValidationError).message).toContain("kaboom");
    }
  });
});
