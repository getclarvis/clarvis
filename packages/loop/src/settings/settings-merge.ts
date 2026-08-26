import type { ProviderConfig } from "@clarvis/capability";
import type {
  CapabilitySettingsSpec,
  SettingsScopeOrigin,
  SettingsValueScope,
} from "@clarvis/capability";
import { BUILTIN_SETTINGS_SPECS } from "../runtime/capabilities/settings-specs.ts";
import type { CapabilityRegistry } from "@clarvis/capability";
import { settingsSchema, type SettingsFile } from "./settings-schema.ts";
import { INPUT_LIMITS } from "../validation/input-limits.ts";

/**
 * One layer in the settings precedence stack: a parsed {@link SettingsFile}
 * tagged with where it came from. Scopes are supplied to {@link mergeSettings}
 * in ascending precedence (later wins).
 */
export interface SettingsScope {
  /** Provenance of this layer (e.g. global vs. workspace vs. plugin). */
  origin: SettingsScopeOrigin;
  /** The parsed settings for this layer. */
  settings: SettingsFile;
}

/** Folds an ordered, low-to-high-precedence list of scopes into the merged value for one key. */
type Strategy = (scopes: SettingsScope[]) => unknown;

/** Last-wins fold: the highest-precedence scope that defines `key` supplies the value. */

function lastWins(key: keyof SettingsFile, scopes: SettingsScope[]): unknown {
  let out: unknown;
  for (const scope of scopes) {
    const value = scope.settings[key];
    if (value !== undefined) out = value;
  }
  return out;
}

/**
 * Union provider lists by `name`, later lists overriding same-named entries.
 *
 * @param lists - provider arrays in ascending precedence; `undefined` entries skipped.
 * @returns the merged list, or `undefined` when every argument was `undefined`.
 */
export function mergeProviders(
  ...lists: (ProviderConfig[] | undefined)[]
): ProviderConfig[] | undefined {
  if (lists.every((l) => l === undefined)) return undefined;
  const byName = new Map<string, ProviderConfig>();
  for (const list of lists) {
    for (const p of list ?? []) byName.set(p.name, p);
  }
  if (byName.size > INPUT_LIMITS.providers) {
    throw new Error(`merged providers exceed ${String(INPUT_LIMITS.providers)} entries`);
  }
  return [...byName.values()];
}

/** Shallow-merge records left-to-right (later keys win); `undefined` when all inputs are absent. */
function mergeRecord<T>(
  maxEntries: number,
  ...records: (Record<string, T> | undefined)[]
): Record<string, T> | undefined {
  if (records.every((r) => r === undefined)) return undefined;
  const merged = Object.assign({}, ...records) as Record<string, T>;
  if (Object.keys(merged).length > maxEntries) {
    throw new Error(`merged record exceeds ${String(maxEntries)} entries`);
  }
  return merged;
}

/**
 * Concatenate a string-list field across scopes in precedence order, dropping
 * duplicates so the first occurrence sets the position (used for `enabledPlugins`
 * and `marketplaces`, where order is precedence).
 */
function concatDistinct(
  scopes: SettingsScope[],
  pick: (s: SettingsFile) => string[] | undefined,
  maxEntries: number,
): string[] | undefined {
  if (scopes.every((s) => pick(s.settings) === undefined)) return undefined;
  const out: string[] = [];
  for (const scope of scopes) {
    for (const value of pick(scope.settings) ?? []) {
      if (!out.includes(value)) out.push(value);
      if (out.length > maxEntries) {
        throw new Error(`merged list exceeds ${String(maxEntries)} entries`);
      }
    }
  }
  return out;
}

/** A capability block's strategy, derived from its spec: scopes with a defined
 * value are collected and merged per the spec (lastWins or a custom fold). */
function specStrategy(spec: CapabilitySettingsSpec): Strategy {
  const key = spec.key as keyof SettingsFile;
  return (scopes) => {
    const valueScopes: SettingsValueScope[] = scopes
      .filter((s) => s.settings[key] !== undefined)
      .map((s) => ({ origin: s.origin, value: s.settings[key] }));
    if (valueScopes.length === 0) return undefined;
    if (spec.merge === "lastWins") return valueScopes[valueScopes.length - 1]!.value;
    return spec.merge(valueScopes);
  };
}

/** Merge strategies for the non-capability core keys of a {@link SettingsFile}. */
const CORE_STRATEGIES: Partial<Record<keyof SettingsFile, Strategy>> = {
  providers: (scopes) => mergeProviders(...scopes.map((s) => s.settings.providers)),
  mcpServers: (scopes) =>
    mergeRecord(INPUT_LIMITS.mcpMapEntries, ...scopes.map((s) => s.settings.mcpServers)),
  default_model: (scopes) => lastWins("default_model", scopes),
  default_vision_model: (scopes) => lastWins("default_vision_model", scopes),
  default_reasoning_effort: (scopes) => lastWins("default_reasoning_effort", scopes),
  budget: (scopes) => lastWins("budget", scopes),
  enabledPlugins: (scopes) =>
    concatDistinct(scopes, (s) => s.enabledPlugins, INPUT_LIMITS.enabledPlugins),
  marketplaces: (scopes) =>
    concatDistinct(scopes, (s) => s.marketplaces, INPUT_LIMITS.marketplaces),
};

/** Every merge strategy: the core keys plus one per built-in capability settings spec. */
const STRATEGIES: Record<string, Strategy> = {
  ...CORE_STRATEGIES,
  ...Object.fromEntries(BUILTIN_SETTINGS_SPECS.map((spec) => [spec.key, specStrategy(spec)])),
};

/** The full set of {@link SettingsFile} keys that {@link mergeSettings} folds. */
export const SETTINGS_MERGE_STRATEGY_KEYS = Object.keys(STRATEGIES) as (keyof SettingsFile)[];

for (const key of Object.keys(settingsSchema.shape)) {
  if (!(key in STRATEGIES)) {
    throw new Error(`settings-merge: no merge strategy for settings key '${key}'`);
  }
}

/**
 * Merge an ordered stack of settings scopes into one effective
 * {@link SettingsFile}, applying each key's strategy (last-wins, union, or a
 * capability's custom fold).
 *
 * @param scopes - layers in ascending precedence (a later scope outranks an earlier one).
 * @returns the merged settings, with a key omitted when no scope defined it.
 * @remarks A module-load guard fails fast if any schema key lacks a strategy, so
 *   a new settings key cannot ship without its merge behavior.
 */
export function mergeSettings(
  scopes: SettingsScope[],
  registry?: CapabilityRegistry,
): SettingsFile {
  const out: SettingsFile = {};
  for (const key of SETTINGS_MERGE_STRATEGY_KEYS) {
    const value = STRATEGIES[key]!(scopes);
    if (value !== undefined) Reflect.set(out, key, value);
  }
  for (const spec of registry?.specs() ?? []) {
    if (spec.key in STRATEGIES) continue;
    const value = specStrategy(spec)(scopes);
    if (value !== undefined) Reflect.set(out, spec.key, value);
  }
  return out;
}
