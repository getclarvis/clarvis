import type { GuardContext, ShellFacts } from "./types.ts";

/**
 * Identify narrow high-risk command forms in already-normalized argv.
 *
 * `sudo` with any arguments and `rm` with a force option require special review.
 * Only options before `--` count; long options merely containing `f` do not.
 * This is a review fact, not a complete danger detector or an approval policy.
 */
export function isDangerousCommand(shell: ShellFacts): boolean {
  return shell.segments.some(({ argv, normalized }) => {
    const head = normalized.split(" ", 1)[0];
    if (head === "sudo") return true;
    if (head !== "rm") return false;
    for (const arg of argv.slice(1)) {
      if (arg === "--") break;
      if (arg === "--force" || /^-[^-]*f[^-]*$/.test(arg)) return true;
    }
    return false;
  });
}

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
