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
  expect(candidate.jobs.publish.needs).toBe("runtime");
  expect(candidateSource).toContain("bun run runtime:qualify --engine docker");
  expect(candidateSource).toContain("bun run runtime:qualify --engine podman");
  expect(candidateSource).toContain("bun run runtime:artifact:build");
  expect(candidateSource).not.toContain("clarvis-runtime-candidate-artifact");
  expect(candidateSource).not.toContain("getclarvis/clarvis-releases");
  expect(candidateSource).not.toContain("CLARVIS_RELEASE_APP_PRIVATE_KEY");
  expect(candidateSource).not.toContain("docker/setup-buildx-action");
  expect(stableSource).not.toContain("docker/setup-buildx-action");
  expect(candidateSource).toContain("runner: ubuntu-26.04-arm");
  expect(candidateSource).toContain("runner: ubuntu-26.04\n");
  expect(candidateSource).not.toContain("apt-get install -y podman");
  expect(stable.jobs.package.needs).toBe("identity");
  expect(stable.jobs.runtime.needs).toBe("identity");
  expect(stable.jobs.identity.steps[1].run).toContain('[[ "$GITHUB_REF_NAME" =~ ^v');
  const token = stable.jobs.publish.steps.findIndex(
    (s) => s.name === "mint public distribution token",
  );
  expect(token).toBeGreaterThan(-1);
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
