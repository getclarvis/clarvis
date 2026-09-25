import { describe, expect, it } from "bun:test";
import { PLANS_SETTINGS_FIELDS, plansParamSchema, plansSettingsSpec } from "../../src/settings.ts";

describe("plans provider settings", () => {
  it("accepts only the built-in Markdown provider", () => {
    expect(plansSettingsSpec.schema.safeParse({ provider: { kind: "markdown" } }).success).toBe(
      true,
    );
    for (const kind of ["executable", "plugin"]) {
      expect(plansSettingsSpec.schema.safeParse({ provider: { kind } }).success).toBe(false);
    }
    expect(plansParamSchema.safeParse({ mode: "on", provider: { kind: "markdown" } }).success).toBe(
      false,
    );
    expect(plansSettingsSpec.pluginContributable).toBe(false);
    expect(PLANS_SETTINGS_FIELDS.plans).toBeDefined();
  });
});
