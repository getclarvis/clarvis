import { opendirSync, realpathSync, statSync, type Dirent } from "node:fs";
import path from "node:path";
import { levelEnabled } from "@clarvis/capability";
import {
  causeOf,
  closeQuietly,
  DEFAULT_DIAGNOSTICS,
  warn,
  type SkillDiagnostics,
} from "./lib/log.ts";
import {
  MAX_SKILL_DIRECTORY_ENTRIES,
  MAX_SKILL_GROUP_DIRECTORIES,
  MAX_SKILL_NESTING,
  MAX_SKILL_RESOURCE_DEPTH,
  MAX_SKILL_RESOURCE_DIRECTORIES,
  MAX_SKILL_RESOURCE_ENTRIES,
  MAX_SKILL_RESOURCES,
  MAX_SKILLS_PER_ROOT,
} from "./limits.ts";
import type { SkillResource } from "./types.ts";

const SKILL_FILE = "skill.md";

/**
 * The subdirectory inside a skill directory that holds harness-directed
 * configuration rather than model-facing content.
 *
 * @remarks
 * Its contents are addressed to whichever runtime loads the skill, never to the
 * model, so the whole directory is withheld from resource enumeration and from
 * resource reads. Matching is by this shape alone: any `.yaml`/`.yml` file
 * directly inside it is a candidate sidecar, and no producer's filename is
 * recognised or spelled anywhere.
 *
 * The name collides with the agent-definition directories (`.clarvis/agents/`,
 * and `.agents/` itself) and is kept anyway, because this is not Clarvis's word
 * to choose: it is the interoperability convention skills are already published
 * under, and a name of our own would simply not be found in a skill somebody
 * else wrote. The collision is also narrower than it reads — this one is only
 * ever a subdirectory *of a skill*, so no path can be ambiguous between them.
 */
const HARNESS_CONFIG_DIR = "agents";

/** Extensions a harness-directed sidecar is recognised by. */
const SIDECAR_EXTENSIONS = [".yaml", ".yml"] as const;

/**
 * A candidate skill: its directory and the `SKILL.md` file found inside it.
 */
export interface SkillDirEntry {
  /** Absolute path to the skill's directory. */
  dir: string;
  /** Absolute path to the `SKILL.md` file within {@link SkillDirEntry.dir}. */
  file: string;
}

/**
 * List the directories under {@link root} that contain a `SKILL.md`, sorted by
 * directory path for deterministic ordering.
 *
 * Descends through directories that hold no skill of their own, so a root that
 * groups its skills — `roles/architect/SKILL.md` — is read as well as one that
 * lists them flat. A directory that *does* hold a `SKILL.md` is a skill, and its
 * own subtree is never descended into: everything under it is that skill's
 * resources, and a `SKILL.md` bundled among them is an example, not a second
 * skill. Depth below the root is bounded by {@link MAX_SKILL_NESTING} and the
 * number of directories visited by {@link MAX_SKILL_GROUP_DIRECTORIES}.
 * Unreadable directories yield nothing rather than throwing.
 *
 * @param root - the root directory to scan.
 * @param followSymlinks - when true, symlinked child dirs and symlinked skill
 *   files are followed via `stat`; when false, only real dirs/files qualify.
 * @param diagnostics - destinations for warnings and skip records.
 * @param maximumSkills - stop probing directories after this many manifests.
 * @returns the discovered `{ dir, file }` entries, sorted by `dir`.
 */
export function listSkillDirs(
  root: string,
  followSymlinks: boolean,
  diagnostics: SkillDiagnostics = DEFAULT_DIAGNOSTICS,
  maximumSkills = MAX_SKILLS_PER_ROOT + 1,
): SkillDirEntry[] {
  const out: SkillDirEntry[] = [];
  const pending: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  let head = 0;
  let probed = 0;
  const done = (): SkillDirEntry[] => out.sort((a, b) => a.dir.localeCompare(b.dir));

  while (head < pending.length) {
    const next = pending[head];
    head += 1;
    if (next === undefined) break;
    const listed = readDirectoryBounded(next.dir, MAX_SKILL_DIRECTORY_ENTRIES, diagnostics);
    if (listed.overflow) continue;
    for (const entry of listed.entries) {
      const dir = path.join(next.dir, entry.name);
      if (!isDirEntry(entry, dir, followSymlinks, diagnostics)) continue;
      probed += 1;
      if (probed > MAX_SKILL_GROUP_DIRECTORIES) {
        warn(
          `clarvis-skills: stopping after ${String(MAX_SKILL_GROUP_DIRECTORIES)} directories ` +
            `under ${root}\n`,
          diagnostics.warningSink,
        );
        skipped(diagnostics, "entries", root);
        return done();
      }
      const file = findSkillFile(dir, followSymlinks, diagnostics);
      if (file !== undefined) {
        out.push({ dir, file });
        if (out.length >= maximumSkills) return done();
        continue;
      }
      if (next.depth + 1 < MAX_SKILL_NESTING) pending.push({ dir, depth: next.depth + 1 });
    }
  }
  return done();
}

