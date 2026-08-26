/**
 * Substitution for the `${VAR}` reference syntax {@link envRefPattern} defines.
 *
 * @remarks Lives beside the pattern rather than in a consumer because three
 *   packages now resolve the same syntax — `@clarvis/mcp-client` for an MCP
 *   server's `env`/`headers`, `@clarvis/llm` for a provider's or model's
 *   `headers`, and `@clarvis/hooks` for the credential denylist it derives from
 *   both. A second implementation is a second reading of the syntax, which is
 *   exactly what {@link envRefPattern}'s own contract exists to prevent.
 */

import { envRefPattern } from "./env-ref.ts";

/**
 * Thrown by {@link resolveStringMap}/{@link resolveHeaders} when one or more
 * `${VAR}` references have no value in the environment. `missing` lists the
 * distinct unresolved variable names.
 */
export class MissingEnvVarsError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(`unresolved environment variable(s): ${missing.join(", ")}`);
    this.name = "MissingEnvVarsError";
    this.missing = missing;
  }
}

/**
 * Substitute `${VAR}` references in a single string against an arbitrary
 * lookup, collecting any that are unset rather than throwing.
 *
 * @param value - the template string; `${NAME}` refs match `[A-Za-z_][A-Za-z0-9_]*`.
 * @param lookup - resolves a variable name to its value, or `undefined` when unset.
 * @returns `resolved` with every found variable substituted (an unset variable
 *   yields an empty string), and `missing` listing the names that were unset (in
 *   encounter order, with duplicates).
 * @remarks Substitution is by `String.replace`, so a value may embed any number
 *   of references among literal text — `Bearer ${TOKEN}` resolves, and its
 *   `TOKEN` is what {@link extractEnvRefs} reports to the hook denylist. A rule
 *   admitting only a whole-value `${NAME}` would be narrower than what this
 *   resolves and than what that denylist already covers.
 */
export function interpolateEnvWith(
  value: string,
  lookup: (name: string) => string | undefined,
): { resolved: string; missing: string[] } {
  const missing: string[] = [];
  const resolved = value.replace(envRefPattern(), (_match, name: string) => {
    const v = lookup(name);
    if (typeof v === "string") return v;
    missing.push(name);
    return "";
  });
  return { resolved, missing };
}

/**
 * Interpolate `${VAR}` refs across every value of a string map, all-or-nothing,
 * against an arbitrary lookup.
 *
 * @param map - the map whose values are templates (keys pass through unchanged).
 * @param lookup - resolves a variable name to its value, or `undefined` when unset.
 * @returns a new map with all values resolved.
 * @throws {@link MissingEnvVarsError} if any referenced variable is unset,
 *   naming the distinct missing variables across the whole map.
 */
export function resolveStringMapWith(
  map: Record<string, string>,
  lookup: (name: string) => string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  const allMissing: string[] = [];
  for (const [key, value] of Object.entries(map)) {
    const { resolved, missing } = interpolateEnvWith(value, lookup);
    if (missing.length > 0) allMissing.push(...missing);
    out[key] = resolved;
  }
  if (allMissing.length > 0) throw new MissingEnvVarsError([...new Set(allMissing)]);
  return out;
}

/**
 * Interpolate `${VAR}` refs across every value of a string map, all-or-nothing.
 *
 * @param map - the map whose values are templates (keys pass through unchanged).
 * @param env - the environment to read from.
 * @returns a new map with all values resolved.
 * @throws {@link MissingEnvVarsError} if any referenced variable is unset,
 *   naming the distinct missing variables across the whole map.
 */
export function resolveStringMap(
  map: Record<string, string>,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  return resolveStringMapWith(map, (name) => env[name]);
}
