/**
 * Host-side resolution of the sandbox settings block into concrete filesystem
 * policy: validating operator-supplied extra paths and discovering the runtime
 * toolchain roots the sandbox must expose read-only. Lives on the host side of
 * the guard/sandbox seam (it touches the real filesystem and `@clarvis/tools`).
 */
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  discoverToolchains,
  forbiddenSandboxRoots,
  type DiscoveredToolchain,
} from "@clarvis/tools/sandbox";
import type { ResolvedSandboxSettings, SandboxSettings } from "./tools-settings.ts";

/** True when `path` is `root` itself or lies inside it (never via `..` or an
 * absolute escape). Used both to keep a workspace path inside the workspace and
 * to reject a path that would contain it. */
function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** A resolved sandbox path: the absolute `path`, plus an `error` string when it
 * was rejected (the caller drops paths that carry one). */
export interface ResolvedSandboxPath {
  path: string;
  error?: string;
}

/**
 * Resolve and validate one sandbox path against the workspace root.
 *
 * @param raw - The configured path, absolute or (when `allowRelative`)
 *   workspace-relative.
 * @param workspaceRoot - The run's workspace root, used to anchor relative paths
 *   and to reject over-broad or workspace-containing paths.
 * @param allowRelative - Whether a non-absolute `raw` is permitted (false for
 *   global settings, which require absolute paths).
 * @returns A {@link ResolvedSandboxPath}; `error` is set when the path is
 *   non-absolute where disallowed, a relative path escapes the workspace, the
 *   path is too broad (`/`, `/home`, the home dir), it contains the workspace,
 *   or it does not exist.
 */
export function resolveSandboxPath(
  raw: string,
  workspaceRoot: string,
  allowRelative: boolean,
): ResolvedSandboxPath {
  if (!allowRelative && !isAbsolute(raw)) {
    return { path: raw, error: "global sandbox paths must be absolute" };
  }
  const root = resolve(workspaceRoot);
  const path = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  if (!isAbsolute(raw) && !within(path, root)) {
    return { path, error: "workspace sandbox path escapes the workspace" };
  }
  if (forbiddenSandboxRoots().includes(path)) {
    return { path, error: "sandbox path is too broad" };
  }
  if (within(root, path)) {
    return { path, error: "sandbox path may not contain the workspace" };
  }
  if (!existsSync(path)) return { path, error: "path does not exist" };
  return { path };
}

/**
 * Discover the language/runtime toolchains a sandbox should expose.
 *
 * @returns The discovered {@link DiscoveredToolchain}s honoring the settings'
 *   `include` filter and `exclude` list; an empty array when `toolchains.mode`
 *   is `"manual"` (auto-discovery disabled).
 */
export function discoverSandboxToolchains(
  settings: SandboxSettings | undefined,
): DiscoveredToolchain[] {
  const toolchains = settings?.toolchains;
  if (toolchains?.mode === "manual") return [];
  const excluded = new Set(toolchains?.exclude ?? []);
  return discoverToolchains(toolchains?.include).filter((item) => !excluded.has(item.id));
}

/**
 * Resolve the full sandbox settings block into the concrete path lists the
 * runtime consumes.
 *
 * @returns The input `settings` augmented with `resolved_runtime_paths` (roots
 *   of the available discovered toolchains) and `resolved_read_only_paths`
 *   (valid, non-excluded `extra_paths`), each omitted when empty; undefined when
 *   `settings` is undefined.
 */
export function resolveSandboxHostPolicy(
  settings: SandboxSettings | undefined,
  workspaceRoot: string,
): ResolvedSandboxSettings | undefined {
  if (settings === undefined) return undefined;
  const runtimePaths = discoverSandboxToolchains(settings).flatMap((item) =>
    item.available && item.root ? [item.root] : [],
  );
  const excludedPaths = new Set(settings.toolchains?.excluded_paths ?? []);
  const readOnlyPaths = (settings.toolchains?.extra_paths ?? []).flatMap((raw) => {
    if (excludedPaths.has(raw)) return [];
    const result = resolveSandboxPath(raw, workspaceRoot, true);
    return result.error === undefined ? [result.path] : [];
  });
  const uniqueRuntimePaths = [...new Set(runtimePaths)];
  const uniqueReadOnlyPaths = [...new Set(readOnlyPaths)];
  return {
    ...settings,
    ...(uniqueRuntimePaths.length > 0 ? { resolved_runtime_paths: uniqueRuntimePaths } : {}),
    ...(uniqueReadOnlyPaths.length > 0 ? { resolved_read_only_paths: uniqueReadOnlyPaths } : {}),
  };
}