/**
 * Find the `SKILL.md` file directly inside {@link dir}, matched
 * case-insensitively.
 *
 * @param dir - the directory to search (non-recursive).
 * @param followSymlinks - when true, a symlink that resolves to a file also
 *   qualifies; otherwise only a real file does.
 * @param diagnostics - destinations for warnings and skip records.
 * @returns the absolute path to the skill file, or `undefined` if none is found.
 */
export function findSkillFile(
  dir: string,
  followSymlinks: boolean,
  diagnostics: SkillDiagnostics = DEFAULT_DIAGNOSTICS,
): string | undefined {
  const listed = readDirectoryBounded(dir, MAX_SKILL_DIRECTORY_ENTRIES, diagnostics);
  if (listed.overflow) return undefined;
  for (const entry of listed.entries) {
    if (entry.name.toLowerCase() !== SKILL_FILE) continue;
    const full = path.join(dir, entry.name);
    if (isFileEntry(entry, full, followSymlinks, diagnostics)) return full;
  }
  return undefined;
}

/**
 * Find the harness-directed sidecar inside a skill directory: the first
 * `.yaml`/`.yml` file, by name, directly under {@link HARNESS_CONFIG_DIR}.
 *
 * @param dir - the skill directory.
 * @param followSymlinks - when true, a symlinked sidecar whose target is a file
 *   also qualifies; otherwise only a real file does.
 * @param diagnostics - destinations for warnings and skip records.
 * @returns the sidecar's absolute path, or `undefined` when the skill carries
 *   none.
 * @remarks A candidate that resolves outside the skill directory is skipped with
 *   a warning, so the sidecar is bound by the same confinement rule bundled
 *   resources are. Discovery stays one level deep on both axes: the skill root is
 *   scanned non-recursively, and so is this directory.
 */
export function findSkillSidecar(
  dir: string,
  followSymlinks: boolean,
  diagnostics: SkillDiagnostics = DEFAULT_DIAGNOSTICS,
): string | undefined {
  const harnessDir = path.join(dir, HARNESS_CONFIG_DIR);
  const rootReal = safeRealpath(dir, diagnostics);
  const listed = readDirectoryBounded(harnessDir, MAX_SKILL_DIRECTORY_ENTRIES, diagnostics);
  for (const entry of listed.entries) {
    const lowered = entry.name.toLowerCase();
    if (!SIDECAR_EXTENSIONS.some((extension) => lowered.endsWith(extension))) continue;
    const full = path.join(harnessDir, entry.name);
    if (!isFileEntry(entry, full, followSymlinks, diagnostics)) continue;
    if (escapesRoot(rootReal, full)) {
      warn(
        `clarvis-skills: skipping skill sidecar escaping skill dir ${full}\n`,
        diagnostics.warningSink,
      );
      skipped(diagnostics, "escaping_symlink", full);
      continue;
    }
    return full;
  }
  return undefined;
}

/**
 * Report whether a resource request addresses the harness-directed
 * configuration directory.
 *
 * @param skillDir - the skill's own directory.
 * @param rel - the requested skill-relative path, as asked for.
 * @param abs - the canonicalized absolute path that request resolved to.
 * @param diagnostics - destinations for the `realpath` probe's own diagnostics.
 * @returns true when either the request or what it resolved to lands inside
 *   {@link HARNESS_CONFIG_DIR}.
 * @remarks Both forms are checked because they fail differently: the lexical one
 *   catches the plain request, and the resolved one catches a symlink inside the
 *   skill that points at the harness directory under another name.
 */
