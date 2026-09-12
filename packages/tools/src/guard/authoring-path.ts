import { relative, isAbsolute } from "node:path";
import { configurationRoots } from "@clarvis/paths";

/** Canonical authored Markdown only; executable manifests, settings and private trees never match. */
export function isCanonicalAuthoringPath(path: string, workspaceRoot: string): boolean {
  const roots = configurationRoots({ workspaceRoot });
  for (const [kind, root] of [
    ["clarvis", roots.workspace_clarvis],
    ["agents", roots.workspace_agents],
  ] as const) {
    const name = relative(root, path).replaceAll("\\", "/");
    if (isAbsolute(name) || name.startsWith("../")) continue;
    if (/^skills\/[a-z0-9][a-z0-9_-]*\/SKILL\.md$/.test(name)) return true;
    if (
      kind === "clarvis" &&
      (/^agents\/[a-z0-9][a-z0-9_-]*\.md$/.test(name) ||
        /^workflows\/[a-z0-9][a-z0-9_-]*\/WORKFLOW\.md$/.test(name))
    )
      return true;
  }
  return false;
}
