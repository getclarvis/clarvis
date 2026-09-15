import { afterEach, describe, expect, it } from "bun:test";
import type { GoalControlRequest, Scope, SettingsData } from "@clarvis/protocol";
import { createGoalFileHostFixture } from "../helpers/goal-file-host.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

type Fixture = Awaited<ReturnType<typeof createGoalFileHostFixture>>;

async function configure(f: Fixture, scope: Scope, patch: SettingsData) {
  const view = await f.client.config.getSettings();
  return f.client.config.updateSettings(
    scope,
    patch,
    view.sources.find((source) => source.scope === scope)?.revision ?? null,
  );
}

async function settle(f: Fixture) {
  await f.until(() => f.host.stats().runs === 0);
  return (await f.client.goals.get("conversation")).state.current!;
}

function checkpoint(f: Fixture) {
  f.setResponder(async () => ({
    name: "update_goal",
    arguments: {
      update: { action: "checkpoint", summary: "Controlled stage", next_step: "Continue later" },
    },
  }));
}

describe("goal defaults through file configuration, IPC and the real SDK", () => {
  it("persists configured limits once and replays creation after configuration changes", async () => {
    const f = await createGoalFileHostFixture();
    cleanups.push(f.close);
    checkpoint(f);
    const limits = {
      max_net_tokens: 6000,
      max_auto_continuations: 0,
      max_no_progress_checkpoints: 2,
      deadline_at: Date.now() + 60000,
    };
    await configure(f, "global", { goals: limits });
    const request: GoalControlRequest = {
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "create",
      action: { kind: "create", objective: "Use configured limits" },
    };
    const receipt = await f.client.goals.control(request);
    const before = await settle(f);
    expect(before.limits).toEqual(limits);
    expect(before).toMatchObject({ status: "usage_limited", auto_continuations: 0 });
    expect(f.requests).toHaveLength(1);
    await configure(f, "global", {
      goals: { max_net_tokens: 9000, max_auto_continuations: 7, max_no_progress_checkpoints: 9 },
    });
    expect(await f.client.goals.control(request)).toEqual(receipt);
    expect((await f.client.goals.get("conversation")).state.current).toEqual(before);
    expect(f.requests).toHaveLength(1);

    const view = await f.client.goals.get("conversation");
    await expect(
      f.client.goals.control({
        session_id: "conversation",
        expected_revision: view.state.revision,
        operation_id: "resume",
        action: { kind: "resume" },
      }),
    ).rejects.toMatchObject({ code: "resource_exhausted" });
    expect(f.requests).toHaveLength(1);
    await f.client.goals.control({
      session_id: "conversation",
      expected_revision: view.state.revision,
      operation_id: "edit",
      action: { kind: "edit", limits: { max_auto_continuations: 1 } },
    });
    f.setResponder(async () => ({
      name: "update_goal",
      arguments: { update: { action: "blocked", reason: "Explicit resume verified" } },
    }));
    await f.client.goals.control({
      session_id: "conversation",
      expected_revision: (await f.client.goals.get("conversation")).state.revision,
      operation_id: "resume",
      action: { kind: "resume" },
    });
    const resumed = await settle(f);
    expect(resumed.limits).toEqual({ ...limits, max_auto_continuations: 1 });
    expect(resumed.consumption.net_tokens).toBeGreaterThan(before.consumption.net_tokens);
    expect(resumed.auto_continuations).toBe(0);
    expect(f.requests).toHaveLength(2);
    expect(new Set(f.requests.map((request) => request.prompt_cache_key)).size).toBe(1);
    await f.client.goals.control({
      session_id: "conversation",
      expected_revision: (await f.client.goals.get("conversation")).state.revision,
      operation_id: "cancel",
      action: { kind: "cancel" },
    });
    await f.client.goals.control({
      session_id: "conversation",
      expected_revision: (await f.client.goals.get("conversation")).state.revision,
      operation_id: "replace",
      action: { kind: "replace", objective: "Use the newly configured limits" },
    });
    const replacement = await settle(f);
    expect(replacement.goal_id).not.toBe(resumed.goal_id);
    expect(replacement.limits).toEqual({
      max_net_tokens: 9000,
      max_auto_continuations: 7,
      max_no_progress_checkpoints: 9,
    });
    expect((await f.client.goals.get("conversation")).state.archive[0]).toMatchObject({
      goal_id: resumed.goal_id,
      consumption: resumed.consumption,
      limits: resumed.limits,
    });
    expect(f.requests).toHaveLength(3);
  });

  it("applies explicit creation overrides before configured defaults", async () => {
    const f = await createGoalFileHostFixture();
    cleanups.push(f.close);
    checkpoint(f);
    await configure(f, "global", {
      goals: { max_net_tokens: 8000, max_auto_continuations: 6, max_no_progress_checkpoints: 2 },
    });
    await f.client.goals.control({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "create",
      action: {
        kind: "create",
        objective: "Use explicit limits",
        limits: { max_net_tokens: 6000, max_auto_continuations: 0 },
      },
    });
    expect((await settle(f)).limits).toEqual({
      max_net_tokens: 6000,
      max_auto_continuations: 0,
      max_no_progress_checkpoints: 2,
    });
    expect(f.requests).toHaveLength(1);
  });

  it("uses the last scope's block and inherits the entry token cap without multiplying it", async () => {
    const f = await createGoalFileHostFixture();
    cleanups.push(f.close);
    checkpoint(f);
    await configure(f, "global", {
      goals: { max_net_tokens: 8000, max_auto_continuations: 6, max_no_progress_checkpoints: 2 },
      budget: { total_token_limit: 5000, on_exceed: "escalate" },
    });
    await configure(f, "workspace", { goals: { max_auto_continuations: 0 } });
    await f.client.goals.control({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "create",
      action: { kind: "create", objective: "Inherit one finite entry cap" },
    });
    const goal = await settle(f);
    expect(goal.limits).toEqual({
      max_net_tokens: 5000,
      max_auto_continuations: 0,
      max_no_progress_checkpoints: 3,
    });
    expect(f.requests).toHaveLength(1);
  });

  it("refuses a configured expired absolute deadline before starting inference", async () => {
    const f = await createGoalFileHostFixture();
    cleanups.push(f.close);
    await configure(f, "global", { goals: { max_net_tokens: 6000, deadline_at: 0 } });
    await expect(
      f.client.goals.control({
        session_id: "conversation",
        expected_revision: 0,
        operation_id: "create",
        action: { kind: "create", objective: "Must not start after the deadline" },
      }),
    ).rejects.toMatchObject({ code: "resource_exhausted" });
    expect(f.requests).toHaveLength(0);
    expect((await f.client.goals.get("conversation")).state.current).toBeUndefined();
    expect(await f.client.goals.receipt("conversation", "create")).toBeNull();
    expect(f.host.stats().runs).toBe(0);
  });
});
