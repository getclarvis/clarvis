import { describe, expect, test } from "bun:test";

import { DEFAULT_BUDGETS, MEMORY_DEFAULTS } from "../../src/config.ts";
import { memoryConfigSchema } from "../../src/schemas.ts";
import { MEMORY_SETTINGS_FIELDS } from "../../src/settings.ts";

describe("the memory settings block", () => {
  test("defaults an omitted `enabled` to the package default", () => {
    expect(memoryConfigSchema.parse({}).enabled).toBe(MEMORY_DEFAULTS.enabled);
  });

  test("accepts every budget the package defaults to, unchanged", () => {
    const parsed = memoryConfigSchema.parse({ budgets: { ...DEFAULT_BUDGETS } });
    expect(parsed.budgets).toEqual(DEFAULT_BUDGETS);
    expect(Object.keys(parsed.budgets!).sort()).toEqual(Object.keys(DEFAULT_BUDGETS).sort());
  });

  test("rejects an unknown key, so a typo is not silently carried", () => {
    expect(() => memoryConfigSchema.parse({ nope: true })).toThrow();
  });

  test("is exposed as an optional settings field", () => {
    expect(MEMORY_SETTINGS_FIELDS.memory.safeParse(undefined).success).toBe(true);
    expect(MEMORY_SETTINGS_FIELDS.memory.safeParse({ model: "x/y" }).success).toBe(true);
  });
});
