import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { globalPaths } from "@clarvis/paths";
import { cacheSourceIdentity } from "../cache/live.ts";
import { prepareHostAuthView } from "../cache/host-auth-view.ts";
import { CacheBudget } from "../cache/limits.ts";
import { cacheHash } from "../cache/wire.ts";
import {
  GOAL_FIXTURE_VERSION,
  GOAL_GLOBAL_LIMITS,
  GOAL_MODELS,
  GOAL_TRIAL_LIMITS,
  prepareGoalLiveFixture,
  type GoalScenario,
} from "./fixture.ts";
import type { GoalLiveJob, GoalLiveResult } from "./types.ts";

/** Explicit local qualification; no CI trigger and no authentication material in fixture state. */
export async function runGoalLive(options: {
  models: readonly string[];
  trials: number;
  output: string;
}): Promise<void> {
  if (
    !Number.isInteger(options.trials) ||
    options.trials < 1 ||
    options.trials > 2 ||
    options.models.length < 1 ||
    options.models.length > 2 ||
    new Set(options.models).size !== options.models.length ||
    options.models.some((model) => !GOAL_MODELS.includes(model as (typeof GOAL_MODELS)[number]))
  )
    throw new Error("Expected one or two supported models and one or two trials");
  const output = resolve(options.output);
  await mkdir(output, { recursive: true });
  const config = {
    models: options.models,
    trials: options.trials,
    limits: GOAL_TRIAL_LIMITS,
    global_limits: GOAL_GLOBAL_LIMITS,
  };
  const source = await cacheSourceIdentity(config);
  const workerPath = resolve(
    import.meta.dir,
    "../../packages/kernel/tests/helpers/goal-live-worker.ts",
  );
  source.fixtureHash = cacheHash([
    GOAL_FIXTURE_VERSION,
    await readFile(join(import.meta.dir, "fixture.ts"), "utf8"),
    await readFile(workerPath, "utf8"),
  ]);
  const budget = new CacheBudget<GoalScenario>(GOAL_GLOBAL_LIMITS);
  const report = {
    schema_version: 2,
    scenario: "goal-continuation",
    source,
    config,
    expected: options.models.flatMap((model) =>
      Array.from({ length: options.trials }, (_, index) => ({ model, trial: index + 1 })),
    ),
    trials: [] as GoalLiveResult[],
    diagnostics: [] as string[],
    verdict: "incomplete",
  };
  const save = () => writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await save();
  process.stdout.write(JSON.stringify({ event: "goal.qualification_limits", ...config }) + "\n");
  for (const expected of report.expected) {
    if (budget.exhausted()) {
      report.diagnostics.push("global_limit_reached");
      break;
    }
    if ((await cacheSourceIdentity(config)).inputsHash !== source.inputsHash) {
      report.diagnostics.push("source_inputs_changed");
      break;
    }
    const root = await mkdtemp(join(tmpdir(), "clarvis-goal-live-"));
    let auth: Awaited<ReturnType<typeof prepareHostAuthView>> | undefined;
    try {
      await prepareGoalLiveFixture(root, expected.model);
      auth = await prepareHostAuthView({
        authenticationRoot: globalPaths().root,
        isolatedRoot: join(root, "global"),
        mountedRoot: join(root, "auth-view"),
      });
      const outputFile = join(output, `${expected.model}-${expected.trial}.json`);
      const job: GoalLiveJob = {
        ...expected,
        root,
        globalDir: auth.globalDir,
        outputFile,
        sdkVersion: source.sdkVersion,
        globalCalls: budget.calls,
        globalStartedAt: budget.startedAt,
      };
      const jobFile = join(root, "job.json");
      await writeFile(jobFile, JSON.stringify(job));
      process.stdout.write(JSON.stringify({ event: "goal.trial_started", ...expected }) + "\n");
      const worker = Bun.spawn([...auth.command, process.execPath, workerPath, jobFile], {
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
        env: { ...process.env, CLARVIS_HOME: auth.globalDir },
        timeout: GOAL_TRIAL_LIMITS.durationMs + 20000,
      });
      const status = await worker.exited;
      const result = JSON.parse(await readFile(outputFile, "utf8")) as GoalLiveResult;
      if (status !== 0 && result.verdict === "pass") {
        result.verdict = "incomplete";
        result.diagnostics.push("worker_exit_failed");
      }
      report.trials.push(result);
      budget.reconcile(result.calls);
      if (!result.cleanup || result.calls.some((call) => call.usage === undefined)) {
        report.diagnostics.push("unknown_physical_usage_or_cleanup");
        break;
      }
    } catch (error) {
      report.diagnostics.push(
        `${expected.model}/${expected.trial}: ${error instanceof Error ? error.message : "trial_failed"}`,
      );
      break;
    } finally {
      try {
        await auth?.cleanup();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
      await save();
    }
  }
  if ((await cacheSourceIdentity(config)).inputsHash !== source.inputsHash)
    report.diagnostics.push("source_inputs_changed");
  report.verdict =
    report.trials.length !== report.expected.length || report.diagnostics.length
      ? "incomplete"
      : report.trials.every((trial) => trial.verdict === "pass")
        ? "pass"
        : "fail";
  await save();
  process.stdout.write(
    JSON.stringify({
      event: "goal.qualification_finished",
      verdict: report.verdict,
      trials: report.trials.length,
      report: join(output, "report.json"),
    }) + "\n",
  );
  process.exitCode = report.verdict === "pass" ? 0 : 1;
}

if (import.meta.main) {
  const option = (name: string, fallback: string) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
  };
  await runGoalLive({
    models: option("--models", GOAL_MODELS.join(",")).split(","),
    trials: Number(option("--trials", "2")),
    output: option("--output", "build/goal-live"),
  });
}
