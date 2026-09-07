const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[a-f0-9]{40}$/;

export interface GitflowReleaseEvent {
  repository?: { full_name?: string };
  created?: boolean;
  deleted?: boolean;
  ref?: string;
  after?: string;
  action?: string;
  pull_request?: {
    merged?: boolean;
    base?: { ref?: string };
    head?: { ref?: string; sha?: string; repo?: { full_name?: string } };
    merge_commit_sha?: string;
  };
}

export interface GitflowReleasePlan {
  kind: "candidate" | "final";
  version: string;
  tag: string;
  sha: string;
}

/** Selects only release-branch pushes or same-repository release merges into main. */
export function planGitflowRelease(
  eventName: string,
  event: GitflowReleaseEvent,
): GitflowReleasePlan | null {
  if (event.repository?.full_name !== "getclarvis/clarvis") {
    throw new Error("unexpected source repository");
  }
  let branch: string;
  let sha: string;
  let kind: GitflowReleasePlan["kind"];
  if (eventName === "push") {
    if (event.deleted || !event.ref?.startsWith("refs/heads/release/")) return null;
    branch = event.ref.slice("refs/heads/".length);
    sha = event.after;
    kind = "candidate";
  } else if (eventName === "pull_request") {
    const pr = event.pull_request;
    if (event.action !== "closed" || !pr?.merged || pr.base?.ref !== "main") return null;
    if (!pr.head?.ref?.startsWith("release/")) return null;
    if (pr.head.repo?.full_name !== event.repository.full_name) {
      throw new Error("release promotion must originate in the source repository");
    }
    branch = pr.head.ref;
    sha = pr.merge_commit_sha;
    kind = "final";
  } else return null;
  const version = branch.slice("release/".length);
  if (!VERSION.test(version)) throw new Error("release branch must be release/<major.minor.patch>");
  if (!SHA.test(sha)) throw new Error("release event has no exact source commit");
  return { kind, version, tag: `v${version}${kind === "candidate" ? "-rc.1" : ""}`, sha };
}

/** Refuses version drift before a candidate or final tag can be written. */
export function validateGitflowVersion(plan: GitflowReleasePlan, version: unknown): void {
  if (version !== plan.version)
    throw new Error("prepare the root version before pushing the release branch");
}

/** Reuses a candidate for the same commit or allocates the next immutable candidate number. */
export function candidateTag(
  version: string,
  sha: string,
  tags: readonly { tag: string; sha: string }[],
): string {
  if (!VERSION.test(version) || !SHA.test(sha)) throw new Error("invalid candidate identity");
  const prefix = `v${version}-rc.`;
  const candidates = tags.filter((entry) => entry.tag.startsWith(prefix));
  let highest = 0;
  for (const entry of candidates) {
    const suffix = entry.tag.slice(prefix.length);
    if (!/^[1-9]\d*$/.test(suffix) || !Number.isSafeInteger(Number(suffix))) {
      throw new Error("invalid candidate sequence");
    }
    if (entry.sha === sha) return entry.tag;
    highest = Math.max(highest, Number(suffix));
  }
  if (!Number.isSafeInteger(highest + 1)) throw new Error("candidate sequence exhausted");
  return `${prefix}${highest + 1}`;
}
