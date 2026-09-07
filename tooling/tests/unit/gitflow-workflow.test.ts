import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { workflowSecurityFailures } from "../../checks/release-readiness.ts";

interface Workflow {
  on: {
    push?: { tags?: string[]; branches?: string[] };
    pull_request?: { branches: string[]; types: string[] };
  };
  jobs: Record<
    string,
    {
      if?: string;
      steps: { name?: string; run?: string; shell?: string; with?: Record<string, unknown> }[];
    }
  >;
}

const source = readFileSync(".github/workflows/gitflow-release.yml", "utf8");
const publication = readFileSync(".github/workflows/release.yml", "utf8");

test("RC tags cannot trigger distribution and tag creation is limited to release pushes and merged PRs", () => {
  const tags = (Bun.YAML.parse(publication) as Workflow).on.push.tags;
  expect(tags).toEqual(["v*", "!v*-rc.*"]);
  const workflow = Bun.YAML.parse(source) as Workflow;
  expect(workflow.on.push.branches).toEqual(["release/*"]);
  expect(workflow.on.pull_request).toEqual({ branches: ["main"], types: ["closed"] });
  expect(workflow.jobs.tag.if).toContain("github.event.pull_request.merged");
  expect(workflow.jobs.tag.if).toContain(
    "github.event.pull_request.head.repo.full_name == github.repository",
  );
  const steps = workflow.jobs.tag.steps;
  const ci = steps.findIndex(
    (step) => step.name === "wait for successful CI on the exact main merge commit",
  );
  const credentials = steps.findIndex(
    (step) => step.name === "mint source-only tag publisher token",
  );
  const publish = steps.findIndex(
    (step) => step.name === "create and push the signed immutable tag",
  );
  expect(ci).toBeGreaterThan(-1);
  expect(credentials).toBeGreaterThan(ci);
  expect(publish).toBeGreaterThan(credentials);
  expect(steps[credentials].with.repositories).toBe("clarvis");
  expect(steps[credentials].with["client-id"]).toBe("${{ vars.CLARVIS_RELEASE_APP_CLIENT_ID }}");
  expect(steps[credentials].with["private-key"]).toBe(
    "${{ secrets.CLARVIS_RELEASE_APP_PRIVATE_KEY }}",
  );
  expect(steps[publish].run).toContain("tooling/release/tag-signing-key.pub");
  expect(steps[publish].run).toContain(
    'test "$(ssh-keygen -y -f "$key_dir/key")" = "$expected_key"',
  );
  expect(workflowSecurityFailures([{ path: "gitflow-release.yml", source }])).toEqual([]);
  for (const step of steps.filter((entry) => entry.shell === "bash")) {
    const result = Bun.spawnSync(["bash", "-n"], { stdin: Buffer.from(step.run), stderr: "pipe" });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  }
});
