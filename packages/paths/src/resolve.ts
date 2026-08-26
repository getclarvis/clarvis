import { isAbsolute, join, resolve } from "node:path";

/**
 * Expand a leading `~` to a home directory.
 *
 * @param p - the path, possibly `~` or `~/…`.
 * @param home - the absolute home directory to substitute for `~`.
 * @returns `home` for exactly `~`, `home` joined with the remainder for `~/…`,
 *   and `p` unchanged otherwise.
 *
 * @remarks Only the two forms a shell itself produces are expanded. A bare
 * `~foo` is left alone — expanding it would mean looking up another user's home
 * directory, which is a different operation with a different failure mode — and
 * so is a Windows-style `~\foo`, because the values reaching here come from
 * settings files and command lines written in the POSIX spelling. Both are
 * returned verbatim rather than rejected, so a directory literally named `~foo`
 * still resolves.
 */
export function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

/**
 * Resolve a path against a base directory after `~` expansion.
 *
 * @param base - the directory a relative path is resolved against.
 * @param p - the path to resolve; `~`/`~/…` is expanded first via {@link expandHome}.
 * @param home - the home directory used for `~` expansion.
 * @returns the expanded path if it is absolute, otherwise it resolved against `base`.
 */
export function resolveAgainst(base: string, p: string, home: string): string {
  const expanded = expandHome(p, home);
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

/**
 * Resolve the effective workspace directory.
 *
 * @param workspace - the configured workspace path, or `undefined` to use `cwd`.
 * @param cwd - the current working directory (the fallback and the resolution base).
 * @param home - the home directory used for `~` expansion.
 * @returns `cwd` when `workspace` is undefined, otherwise `workspace` resolved
 *   against `cwd` via {@link resolveAgainst}.
 *
 * @remarks `cwd` is returned verbatim rather than resolved, so a caller that
 * passes a non-canonical directory gets it back unchanged; every other input
 * goes through {@link resolveAgainst}.
 */
export function resolveWorkspaceDir(
  workspace: string | undefined,
  cwd: string,
  home: string,
): string {
  if (workspace === undefined) return cwd;
  return resolveAgainst(cwd, workspace, home);
}
