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

test("distribution workflows separate candidate and stable publication and gate real engine qualification", () => {
  const candidate = Bun.YAML.parse(candidateSource) as Workflow;
  const stable = Bun.YAML.parse(stableSource) as Workflow;
  expect(candidate.on.push.tags).toEqual(["v*-rc.*"]);
  expect(candidate.jobs.publish.needs).toBe("images");
  expect(candidateSource).toContain('bash tooling/ci/qualify-runtime.sh "$image_tag" docker');
  expect(candidateSource).toContain('bash tooling/ci/qualify-runtime.sh "$image_tag" podman');
  expect(candidateSource).not.toContain("getclarvis/clarvis-releases");
  expect(candidateSource).not.toContain("CLARVIS_RELEASE_APP_PRIVATE_KEY");
  expect(stable.jobs.package.needs).toBe("identity");
  expect(stable.jobs["runtime-image"].needs).toBe("identity");
  expect(stable.jobs.identity.steps[1].run).toContain('[[ "$GITHUB_REF_NAME" =~ ^v');
  const publicCheck = stable.jobs.publish.steps.findIndex(
    (s) => s.name === "verify public runtime image availability",
  );
  const token = stable.jobs.publish.steps.findIndex(
    (s) => s.name === "mint a token scoped to the public distribution repository",
  );
  expect(publicCheck).toBeGreaterThan(-1);
  expect(token).toBeGreaterThan(publicCheck);
  expect(
    workflowSecurityFailures([
      { path: "candidate.yml", source: candidateSource },
      { path: "release.yml", source: stableSource },
    ]),
  ).toEqual([]);
  for (const workflow of [candidate, stable])
    for (const job of Object.values(workflow.jobs))
      for (const step of job.steps) {
        if (step.shell !== "bash") continue;
        const result = Bun.spawnSync(["bash", "-n"], {
          stdin: Buffer.from(step.run),
          stderr: "pipe",
        });
        expect(result.stderr.toString()).toBe("");
        expect(result.exitCode).toBe(0);
      }
});