export function isHarnessConfigPath(
  skillDir: string,
  rel: string,
  abs: string,
  diagnostics: SkillDiagnostics = DEFAULT_DIAGNOSTICS,
): boolean {
  const first = path.normalize(rel).split(path.sep)[0]?.toLowerCase() ?? "";
  if (first === HARNESS_CONFIG_DIR) return true;
  const harnessReal = safeRealpath(path.join(skillDir, HARNESS_CONFIG_DIR), diagnostics);
  return abs === harnessReal || abs.startsWith(harnessReal + path.sep);
}

/**
 * Recursively enumerate every resource file under a skill directory (the
 * progressive-disclosure resource layer), excluding the top-level `SKILL.md`
 * itself.
 *
 * Each file is classified by its top-level subdirectory
 * (`scripts`/`references`/`assets`/`examples`, else `other`) and reported with a
 * POSIX-style path relative to {@link dir}. Traversal is loop-safe (a real-path
 * `visited` set) and, when following symlinks, drops any that escape the skill
 * directory (see {@link escapesRoot}).
 *
 * The top-level {@link HARNESS_CONFIG_DIR} is skipped whole, as `SKILL.md`
 * itself is. Its contents are addressed to the harness, and this listing is
 * rendered to the model: leaving it in would both name a harness-directed file
 * to the model and invite it to read one back through `load_skill`.
 *
 * @param dir - the skill directory to walk.
 * @param followSymlinks - whether symlinked files and subdirectories are
 *   followed; escaping symlinks are always skipped with a warning.
 * @param diagnostics - where a prose warning and a `skill.resource_skipped`
 *   record go for every entry the traversal leaves out.
 * @returns the resources, sorted by their relative path.
 * @remarks Directory entries arrive sorted ascending, and children are pushed
 *   onto the pending stack in reverse so the depth-first visit order matches the
 *   recursive form this replaced; the final sort makes the result independent of
 *   it either way.
 */
