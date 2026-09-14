import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ciWorkflowFailures, LINUX_GATES, type CiWorkflow } from "../../lib/ci-workflow.ts";

const source = readFileSync(".github/workflows/ci.yml", "utf8");
const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
const parsed = () => Bun.YAML.parse(source) as CiWorkflow;
const serialize = (workflow: CiWorkflow) => Bun.YAML.stringify(workflow);

describe("independent CI workflow", () => {
  test("preserves every gate, real dependency and local sequential contract", () => {
    expect(ciWorkflowFailures(source, scripts)).toEqual([]);
  });

  test("rejects loss of each Linux gate or aggregate dependency", () => {
    for (const gate of LINUX_GATES) {
      const missingJob = parsed();
      delete missingJob.jobs[gate];
      expect(ciWorkflowFailures(serialize(missingJob), scripts).length).toBeGreaterThan(0);
      const missingNeed = parsed();
      missingNeed.jobs.linux.needs = LINUX_GATES.filter((id) => id !== gate);
      expect(ciWorkflowFailures(serialize(missingNeed), scripts)).toContain(
        "linux: dependency set changed",
      );
    }
  });

  test("rejects missing commands, restoration, receipt and unsafe workflow mutations", () => {
    const mutations: ((workflow: CiWorkflow) => void)[] = [
      (workflow) => {
        workflow.jobs.checks.steps = workflow.jobs.checks.steps.filter(
          (step) => step.run !== "bun run test:cache",
        );
      },
      (workflow) => {
        workflow.jobs.checks.steps = workflow.jobs.checks.steps.filter(
          (step) => step.run !== "bun run lint:intent",
        );
      },
      (workflow) => {
        workflow.jobs.lint.steps.at(-1).run = "bun run lint";
      },
      (workflow) => {
        workflow.jobs.typecheck.steps = workflow.jobs.typecheck.steps.filter(
          (step) => step.run !== "bun run tooling/checks/ci-artifacts.ts restore",
        );
      },
      (workflow) => {
        workflow.jobs.build.steps = workflow.jobs.build.steps.filter(
          (step) => step.run !== "bun run smoke",
        );
      },
      (workflow) => {
        delete workflow.jobs.build.outputs["producer-attempt"];
      },
      (workflow) => {
        workflow.jobs.knip.env.CI_BUILD_PRODUCER_ATTEMPT = "${{ github.run_attempt }}";
      },
      (workflow) => {
        workflow.jobs.knip.steps.find((step) =>
          step.uses?.startsWith("actions/download-artifact@"),
        ).with.name = "linux-build";
      },
      (workflow) => {
        workflow.jobs.coverage.steps.at(-1).env = {};
      },
      (workflow) => {
        workflow.jobs.coverage["continue-on-error"] = true;
      },
      (workflow) => {
        workflow.jobs.lint.steps.at(-1).if = "false";
      },
      (workflow) => {
        workflow.jobs.linux.if = "${{ success() }}";
      },
      (workflow) => {
        workflow.jobs.build.steps[0].with["persist-credentials"] = true;
      },
      (workflow) => {
        workflow.jobs.build.steps[0].uses = "actions/checkout@main";
      },
      (workflow) => {
        workflow.permissions.contents = "write";
      },
    ];
    for (const mutate of mutations) {
      const workflow = parsed();
      mutate(workflow);
      expect(ciWorkflowFailures(serialize(workflow), scripts).length).toBeGreaterThan(0);
    }
  });

  test("keeps native Windows/macOS scope and the release consumer's three public contexts", () => {
    const workflow = parsed();
    const keyboard =
      "bun test packages/code/tests/unit/keyboard-profile.test.ts packages/code/tests/unit/keyspec.test.ts packages/code/tests/unit/active-actions.test.ts";
    expect(workflow.jobs.windows["runs-on"]).toBe("windows-latest");
    expect(
      workflow.jobs.windows.steps
        .filter((step) => step.run?.startsWith("bun "))
        .map((step) => step.run),
    ).toEqual([
      "bun --version && bun --revision",
      "bun install --frozen-lockfile",
      "bun --filter @clarvis/paths test",
      "bun --filter @clarvis/tools test",
      "bun --filter @clarvis/plan test",
      "bun --filter @clarvis/memory test",
      keyboard,
    ]);
    expect(workflow.jobs["sandbox-macos"]["runs-on"]).toBe("macos-14");
    expect(
      workflow.jobs["sandbox-macos"].steps.flatMap((step) => (step.run ? [step.run] : [])),
    ).toEqual([
      "bun --version && bun --revision",
      "brew install ripgrep && rg --version",
      "bun install --frozen-lockfile",
      "CLARVIS_NATIVE_SANDBOX_CANARY=1 bun --filter @clarvis/tools test",
      "CLARVIS_NATIVE_SANDBOX_CANARY=1 bun test packages/kernel/tests/integration/sandbox-policy.test.ts",
      keyboard,
    ]);
    const release = readFileSync(".github/workflows/gitflow-release.yml", "utf8");
    for (const id of ["linux", "windows", "sandbox-macos"])
      expect(release).toContain(`'${workflow.jobs[id].name}'`);
  });
});

describe("real required-linux Bash aggregator", () => {
  const body = parsed().jobs.linux.steps[0].run;
  const successful = () =>
    Object.fromEntries(LINUX_GATES.map((id) => [id, { result: "success", outputs: {} }]));
  const aggregate = (needs: string) =>
    Bun.spawnSync(["bash", "-c", body], {
      env: { ...process.env, NEEDS_JSON: needs },
      stdout: "pipe",
      stderr: "pipe",
    }).exitCode;

  test("accepts only a complete successful dependency object", () => {
    expect(aggregate(JSON.stringify(successful()))).toBe(0);
  });

  test("rejects each dependency's failure, cancellation, skip, unknown or missing result", () => {
    for (const id of LINUX_GATES)
      for (const result of ["failure", "cancelled", "skipped", "unknown", undefined]) {
        const needs = successful();
        needs[id].result = result;
        expect(aggregate(JSON.stringify(needs))).not.toBe(0);
      }
    for (const id of LINUX_GATES) {
      const needs = successful();
      delete needs[id];
      expect(aggregate(JSON.stringify(needs))).not.toBe(0);
    }
  });

  test("rejects empty, malformed, multiple or non-object JSON and unexpected dependencies", () => {
    for (const needs of [
      "",
      "{",
      "{}",
      "[]",
      "null",
      '"success"',
      `{} ${JSON.stringify(successful())}`,
      JSON.stringify({ ...successful(), extra: { result: "success" } }),
      JSON.stringify({ ...successful(), build: null }),
    ]) {
      expect(aggregate(needs)).not.toBe(0);
    }
  });
});
