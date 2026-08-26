import { describe, it, expect } from "../bun-test.ts";
import { z } from "zod";
import { createCapabilityRegistry, type CapabilitySettingsSpec } from "@clarvis/capability";
import {
  readCapabilitySettings,
  settingsSchemaFor,
} from "../../src/settings/capability-settings.ts";
import { settingsSchema } from "../../src/settings/settings-schema.ts";
import {
  pluginManifestSchema,
  pluginSettingsFragment,
  unknownManifestKeys,
} from "../../src/settings/plugin-schema.ts";

const MANIFEST = { name: "auditor", version: "1.0.0", description: "an auditing plugin" };

const auditSchema = z
  .object({
    severity_floor: z.enum(["low", "medium", "high"]).default("low"),
    max_findings: z.number().int().positive().default(50),
  })
  .strict();

function spec(key: string, over: Partial<CapabilitySettingsSpec> = {}): CapabilitySettingsSpec {
  return { key, schema: auditSchema, merge: "lastWins", pluginContributable: false, ...over };
}

function registryOf(
  ...specs: CapabilitySettingsSpec[]
): ReturnType<typeof createCapabilityRegistry> {
  const registry = createCapabilityRegistry();
  for (const s of specs) registry.register(s);
  return registry;
}

describe("settingsSchemaFor", () => {
  it("is the engine's own schema when no registry is supplied", () => {
    expect(settingsSchemaFor()).toBe(settingsSchema);
  });

  it("is the engine's own schema when the registry is empty", () => {
    expect(settingsSchemaFor(createCapabilityRegistry())).toBe(settingsSchema);
  });

  it("admits a registered block and validates it with the capability's own schema", () => {
    const parsed = settingsSchemaFor(registryOf(spec("audit"))).parse({
      default_model: "anthropic/x",
      audit: { severity_floor: "high" },
    }) as unknown as Record<string, unknown>;
    expect(parsed.audit).toEqual({ severity_floor: "high", max_findings: 50 });
    expect(parsed.default_model).toBe("anthropic/x");
  });

  it("rejects a typo inside a registered block rather than carrying it", () => {
    expect(() =>
      settingsSchemaFor(registryOf(spec("audit"))).parse({ audit: { severity_flooor: "high" } }),
    ).toThrow();
  });

  it("stays strict: a key nobody registered is still rejected", () => {
    expect(() => settingsSchemaFor(registryOf(spec("audit"))).parse({ nonsense: true })).toThrow();
  });

  it("makes a registered block optional rather than required", () => {
    expect(() => settingsSchemaFor(registryOf(spec("audit"))).parse({})).not.toThrow();
  });

  it("admits every registered block, not just the first", () => {
    const schema = settingsSchemaFor(registryOf(spec("audit"), spec("telemetry")));
    const parsed = schema.parse({
      audit: { severity_floor: "medium" },
      telemetry: { severity_floor: "low" },
    }) as unknown as Record<string, unknown>;
    expect(parsed.audit).toMatchObject({ severity_floor: "medium" });
    expect(parsed.telemetry).toMatchObject({ severity_floor: "low" });
  });

  it("refuses a registered key that collides with a built-in settings block", () => {
    // zod's .extend() is last-wins, so without this guard the registered schema
    // would REPLACE the engine's block for the whole host.
    expect(() => settingsSchemaFor(registryOf(spec("guard", { schema: z.any() })))).toThrow(
      "capability settings key 'guard' collides with a built-in settings block",
    );
  });

  it("would otherwise have let a registered block widen the engine's own validation", () => {
    // The value the collision would have bought: `guard` is rejected by the
    // engine's schema, and a permissive registered `guard` block would have made
    // it pass. Proving the engine still rejects it is what makes the throw above
    // a fix rather than a formality.
    expect(() => settingsSchema.parse({ guard: { mode: "totally-not-a-mode" } })).toThrow();
  });

  it("refuses a registered spec that asks to be plugin-contributable", () => {
    // pluginManifestSchema is composed from `capabilityPluginFields`, which is
    // spread from the BUILT-IN specs' field consts, and pluginSettingsFragment
    // iterates BUILTIN_SETTINGS_SPECS. Nothing reads a registered spec's plugin
    // fields, so `true` here used to be accepted and then do nothing at all.
    expect(() =>
      settingsSchemaFor(registryOf(spec("audit", { pluginContributable: true }))),
    ).toThrow("capability settings key 'audit' declares a plugin-manifest surface");
  });

  it("refuses a registered spec carrying only a plugin description", () => {
    expect(() =>
      settingsSchemaFor(registryOf(spec("audit", { pluginDescription: "audit knobs" }))),
    ).toThrow("capability settings key 'audit' declares a plugin-manifest surface");
  });

  it("refuses a registered spec carrying only a forbidden reason", () => {
    // pluginContributable stays at its false default here: the reason text is
    // the manifest's rejection message for a built-in key, and a registered
    // spec's is never the message anything is rejected with.
    expect(() =>
      settingsSchemaFor(
        registryOf(spec("audit", { pluginForbiddenReason: "a plugin may not contribute 'audit'" })),
      ),
    ).toThrow("capability settings key 'audit' declares a plugin-manifest surface");
  });

  it("admits a registered spec that claims no plugin surface at all", () => {
    expect(() => settingsSchemaFor(registryOf(spec("audit")))).not.toThrow();
  });

  it("would otherwise have accepted a plugin declaration the manifest never honours", () => {
    // The value the guard buys: whatever a registered spec claimed, a manifest
    // carrying its key contributes nothing. The manifest is `.loose()`, so the
    // key is carried rather than rejected — but it is reported as unrecognized,
    // and the fragment it contributes never mentions it.
    const carried = { ...MANIFEST, audit: { severity_floor: "high" } };
    expect(pluginManifestSchema.safeParse(carried).success).toBe(true);
    expect(unknownManifestKeys(carried)).toEqual(["audit"]);
    expect(
      pluginSettingsFragment(
        pluginManifestSchema.parse(carried) as Parameters<typeof pluginSettingsFragment>[0],
      ),
    ).toEqual({});
    expect(
      pluginSettingsFragment(
        pluginManifestSchema.parse(MANIFEST) as Parameters<typeof pluginSettingsFragment>[0],
      ),
    ).toEqual({});
  });

  it("names every built-in block as off-limits, not just the sampled one", () => {
    for (const key of Object.keys(settingsSchema.shape)) {
      expect(() => settingsSchemaFor(registryOf(spec(key, { schema: z.any() })))).toThrow(
        `capability settings key '${key}' collides with a built-in settings block`,
      );
    }
  });
});

describe("readCapabilitySettings", () => {
  it("returns undefined when the settings carry no such block", () => {
    expect(readCapabilitySettings({}, spec("audit"))).toBeUndefined();
  });

  it("parses the block through the capability's schema, applying its defaults", () => {
    const block = readCapabilitySettings<z.infer<typeof auditSchema>>(
      { audit: { severity_floor: "high" } },
      spec("audit"),
    );
    expect(block).toEqual({ severity_floor: "high", max_findings: 50 });
  });

  it("throws when the block is present but invalid", () => {
    expect(() =>
      readCapabilitySettings({ audit: { severity_floor: "nope" } }, spec("audit")),
    ).toThrow();
  });

  it("reads only the spec's own key", () => {
    expect(
      readCapabilitySettings({ telemetry: { severity_floor: "high" } }, spec("audit")),
    ).toBeUndefined();
  });
});
