import type { EffectAttestorDeps, GuardEffectFact } from "./types.ts";
import { query } from "./query.ts";
import { githubRemote, repository } from "./git.ts";
import { effectDigest, effectFact } from "./facts.ts";

/** Attest the closed set of supported GitHub CLI observations and mutations. */
export async function githubCommand(
  deps: EffectAttestorDeps,
  cwd: string,
  argv: string[],
): Promise<GuardEffectFact> {
  if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "view")
    return githubPullRequestView(deps, cwd, argv);
  if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "checks")
    return githubPullRequestChecks(deps, cwd, argv);
  if (argv[0] !== "gh" || argv[1] !== "run" || argv[2] !== "rerun") {
    const id =
      argv[1] === "pr" && ["create", "edit"].includes(argv[2] ?? "")
        ? "github.pr.open_or_update"
        : argv[1] === "pr" && argv[2] === "merge"
          ? "github.pr.merge"
          : argv[1] === "pr" && ["checks", "view"].includes(argv[2] ?? "")
            ? "github.checks.observe"
            : argv[1] === "workflow" && argv[2] === "run"
              ? "github.actions.dispatch"
              : argv[1] === "release"
                ? "release.publish"
                : "external.unknown";
    return effectFact(deps, id);
  }
  let id: string | undefined;
  let repo: string | undefined;
  let failed = false;
  for (let at = 3; at < argv.length; at++) {
    const value = argv[at] ?? "";
    if (value === "--failed" && !failed) failed = true;
    else if (value === "--repo" && repo === undefined) repo = argv[++at];
    else if (/^[0-9]+$/.test(value) && id === undefined) id = value;
    else return effectFact(deps, "external.unknown");
  }
  if (!failed) return effectFact(deps, "github.actions.rerun_all");
  if (
    id === undefined ||
    (repo !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
  ) {
    return effectFact(deps, "github.actions.rerun_failed");
  }
  const git = await repository(deps, cwd);
  const origin = await githubRemote(deps, cwd);
  repo ??= origin;
  if (repo === undefined || origin !== repo.toLowerCase())
    return effectFact(deps, "github.actions.rerun_failed");
  const run = JSON.parse(
    await query(deps, cwd, "gh", [
      "run",
      "view",
      id,
      "--repo",
      repo,
      "--json",
      "databaseId,event,headBranch,headSha,status,conclusion,attempt",
    ]),
  ) as Record<string, unknown>;
  const pr = JSON.parse(
    await query(deps, cwd, "gh", [
      "pr",
      "view",
      git.branch,
      "--repo",
      repo,
      "--json",
      "number,headRefName,headRefOid,state",
    ]),
  ) as Record<string, unknown>;
  if (
    String(run.databaseId) !== id ||
    run.headBranch !== git.branch ||
    run.headSha !== git.head ||
    run.status !== "completed" ||
    !["failure", "timed_out"].includes(String(run.conclusion)) ||
    !["push", "pull_request"].includes(String(run.event)) ||
    pr.headRefName !== git.branch ||
    pr.headRefOid !== git.head ||
    pr.state !== "OPEN" ||
    !Number.isSafeInteger(pr.number) ||
    Number(pr.number) <= 0 ||
    !Number.isSafeInteger(run.attempt) ||
    Number(run.attempt) <= 0
  )
    return effectFact(deps, "github.actions.rerun_failed");
  return effectFact(
    deps,
    "github.actions.rerun_failed",
    {
      kind: "workflow_run",
      digest: effectDigest(repo.toLowerCase(), id),
      state_digest: effectDigest(git.head, String(run.attempt)),
      labels: { repo: repo.toLowerCase(), branch: git.branch, pr: Number(pr.number) },
    },
    { failed_only: true, attempts: 1, head_sha: git.head, run_id: id },
    true,
  );
}

const PULL_REQUEST_FIELDS = new Set([
  "baseRefName",
  "headRefName",
  "headRefOid",
  "isDraft",
  "mergeStateStatus",
  "number",
  "reviewDecision",
  "state",
  "statusCheckRollup",
  "title",
  "url",
]);

async function githubPullRequestView(
  deps: EffectAttestorDeps,
  cwd: string,
  argv: string[],
): Promise<GuardEffectFact> {
  let id: string | undefined;
  let repo: string | undefined;
  let fields: string | undefined;
  for (let at = 3; at < argv.length; at++) {
    const value = argv[at] ?? "";
    if (/^[1-9][0-9]*$/.test(value) && id === undefined) id = value;
    else if (value === "--repo" && repo === undefined) repo = argv[++at];
    else if (value === "--json" && fields === undefined) fields = argv[++at];
    else return effectFact(deps, "github.checks.observe");
  }
  const requestedFields = fields?.split(",") ?? [];
  const number = Number(id);
  if (
    id === undefined ||
    !Number.isSafeInteger(number) ||
    requestedFields.length === 0 ||
    requestedFields.some((field) => !PULL_REQUEST_FIELDS.has(field)) ||
    (repo !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
  )
    return effectFact(deps, "github.checks.observe");
  return githubPullRequestObservation(deps, cwd, id, repo);
}

async function githubPullRequestChecks(
  deps: EffectAttestorDeps,
  cwd: string,
  argv: string[],
): Promise<GuardEffectFact> {
  let id: string | undefined;
  let repo: string | undefined;
  let watch = false;
  let interval: string | undefined;
  for (let at = 3; at < argv.length; at++) {
    const value = argv[at] ?? "";
    if (/^[1-9][0-9]*$/.test(value) && id === undefined) id = value;
    else if (value === "--repo" && repo === undefined && argv[at + 1] !== undefined)
      repo = argv[++at];
    else if (value === "--watch" && !watch) watch = true;
    else if (value === "--interval" && interval === undefined && argv[at + 1] !== undefined)
      interval = argv[++at];
    else return effectFact(deps, "github.checks.observe");
  }
  const number = Number(id);
  const refreshSeconds = Number(interval);
  if (
    id === undefined ||
    !Number.isSafeInteger(number) ||
    (repo !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) ||
    (interval !== undefined &&
      (!watch || !/^[1-9][0-9]*$/.test(interval) || !Number.isSafeInteger(refreshSeconds)))
  )
    return effectFact(deps, "github.checks.observe");
  return githubPullRequestObservation(deps, cwd, id, repo);
}

async function githubPullRequestObservation(
  deps: EffectAttestorDeps,
  cwd: string,
  id: string,
  repo: string | undefined,
): Promise<GuardEffectFact> {
  const number = Number(id);
  const git = await repository(deps, cwd);
  const origin = await githubRemote(deps, cwd);
  repo ??= origin;
  if (repo === undefined || origin !== repo.toLowerCase())
    return effectFact(deps, "github.checks.observe");
  repo = repo.toLowerCase();
  const pr = JSON.parse(
    await query(deps, cwd, "gh", [
      "pr",
      "view",
      id,
      "--repo",
      repo,
      "--json",
      [...PULL_REQUEST_FIELDS].join(","),
    ]),
  ) as Record<string, unknown>;
  if (
    String(pr.number) !== id ||
    pr.headRefName !== git.branch ||
    pr.headRefOid !== git.head ||
    pr.state !== "OPEN"
  )
    return effectFact(deps, "github.checks.observe");
  return effectFact(
    deps,
    "github.checks.observe",
    {
      kind: "pull_request",
      digest: effectDigest(repo, id),
      state_digest: effectDigest(git.head),
      labels: { repo, branch: git.branch, pr: number },
    },
    {},
    true,
  );
}
