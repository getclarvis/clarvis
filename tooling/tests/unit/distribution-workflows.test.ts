import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function targetFixture(target: "linux-x64" | "linux-arm64") {
  return {
    base: {
      image: "ghcr.io/getclarvis/clarvis-runtime-base",
      digest: `sha256:${"a".repeat(64)}`,
      abi: "clarvis-linux-glibc-v1",
    },
    artifact: {
      asset: `clarvis-kernel-${target}.tar.gz`,
      sha256: "b".repeat(64),
      size: 1024,
    },
    kernel_wire_version: 11,
    broker_version: 1,
    channel_version: 1,
  };
}

function expectWorkflowJsonWriters(
  source: string,
  paths: {
    targetDirectory: string;
    inputDirectories: readonly [string, string];
    targetOutput: string;
    aggregateOutput: string;
  },
): void {
  const snippets = [...source.matchAll(/bun -e '([^']*Bun\.write[^']*)'/gu)].map(
    (match) => match[1],
  );
  expect(snippets).toHaveLength(2);
  const directory = mkdtempSync(join(tmpdir(), "clarvis-workflow-json-"));
  try {
    mkdirSync(join(directory, paths.targetDirectory), { recursive: true });
    for (const [inputDirectory, target] of paths.inputDirectories.map((value, index) => [
      value,
      index === 0 ? "linux-x64" : "linux-arm64",
    ]) as readonly (readonly [string, "linux-x64" | "linux-arm64"])[]) {
      mkdirSync(join(directory, inputDirectory), { recursive: true });
      writeFileSync(
        join(directory, inputDirectory, "target.json"),
        `${JSON.stringify(targetFixture(target), null, 2)}\n`,
      );
    }
    const env = {
      ...process.env,
      BASE_IMAGE: "ghcr.io/getclarvis/clarvis-runtime-base",
      BASE_DIGEST: `sha256:${"a".repeat(64)}`,
      ARTIFACT_SHA: "b".repeat(64),
      ARTIFACT_SIZE: "1024",
      TARGET: "linux-x64",
      VERSION: "0.2.0",
      GITHUB_SHA: "c".repeat(40),
    };
    for (const snippet of snippets) {
      const result = Bun.spawnSync(["bun", "-e", snippet], { cwd: directory, env, stderr: "pipe" });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
    }
    expect(() =>
      JSON.parse(readFileSync(join(directory, paths.targetOutput), "utf8")),
    ).not.toThrow();
    expect(() =>
      JSON.parse(readFileSync(join(directory, paths.aggregateOutput), "utf8")),
    ).not.toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

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

test("distribution workflow JSON writers emit parseable target and aggregate manifests", () => {
  expectWorkflowJsonWriters(candidateSource, {
    targetDirectory: "build/candidate/linux-x64",
    inputDirectories: [
      "build/candidate/candidate-linux-x64",
      "build/candidate/candidate-linux-arm64",
    ],
    targetOutput: "build/candidate/linux-x64/target.json",
    aggregateOutput: "build/candidate/runtime-input.json",
  });
  expectWorkflowJsonWriters(stableSource, {
    targetDirectory: "build/runtime/linux-x64",
    inputDirectories: [
      "build/runtime/kernel-input-linux-x64",
      "build/runtime/kernel-input-linux-arm64",
    ],
    targetOutput: "build/runtime/linux-x64/target.json",
    aggregateOutput: "build/runtime/runtime-input.json",
  });
});
