import { resolve } from "node:path";
import type { ReviewedEffectTarget } from "@clarvis/capability";
import {
  analyzeShell,
  posixDialect,
  resolveCandidate,
  type GuardContext,
} from "@clarvis/tools/guard";
import type { EffectAttestorDeps, GuardEffectBatch, GuardEffectFact } from "./types.ts";
import { effectDigest, effectFact } from "./facts.ts";
import { repository } from "./git.ts";
import { githubRerun } from "./github-cli.ts";
import { projectLiteralData } from "./literal-data.ts";

/** Closed composition of initially supported shell effects; one unknown segment closes the batch. */
export async function attestShell(
  ctx: GuardContext,
  deps: EffectAttestorDeps,
): Promise<GuardEffectBatch> {
  const unknown = (): GuardEffectBatch => ({
    facts: [effectFact(deps, "external.unknown")],
    reviewability: "human_only",
  });
  if (typeof ctx.args.command !== "string" || process.platform === "win32") return unknown();
  const projection = projectLiteralData(ctx.args.command);
  const shell = analyzeShell(projection.source, posixDialect);
  if (shell.segments.length > 32) return unknown();
  if (
    shell.undecidable &&
    !shell.segments.every((segment) => segment.argv[0] === "export" || segment.decidable)
  )
    return unknown();
  if (/[|&<>]/.test(projection.source.replace(/&&/g, ""))) return unknown();
  const initialCwd = resolve(
    ctx.config.workspaceRoot,
    typeof ctx.args.cwd === "string" ? ctx.args.cwd : ".",
  );
  if (!resolveCandidate(initialCwd, ctx.config.workspaceRoot).withinWorkspace) return unknown();
  const target: ReviewedEffectTarget = {
    kind: "workspace",
    digest: effectDigest(ctx.config.workspaceRoot),
  };
  const facts: GuardEffectFact[] = [];
  const used = new Set<string>();
  try {
    for (const segment of shell.segments) {
      let argv = segment.argv;
      let cwd = initialCwd;
      if (argv[0] === "git" && argv[1] === "-C") {
        if (argv[2] === undefined || argv.length < 4) return unknown();
        cwd = resolve(initialCwd, argv[2]);
        if (!resolveCandidate(cwd, ctx.config.workspaceRoot).withinWorkspace) return unknown();
        argv = ["git", ...argv.slice(3)];
      }
      if (segment.envAssignments.length > 0) return unknown();
      if (argv[0] === "export") {
        const assignment = argv[1];
        if (argv.length !== 2 || assignment === undefined || !assignment.startsWith("TMPDIR="))
          return unknown();
        const root = assignment.slice(7);
        if (!ctx.config.temporaryRoots.includes(root) || /[$`*?{}]/.test(root)) return unknown();
        const path = resolveCandidate(root, ctx.config.workspaceRoot, {
          alsoAllow: ctx.config.temporaryRoots,
        });
        if (!path.withinWorkspace) return unknown();
        facts.push(
          effectFact(deps, "environment.temporary_root", target, { root: path.resolved }, true),
        );
      } else if (argv[0] === "git" && argv[1] === "commit") {
        for (let at = 2; at < argv.length; at++) {
          if (!["-m", "--message"].includes(argv[at] ?? "") || argv[at + 1] === undefined)
            return unknown();
          const message = argv[++at] ?? "";
          const producer = projection.producers.find((entry) => entry.marker === message);
          if (producer !== undefined) {
            used.add(producer.marker);
            facts.push(
              effectFact(deps, "value.literal_data", target, { bytes: producer.bytes }, true),
            );
          } else if (projection.producers.some((entry) => message.includes(entry.marker)))
            return unknown();
        }
        if (argv.length < 4) return unknown();
        const git = await repository(deps, cwd);
        if (resolve(git.root) !== resolve(ctx.config.workspaceRoot)) return unknown();
        facts.push(effectFact(deps, "git.commit", git.target, { head_sha: git.head }, true));
      } else if (argv[0] === "git" && ["status", "log"].includes(argv[1] ?? "")) {
        if (argv.slice(2).some((arg) => !/^--(?:short|oneline)$|^-\d+$/.test(arg)))
          return unknown();
        facts.push(effectFact(deps, "workspace.inspect", target, {}, true));
      } else if (argv[0] === "git" && argv[1] === "push") {
        facts.push(
          effectFact(
            deps,
            argv.some(
              (arg) =>
                arg === "--force" ||
                arg === "-f" ||
                arg.startsWith("--force-with-lease") ||
                arg.startsWith("+"),
            )
              ? "git.history_rewrite"
              : "git.push",
          ),
        );
      } else if (
        argv[0] === "git" &&
        ["reset", "rebase", "filter-branch", "filter-repo"].includes(argv[1] ?? "")
      ) {
        facts.push(effectFact(deps, "git.history_rewrite"));
      } else if (argv[0] === "gh") facts.push(await githubRerun(deps, cwd, argv));
      else return unknown();
    }
  } catch {
    return unknown();
  }
  if (facts.length === 0 || facts.length > 32 || used.size !== projection.producers.length)
    return unknown();
  if (facts.some((fact) => fact.reviewability === "human_only"))
    return { facts, reviewability: "human_only" };
  const reviewability = projection.producers.length > 0 ? "judgeable" : "static";
  for (const fact of facts) {
    fact.reviewability = reviewability;
    fact.analysis_issues = ctx.shell?.analysisIssues ?? [];
  }
  return { facts, reviewability };
}
