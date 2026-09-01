import path from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { ToolError } from "../errors.ts";
import { NOOP_TOOLS_LOGGER, type ToolsLogger } from "./log.ts";

/**
 * Resolve a caller-supplied path to a normalized absolute path, optionally
 * proving it stays inside the workspace.
 *
 * @param input - an absolute path, or one relative to `workspaceRoot`.
 * @param workspaceRoot - the workspace directory relative paths resolve against.
 * @param confine - when `true`, reject a target that escapes the workspace root.
 * @param alsoAllow - further roots a confined target may legitimately sit under.
 * @returns the normalized absolute path.
 * @throws {@link ToolError} with code `path_escape` when `confine` is set and the
 *   resolved path lands outside every permitted root.
 * @remarks The confinement check follows symlinks via {@link canonicalize} and
 *   tolerates a not-yet-existing target (see {@link canonicalizeAllowingMissing}).
 *
 *   `alsoAllow` exists for one case and should not be widened casually: a tool
 *   result too large to inline is spilled to the workspace's *state* tree, which
 *   is outside the working tree by design, and the model is handed its path to
 *   read back. Only the read tools pass it, so the widening never admits a
 *   write. The content is output the model already produced and had truncated,
 *   so nothing new is exposed by letting it read the rest.
 *
 *   **The confinement it proves is a check, not a hold, and on the write path
 *   nothing re-establishes it.** What is returned is `abs` — the lexically
 *   normalized path — never the canonical form the check was performed against,
 *   so between this call and the `mkdir`, staging write or `rename` that
 *   follows, a concurrent process can replace a validated parent directory with
 *   a symlink or junction pointing outside the workspace, and the mutation
 *   lands there. That window is open for `mkdir`, `remove`, `move`, `copy` and
 *   for a `write_file` creating a new file.
 *
 *   The read path is not exposed the same way, and the asymmetry is deliberate
 *   rather than lucky: a content read re-proves confinement *after* `open`, by
 *   checking the opened descriptor's `dev`/`ino` identity
 *   (`assertOpenedFileConfined` in `lib/files.ts`), which is why
 *   discarding the canonical form here is harmless there and is not harmless
 *   here.
 *
 *   Closing it needs descriptor- or handle-relative mutation rooted at a trusted
 *   workspace directory — `openat`/`renameat` and the Windows equivalent —
 *   shared by every mutating tool. Narrowing the window by re-running
 *   `realpath`, or by checking the final component, does not close it, and
 *   atomic replacement does not imply confinement: an atomic `rename` into a
 *   swapped parent is atomically outside the workspace. The full threat model
 *   and the mitigations already rejected are in `specs/known-issues.md`; this
 *   remark exists so the decision is readable at the line that makes it rather
 *   than only in a document.
 */
export function resolvePath(
  input: string,
  workspaceRoot: string,
  confine = false,
  alsoAllow: readonly string[] = [],
  logger: ToolsLogger = NOOP_TOOLS_LOGGER,
): string {
  const abs = path.isAbsolute(input) ? path.normalize(input) : path.resolve(workspaceRoot, input);
  if (confine) assertWithinWorkspace(abs, workspaceRoot, input, undefined, alsoAllow, logger);
  return abs;
}

/**
 * Render an absolute path for display, relative to the workspace when it sits
 * inside it.
 *
 * @param absPath - the absolute path to present.
 * @param workspaceRoot - the workspace the path is shown relative to.
 * @returns `"."` when `absPath` is the root itself, the workspace-relative path
 *   when inside, or the unchanged absolute path when it lies outside.
 * @remarks Always forward-slashed, even on Windows: this is model- and
 *   user-facing text, not a filesystem argument, and a caller comparing tool
 *   output across platforms should see one consistent separator.
 */
export function displayPath(absPath: string, workspaceRoot: string): string {
  const rel = path.relative(workspaceRoot, absPath);
  if (rel === "") return ".";
  if (rel.startsWith("..") || path.isAbsolute(rel)) return toPosix(absPath);
  return toPosix(rel);
}

/** Rewrite a native path to forward-slash form for display; a no-op on POSIX. */
function toPosix(p: string): string {
  return path.sep === "\\" ? p.split(path.sep).join("/") : p;
}

