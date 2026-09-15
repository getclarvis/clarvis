import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { globalPaths } from "@clarvis/paths";
import type { CacheCall, CacheLimits } from "../cache/types.ts";

export const GOAL_FIXTURE_VERSION = 1;
export type GoalScenario = "goal-continuation";
export type GoalPhysicalCall = CacheCall<GoalScenario>;
export const GOAL_TRIAL_LIMITS: CacheLimits = {
  calls: 32,
  input: 500000,
  output: 24000,
  durationMs: 6 * 60000,
};
export const GOAL_GLOBAL_LIMITS: CacheLimits = {
  calls: 128,
  input: 2000000,
  output: 96000,
  durationMs: 30 * 60000,
};
export const GOAL_MODELS = ["gpt-5.6-terra", "gpt-5.6-luna"] as const;
export const GOAL_OBJECTIVE = [
  "Fix sumEvenSquares in solution.ts to sum the squares of only the even integers in its input.",
  "The readonly specification is solution.test.ts; do not modify that test file.",
  "Use exactly two work stages: in the first run create a plan with implementation and verification tasks,",
  "delegate implementation to helper, inspect its returned result, then request a goal checkpoint.",
  "Leave verification pending and do not return a final completion in that first run.",
  "The host will automatically continue the same goal. In the next run execute bun test solution.test.ts,",
  "inspect the result, close the plan tasks with current CAS values, submit a completion candidate with",
  "the objective assessment, and finish. A checkpoint request is the required first-stage boundary.",
].join(" ");
export const GOAL_TEST_SOURCE = [
  'import {expect, test} from "bun:test";',
  'import {sumEvenSquares} from "./solution.ts";',
  'test("positive even squares", () => expect(sumEvenSquares([1, 2, 3, 4])).toBe(20));',
  'test("negative even squares", () => expect(sumEvenSquares([-4, -3, -2])).toBe(20));',
  'test("empty", () => expect(sumEvenSquares([])).toBe(0));',
  'test("duplicates and zero", () => expect(sumEvenSquares([0, 2, 2])).toBe(8));',
  "",
].join("\n");

/** Only synthetic operator configuration and workspace content; authentication is mounted separately. */
export async function prepareGoalLiveFixture(root: string, model: string): Promise<void> {
  const workspace = join(root, "workspace");
  const paths = globalPaths(join(root, "global"));
  await mkdir(workspace, { recursive: true });
  await mkdir(paths.agentsDir, { recursive: true });
  await mkdir(paths.state, { recursive: true });
  await writeFile(
    paths.settingsFile,
    JSON.stringify({
      default_model: `chatgpt/${model}`,
      default_reasoning_effort: "medium",
      providers: [{ name: "chatgpt", kind: "openai-codex" }],
      runtime: { backend: "native" },
      plans: { mode: "on", retention: "keep" },
      guard: { type: "shell", mode: "off" },
      budget: {
        on_exceed: "stop",
        total_token_limit: 30000,
        timeout_ms: GOAL_TRIAL_LIMITS.durationMs,
      },
    }),
  );
  for (const name of ["goal-leader", "helper"]) {
    await writeFile(
      join(paths.agentsDir, `${name}.md`),
      [
        "---",
        `model: chatgpt/${model}`,
        "reasoning_effort: medium",
        "tools: []",
        "grants: [read_workspace, edit_workspace, run_commands]",
        "iteration_limit: 20",
        "call_timeout_ms: 120000",
        "retry: {max_retries: 1}",
        ...(name === "goal-leader" ? ["can_spawn: [helper]"] : []),
        "---",
        name === "goal-leader"
          ? "Follow the persistent goal and preserve its required stage boundaries. Use get_goal to recover stage state. Use the ordinary plan, delegation and verification tools."
          : "Implement the assigned synthetic change, report observed results, and leave the leader to verify and close its plan. Do not edit solution.test.ts.",
        "",
      ].join("\n"),
    );
  }
  await writeFile(
    join(workspace, "solution.ts"),
    "export function sumEvenSquares(values: number[]): number { return values.reduce((sum, value) => sum + value, 0); }\n",
  );
  await writeFile(join(workspace, "solution.test.ts"), GOAL_TEST_SOURCE);
}
