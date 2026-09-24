import path from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { ToolError, type ErrorCode } from "../errors.ts";
import { configurationRoots, configurationTarget, type ConfigurationRoot } from "@clarvis/paths";
import type { RuntimeConfig } from "../config.ts";

/**
 * Resolve a caller-supplied path to a normalized absolute path.
 *
 * @param input - an absolute path, or one relative to `workspaceRoot`.
 * @param workspaceRoot - the workspace directory relative paths resolve against.
 * @returns the normalized absolute path.
 * @remarks `workspaceRoot` is a relative-path base, not an authorization boundary.
 * The selected execution environment determines which absolute paths can be used.
 */
export function resolvePath(input: string, workspaceRoot: string): string {
  return path.isAbsolute(input) ? path.normalize(input) : path.resolve(workspaceRoot, input);
}

/** Reject shell-only home shorthand before a file tool can create a literal `~` directory. */
function rejectHomeShorthand(input: string): void {
  if (input === "~" || input.startsWith("~/") || input.startsWith("~\\"))
    throw new ToolError(
      "invalid_input",
      `Home shorthand is not supported in file tools: ${input}. Use an absolute path or a path relative to the workspace.`,
      { path: input },
    );
}

/** Resolve a file-tool path while preserving independent configuration protection. */
export function resolveFileToolPath(
  input: string,
  config: Pick<RuntimeConfig, "workspaceRoot" | "stateRoot" | "configurationRoots">,
): string {
  rejectHomeShorthand(input);
  const abs = resolvePath(input, config.workspaceRoot);
  if (isWithinRoots(abs, [config.stateRoot]))
    throw new ToolError("path_escape", `Path is not a readable output artifact: ${input}`, {
      path: input,
    });
  const roots =
    config.configurationRoots ?? configurationRoots({ workspaceRoot: config.workspaceRoot });
  const lexicalTarget = configurationTarget(roots, abs);
  const canonical = canonicalizeAllowingMissing(abs);
  if (canonical === undefined)
    throw new ToolError(
      lexicalTarget === undefined ? "io_error" : "path_escape",
      `Path could not be safely resolved: ${input}.`,
      {
        path: input,
      },
    );
  const canonicalRoots = {} as Record<ConfigurationRoot, string>;
  for (const [root, directory] of Object.entries(roots)) {
    const resolved = canonicalizeAllowingMissing(directory);
    if (resolved === undefined)
      throw new ToolError("path_escape", `Configuration root could not be resolved: ${root}.`);
    canonicalRoots[root as ConfigurationRoot] = resolved;
  }
  const actualTarget = configurationTarget(canonicalRoots, canonical);
  const classification = lexicalTarget?.kind ?? actualTarget?.kind;
  if (classification === "secret")
    throw new ToolError("denied", `Configuration target is secret: ${input}.`, { path: input });
  if (classification === "reserved_unknown")
    throw new ToolError(
      "unrecognized_configuration_target",
      `Configuration target is not recognized: ${input}.`,
      { path: input },
    );
  if (
    (lexicalTarget === undefined) !== (actualTarget === undefined) ||
    (lexicalTarget !== undefined &&
      (lexicalTarget.root !== actualTarget?.root || lexicalTarget.path !== actualTarget.path))
  )
    throw new ToolError("path_escape", `Configuration path changed during resolution: ${input}.`, {
      path: input,
    });
  if (lexicalTarget !== undefined) {
    let current = roots[lexicalTarget.root];
    for (const part of ["", ...lexicalTarget.path.split("/")]) {
      if (part !== "") current = path.join(current, part);
      try {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink() || (current === abs && stat.isFile() && stat.nlink !== 1))
          throw new ToolError("denied", `Configuration target contains a link: ${input}.`, {
            path: input,
          });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return abs;
}

/** Skip private or redirected leaves before a recursive file tool observes them. */
export function isAdmittedFileToolSearchPath(
  candidate: string,
  config: Pick<RuntimeConfig, "workspaceRoot" | "stateRoot" | "configurationRoots">,
): boolean {
  try {
    resolveFileToolPath(candidate, config);
    return true;
  } catch {
    return false;
  }
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
 * narrow, protected-root comparison error. Windows is unconditionally case-insensitive, so
 * the guarantee stays exact there.
 *
 * `toLowerCase`, never `toLocaleLowerCase`: the former is locale-independent, so
 * a Turkish locale cannot make `I` and `i` disagree between the two sides of the
 * comparison.
 */
function forCompare(p: string, caseInsensitive: boolean): string {
  return caseInsensitive ? p.toLowerCase() : p;
}

/** Canonical location fact for Guard risk analysis; this never grants file access. */
export function isWithinRoots(
  abs: string,
  roots: readonly string[],
  caseInsensitive = process.platform === "win32",
): boolean {
  const target = canonicalizeAllowingMissing(abs);
  if (target === undefined) return false;
  const targetReal = forCompare(target, caseInsensitive);
  for (const candidate of roots) {
    const root = canonicalizeAllowingMissing(candidate);
    if (root === undefined) continue;
    const rootReal = forCompare(root, caseInsensitive);
    if (targetReal === rootReal || targetReal.startsWith(rootReal + path.sep)) return true;
  }
  return false;
}

/**
 * Refuse a native mutation whose canonical target overlaps a host-protected root.
 *
 * @param options.rejectAncestors - Also rejects a target that contains a protected root.
 *   Recursive callers must enable this because traversing an otherwise writable
 *   ancestor would still let them mutate the protected package below it.
 * @param options.code - Stable error code for a protected-root overlap.
 * @param options.message - Human-facing error for a protected-root overlap.
 */
export function assertOutsideRoots(
  abs: string,
  protectedRoots: readonly string[],
  input: string,
  options: { rejectAncestors?: boolean; code?: ErrorCode; message?: string } = {},
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
      (options.rejectAncestors === true && rootReal.startsWith(targetReal + path.sep))
    ) {
      throw new ToolError(
        options.code ?? "path_escape",
        options.message ??
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
 *   segments, so a to-be-created classified path can still be checked, or
 *   `undefined` when the caller cannot prove its classification.
 * @remarks
 * The walk is driven by whether `realpath` *succeeds*, not by whether the path
 * exists. Those differ: a directory that exists but is mode `0o000` fails to
 * resolve on macOS, where `realpath(3)` must open the target, while resolving
 * fine on Linux, whose implementation only walks and `readlink`s. Falling back
 * to a lexical path in that case mixed an unresolved target against a resolved
 * root. A workspace under a symlinked ancestor — for example `/var` pointing
 * to `/private/var` on macOS — can otherwise produce a false classification.
 *
 * Skipping a segment is only sound when that segment cannot redirect the path,
 * so every skipped segment is `lstat`ed and a symlink stops the walk with
 * `undefined`. Resolving less is otherwise *not* safe: `realpath` needs read
 * permission on a directory where creating a file needs only search and write,
 * so a link with mode `0o311` may fail to resolve while `open` follows it.
 * Treating "unresolvable" as an admitted classified path would allow a redirect.
 * `lstat` is enough to decide it and needs only
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
