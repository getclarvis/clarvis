/**
 * Re-exports the `*`-only glob syntax the shell guard's allow/deny lists are
 * matched against.
 *
 * @remarks The implementation lives in `@clarvis/capability`, shared with
 *   `@clarvis/hooks`' `match.tool` filter so the two security-relevant glob
 *   dialects can only be right or wrong once. Kept as a re-export at this path
 *   so `shell-guard.ts`'s import needs no change.
 */
export { globToRegExp } from "@clarvis/capability";
