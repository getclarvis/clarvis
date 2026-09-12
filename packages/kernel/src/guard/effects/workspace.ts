import { basename, relative, isAbsolute } from "node:path";
import { configurationRoots } from "@clarvis/paths";
import { isCanonicalAuthoringPath, type GuardContext } from "@clarvis/tools/guard";
import { effectDigest, effectFact } from "./facts.ts";
import type { EffectAttestorDeps } from "./types.ts";
import type { GuardEffectBatch } from "./types.ts";

const READ = new Set(["read_file", "file_stat", "list_dir", "glob", "grep", "tree", "read_image"]);
const WRITE = new Set(["write_file", "edit_file", "multi_edit", "apply_patch"]);
const EXECUTABLE_MANIFEST =
  /^(?:package\.json|bun\.lockb?|Makefile|Dockerfile|Cargo\.toml|pyproject\.toml|.*\.lock)$/i;
const SECRET =
  /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|id_rsa|id_ed25519|keys\.json|.*\.(?:pem|key|p12|pfx))$/i;
function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\"))
  );
}

/** Native paths arrive resolved; every target is classified independently and any unknown closes the call. */
export function attestWorkspace(ctx: GuardContext, deps: EffectAttestorDeps): GuardEffectBatch {
  const unknown = (): GuardEffectBatch => ({
    facts: [effectFact(deps, "external.unknown")],
    reviewability: "human_only",
  });
  if ((!READ.has(ctx.tool) && !WRITE.has(ctx.tool)) || ctx.paths.length === 0) return unknown();
  const roots = configurationRoots({ workspaceRoot: ctx.config.workspaceRoot });
  const facts = [];
  for (const path of ctx.paths) {
    if (
      !path.withinWorkspace ||
      inside(ctx.config.stateRoot, path.resolved) ||
      SECRET.test(basename(path.resolved))
    )
      return unknown();
    const authoring = isCanonicalAuthoringPath(path.resolved, ctx.config.workspaceRoot);
    const protectedPath =
      inside(roots.workspace_clarvis, path.resolved) ||
      inside(roots.workspace_agents, path.resolved);
    const local = relative(ctx.config.workspaceRoot, path.resolved).replaceAll("\\", "/");
    if (
      (protectedPath && !authoring) ||
      (!authoring &&
        (local.split("/").some((part) => part.startsWith(".")) ||
          EXECUTABLE_MANIFEST.test(basename(local))))
    )
      return unknown();
    const id = READ.has(ctx.tool)
      ? "workspace.inspect"
      : authoring
        ? "clarvis.authoring.write"
        : "workspace.content.write";
    const constraints: Record<string, string | number | boolean> =
      id === "clarvis.authoring.write" ? { path_digest: effectDigest(path.resolved) } : {};
    facts.push(
      effectFact(
        deps,
        id,
        { kind: "workspace", digest: effectDigest(ctx.config.workspaceRoot, path.resolved) },
        constraints,
        true,
      ),
    );
  }
  return { facts, reviewability: "static" };
}
