/**
 * The settings.json / run-request contract for provider-backed planning.
 *
 * @remarks Ships with the capability rather than with the engine. A host
 * registers it on its {@link CapabilitySettingsSpec} registry at boot, exactly
 * as `@clarvis/workflows` does, which is what lets the engine validate a
 * `plans` block it has never heard of.
 */
import { z } from "zod";
import type { CapabilitySettingsSpec } from "@clarvis/capability";
import { planProviderConfigSchema } from "./provider-config.ts";

/**
 * The product defaults for the `plans` block, in one place so the settings
 * schema, the kernel's run-request assembler and any UI that has to mint a
 * block cannot drift apart.
 *
 * @remarks
 * `retention` mirrors {@link import("./schemas.ts").DEFAULT_PLAN_RETENTION}, and
 * a test in this package asserts the two agree.
 */
export const PLANS_DEFAULTS = {
  mode: "on",
  retention: "keep",
  pending_task_nudges: 3,
} as const;

/** The plan mode: `off` exposes no plan tools, `on` plans without a gate, and
 * `review` holds the plan for human approval before it may be executed. */
const plansModeField = z.enum(["off", "on", "review"], {
  error: "plans must be 'off', 'on', or 'review' (or an object with those keys)",
});

/** The `plans:` settings block: `mode` (see {@link plansModeField}), `retention`
 * (`keep` retains the file as workspace history, `discard` deletes it after a
 * successful terminal record) and the open-task nudge budget. */
const plansConfigSchema = z
  .object({
    mode: plansModeField.default(PLANS_DEFAULTS.mode),
    retention: z.enum(["discard", "keep"]).default(PLANS_DEFAULTS.retention),
    pending_task_nudges: z.number().int().nonnegative().default(PLANS_DEFAULTS.pending_task_nudges),
    provider: planProviderConfigSchema.optional(),
  })
  .strict();

/** The request-visible subset. Provider selection is configuration-only. */
const plansRunConfigSchema = z
  .object({
    mode: plansModeField,
    retention: z.enum(["discard", "keep"]).optional(),
    pending_task_nudges: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * Accepts the terse per-run override ("off"/"on"/"review") OR the full block,
 * so `retention` and `pending_task_nudges` from settings.json actually reach the
 * run instead of being flattened away into a bare mode.
 *
 * @remarks
 * The object form is `.partial()`, so an omitted `retention` stays omitted all
 * the way down and the plan store's own {@link PLANS_DEFAULTS.retention | default}
 * applies. Callers that want the settings default materialized must write it in.
 */
export const plansParamSchema = z
  .union([plansModeField, plansRunConfigSchema])
  .optional()
  .describe(
    "Per-run override for planning. Either 'off' | 'on' | 'review', " +
      "or { mode, retention, pending_task_nudges } to also set the plan's retention and the " +
      "open-task nudge budget for this run.",
  );

/** The `plans` block of settings.json, spread into settingsSchema. */
export const PLANS_SETTINGS_FIELDS = {
  plans: plansConfigSchema
    .optional()
    .describe(
      "Execution plans. Absent provider means Markdown; mode 'off' disables run activation.",
    ),
};
/** Per-run plan params, spread into the run request (and the mcp slim tool). */
export const PLANS_REQUEST_PARAMS = { plans: plansParamSchema };
/** Registration entry for the plans block: last scope wins, not
 * plugin-contributable, and passes the `plans` run param through. */
export const plansSettingsSpec: CapabilitySettingsSpec = {
  key: "plans",
  schema: plansConfigSchema,
  merge: "lastWins",
  pluginContributable: false,
  requestParams: PLANS_REQUEST_PARAMS,
};

/** The `plans` block of `settings.json`, as validated by {@link plansSettingsSpec}.
 *
 * @remarks The *input* shape: a settings file is authored, so every field with a
 * schema default is optional on disk even though it is present once parsed. */
export type PlansSettingsBlock = z.input<typeof plansConfigSchema>;
