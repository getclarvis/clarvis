/**
 * The `${VAR}` reference syntax used across the workspace configuration
 * surface: `@clarvis/mcp-client` interpolates it into an MCP server's `env` and
 * `headers`, `@clarvis/llm` into a provider's or model's `headers`, and
 * `@clarvis/hooks` reads it to widen the credential denylist a hook
 * subprocess's environment is filtered through.
 *
 * @remarks Shared here because the uses must never drift: a configured template
 * can name a variable that holds a credential, and `@clarvis/hooks` has to
 * recognize the exact same references the resolvers would substitute, or a
 * secret admitted through one reading of the syntax could leak to a hook
 * subprocess filtered against a narrower one. The substitution itself lives in
 * `env-interpolate.ts`, beside this, for the same reason.
 */

/**
 * Builds the `${VAR}` reference pattern.
 *
 * @returns a fresh, globally-flagged `RegExp` matching `${NAME}` where `NAME`
 *   is `[A-Za-z_][A-Za-z0-9_]*`, with the name captured in group 1.
 * @remarks Returns a new instance on every call rather than a shared module
 *   constant. A `/g` regex is stateful through `lastIndex`, and a shared
 *   instance reused across an interleaved `replace`/`test`/`exec` call would
 *   make one call's result depend on another's; a factory removes the hazard
 *   entirely rather than requiring every call site to remember to reset it.
 */
export function envRefPattern(): RegExp {
  return /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
}

/**
 * Extracts every `${VAR}` reference name from a template string.
 *
 * @param template - a configured string that may embed `${NAME}` references.
 * @returns the referenced names, in order of appearance, with duplicates kept.
 */
export function extractEnvRefs(template: string): string[] {
  const names: string[] = [];
  for (const m of template.matchAll(envRefPattern())) {
    if (m[1] !== undefined) names.push(m[1]);
  }
  return names;
}