/**
 * Fold a path for comparison where the host filesystem ignores case.
 *
 * @remarks
 * Windows only. macOS's default APFS volume is case-insensitive too, but
 * case-sensitive APFS exists, and folding there would accept `/ws/Foo` against
 * root `/ws/foo` where those are genuinely different directories - a real, if
 * narrow, confinement escape. Windows is unconditionally case-insensitive, so
 * the guarantee stays exact there.
 *
 * `toLowerCase`, never `toLocaleLowerCase`: the former is locale-independent, so
 * a Turkish locale cannot make `I` and `i` disagree between the two sides of the
 * comparison.
 */
function forCompare(p: string, caseInsensitive: boolean): string {
  return caseInsensitive ? p.toLowerCase() : p;
}

/**
 * Assert that `abs` resolves to `workspaceRoot` or a path beneath it, comparing
 * canonicalized (symlink-resolved) forms so a symlink cannot smuggle a target
 * out of the workspace.
 *
 * @param abs - the absolute path to check.
 * @param workspaceRoot - the root the path must stay within.
 * @param input - the caller's original spelling, for the error message.
 * @param caseInsensitive - whether to fold case before comparing; defaults to
 *   the host filesystem's semantics and is injectable for tests, because the
 *   property only reproduces with paths whose case differs and those cannot be
 *   built as real directories on a case-sensitive host.
 * @throws {@link ToolError} with code `path_escape` when the target lies outside
 *   the workspace root.
 * @remarks
 * Folding happens *after* canonicalization, on both sides. That matters for a
 * not-yet-existing target: {@link canonicalizeAllowingMissing} re-appends the
 * caller's own spelling of the missing tail, which on Windows would otherwise be
 * compared against a root carrying the filesystem's canonical casing.
 *
 * The trailing separator in the prefix test is what keeps `C:\Projects\x` from
 * passing as a child of `C:\Proj`.
 *
 * Both sides resolve through {@link canonicalizeAllowingMissing}, not the
 * plain {@link canonicalize}, even though `workspaceRoot` is expected to
 * exist in practice. On Windows, a `canonicalize` that falls back to lexical
 * `path.normalize` (because the exact path is missing) never gains a drive
 * letter, while `canonicalizeAllowingMissing` walks up to an existing
 * ancestor and `realpath`s *that* - so the two resolvers can disagree on a
 * root that does not yet exist even though they agree on one that does. Using
 * the same resolver on both sides keeps them consistent in either case; for
 * an already-existing root it degrades to exactly one `canonicalize` call, so
 * there is no cost to the common path.
 *
 * **The refusal must not name the escape hatch.** This message becomes a tool
 * *result*, so its reader is the model, not the operator — and it used to end
 * with a parenthetical naming the environment variable that lifts it. An agent that wants to
 * finish its task reads that as the next step: export the variable in a `shell`
 * call, write it into a config file, or tell the user to. Handing the
 * workaround to the party the boundary exists to bound teaches bypassing a
 * security control as ordinary problem-solving, and a model that learns it here
 * will try it on the next confinement too.
 *
 * So the message states the fact, points at the productive move, and closes the
 * futile one: the setting is read when the toolset is constructed, before the
 * run, so nothing done inside a run can change it. Saying that is worth more
 * than silence — it stops the attempt rather than merely omitting the
 * instructions. The knob is real — `AgentToolsOptions.confineToWorkspace`, which
 * an operator running under `@clarvis/loop` reaches as
 * `CLARVIS_AGENT_TOOLS_CONFINE=0` — and stays documented where the person who
 * may legitimately set it will look: `packages/tools/README.md`.
 */
export function assertWithinWorkspace(
  abs: string,
  workspaceRoot: string,
  input: string,
  caseInsensitive = process.platform === "win32",
  alsoAllow: readonly string[] = [],
  logger: ToolsLogger = NOOP_TOOLS_LOGGER,
): void {
  const target = canonicalizeAllowingMissing(abs);
  if (target !== undefined) {
    const targetReal = forCompare(target, caseInsensitive);
    for (const candidate of [workspaceRoot, ...alsoAllow]) {
      const root = canonicalizeAllowingMissing(candidate);
      if (root === undefined) continue;
      const rootReal = forCompare(root, caseInsensitive);
      if (targetReal === rootReal || targetReal.startsWith(rootReal + path.sep)) return;
    }
  }
  logger.debug(
    {
      event: "tools.path_refused",
      input,
      reason: target === undefined ? "unresolvable" : "outside_root",
      allow_roots_count: alsoAllow.length + 1,
    },
    "a tool path was refused; the call fails with path_escape and the model is told the boundary is fixed",
  );
  throw new ToolError(
    "path_escape",
    `Path escapes the workspace root: ${input}. Only paths inside the workspace are ` +
      `available. This boundary is set before the run starts and cannot be changed from ` +
      `within it.`,
    { path: input },
  );
}

