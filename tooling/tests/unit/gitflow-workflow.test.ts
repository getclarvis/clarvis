import { expect, test } from "bun:test";
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

test("RC tags cannot trigger distribution and tag creation is limited to open release PRs and merged PRs", () => {
  const tags = (Bun.YAML.parse(publication) as Workflow).on.push.tags;
  expect(tags).toEqual(["v*", "!v*-rc.*"]);
  const workflow = Bun.YAML.parse(source) as Workflow;
  expect(workflow.on.push).toBeUndefined();
  expect(workflow.on.pull_request).toEqual({
    branches: ["main"],
    types: ["opened", "reopened", "synchronize", "edited", "closed"],
  });
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
  const guard = steps.findIndex(
    (step) => step.name === "verify candidate PR is still open at the exact head",
  );
  expect(guard).toBeGreaterThan(ci);
  expect(credentials).toBeGreaterThan(guard);
  expect(steps[guard].run).toContain('.state == "open"');
  expect(steps[guard].run).toContain('.base.ref == "main"');
  expect(steps[guard].run).toContain(".head.sha == $sha");
  expect(steps[0].with.ref).toContain("github.event.pull_request.head.sha");
  expect(ci).toBeGreaterThan(-1);
  expect(credentials).toBeGreaterThan(ci);
  expect(publish).toBeGreaterThan(credentials);
  expect(steps[credentials].with.repositories).toBe("clarvis");
  expect(steps[credentials].with["client-id"]).toBe("${{ vars.CLARVIS_RELEASE_APP_CLIENT_ID }}");
  expect(steps[credentials].with["private-key"]).toBe(
    "${{ secrets.CLARVIS_RELEASE_APP_PRIVATE_KEY }}",
  );
  expect(steps[publish].run).toContain("tooling/release/tag-signing-key.pub");
  expect(steps[publish].run).toContain('test "$actual_key" = "$expected_key"');
  expect(workflowSecurityFailures([{ path: "gitflow-release.yml", source }])).toEqual([]);
  for (const step of steps.filter((entry) => entry.shell === "bash")) {
    const result = Bun.spawnSync(["bash", "-n"], { stdin: Buffer.from(step.run), stderr: "pipe" });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  }
});

test("the runner validates SSH key material independently of its comment", () => {
  const directory = mkdtempSync(join(tmpdir(), "clarvis-signing-check-"));
  try {
    const key = join(directory, "key");
    const generated = Bun.spawnSync([
      "ssh-keygen",
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      "Release Bot signing key",
      "-f",
      key,
    ]);
    expect(generated.exitCode).toBe(0);
    mkdirSync(join(directory, "tooling/release"), { recursive: true });
    const publicKey = readFileSync(`${key}.pub`, "utf8");
    const publicPath = join(directory, "tooling/release/tag-signing-key.pub");
    writeFileSync(publicPath, publicKey);
    const workflow = Bun.YAML.parse(source) as Workflow;
    const script = workflow.jobs.tag.steps
      .find((step) => step.name === "create and push the signed immutable tag")
      .run.split("git config --local user.name")[0];
    const run = () =>
      Bun.spawnSync(["bash", "-c", script], {
        cwd: directory,
        env: { ...process.env, TAG_SIGNING_KEY: readFileSync(key, "utf8") },
        stderr: "pipe",
      });
    expect(run().exitCode).toBe(0);
    writeFileSync(publicPath, "ssh-ed25519 mismatched-key different comment\n");
    expect(run().exitCode).not.toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
