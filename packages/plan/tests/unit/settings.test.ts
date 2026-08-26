import { describe, expect, it } from "bun:test";

import { PLANS_SETTINGS_FIELDS, plansParamSchema, plansSettingsSpec } from "../../src/settings.ts";

describe("plans provider settings", () => {
  it("accepts all provider selections only in the settings block", () => {
    for (const provider of [
      { kind: "markdown" },
      { kind: "executable", command: "python3", args: ["server.py", "plans"] },
      { kind: "plugin", plugin: "acme-linear" },
    ]) {
      expect(plansSettingsSpec.schema.safeParse({ provider }).success).toBe(true);
      expect(plansParamSchema.safeParse({ mode: "on", provider }).success).toBe(false);
    }
    expect(plansSettingsSpec.pluginContributable).toBe(false);
    expect(PLANS_SETTINGS_FIELDS.plans).toBeDefined();
  });
});
