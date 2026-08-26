import type { GuardContext } from "./types.ts";

/**
 * Whether every path the call touches is provably inside the workspace.
 *
 * @param ctx - the guard context to inspect.
 * @returns `true` only when the analysis is decidable, at least one path was
 *   resolved, and all resolved paths sit within the workspace root.
 * @remarks
 * Conservative on purpose: an {@link ShellFacts.undecidable | undecidable}
 * command or a call with no resolved paths returns `false`, so a guard built on
 * this never grants a blanket allow to something it could not fully analyze.
 */
export function withinWorkspace(ctx: GuardContext): boolean {
  if (ctx.shell?.undecidable) return false;
  if (ctx.paths.length === 0) return false;
  return ctx.paths.every((p) => p.withinWorkspace);
}

/**
 * Whether any path the call touches resolves outside the workspace.
 *
 * @param ctx - the guard context to inspect.
 * @returns `true` if at least one resolved path escapes the workspace root.
 * @remarks Not the negation of {@link withinWorkspace}: a call with no paths
 *   (or one that is undecidable) is neither fully inside nor touching outside,
 *   so both predicates return `false`.
 */
export function touchesOutside(ctx: GuardContext): boolean {
  return ctx.paths.some((p) => !p.withinWorkspace);
}
