import { createRequire } from "node:module";
import type { Ignore } from "ignore";
import { closeSync, constants, existsSync, fstatSync, openSync, readSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { INTERNAL_IGNORE_PATTERNS } from "@clarvis/paths";
import { warn } from "./log.ts";

const makeIgnore = createRequire(import.meta.url)("ignore") as (options?: object) => Ignore;

/** Ignore files are configuration, not an unbounded content channel. */
export const MAX_IGNORE_FILE_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

/** A gitignore-style decision function over workspace-relative paths. */
export interface Matcher {
  /**
   * @param relPath - a path relative to the workspace root.
   * @returns `true` when the path is ignored by the composed gitignore rules.
   */
  ignores(relPath: string): boolean;
}

/**
 * Read one bounded regular file from a non-blocking descriptor.
 *
 * Missing, unreadable, non-regular, or oversized inputs all produce
 * `undefined`. In particular, a FIFO cannot block the synchronous ignore
 * matcher while waiting for a writer, and a pathname replacement after open
 * cannot swap the validated object underneath the read. Close failure is
 * irrelevant because ignore sources are optional and cannot become usable
 * after their read has already settled.
 */
function readFileSafe(p: string): string | undefined {
  let fd: number;
  try {
    const flags = process.platform === "win32" ? "r" : constants.O_RDONLY | constants.O_NONBLOCK;
    fd = openSync(p, flags);
  } catch {
    return undefined;
  }

  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_IGNORE_FILE_BYTES) return undefined;

    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= MAX_IGNORE_FILE_BYTES) {
      const length = Math.min(READ_CHUNK_BYTES, MAX_IGNORE_FILE_BYTES - total + 1);
      const chunk = Buffer.allocUnsafe(length);
      const bytesRead = readSync(fd, chunk, 0, length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > MAX_IGNORE_FILE_BYTES) return undefined;
    return Buffer.concat(chunks, total).toString("utf8");
  } catch {
    return undefined;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Walk upward from `start` to the nearest ancestor containing a `.git` entry,
 * which anchors gitignore resolution.
 *
 * @returns the directory holding `.git`, or `start` itself when no `.git` is
 *   found up to the filesystem root.
 */
function findIgnoreRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/**
 * Locate git's global excludes file, honoring `XDG_CONFIG_HOME` and falling back
 * to `~/.config/git/ignore`.
 *
 * @returns the conventional path. Existence and type are validated from the
 *   descriptor when it is read.
 */
function globalExcludesPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const candidate = xdg
    ? path.join(xdg, "git", "ignore")
    : path.join(os.homedir(), ".config", "git", "ignore");
  return candidate;
}

/** Rewrite a native path to forward-slash (POSIX) form for gitignore matching. */
function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * Build a {@link Matcher} that replicates git's ignore semantics for a workspace,
 * composing (in precedence order) built-in excludes (`.git`, `.clarvis`,
 * `.clarvis-tmp-*`), `.git/info/exclude`, the user's global excludes, and every
 * `.gitignore` from the ignore root down to each queried path.
 *
 * @param workspaceRoot - the workspace whose files are being classified; the
 *   ignore root is the nearest enclosing `.git` directory (or the workspace
 *   itself when none is found).
 * @returns a {@link Matcher}; `.gitignore` files are read and cached lazily on
 *   first query into each directory, so later edits are not picked up by the same
 *   instance.
 * @remarks Nearer-directory rules override farther ones and a later negation
 *   (`!pattern`) can un-ignore a path, matching git. Paths outside the workspace,
 *   empty paths, and `"."` are never ignored; anything under a `.git` directory
 *   always is. An unreadable `.gitignore` that exists is reported via
 *   {@link warn} and treated as absent.
 */
export function loadIgnore(workspaceRoot: string): Matcher {
  const ignoreRoot = findIgnoreRoot(workspaceRoot);

  const base = makeIgnore();
  base.add(INTERNAL_IGNORE_PATTERNS.join("\n"));
  const infoExclude = readFileSafe(path.join(ignoreRoot, ".git", "info", "exclude"));
  if (infoExclude !== undefined) base.add(infoExclude);
  const globalPath = globalExcludesPath();
  const globalExcludes = readFileSafe(globalPath);
  if (globalExcludes !== undefined) base.add(globalExcludes);

  const perDir = new Map<string, Ignore | null>();
  /** Lazily load and cache the `.gitignore` matcher for a single directory,
   * returning `null` when the directory has no readable `.gitignore`. */
  function dirMatcher(dir: string): Ignore | null {
    const cached = perDir.get(dir);
    if (cached !== undefined) return cached;
    const gitignorePath = path.join(dir, ".gitignore");
    const content = readFileSafe(gitignorePath);
    if (content === undefined && existsSync(gitignorePath)) {
      warn(`clarvis-tools: warning: cannot read ${gitignorePath}\n`, {
        event: "tools.ignore_unreadable",
        fields: { path: gitignorePath },
      });
    }
    const m = content !== undefined ? makeIgnore().add(content) : null;
    perDir.set(dir, m);
    return m;
  }

  /** List the directory chain from the ignore root down to `dir` inclusive
   * (root first), so each level's `.gitignore` applies in order; empty when
   * `dir` is not under the ignore root. */
  function dirsFromRootTo(dir: string): string[] {
    const chain: string[] = [];
    let cur = dir;
    for (;;) {
      chain.push(cur);
      if (cur === ignoreRoot) return chain.reverse();
      const parent = path.dirname(cur);
      if (parent === cur) return [];
      cur = parent;
    }
  }

  /** Fold one directory's matcher into the running decision: an ignore forces
   * `true`, a negation forces `false`, and no match leaves `current` unchanged
   * (paths outside this matcher's directory are skipped). */
  function apply(m: Ignore, rel: string, current: boolean | undefined): boolean | undefined {
    if (!rel || rel.startsWith("../")) return current;
    const r = m.test(rel);
    if (r.ignored) return true;
    if (r.unignored) return false;
    return current;
  }

  return {
    ignores(relPath: string): boolean {
      if (!relPath || relPath === ".") return false;
      const norm = toPosix(relPath);
      if (norm.startsWith("../") || path.isAbsolute(norm)) return false;

      const abs = path.resolve(workspaceRoot, relPath);
      if (toPosix(path.relative(ignoreRoot, abs)).split("/").includes(".git")) return true;

      let decision: boolean | undefined = apply(
        base,
        toPosix(path.relative(ignoreRoot, abs)),
        undefined,
      );
      for (const dir of dirsFromRootTo(path.dirname(abs))) {
        const m = dirMatcher(dir);
        if (m) decision = apply(m, toPosix(path.relative(dir, abs)), decision);
      }
      return decision === true;
    },
  };
}
