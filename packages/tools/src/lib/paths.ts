import path from "node:path";
import { ToolError } from "../errors.ts";
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

/** Resolve a file-tool path against the workspace without imposing an access boundary. */
export function resolveFileToolPath(
  input: string,
  config: Pick<RuntimeConfig, "workspaceRoot">,
): string {
  rejectHomeShorthand(input);
  return resolvePath(input, config.workspaceRoot);
}

/**
 * Render an absolute path for display, relative to the workspace when it sits
 * inside it.
 *
 * @param absPath - the absolute path to present.
 * @param workspaceRoot - the workspace the path is shown relative to.
 * @returns `"."` when `absPath` is the root itself, the workspace-relative path
 *   when inside, or the unchanged absolute path when it lies outside.
 * @remarks Always forward-slashed: this is model-facing and user-facing text, not a filesystem argument.
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
