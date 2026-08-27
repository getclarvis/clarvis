import { z } from "zod";
import { editDistance, typoBudget } from "./typo-suggestion.ts";
import { capabilityExecutablesSchema, capabilityRunPoliciesSchema } from "@clarvis/capability";
import { BUILTIN_SETTINGS_SPECS } from "../runtime/capabilities/settings-specs.ts";
import { capabilityPluginFields } from "../runtime/capabilities/settings-specs.ts";
import { mcpServerPluginSchema, pluginNameField, type SettingsFile } from "./settings-schema.ts";

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * A manifest's `author`, accepted either as a plain string or as the
 * `{ name, email?, url? }` object every other agent host writes, and normalized
 * to the name so nothing downstream has to know which form was on disk.
 */
const authorField = z
  .union([
    z.string().min(1),
    z.object({ name: z.string().min(1, "author.name must be a non-empty string") }).loose(),
  ])
  .transform((value) => (typeof value === "string" ? value : value.name))
  .describe("Who wrote the plugin. A string, or a { name, email?, url? } object.");

/**
 * The `plugin.json` manifest schema: identity (`name`/`version`/`description`/
 * `author`), contributed `mcpServers`, and each capability's
 * plugin-contributable fields (spread in from {@link capabilityPluginFields}).
 *
 * @remarks `.loose()` — an unrecognized key is carried rather than rejected, so a
 *   manifest written for another agent host installs instead of being refused
 *   over `license` or `homepage`. Nothing reads those keys: they are reported by
 *   {@link unknownManifestKeys} and shown to the operator, because a key that is
 *   a *directive* elsewhere (`skills`, `sessionStart`) does nothing here and a
 *   plugin that silently lost half its behaviour is worse than one that refused
 *   to install.
 *
 *   **`dependencies` is not among the keys this schema gives meaning to**, and
 *   was removed rather than kept. It validated an array of plugin names,
 *   described them as "other plugins that must be enabled for this one to
 *   work", and no loader anywhere read the result — so a plugin declaring a
 *   dependency installed and ran with that dependency absent, silently, which
 *   is the exact failure the `.loose()` remark above exists to prevent. Off the
 *   shape it now lands in {@link unknownManifestKeys} and the operator is told
 *   "manifest keys Clarvis does not act on: dependencies". Recognizing a
 *   directive and then ignoring it is worse than not recognizing it, because
 *   only the second one is visible.
 *
 *   **`name` is the only required key after host normalization.** A native Git
 *   install uses it to choose the install directory. A reader of an already
 *   installed foreign layout may instead supply a missing name from that
 *   directory, and the directory remains the host-owned runtime namespace even
 *   when foreign presentation metadata names the plugin differently. `version`
 *   and `description` are conveniences for the operator's panel, and refusing to
 *   install a working plugin over a missing one-line summary is the refusal this
 *   schema exists to stop. Both are still validated when present.
 */
export const pluginManifestSchema = z
  .object({
    name: pluginNameField.describe(
      "Plugin id used to name a native install. An existing install's directory remains the " +
        "host-owned namespace for its contributions (<name>:<agent>, <name>:<server>).",
    ),
    version: z
      .string()
      .regex(SEMVER_RE, "version must be a semver string (e.g. '1.0.0')")
      .optional()
      .describe("Semver version of this plugin. Validated when present."),
    description: z
      .string()
      .min(1, "description must be a non-empty string")
      .optional()
      .describe("One line on what this plugin is for."),
    author: authorField.optional(),
    mcpServers: z
      .record(z.string().min(1), mcpServerPluginSchema)
      .optional()
      .describe(
        "MCP servers this plugin contributes. Namespaced to <plugin>:<server> on load, and " +
          "inert until an agent references '<plugin>:<server>.<tool>'. Executable: gated on " +
          "enable. A manifest may also name a companion document holding this map instead of " +
          "writing it inline; the host resolves that before validation, exactly as it does for " +
          "hooks.",
      ),
    capabilityExecutables: capabilityExecutablesSchema
      .optional()
      .describe(
        "Language-neutral JSON-RPC services this plugin offers by capability. A service is " +
          "inert until the operator enables the plugin and selects it for that capability.",
      ),
    capabilityRunPolicies: capabilityRunPoliciesSchema
      .optional()
      .describe(
        "Per-skill run policy for capabilities supplied by this plugin. The host applies a " +
          "policy only when the skill and the selected capability provider both resolve to " +
          "this plugin.",
      ),
    ...capabilityPluginFields,
  })
  .loose();

