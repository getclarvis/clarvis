/**
 * How a capability declares its host-configuration surface: one settings.json
 * block, its merge strategy across settings scopes, whether plugins may
 * contribute it, and any per-run request parameters.
 *
 * The zod fields themselves are composed statically (settings-specs.ts spreads
 * each capability's field consts, preserving precise inference for
 * SettingsFile/RunRequest); the spec objects drive the generic machinery —
 * merge strategies, the plugin-manifest surface, and the mcp assemblers'
 * request-param passthrough.
 */
import type { z } from "zod";

/** Where a settings-scope value came from: an enabled `plugin`'s manifest or the
 * `operator`'s own settings.json. */
export type SettingsScopeOrigin = "plugin" | "operator";

/** One scope's value for a capability's settings key (only defined values). */
export interface SettingsValueScope {
  origin: SettingsScopeOrigin;
  value: unknown;
}

/** How a capability's stacked settings scopes combine into one value: the
 * built-in `"lastWins"`, or a custom reducer over the ordered
 * {@link SettingsValueScope}s. */
export type SettingsMergeStrategy =
  "lastWins" | ((scopes: readonly SettingsValueScope[]) => unknown);

/** One capability's declaration of its host-configuration surface: its
 * settings.json block key and schema, its cross-scope merge strategy, whether a
 * plugin manifest may contribute it, and any per-run request parameters. */
export interface CapabilitySettingsSpec {
  /** The block's key in settings.json (and in a plugin manifest, if allowed). */
  key: string;
  /** The block's schema, unwrapped (composition applies optional/describe). */
  schema: z.ZodType;
  /** How values from stacked settings scopes combine. */
  merge: SettingsMergeStrategy;
  /** Whether an enabled plugin's manifest may contribute this block. */
  pluginContributable: boolean;
  /** Manifest describe text (contributable) — plugin-facing wording. */
  pluginDescription?: string;
  /**
   * When NOT contributable: an explanatory rejection for a manifest that
   * tries anyway (declared as a z.undefined field). Without it the manifest's
   * strict parsing rejects the key generically.
   */
  pluginForbiddenReason?: string;
  /** Per-run request parameters (optional-wrapped, described zod fields). */
  requestParams?: z.ZodRawShape;
}

/** Request-param keys a spec adds to the run request (assembler passthrough). */
export function requestParamKeys(specs: readonly CapabilitySettingsSpec[]): string[] {
  return specs.flatMap((spec) => Object.keys(spec.requestParams ?? {}));
}
