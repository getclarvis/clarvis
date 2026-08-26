/**
 * The `*`-only glob syntax shared by `@clarvis/kernel`'s shell guard allow/deny
 * lists and `@clarvis/hooks`' `match.tool` filters.
 *
 * @remarks Both patterns are security-relevant: an unanchored match would let
 * `github.*` also select `mygithub.internal`. Sharing one implementation
 * means the anchoring and escaping rules can only be right or wrong once.
 */

/**
 * Escapes every regex metacharacter in `s` so it matches literally.
 *
 * @param s - a glob fragment with no `*` wildcards (the caller splits on `*`
 *   first).
 * @returns `s` with `.*+?^${}()|[]\` backslash-escaped.
 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Converts a simple `*`-glob into an anchored regular expression (other regex
 * metacharacters are escaped).
 *
 * @param pattern - a glob whose only wildcard is `*` (matching any run of
 *   characters); all other regex metacharacters are treated literally.
 * @returns a regex anchored with `^`/`$`, so the whole candidate string must
 *   match - each `*` becomes `.*`.
 */
export function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
}
