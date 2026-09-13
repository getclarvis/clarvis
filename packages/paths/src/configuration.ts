import { homedir } from "node:os";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { AGENTS_DIR, MARKETPLACE_FILE } from "./constants.ts";
import { globalPaths } from "./global.ts";
import { workspacePaths } from "./workspace.ts";

/** The four configuration scopes; each mutation requires independent effect admission. */
export type ConfigurationRoot =
  "global_clarvis" | "workspace_clarvis" | "global_agents" | "workspace_agents";

/** Resolve configuration roots without creating directories or granting access to their contents. */
export function configurationRoots(options: {
  workspaceRoot: string;
  globalDir?: string;
  home?: string;
}): Readonly<Record<ConfigurationRoot, string>> {
  return {
    global_clarvis: resolve(globalPaths(options.globalDir).root),
    workspace_clarvis: resolve(workspacePaths(options.workspaceRoot).clarvisDir),
    global_agents: resolve(join(options.home ?? homedir(), AGENTS_DIR)),
    workspace_agents: resolve(join(options.workspaceRoot, AGENTS_DIR)),
  };
}

const CLARVIS_FILES = new Set([
  "settings.json",
  "shared-agent.md",
  "guard-judge.md",
  "memory-policy.md",
  "CLARVIS.md",
  "AGENTS.md",
]);
const CLARVIS_DIRS = new Set([
  "agents",
  "skills",
  "plugins",
  "workflows",
  "extension-profiles",
  "runtime-recipes",
]);
const SHARED_DIRS = new Set(["skills", "plugins"]);
const PRIVATE_COMPONENT =
  /^(?:keys?|subscriptions?|auth(?:-key)?|credentials?|secrets?|tokens?|workspace-trust)(?:[.-]|$)|^\.env(?:[.-]|$)|\.(?:pem|key|p12|pfx)$/i;

/**
 * Classify a relative configuration target without granting access or touching disk.
 * Callers still resolve actual targets and enforce confinement and link protections.
 * Unknown/private trees and malformed relative paths never become inferred writes.
 */
export function configurationPathClass(
  root: ConfigurationRoot,
  path: string,
): "authoring" | "operational" | "private" {
  const parts = path === "" ? [] : path.split("/");
  if (
    path.length > 1024 ||
    [...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    /[\\:]/.test(path) ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) ||
        PRIVATE_COMPONENT.test(part) ||
        [".git", "node_modules", "state", "cache"].includes(part.toLowerCase()),
    )
  )
    return "private";
  const head = parts[0];
  if (head === undefined) return "operational";
  const shared = root.endsWith("_agents");
  const admitted = shared
    ? SHARED_DIRS.has(head) || (parts.length === 1 && head === MARKETPLACE_FILE)
    : CLARVIS_DIRS.has(head) || (parts.length === 1 && CLARVIS_FILES.has(head));
  if (!admitted) return "private";
  if (
    /^skills\/[a-z0-9][a-z0-9_-]*\/SKILL\.md$/.test(path) ||
    (!shared &&
      (/^agents\/[a-z0-9][a-z0-9_-]*\.md$/.test(path) ||
        /^workflows\/[a-z0-9][a-z0-9_-]*\/WORKFLOW\.md$/.test(path)))
  )
    return "authoring";
  return "operational";
}

/** Locate an already resolved target in the shared root vocabulary without granting access.
 * Callers own canonical filesystem resolution and must still reject links and escapes.
 */
export function configurationTarget(
  roots: Readonly<Partial<Record<ConfigurationRoot, string>>>,
  target: string,
):
  | { root: ConfigurationRoot; path: string; kind: ReturnType<typeof configurationPathClass> }
  | undefined {
  for (const [root, directory] of Object.entries(roots)) {
    const path = relative(directory, target);
    if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) continue;
    const key = root as ConfigurationRoot;
    const local = path.split(sep).join("/");
    return { root: key, path: local, kind: configurationPathClass(key, local) };
  }
  return undefined;
}