/**
 * Refuse a native mutation whose canonical target overlaps a host-protected root.
 *
 * @param rejectAncestors - Also rejects a target that contains a protected root.
 *   Recursive callers must enable this because traversing an otherwise writable
 *   ancestor would still let them mutate the protected package below it.
 */
export function assertOutsideRoots(
  abs: string,
  protectedRoots: readonly string[],
  input: string,
  rejectAncestors = false,
): void {
  const target = canonicalizeAllowingMissing(abs);
  if (target === undefined) {
    throw new ToolError("path_escape", `Path could not be safely resolved: ${input}.`, {
      path: input,
    });
  }
  const targetReal = forCompare(target, process.platform === "win32");
  for (const candidate of protectedRoots) {
    const root = canonicalizeAllowingMissing(candidate);
    if (root === undefined) continue;
    const rootReal = forCompare(root, process.platform === "win32");
    if (
      targetReal === rootReal ||
      targetReal.startsWith(rootReal + path.sep) ||
      (rejectAncestors && rootReal.startsWith(targetReal + path.sep))
    ) {
      throw new ToolError(
        "path_escape",
        `Path targets an enabled skill package and cannot be changed by native file tools: ${input}.`,
        { path: input },
      );
    }
  }
}

/**
 * Resolve `p` to its real (symlink-free) path, or `undefined` when it cannot be
 * `realpath`ed for any reason — it does not exist, or a component of it is not
 * searchable by this process.
 */
function canonicalize(p: string): string | undefined {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
}

/**
 * Canonicalize a path that may not be resolvable by walking up to the nearest
 * ancestor that *is*, `realpath`ing that, then re-appending the remaining tail.
 *
 * @param abs - the absolute path to canonicalize.
 * @returns the real path of the resolvable prefix joined with the trailing
 *   segments, so a to-be-created file still confines correctly, or `undefined`
 *   when containment cannot be proven and the caller must refuse.
 * @remarks
 * The walk is driven by whether `realpath` *succeeds*, not by whether the path
 * exists. Those differ: a directory that exists but is mode `0o000` fails to
 * resolve on macOS, where `realpath(3)` must open the target, while resolving
 * fine on Linux, whose implementation only walks and `readlink`s. Falling back
 * to a lexical path in that case mixed an unresolved target against a resolved
 * root, and any workspace under a symlinked ancestor — every macOS temp
 * directory, since `/var` is a symlink to `/private/var` — then failed the
 * prefix test and reported `path_escape` for what was really a permission
 * error.
 *
 * Skipping a segment is only sound when that segment cannot redirect the path,
 * so every skipped segment is `lstat`ed and a symlink stops the walk with
 * `undefined`. Resolving less is otherwise *not* safe: `realpath` needs read
 * permission on a directory where creating a file needs only search and write,
 * so a link with mode `0o311` pointing out of the workspace fails to resolve
 * while `open` follows it perfectly well. Treating "unresolvable" as "inside"
 * would admit exactly that write. `lstat` is enough to decide it and needs only
 * search on the parent, which the walk has already proven by resolving it.
 */
function canonicalizeAllowingMissing(abs: string): string | undefined {
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    const real = canonicalize(cur);
    if (real !== undefined) return tail.length > 0 ? path.join(real, ...tail) : real;
    if (isSymbolicLink(cur)) return undefined;
    const parent = path.dirname(cur);
    if (parent === cur) return path.normalize(abs);
    tail.unshift(path.basename(cur));
    cur = parent;
  }
}

/**
 * Whether `p` is itself a symbolic link, without following it.
 *
 * @returns `true` only on a definite link; a path that cannot be `lstat`ed at
 *   all (typically because it does not exist) is not one.
 */
function isSymbolicLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
