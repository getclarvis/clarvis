import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalPaths } from "@clarvis/paths";
import { CacheBudget } from "../../cache/limits.ts";
import { cacheHash } from "../../cache/wire.ts";
import { goalArgumentShape, goalChatGptAffinity } from "../../goal/evidence.ts";
import type { GoalPhysicalCall } from "../../goal/fixture.ts";
import {
  GOAL_TEST_SOURCE,
  GOAL_TRIAL_LIMITS,
  prepareGoalLiveFixture,
  type GoalScenario,
} from "../../goal/fixture.ts";

test("goal live fixture does not provision credentials and its baseline fails the independent test", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-goal-live-fixture-"));
  try {
    await prepareGoalLiveFixture(root, "gpt-5.6-terra");
    expect(await Bun.file(globalPaths(join(root, "global")).subscriptionsFile).exists()).toBe(
      false,
    );
    expect(await readFile(join(root, "workspace", "solution.test.ts"), "utf8")).toBe(
      GOAL_TEST_SOURCE,
    );
    const child = Bun.spawn([process.execPath, "test", "solution.test.ts", "--timeout", "5000"], {
      cwd: join(root, "workspace"),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10000,
    });
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(status).toBe(1);
    expect(stdout + stderr).toContain("3 fail");
    const budget = new CacheBudget<GoalScenario>({ ...GOAL_TRIAL_LIMITS, calls: 1 });
    budget.admit();
    expect(() => budget.admit()).toThrow("limit_reached");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("goal affinity compares the ChatGPT header's hash and fails closed on absent or foreign identities", () => {
  const keyHash = cacheHash("session_agent");
  const call = {
    sessionId: "session",
    keyHash,
    sessionHeaderHash: cacheHash(keyHash),
  } as GoalPhysicalCall;
  expect(goalChatGptAffinity(call, "session")).toBe(true);
  expect(goalChatGptAffinity(call, "another")).toBe(false);
  expect(goalChatGptAffinity({ ...call, sessionHeaderHash: undefined }, "session")).toBe(false);
  expect(goalChatGptAffinity({ ...call, sessionHeaderHash: keyHash }, "session")).toBe(false);
  expect(goalChatGptAffinity({ ...call, keyHash: cacheHash("session_child") }, "session")).toBe(
    false,
  );
});

test("goal tool diagnostics preserve null and extra-field shapes without argument content", () => {
  const shape = goalArgumentShape({
    action: "checkpoint",
    summary: "private text",
    next_step: "next",
    reason: null,
    assessments: [],
  });
  expect(shape).toEqual({
    action: "string",
    summary: "string",
    next_step: "string",
    reason: "null",
    assessments: { length: 0, items: [] },
  });
  expect(JSON.stringify(shape)).not.toContain("private text");
});
