/**
 * The `hooks` configuration surface: the settings block, the plugin-manifest
 * entry and the merge spec the engine's schemas compose from.
 *
 * @remarks Deliberately holds no executable half. This module is imported by
 * `settings-specs.ts` and hence by the settings, plugin and request schemas —
 * i.e. by everything — so anything it reaches is loaded on every import of the
 * engine. The hook *vocabulary* it builds on (`hookSchema`, the event groups,
 * the timeout table) therefore lives in `@clarvis/capability`, and the code that
 * actually spawns a hook lives in `@clarvis/hooks/capability`, which the engine
 * loads only when `builtins.hooks` is on.
 */
import { z } from "zod";
import type { CapabilitySettingsSpec } from "@clarvis/capability";
import {
  hookSchema,
  MAX_HOOKS_PER_RUN,
  MAX_HOOKS_PER_SOURCE,
  type HookConfig,
} from "@clarvis/capability";

/** The `hooks` block of settings.json, spread into settingsSchema. */
export const HOOKS_SETTINGS_FIELDS = {
  hooks: z
    .array(hookSchema)
    .max(MAX_HOOKS_PER_SOURCE)
    .optional()
    .describe(
      "Workspace hooks: shell commands triggered on lifecycle events. Each entry fires " +
        "its command on the given event, optionally filtered by tool name pattern(s) " +
        "and/or argument regexes (tool events only).",
    ),
};

/** Host-derived context for the external skill-command expansion hook. */
export const HOOKS_REQUEST_PARAMS = {
  hook_user_prompt_expansion: z
    .object({
      command_name: z
        .string()
        .min(1)
        .max(256)
        .describe(
          "The user-invoked skill command, optionally qualified by its plugin (plugin:skill).",
        ),
    })
    .strict()
    .optional()
    .describe(
      "Host-derived context for UserPromptExpansion hooks. Omitted for ordinary prompts and " +
        "model-initiated skill loads.",
    ),
};

/** Describe text shared by the plugin-manifest field and its settings spec:
 * plugin hooks run after every operator hook, so an operator always judges first. */
const HOOKS_PLUGIN_DESCRIPTION =
  "Hooks this plugin contributes. These run AFTER every operator hook, so an operator " +
  "hook always gets the first verdict. Executable: gated on enable.";

/** The `hooks` entry of a plugin manifest, spread into pluginManifestSchema. */
export const HOOKS_PLUGIN_FIELDS = {
  hooks: z
    .array(hookSchema)
    .max(MAX_HOOKS_PER_SOURCE)
    .optional()
    .describe(HOOKS_PLUGIN_DESCRIPTION),
};

/**
 * Registration entry that merges hooks across settings scopes: all operator
 * hooks first, then all plugin hooks, so operator hooks always get the first
 * verdict. Plugin-contributable.
 */
export const hooksSettingsSpec: CapabilitySettingsSpec = {
  key: "hooks",
  schema: z.array(hookSchema).max(MAX_HOOKS_PER_SOURCE),
  merge: (scopes) => {
    const of = (origin: "operator" | "plugin"): HookConfig[] =>
      scopes.filter((s) => s.origin === origin).flatMap((s) => s.value as HookConfig[]);
    return [...of("operator"), ...of("plugin")].slice(0, MAX_HOOKS_PER_RUN);
  },
  pluginContributable: true,
  pluginDescription: HOOKS_PLUGIN_DESCRIPTION,
  requestParams: HOOKS_REQUEST_PARAMS,
};
