/**
 * The single registration point for capability configuration surfaces.
 *
 * Adding a capability with settings or run params touches its own module
 * (declare the fields + a CapabilitySettingsSpec) and this file (spread the
 * fields, list the spec). settings-schema, settings-merge, plugin-schema,
 * request-schema and the mcp assemblers all compose from here and never
 * change per feature.
 *
 * The field consts are spread statically so zod inference stays precise
 * (SettingsFile / ParsedRunRequest keep their exact shapes); the spec list
 * drives the generic machinery (merge strategies, plugin surface, request
 * param passthrough).
 *
 * Why a *built-in* list at all, rather than every capability arriving through
 * the same runtime registry: the static spread is the reason. A registry is a
 * runtime value, so a schema composed from one is `ZodObject<Record<string,
 * unknown>>` — `SettingsFile` and `ParsedRunRequest` stop being precise types
 * and every consumer of a settings field falls back to `unknown`, in `@clarvis/code`
 * above all. The built-ins are exactly the capabilities the engine itself owns
 * and therefore *can* name at compile time; a host-registered capability cannot
 * be named here without the engine depending on it, which is the whole point of
 * the registry. So the split is not two mechanisms for one job — it is the type
 * boundary between what the engine knows statically and what a host adds.
 */
import type { CapabilitySettingsSpec } from "@clarvis/capability";
import { requestParamKeys } from "@clarvis/capability";
import {
  effectReviewSchema,
  effectReviewSettingsSpec,
  EFFECT_REVIEW_PLUGIN_FIELDS,
} from "./effect-review-settings.ts";
import {
  AGENT_TOOLS_REQUEST_PARAMS,
  AGENT_TOOLS_SETTINGS_FIELDS,
  GUARD_PLUGIN_FIELDS,
  agentToolsSettingsSpec,
  sandboxSettingsSpec,
} from "./tools-settings.ts";
import {
  HOOKS_PLUGIN_FIELDS,
  HOOKS_REQUEST_PARAMS,
  HOOKS_SETTINGS_FIELDS,
  hooksSettingsSpec,
} from "./hooks.ts";
import { SKILLS_PLUGIN_FIELDS } from "./skills-settings.ts";
import {
  AGENTS_REQUEST_PARAMS,
  AGENTS_SETTINGS_FIELDS,
  agentsSettingsSpec,
} from "@clarvis/supervision";

/** The built-in capability settings specs, in the order the generic merge /
 * plugin-surface / request-passthrough machinery iterates them. */
export const BUILTIN_SETTINGS_SPECS: readonly CapabilitySettingsSpec[] = [
  effectReviewSettingsSpec,
  hooksSettingsSpec,
  agentToolsSettingsSpec,
  sandboxSettingsSpec,
  agentsSettingsSpec,
];

/** Capability blocks of settings.json (spread into settingsSchema). */
export const capabilitySettingsFields = {
  effect_review: effectReviewSchema.optional(),
  ...HOOKS_SETTINGS_FIELDS,
  ...AGENT_TOOLS_SETTINGS_FIELDS,
  ...AGENTS_SETTINGS_FIELDS,
};

/** Per-run request params (spread into runRequestSchema and the slim tool). */
export const capabilityRequestParamFields = {
  ...HOOKS_REQUEST_PARAMS,
  ...AGENT_TOOLS_REQUEST_PARAMS,
  ...AGENTS_REQUEST_PARAMS,
};

/** Capability entries of a plugin manifest (spread into pluginManifestSchema):
 * contributable blocks with plugin-facing describes, explicit forbidden markers
 * for blocks a plugin must not touch, and declarative fields that carry no
 * settings spec at all — a manifest key the capability reads directly, which
 * therefore never reaches merged settings and never joins the executable
 * surface. */
export const capabilityPluginFields = {
  ...EFFECT_REVIEW_PLUGIN_FIELDS,
  ...HOOKS_PLUGIN_FIELDS,
  ...GUARD_PLUGIN_FIELDS,
  ...SKILLS_PLUGIN_FIELDS,
};

/** Request-param keys hosts pass through when assembling a run body. */
export const CAPABILITY_REQUEST_PARAM_KEYS: readonly string[] =
  requestParamKeys(BUILTIN_SETTINGS_SPECS);
