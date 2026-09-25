import { workflowSecurityFailures } from "../checks/release-readiness.ts";
import { checkGateChain, checkRootBuild } from "./test-harness.ts";

export interface CiStep {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  shell?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  "continue-on-error"?: boolean;
}

export interface CiJob {
  name?: string;
  needs?: string | string[];
  if?: string;
  "runs-on": string;
  "timeout-minutes": number;
  "continue-on-error"?: boolean;
  permissions?: unknown;
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  steps: CiStep[];
}

export interface CiWorkflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, CiJob>;
}

export const LINUX_GATES = ["build", "typecheck", "lint", "knip", "checks", "coverage"];
const CONSUMERS = ["typecheck", "lint", "knip", "checks", "coverage"];
const equalSet = (actual: string[], expected: string[]) =>
  JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
const needsOf = (job: CiJob) => (typeof job.needs === "string" ? [job.needs] : (job.needs ?? []));

/** Fail closed on a missing gate, dependency, preparation step or public status, without running CI. */
export function ciWorkflowFailures(source: string, scripts: Record<string, string>): string[] {
  const failures = workflowSecurityFailures([{ path: ".github/workflows/ci.yml", source }]);
  failures.push(...checkRootBuild(scripts), ...checkGateChain(scripts["check:pre-commit"]));
  const check = (condition: boolean, message: string) => {
    if (!condition) failures.push(message);
  };
  try {
    const workflow = Bun.YAML.parse(source) as CiWorkflow;
    check(
      equalSet(Object.keys(workflow.on), ["push", "pull_request", "workflow_dispatch"]),
      "CI trigger set changed",
    );
    check(
      JSON.stringify(workflow.on.push) === JSON.stringify({ branches: ["main", "develop"] }),
      "CI push branches changed",
    );
    check(
      workflow.on.pull_request === null && workflow.on.workflow_dispatch === null,
      "CI event filtering changed",
    );
    check(
      JSON.stringify(workflow.permissions) === JSON.stringify({ contents: "read" }),
      "CI permissions changed",
    );
    check(
      workflow.concurrency.group === "ci-${{ github.ref }}" &&
        workflow.concurrency["cancel-in-progress"] === true,
      "CI cancellation contract changed",
    );
    check(
      equalSet(Object.keys(workflow.jobs), [...LINUX_GATES, "linux", "keyboard-macos"]),
      "CI job set is incomplete or unexpected",
    );
    for (const [id, job] of Object.entries(workflow.jobs)) {
      check(
        Number.isFinite(job["timeout-minutes"]) && job["timeout-minutes"] > 0,
        `${id}: finite timeout required`,
      );
      check(
        !job["continue-on-error"] && job.permissions === undefined,
        `${id}: job bypass or permissions override forbidden`,
      );
      if (id !== "linux") check(job.if === undefined, `${id}: unexpected conditional gate`);
      for (const step of job.steps)
        check(
          !step["continue-on-error"] && step.if === undefined,
          `${id}: step bypass or skip forbidden`,
        );
      const expectedNeeds = id === "linux" ? LINUX_GATES : CONSUMERS.includes(id) ? ["build"] : [];
      check(equalSet(needsOf(job), expectedNeeds), `${id}: dependency set changed`);
      if (LINUX_GATES.includes(id) || id === "linux")
        check(job["runs-on"] === "ubuntu-latest", `${id}: Linux runner changed`);
    }
    const build = workflow.jobs.build;
    const runs = (job: CiJob) => job.steps.flatMap((step) => (step.run ? [step.run] : []));
    const index = (job: CiJob, run: string) => job.steps.findIndex((step) => step.run === run);
    const ordered = (job: CiJob, commands: string[], id: string) => {
      const indices = commands.map((command) => index(job, command));
      check(
        indices.every((value, i) => value >= 0 && (i === 0 || value > indices[i - 1])),
        `${id}: required step missing or reordered`,
      );
    };
    ordered(
      build,
      [
        "time bun install --frozen-lockfile",
        "bun run build",
        "bun run smoke",
        "bun run tooling/checks/ci-artifacts.ts pack",
      ],
      "build",
    );
    const upload = build.steps.findIndex((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    check(
      upload > index(build, "bun run tooling/checks/ci-artifacts.ts pack"),
      "build: upload must follow build, smoke and packaging",
    );
    check(
      build.steps[upload]?.with?.["if-no-files-found"] === "error" &&
        build.steps[upload]?.with?.path === "coverage/ci/linux-build.tar",
      "build: required tar artifact missing",
    );
    for (const [key, step] of Object.entries({
      "artifact-id": "upload",
      "artifact-digest": "upload",
      "tar-digest": "pack",
      "producer-attempt": "pack",
    })) {
      check(
        build.outputs?.[key] === `\${{ steps.${step}.outputs.${key} }}`,
        `build: missing ${key} output`,
      );
    }
    const commands: Record<string, string[]> = {
      typecheck: ["bun run typecheck"],
      lint: ["bun run lint:eslint"],
      knip: ["bun run knip"],
      checks: ["bun run format:check", "bun run lint:intent", "bun run test:cache"],
      coverage: ["bash tooling/ci/retry-code-coverage.sh"],
    };
    for (const id of CONSUMERS) {
      const job = workflow.jobs[id];
      ordered(
        job,
        [
          "time bun install --frozen-lockfile",
          "bun run tooling/checks/ci-artifacts.ts producer",
          "bun run tooling/checks/ci-artifacts.ts restore",
          ...commands[id],
        ],
        id,
      );
      const download = job.steps.findIndex((step) =>
        step.uses?.startsWith("actions/download-artifact@"),
      );
      check(
        download > index(job, "bun run tooling/checks/ci-artifacts.ts producer") &&
          download < index(job, "bun run tooling/checks/ci-artifacts.ts restore"),
        `${id}: download ordering changed`,
      );
      const inputs = job.steps[download]?.with ?? {};
      check(
        inputs["artifact-ids"] === "${{ needs.build.outputs.artifact-id }}" &&
          inputs["digest-mismatch"] === "error" &&
          inputs.path === "coverage/ci/incoming" &&
          inputs["merge-multiple"] === true &&
          inputs.name === undefined &&
          inputs.pattern === undefined &&
          inputs["run-id"] === undefined,
        `${id}: exact current-run artifact download required`,
      );
      for (const [key, output] of Object.entries({
        CI_BUILD_ARTIFACT_ID: "artifact-id",
        CI_BUILD_ARTIFACT_DIGEST: "artifact-digest",
        CI_BUILD_TAR_DIGEST: "tar-digest",
        CI_BUILD_PRODUCER_ATTEMPT: "producer-attempt",
      }))
        check(
          job.env?.[key] === `\${{ needs.build.outputs.${output} }}`,
          `${id}: missing producer receipt ${key}`,
        );
      check(
        !runs(job).some((run) => /^bun run (?:build|lint)$/.test(run)),
        `${id}: duplicate aggregate gate or build`,
      );
    }
    const aggregate = workflow.jobs.linux;
    check(
      aggregate.name === "linux" && aggregate.if === "${{ always() }}",
      "linux: stable always-run aggregator required",
    );
    check(
      aggregate.steps.length === 1 &&
        aggregate.steps[0].shell === "bash" &&
        aggregate.steps[0].env?.NEEDS_JSON === "${{ toJSON(needs) }}" &&
        !aggregate.steps[0].run.includes("${{"),
      "linux: needs JSON must enter Bash through environment only",
    );
    check(
      workflow.jobs["keyboard-macos"].name === "keyboard policy (macos)",
      "macOS required status changed",
    );
    check(
      scripts.lint === "bun run lint:eslint && bun run lint:intent && bun run knip",
      "Local lint aggregation changed",
    );
    check(
      scripts["test:coverage"] ===
        "bun --workspaces --sequential --if-present test:coverage && bun run coverage:check",
      "Local coverage contract changed",
    );
  } catch (error) {
    failures.push(`Invalid CI workflow structure: ${String(error)}`);
  }
  return failures;
}
