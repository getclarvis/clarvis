import { appendFileSync, readFileSync } from "node:fs";
import {
  type GitflowReleaseEvent,
  candidateTag,
  planGitflowRelease,
  validateGitflowVersion,
} from "../lib/gitflow-release.ts";

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** Plans tags from the immutable webhook payload, then publishes only the validated signed identity. */
export function main(): void {
  const event = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"),
  ) as GitflowReleaseEvent;
  const plan = planGitflowRelease(process.env.GITHUB_EVENT_NAME, event);
  if (plan === null) return;
  if (git("rev-parse", "HEAD") !== plan.sha) throw new Error("checkout differs from event commit");
  const product = JSON.parse(readFileSync("package.json", "utf8")) as { version?: unknown };
  validateGitflowVersion(plan, product.version);
  const candidates = git("tag", "--list", `v${plan.version}-rc.*`)
    .split("\n")
    .filter(Boolean)
    .map((tag) => ({ tag, sha: git("rev-parse", `${tag}^{commit}`) }));
  if (plan.kind === "candidate") {
    if (git("ls-remote", "origin", `refs/tags/v${plan.version}`).length > 0) {
      throw new Error("final tag already exists; start a new release version");
    }
    plan.tag = candidateTag(plan.version, plan.sha, candidates);
  }
  if (plan.kind === "final") {
    const parents = git("rev-list", "--parents", "-n", "1", plan.sha).split(" ");
    if (parents.length !== 3 || parents[2] !== event.pull_request.head.sha) {
      throw new Error(
        "release promotion requires a merge commit with the release head as second parent",
      );
    }
    if (git("ls-remote", "origin", "refs/heads/main").split(/\s/)[0] !== plan.sha) {
      throw new Error("main has advanced beyond this release promotion");
    }
    if (!candidates.some((candidate) => candidate.sha === event.pull_request.head.sha)) {
      throw new Error("release head has no candidate tag; wait for its candidate workflow first");
    }
  }
  const mode = process.argv[2];
  if (mode === "plan") {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `tag=${plan.tag}\nsha=${plan.sha}\nkind=${plan.kind}\n`,
    );
    return;
  }
  if (mode !== "publish") throw new Error("usage: gitflow.ts <plan|publish>");
  if (plan.kind === "final") {
    const candidate = candidates.find((entry) => entry.sha === event.pull_request.head.sha);
    git("verify-tag", candidate.tag);
  }
  const existing = git("ls-remote", "origin", `refs/tags/${plan.tag}`, `refs/tags/${plan.tag}^{}`);
  if (existing.length > 0) {
    const peeled = existing
      .split("\n")
      .find((line) => line.endsWith("^{}"))
      ?.split(/\s/)[0];
    if (peeled !== plan.sha)
      throw new Error("existing tag differs from planned signed release; refusing overwrite");
    git("verify-tag", plan.tag);
    process.stdout.write(`Tag ${plan.tag} already exists at ${plan.sha}; no mutation performed.\n`);
    return;
  }
  git(
    "tag",
    "-s",
    plan.tag,
    plan.sha,
    "-m",
    `Clarvis ${plan.tag}${plan.kind === "candidate" ? " (source candidate only)" : ""}`,
  );
  git("verify-tag", plan.tag);
  git("push", "origin", `refs/tags/${plan.tag}`);
}

if (import.meta.main) main();
