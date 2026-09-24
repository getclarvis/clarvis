import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { workflowSecurityFailures } from "../../checks/release-readiness.ts";

interface Workflow {
  on: { push: { tags: string[] } };
  jobs: Record<
    string,
    { needs?: string | string[]; steps: { run?: string; shell?: string; name?: string }[] }
  >;
}

const candidateSource = readFileSync(".github/workflows/candidate.yml", "utf8");
const stableSource = readFileSync(".github/workflows/release.yml", "utf8");

test("candidate and stable workflows publish source tags and verified installers", () => {
  const candidate = Bun.YAML.parse(candidateSource) as Workflow;
  const stable = Bun.YAML.parse(stableSource) as Workflow;
  expect(candidate.on.push.tags).toEqual(["v*-rc.*"]);
  expect(Object.keys(candidate.jobs)).toEqual(["publish"]);
  expect(
    candidate.jobs.publish.steps.some(
      (step) => step.run === "bun run tooling/release/candidate.ts validate",
    ),
  ).toBe(true);
  expect(
    candidate.jobs.publish.steps.some(
      (step) => step.run === "bun run tooling/release/candidate.ts publish",
    ),
  ).toBe(true);
  expect(stable.jobs.package.needs).toBe("identity");
  expect(stable.jobs.publish.needs).toBe("package");
  expect(stable.jobs.identity.steps[1].run).toContain('[[ "$GITHUB_REF_NAME" =~ ^v');
  expect(
    stable.jobs.publish.steps.some((step) => step.name === "mint public distribution token"),
  ).toBe(true);
  expect(
    workflowSecurityFailures([
      { path: "candidate.yml", source: candidateSource },
      { path: "release.yml", source: stableSource },
    ]),
  ).toEqual([]);
  for (const workflow of [candidate, stable]) {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps) {
        if (step.shell !== "bash") continue;
        const result = Bun.spawnSync(["bash", "-n"], {
          stdin: Buffer.from(step.run),
          stderr: "pipe",
        });
        expect(result.stderr.toString()).toBe("");
        expect(result.exitCode).toBe(0);
      }
    }
  }
});
