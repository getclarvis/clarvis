import type { z } from "zod";
import type { CapabilityRegistry, CapabilitySettingsSpec } from "@clarvis/capability";
import { settingsSchema, type SettingsFile } from "./settings-schema.ts";

/**
 * Build the schema that validates a `settings.json`, admitting the blocks a
 * host has registered on top of the engine's own.
 *
 * @param registry - the capability registry a host filled before loading
 *   settings; pass `undefined` for the engine's blocks alone.
 * @returns a strict schema over the built-in shape plus one optional entry per
 *   registered spec.
 * @throws {@link Error} when a registered spec's `key` names one of the engine's
 *   own settings blocks. `.extend()` is last-wins, so such a spec would silently
 *   *replace* the built-in block's schema for the whole host — validating
 *   a built-in block against whatever the capability declared, while
 *   `mergeSettings` still merged it with the engine's strategy. The registry
 *   itself only rejects a duplicate *within* the registry, so this is the only
 *   place the collision can be seen.
 * @throws {@link Error} when a registered spec declares plugin contributions or
 * description metadata, which the generic manifest does not compose. Explicit
 * prohibitions are supported when the host supplies its registry to the parser.
 * @remarks The built-in blocks stay spread **statically** into
 *   {@link settingsSchema}, which is what keeps zod's inference exact and the
 *   `ParsedRunRequest`/`RunRequest` drift locks meaningful. Only the registered
 *   blocks are added here, and only at the point of validation — so a capability
 *   shipped in its own package gets its settings checked by its own schema
 *   without the engine ever naming it, and a typo in any other key is still
 *   rejected rather than silently carried.
 *
 *   A block registered after settings were parsed is not in this schema, which
 *   is why registration belongs at boot.
 */
export function settingsSchemaFor(registry?: CapabilityRegistry): z.ZodType<SettingsFile> {
  const specs = registry?.specs() ?? [];
  if (specs.length === 0) return settingsSchema;
  for (const spec of specs) {
    if (spec.key in settingsSchema.shape) {
      throw new Error(
        `capability settings key '${spec.key}' collides with a built-in settings block; ` +
          "a registered capability must declare a key the engine does not already own.",
      );
    }
    if (spec.pluginContributable || spec.pluginDescription !== undefined) {
      throw new Error(
        `capability settings key '${spec.key}' declares a plugin-manifest surface, which only a ` +
          "built-in settings spec has; the plugin manifest schema is composed statically from " +
          "the engine's own blocks, so a registered spec's plugin fields are read by nobody. " +
          "Declare 'pluginContributable: false' with no plugin description.",
      );
    }
  }
  const extra: z.ZodRawShape = Object.fromEntries(
    specs.map((spec) => [spec.key, spec.schema.optional()]),
  );
  return settingsSchema.extend(extra).strict();
}

/**
 * Read one registered capability's block out of validated settings.
 *
 * @param settings - a validated `settings.json` (or any merged view of one).
 * @param spec - the capability's registration entry.
 * @returns the parsed block, or `undefined` when the settings carry none.
 * @throws {@link z.ZodError} when the block is present but does not satisfy
 *   `spec.schema`.
 * @remarks A registered block is absent from {@link SettingsFile}'s static type
 *   by construction — the engine does not know it exists — so a host reaches it
 *   through the owning capability's own schema rather than through a cast. That
 *   is the point: the block is validated by whoever declared it.
 */
export function readCapabilitySettings<T>(
  settings: Readonly<Record<string, unknown>>,
  spec: CapabilitySettingsSpec,
): T | undefined {
  const raw = settings[spec.key];
  if (raw === undefined) return undefined;
  return spec.schema.parse(raw) as T;
}