/** The inferred type of a validated plugin manifest; see {@link pluginManifestSchema}. */
export type PluginManifest = z.infer<typeof pluginManifestSchema>;

/** The manifest keys {@link pluginManifestSchema} gives meaning to. */
const KNOWN_MANIFEST_KEYS: ReadonlySet<string> = new Set(Object.keys(pluginManifestSchema.shape));

/**
 * The keys of a manifest document that {@link pluginManifestSchema} does not
 * recognize, sorted.
 *
 * @param document - the JSON-parsed manifest, before or after validation.
 * @returns the unrecognized key names; empty for a manifest written against this
 *   schema, and for a non-object input.
 * @remarks Reported rather than rejected — see the schema's `.loose()` remark.
 */
export function unknownManifestKeys(document: unknown): string[] {
  if (typeof document !== "object" || document === null || Array.isArray(document)) return [];
  return Object.keys(document)
    .filter((key) => !KNOWN_MANIFEST_KEYS.has(key))
    .sort();
}

/** An unrecognized manifest key that looks like a misspelling of a known one. */
export interface SuspectedManifestTypo {
  /** The key as written in the manifest. */
  key: string;
  /** The known key it most likely meant. */
  suggestion: string;
}

/**
 * Find unrecognized manifest keys that are near-misses of a key this schema does
 * give meaning to.
 *
 * @param document - the JSON-parsed manifest.
 * @returns one entry per suspected misspelling, key-sorted; empty when every
 *   unrecognized key is simply foreign.
 * @remarks
 * The cost of `.loose()`. While unknown keys were rejected, `"mcpServer"` failed
 * the install and the author fixed it in seconds; now it installs, contributes
 * nothing, and looks exactly like a key belonging to some other agent host. This
 * is what keeps a one-character slip legible as a slip — the operator is told
 * what was probably meant instead of being left to compare two spellings.
 */
export function suspectedManifestTypos(document: unknown): SuspectedManifestTypo[] {
  const out: SuspectedManifestTypo[] = [];
  for (const key of unknownManifestKeys(document)) {
    const limit = typoBudget(key);
    let best: { suggestion: string; distance: number } | undefined;
    for (const known of KNOWN_MANIFEST_KEYS) {
      const distance = editDistance(key.toLowerCase(), known.toLowerCase(), limit);
      if (distance <= limit && (best === undefined || distance < best.distance)) {
        best = { suggestion: known, distance };
      }
    }
    if (best !== undefined) out.push({ key, suggestion: best.suggestion });
  }
  return out;
}

/**
 * Project a plugin manifest into the {@link SettingsFile} fragment it contributes
 * to the merged settings: its `mcpServers` plus every built-in capability field
 * marked `pluginContributable`.
 *
 * @param manifest - the parsed plugin manifest.
 * @returns a settings fragment carrying only the plugin-contributable keys the
 *   manifest actually set.
 */
export function pluginSettingsFragment(manifest: PluginManifest): SettingsFile {
  const fragment: SettingsFile = {
    ...(manifest.mcpServers !== undefined ? { mcpServers: manifest.mcpServers } : {}),
  };
  const source = manifest as Record<string, unknown>;
  for (const spec of BUILTIN_SETTINGS_SPECS) {
    if (!spec.pluginContributable) continue;
    const value = source[spec.key];
    if (value !== undefined) Reflect.set(fragment, spec.key, value);
  }
  return fragment;
}
