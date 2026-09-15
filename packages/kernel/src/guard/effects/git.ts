import { resolve } from "node:path";
import type { EffectAttestorDeps } from "./types.ts";
import { query } from "./query.ts";
import { effectDigest, effectFact } from "./facts.ts";

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

/** Resolve a canonical GitHub repository name without exposing credentials from remote URLs. */
export async function githubRemote(
  deps: EffectAttestorDeps,
  cwd: string,
  remote = "origin",
  push = false,
): Promise<string | undefined> {
  if (!/^[A-Za-z0-9_.-]+$/.test(remote)) return undefined;
  const url = await query(deps, cwd, "git", [
    "remote",
    "get-url",
    ...(push ? ["--push"] : []),
    remote,
  ]);
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
      url,
    );
  return match?.[1]?.toLowerCase();
}

/** Attest a non-forced push of the current branch to an explicit GitHub remote and branch. */
export async function gitPush(
  deps: EffectAttestorDeps,
  cwd: string,
  argv: string[],
  workspaceRoot: string,
) {
  let upstream = false;
  const operands: string[] = [];
  for (const value of argv.slice(2)) {
    if ((value === "-u" || value === "--set-upstream") && !upstream) upstream = true;
    else if (value.startsWith("-")) return effectFact(deps, "git.push");
    else operands.push(value);
  }
  if (operands.length !== 2) return effectFact(deps, "git.push");
  const [remote, requestedBranch] = operands;
  if (remote === undefined || requestedBranch === undefined) return effectFact(deps, "git.push");
  const git = await repository(deps, cwd);
  if (
    resolve(git.root) !== resolve(workspaceRoot) ||
    ![git.branch, `refs/heads/${git.branch}`].includes(requestedBranch)
  )
    return effectFact(deps, "git.push");
  const repo = await githubRemote(deps, cwd, remote, true);
  if (repo === undefined) return effectFact(deps, "git.push");
  return effectFact(
    deps,
    "git.push",
    {
      kind: "repository",
      digest: effectDigest(repo, git.branch),
      state_digest: effectDigest(git.head),
      labels: { repo, branch: git.branch, remote },
    },
    { head_sha: git.head, set_upstream: upstream },
    true,
  );
}
