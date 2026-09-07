import { describe, expect, test } from "bun:test";
import {
  candidateTag,
  planGitflowRelease,
  validateGitflowVersion,
} from "../../lib/gitflow-release.ts";

const sha = "a".repeat(40);
const repository = { full_name: "getclarvis/clarvis" };
const push = {
  repository,
  created: true,
  deleted: false,
  ref: "refs/heads/release/0.2.0",
  after: sha,
};
const merge = {
  repository,
  action: "closed",
  pull_request: {
    merged: true,
    base: { ref: "main" },
    head: { ref: "release/0.2.0", repo: repository },
    merge_commit_sha: sha,
  },
};

describe("Gitflow release identity", () => {
  test("plans a source candidate and a final tag on the exact merge SHA", () => {
    expect(planGitflowRelease("push", push)).toEqual({
      kind: "candidate",
      version: "0.2.0",
      tag: "v0.2.0-rc.1",
      sha,
    });
    expect(planGitflowRelease("pull_request", merge)).toEqual({
      kind: "final",
      version: "0.2.0",
      tag: "v0.2.0",
      sha,
    });
    expect(planGitflowRelease("push", { ...push, created: false })?.kind).toBe("candidate");
  });
  test("ignores unrelated pushes, deletions, closed unmerged PRs, and other bases", () => {
    expect(planGitflowRelease("push", { ...push, ref: "refs/heads/develop" })).toBeNull();
    expect(planGitflowRelease("push", { ...push, deleted: true })).toBeNull();
    expect(planGitflowRelease("workflow_dispatch", push)).toBeNull();
    for (const patch of [
      { merged: false },
      { base: { ref: "develop" } },
      { head: { ref: "feat/test" } },
    ]) {
      expect(
        planGitflowRelease("pull_request", {
          ...merge,
          pull_request: { ...merge.pull_request, ...patch },
        }),
      ).toBeNull();
    }
  });
  test("rejects foreign repositories, fork promotions, malformed versions and SHAs", () => {
    expect(() =>
      planGitflowRelease("push", { ...push, repository: { full_name: "other/repo" } }),
    ).toThrow();
    expect(() =>
      planGitflowRelease("pull_request", {
        ...merge,
        pull_request: {
          ...merge.pull_request,
          head: { ref: "release/0.2.0", repo: { full_name: "other/repo" } },
        },
      }),
    ).toThrow();
    for (const version of ["v0.2.0", "0.2.0-rc.1", "01.2.0", "0.2.0/other", "$(id)"]) {
      expect(() =>
        planGitflowRelease("push", { ...push, ref: `refs/heads/release/${version}` }),
      ).toThrow();
    }
    expect(() => planGitflowRelease("push", { ...push, after: "bad" })).toThrow();
  });
  test("requires prepared source version and increments candidates without moving old tags", () => {
    const plan = planGitflowRelease("push", push);
    expect(() => validateGitflowVersion(plan, "0.1.1")).toThrow();
    expect(() => validateGitflowVersion(plan, "0.2.0")).not.toThrow();
    const tags = [
      { tag: "v0.2.0-rc.1", sha: "b".repeat(40) },
      { tag: "v0.2.0-rc.2", sha },
    ];
    expect(candidateTag("0.2.0", sha, tags)).toBe("v0.2.0-rc.2");
    expect(candidateTag("0.2.0", "c".repeat(40), tags)).toBe("v0.2.0-rc.3");
    expect(candidateTag("0.2.0", sha, [])).toBe("v0.2.0-rc.1");
    expect(() =>
      candidateTag("0.2.0", sha, [{ tag: "v0.2.0-rc.01", sha: "b".repeat(40) }]),
    ).toThrow();
  });
});
