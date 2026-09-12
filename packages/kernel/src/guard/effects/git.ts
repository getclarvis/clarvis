import type { EffectAttestorDeps } from "./types.ts";
import { query } from "./query.ts";
import { effectDigest } from "./facts.ts";

/** Resolve Git repository, branch and moving HEAD without executing the operation under review. */
export async function repository(deps: EffectAttestorDeps, cwd: string) {
  const root = await query(deps, cwd, "git", ["rev-parse", "--show-toplevel"]);
  const branch = await query(deps, cwd, "git", ["symbolic-ref", "--short", "HEAD"]);
  const head = await query(deps, cwd, "git", ["rev-parse", "--verify", "HEAD"]);
  if (!root || !branch || branch.length > 256 || !/^[a-f0-9]{40,64}$/.test(head))
    throw new Error("invalid repository evidence");
  return {
    root,
    branch,
    head,
    target: {
      kind: "repository" as const,
      digest: effectDigest(root, branch),
      state_digest: effectDigest(head),
    },
  };
}