export function enumerateResources(
  dir: string,
  followSymlinks: boolean,
  diagnostics: SkillDiagnostics = DEFAULT_DIAGNOSTICS,
): SkillResource[] {
  const warningSink = diagnostics.warningSink;
  const out: SkillResource[] = [];
  const visited = new Set<string>();
  const rootReal = safeRealpath(dir, diagnostics);
  const pending: Array<{ current: string; depth: number }> = [{ current: dir, depth: 0 }];
  let inspectedEntries = 0;

  while (pending.length > 0) {
    if (visited.size >= MAX_SKILL_RESOURCE_DIRECTORIES) {
      warn(
        `clarvis-skills: resource directory limit (${String(MAX_SKILL_RESOURCE_DIRECTORIES)}) ` +
          `reached in ${dir}\n`,
        warningSink,
      );
      skipped(diagnostics, "directories", dir);
      break;
    }
    const next = pending.pop()!;
    const real = safeRealpath(next.current, diagnostics);
    if (visited.has(real)) continue;
    visited.add(real);

    const remainingEntries = MAX_SKILL_RESOURCE_ENTRIES - inspectedEntries;
    if (remainingEntries <= 0) {
      warn(
        `clarvis-skills: resource entry limit (${String(MAX_SKILL_RESOURCE_ENTRIES)}) ` +
          `reached in ${dir}\n`,
        warningSink,
      );
      skipped(diagnostics, "entries", dir);
      break;
    }
    const listed = readDirectoryBounded(
      next.current,
      Math.min(MAX_SKILL_DIRECTORY_ENTRIES, remainingEntries),
      diagnostics,
    );
    inspectedEntries += listed.inspected;
    if (inspectedEntries > MAX_SKILL_RESOURCE_ENTRIES) {
      warn(
        `clarvis-skills: resource entry limit (${String(MAX_SKILL_RESOURCE_ENTRIES)}) ` +
          `reached in ${dir}\n`,
        warningSink,
      );
      skipped(diagnostics, "entries", dir);
      break;
    }
    if (listed.overflow) continue;
    const childDirectories: string[] = [];

    for (const entry of listed.entries) {
      const full = path.join(next.current, entry.name);
      if (next.current === dir && entry.name.toLowerCase() === HARNESS_CONFIG_DIR) continue;
      if (entry.isSymbolicLink() && followSymlinks && escapesRoot(rootReal, full)) {
        warn(`clarvis-skills: skipping resource symlink escaping skill dir ${full}\n`, warningSink);
        skipped(diagnostics, "escaping_symlink", full);
        continue;
      }
      if (isFileEntry(entry, full, followSymlinks, diagnostics)) {
        if (next.current === dir && entry.name.toLowerCase() === SKILL_FILE) continue;
        if (out.length >= MAX_SKILL_RESOURCES) {
          warn(
            `clarvis-skills: resource file limit (${String(MAX_SKILL_RESOURCES)}) reached in ` +
              `${dir}\n`,
            warningSink,
          );
          skipped(diagnostics, "count", full);
          return out.sort((a, b) => a.rel.localeCompare(b.rel));
        }
        out.push({ kind: classify(dir, full), rel: toPosixRel(dir, full), path: full });
      } else if (isDirEntry(entry, full, followSymlinks, diagnostics)) {
        if (next.depth >= MAX_SKILL_RESOURCE_DEPTH) {
          warn(
            `clarvis-skills: skipping resource directory deeper than ` +
              `${String(MAX_SKILL_RESOURCE_DEPTH)} levels: ${full}\n`,
            warningSink,
          );
          skipped(diagnostics, "depth", full);
          continue;
        }
        childDirectories.push(full);
      }
    }
    for (let index = childDirectories.length - 1; index >= 0; index -= 1) {
      pending.push({ current: childDirectories[index]!, depth: next.depth + 1 });
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * Why one entry was left out of a skill's resource listing.
 *
 * @remarks `escaping_symlink` is the confinement-relevant one; the rest are the
 *   four traversal caps, named after the bound each hit.
 */
export type ResourceSkipReason =
  "escaping_symlink" | "dangling" | "depth" | "entries" | "directories" | "count";

/**
 * Record one omission from a resource listing.
 *
 * @param diagnostics - the destinations; only the logger is used.
 * @param reason - which rule dropped the entry.
 * @param target - the entry, or the skill directory for a whole-traversal cap.
 * @remarks Guarded by {@link levelEnabled} because this repeats per directory
 *   entry, bounded only by `MAX_SKILL_RESOURCE_ENTRIES`. The bindings object is
 *   built at the call site, so a backend's own level check comes too late.
 */
function skipped(diagnostics: SkillDiagnostics, reason: ResourceSkipReason, target: string): void {
  const logger = diagnostics.logger;
  if (!levelEnabled(logger, "debug")) return;
  logger.debug(
    { event: "skill.resource_skipped", reason, path: target },
    "a skill resource entry was left out of the listing; the model will not see it",
  );
}

/**
 * Report whether the real path of {@link full} lies outside the skill root,
 * used to reject symlinks that point beyond the skill directory.
 *
 * @param rootReal - the real path of the skill directory.
 * @param full - the entry path to test.
 * @returns true when {@link full} resolves outside {@link rootReal} (not the root
 *   itself and not a descendant of it), or when it cannot be resolved for any
 *   reason other than the target being absent.
 * @remarks
 * A *missing* target is reported as not escaping so the caller falls through to
 * the dangling-symlink handling, which skips it with the accurate warning.
 * Resolving to the unresolved path instead compared a raw path against a
 * canonical root, and under a symlinked ancestor — every macOS temp directory,
 * since `/var` is a symlink to `/private/var` — every dangling link looked like
 * an escape.
 *
 * Every *other* resolution failure counts as escaping, because containment
 * cannot be shown and the fall-through does not skip the entry: `isFileEntry`
 * asks `stat`, which needs only search permission on the parent where `realpath`
 * needs read on the target, so a link out of the skill directory whose target is
 * unreadable would otherwise be published as a resource.
 */
function escapesRoot(rootReal: string, full: string): boolean {
  let real: string;
  try {
    real = realpathSync.native(full);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
  return real !== rootReal && !real.startsWith(rootReal + path.sep);
}

/**
 * Classify a resource by its top-level subdirectory under the skill root.
 *
 * @param skillDir - the skill's root directory.
 * @param full - the resource's absolute path.
 * @returns the well-known bucket (`scripts`/`references`/`assets`/`examples`)
 *   when the first path segment matches one, else `other`.
 */
function classify(skillDir: string, full: string): SkillResource["kind"] {
  const top = path.relative(skillDir, full).split(path.sep)[0] ?? "";
  if (top === "scripts" || top === "references" || top === "assets" || top === "examples") {
    return top;
  }
  return "other";
}

/**
 * Compute the path of {@link full} relative to {@link skillDir} with POSIX `/`
 * separators, so resource paths are stable across platforms.
 */
function toPosixRel(skillDir: string, full: string): string {
  return path.relative(skillDir, full).split(path.sep).join("/");
}

interface BoundedDirectoryEntries {
  entries: Dirent[];
  overflow: boolean;
  /** Entries consumed from the stream, including the one that proves overflow. */
  inspected: number;
}

/**
 * Stream at most `maximum` entries so a hostile directory is never materialized whole.
 *
 * @remarks Opening and reading share one `catch` deliberately. Bun's
 * `opendirSync` does not fail eagerly — a missing path, a path that is not a
 * directory, and a permission denial all surface on the first `readSync`
 * instead — so guarding the open separately would be a branch no input can
 * reach. Wrapping both keeps every failure disclosed as an empty listing while
 * leaving no arm that cannot run.
 */
function readDirectoryBounded(
  dir: string,
  maximum: number,
  diagnostics: SkillDiagnostics,
): BoundedDirectoryEntries {
  const entries: Dirent[] = [];
  let inspected = 0;
  let opened: ReturnType<typeof opendirSync> | undefined;
  try {
    opened = opendirSync(dir);
    for (;;) {
      const entry = opened.readSync();
      if (entry === null) break;
      inspected += 1;
      if (entries.length >= maximum) {
        warn(
          `clarvis-skills: skipping directory with more than ${String(maximum)} entries: ` +
            `${dir}\n`,
          diagnostics.warningSink,
        );
        skipped(diagnostics, "entries", dir);
        return { entries: [], overflow: true, inspected };
      }
      entries.push(entry);
    }
  } catch (error) {
    diagnostics.logger.debug(
      { event: "skill.dir_unreadable", path: dir, cause: causeOf(error) },
      "a directory could not be listed; it contributes no skills and no resources",
    );
    return { entries: [], overflow: false, inspected };
  } finally {
    const handle = opened;
    if (handle !== undefined) {
      closeQuietly(
        () => {
          handle.closeSync();
        },
        diagnostics.logger,
        { path: dir },
      );
    }
  }
  return {
    entries: entries.sort((a, b) => a.name.localeCompare(b.name)),
    overflow: false,
    inspected,
  };
}

/**
 * Resolve {@link p} to its native real path, falling back to {@link p} itself
 * when resolution fails (e.g. a dangling link) so cycle detection still has a
 * usable key.
 *
 * @param p - the path to resolve.
 * @param diagnostics - receives a `debug` record naming the failure.
 */
function safeRealpath(p: string, diagnostics: SkillDiagnostics): string {
  try {
    return realpathSync.native(p);
  } catch (error) {
    diagnostics.logger.debug(
      { event: "skill.realpath_failed", path: p, cause: causeOf(error) },
      "a path could not be resolved; the unresolved form is used as the cycle-detection key",
    );
    return p;
  }
}

/**
 * Decide whether a directory entry counts as a file: a real file always does; a
 * symlink does only when {@link followSymlinks} is set and its target is a file.
 */
function isFileEntry(
  entry: Dirent,
  full: string,
  followSymlinks: boolean,
  diagnostics: SkillDiagnostics,
): boolean {
  if (entry.isFile()) return true;
  if (entry.isSymbolicLink() && followSymlinks) return safeStatIsFile(full, diagnostics);
  return false;
}

/**
 * Decide whether a directory entry counts as a directory: a real directory
 * always does; a symlink does only when {@link followSymlinks} is set and its
 * target is a directory.
 */
function isDirEntry(
  entry: Dirent,
  full: string,
  followSymlinks: boolean,
  diagnostics: SkillDiagnostics,
): boolean {
  if (entry.isDirectory()) return true;
  if (entry.isSymbolicLink() && followSymlinks) return safeStatIsDir(full, diagnostics);
  return false;
}

/**
 * Follow a symlink and report whether its target is a regular file, warning and
 * returning false for a dangling link.
 */
function safeStatIsFile(full: string, diagnostics: SkillDiagnostics): boolean {
  try {
    return statSync(full).isFile();
  } catch {
    warn(`clarvis-skills: skipping dangling symlink ${full}\n`, diagnostics.warningSink);
    skipped(diagnostics, "dangling", full);
    return false;
  }
}

/**
 * Follow a symlink and report whether its target is a directory, warning and
 * returning false for a dangling link.
 */
function safeStatIsDir(full: string, diagnostics: SkillDiagnostics): boolean {
  try {
    return statSync(full).isDirectory();
  } catch {
    warn(`clarvis-skills: skipping dangling symlink ${full}\n`, diagnostics.warningSink);
    skipped(diagnostics, "dangling", full);
    return false;
  }
}
