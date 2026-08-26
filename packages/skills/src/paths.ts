import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import { SkillError } from "./errors.ts";
import { causeOf } from "./lib/log.ts";

/**
 * Resolve a skill-relative resource path to an absolute one, refusing any path
 * that escapes the skill directory.
 *
 * The guard is symlink-aware: both the skill directory and the target are
 * canonicalized (`realpath`) before the containment check, so a symlink inside
 * the skill pointing outside it is caught. The target may not yet exist — its
 * closest existing ancestor is canonicalized and the missing tail re-appended
 * (see {@link canonicalizeAllowingMissing}).
 *
 * @param skillDir - absolute path of the skill's own directory.
 * @param rel - the resource path relative to `skillDir`.
 * @param logger - receives a warning whenever the containment check had to fall
 *   back to a lexical comparison because `realpath` failed.
 * @returns the canonical absolute path under `skillDir`.
 * @throws {@link SkillError} `invalid_input` if `rel` is empty or absolute;
 *   `path_escape` if the canonicalized target falls outside `skillDir`.
 */
export function resolveResourcePath(
  skillDir: string,
  rel: string,
  logger: Logger = NOOP_LOGGER,
): string {
  if (rel.length === 0) {
    throw new SkillError("invalid_input", "resource path must not be empty");
  }
  if (path.isAbsolute(rel)) {
    throw new SkillError("invalid_input", `resource path must be relative: ${rel}`, { rel });
  }
  const abs = path.resolve(skillDir, rel);
  const dirReal = canonicalize(skillDir, logger);
  const targetReal = canonicalizeAllowingMissing(abs, logger);
  if (targetReal !== dirReal && !targetReal.startsWith(dirReal + path.sep)) {
    throw new SkillError("path_escape", `resource path escapes the skill directory: ${rel}`, {
      rel,
    });
  }
  return targetReal;
}

/**
 * Canonicalize an existing path via the native `realpath`, resolving symlinks.
 *
 * @param p - the path to canonicalize; must exist for the `realpath` to succeed.
 * @param logger - receives one warning per fallback.
 * @returns the real path; falls back to a lexical {@link path.normalize} when
 *   `realpath` throws (e.g. the path does not exist).
 * @remarks The fallback is confinement-relevant, which is why it is reported at
 *   `warn` rather than `debug`: a lexical comparison cannot see through a
 *   symlink, so a containment decision taken on it is weaker than the one this
 *   function promises. Every caller passes a path it expects to exist.
 */
function canonicalize(p: string, logger: Logger): string {
  try {
    return realpathSync.native(p);
  } catch (error) {
    logger.warn(
      { event: "skill.path_unresolved", path: p, cause: causeOf(error) },
      "a skill path could not be canonicalized; containment was checked against its " +
        "lexical form, which cannot see through a symlink",
    );
    return path.normalize(p);
  }
}

/**
 * Canonicalize a path whose leaf (or deeper tail) may not exist yet.
 *
 * Walks up to the nearest existing ancestor, canonicalizes that via
 * {@link canonicalize}, then re-joins the non-existent tail — so symlinks in the
 * existing prefix are resolved without requiring the full path to be present.
 *
 * @param abs - the absolute path to canonicalize.
 * @param logger - forwarded to {@link canonicalize}.
 * @returns the canonical path with any missing tail re-appended; falls back to a
 *   lexical {@link path.normalize} of `abs` when no ancestor exists (root
 *   reached).
 */
function canonicalizeAllowingMissing(abs: string, logger: Logger): string {
  const tail: string[] = [];
  let cur = abs;
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return path.normalize(abs);
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  const real = canonicalize(cur, logger);
  return tail.length > 0 ? path.join(real, ...tail) : real;
}
