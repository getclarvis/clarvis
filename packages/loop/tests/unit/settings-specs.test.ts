import { describe, expect, it } from "../bun-test.ts";

import {
  BUILTIN_SETTINGS_SPECS,
  CAPABILITY_REQUEST_PARAM_KEYS,
  capabilityRequestParamFields,
  capabilitySettingsFields,
} from "../../src/runtime/capabilities/settings-specs.ts";
import { SETTINGS_MERGE_STRATEGY_KEYS } from "../../src/settings/settings-merge.ts";
import { settingsSchema } from "../../src/settings/settings-schema.ts";
import { pluginManifestSchema } from "../../src/settings/plugin-schema.ts";
import { runRequestSchema } from "../../src/validation/request-schema.ts";

describe("capability settings registry", () => {
  it("every capability block is served by settingsSchema and has a merge strategy", () => {
    const schemaKeys = Object.keys(settingsSchema.shape);
    const strategyKeys = SETTINGS_MERGE_STRATEGY_KEYS as string[];
    for (const key of Object.keys(capabilitySettingsFields)) {
      expect(schemaKeys).toContain(key);
      expect(strategyKeys).toContain(key);
    }
    for (const key of schemaKeys) expect(strategyKeys).toContain(key);
  });

  it("every declared request param is served by the run request schema", () => {
    const requestKeys = Object.keys(runRequestSchema.shape);
    expect(Object.keys(capabilityRequestParamFields).sort()).toEqual(
      [...CAPABILITY_REQUEST_PARAM_KEYS].sort(),
    );
    for (const key of CAPABILITY_REQUEST_PARAM_KEYS) {
      expect(requestKeys).toContain(key);
    }
  });

  it("the plugin surface follows each spec's contributability", () => {
    const manifestKeys = Object.keys(pluginManifestSchema.shape);
    for (const spec of BUILTIN_SETTINGS_SPECS) {
      if (spec.pluginContributable || spec.pluginForbiddenReason !== undefined) {
        expect(manifestKeys).toContain(spec.key);
      } else {
        expect(manifestKeys).not.toContain(spec.key);
      }
    }
    const guardTry = pluginManifestSchema.safeParse({
      name: "p1",
      version: "1.0.0",
      description: "d",
      guard: { type: "shell" },
    });
    expect(guardTry.success).toBe(false);
    expect(JSON.stringify(guardTry.error?.issues)).toContain("a plugin may not contribute 'guard'");
  });

  it("keeps bootstrapSkill a manifest-only key with no settings spec", () => {
    expect(Object.keys(pluginManifestSchema.shape)).toContain("bootstrapSkill");
    expect(BUILTIN_SETTINGS_SPECS.every((spec) => spec.key !== "bootstrapSkill")).toBe(true);
    expect(Object.keys(settingsSchema.shape)).not.toContain("bootstrapSkill");
    expect(Object.keys(runRequestSchema.shape)).not.toContain("bootstrapSkill");
  });
});
