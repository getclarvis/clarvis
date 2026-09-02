import { expect, test } from "bun:test";
import type { RunEvent } from "@clarvis/protocol";
import {
  reduceWorkflowProjection,
  workflowLeaderCounts,
  type WorkflowActivity,
} from "../../src/adapters/workflow-projection.ts";

function started(
  runId: string,
  parent: string,
  task: string,
  profile?: string,
  at = 1,
): Extract<RunEvent, { type: "workflow_run_started" }> {
  return {
    type: "workflow_run_started",
    at,
    run_id: runId,
    parent_run_id: parent,
    title: `Title ${runId}`,
    task,
    ...(profile ? { profile } : {}),
  };
}

const runEnded = (reason: string, at: number): Extract<RunEvent, { type: "run_ended" }> =>
  ({ type: "run_ended", at, reason }) as Extract<RunEvent, { type: "run_ended" }>;

test("seeds the manager root from the first leader's parent and adds the leader", () => {
  const activity = reduceWorkflowProjection(
    null,
    started("leader-1", "mgr", "research", "researcher"),
  );
  expect(activity).not.toBeNull();
  expect(activity!.root).toBe("mgr");
  expect(activity!.nodes.get("mgr")?.kind).toBe("manager");
  const leader = activity!.nodes.get("leader-1")!;
  expect(leader.kind).toBe("leader");
  expect(leader.profile).toBe("researcher");
  expect(leader.title).toBe("Title leader-1");
  expect(leader.status).toBe("running");
});

test("projects an awaiting-Admiral checkpoint even when no leader is currently live", () => {
  let activity = reduceWorkflowProjection(null, {
    type: "workflow_sequence_state",
    at: 2,
    run_id: "mgr",
    session_id: "wfseq-1",
    status: "awaiting_manager",
    revision: 3,
    round_id: "discover",
    pass: 0,
    next_round_id: "verify",
    next_pass: 0,
    leaders_started: 4,
    max_total_leaders: 32,
  });
  expect(activity?.root).toBe("mgr");
  expect(activity?.sequence).toMatchObject({
    status: "awaiting_manager",
    revision: 3,
    nextRoundId: "verify",
    leadersStarted: 4,
    maxTotalLeaders: 32,
  });

  activity = reduceWorkflowProjection(activity, started("leader-5", "mgr", "verify"));
  expect(activity?.sequence?.status).toBe("awaiting_manager");
  expect(activity?.nodes.get("leader-5")?.status).toBe("running");
});

test("keeps authored round context and a terminal failure reason on the live leader", () => {
  let activity = reduceWorkflowProjection(null, {
    ...started("leader-1", "mgr", "verify"),
    round_id: "verify",
    pass: 1,
    item_index: 2,
    replica: 0,
    replica_count: 3,
  });
  expect(activity!.nodes.get("leader-1")).toMatchObject({
    roundId: "verify",
    pass: 1,
    itemIndex: 2,
    replica: 0,
    replicaCount: 3,
  });

  activity = reduceWorkflowProjection(activity, {
    type: "workflow_run_failed",
    at: 6,
    run_id: "leader-1",
    parent_run_id: "mgr",
    status: "failed",
    error: { code: "test_failed", message: "the targeted suite failed" },
  });
  expect(activity!.nodes.get("leader-1")).toMatchObject({
    status: "error",
    reason: "the targeted suite failed",
  });
});

test("closes leaders on completion and failure, tracking the running count", () => {
  let activity: WorkflowActivity | null = null;
  activity = reduceWorkflowProjection(activity, started("leader-1", "mgr", "a"));
  activity = reduceWorkflowProjection(activity, started("leader-2", "mgr", "b"));
  expect(workflowLeaderCounts(activity!)).toEqual({ total: 2, running: 2 });

  activity = reduceWorkflowProjection(activity, {
    type: "workflow_run_completed",
    at: 5,
    run_id: "leader-1",
    parent_run_id: "mgr",
    status: "completed",
  });
  activity = reduceWorkflowProjection(activity, {
    type: "workflow_run_failed",
    at: 6,
    run_id: "leader-2",
    parent_run_id: "mgr",
    status: "failed",
  });

  expect(activity!.nodes.get("leader-1")?.status).toBe("ok");
  expect(activity!.nodes.get("leader-2")?.status).toBe("error");
  expect(workflowLeaderCounts(activity!)).toEqual({ total: 2, running: 0 });
});

test("preserves cancellation instead of presenting a stopped leader as failed", () => {
  let activity = reduceWorkflowProjection(null, started("leader-1", "mgr", "a"));
  activity = reduceWorkflowProjection(activity, {
    type: "workflow_run_failed",
    at: 6,
    run_id: "leader-1",
    parent_run_id: "mgr",
    status: "cancelled",
  });

  expect(activity!.nodes.get("leader-1")?.status).toBe("cancelled");
  expect(workflowLeaderCounts(activity!)).toEqual({ total: 1, running: 0 });
});

test("folds workflow_run_progress into a leader's live iterations and tokens, staying running", () => {
  let activity = reduceWorkflowProjection(null, started("leader-1", "mgr", "research"));
  activity = reduceWorkflowProjection(activity, {
    type: "workflow_run_progress",
    at: 3,
    run_id: "leader-1",
    parent_run_id: "mgr",
    iterations: 2,
    input_tokens: 1200,
    output_tokens: 340,
  });
  const leader = activity!.nodes.get("leader-1")!;
  expect(leader.status).toBe("running");
  expect(leader.iterations).toBe(2);
  expect(leader.inputTokens).toBe(1200);
  expect(leader.outputTokens).toBe(340);
  expect(leader.title).toBe("Title leader-1");
});

test("updates the manager title from the live metadata event", () => {
  let activity = reduceWorkflowProjection(null, started("leader-1", "mgr", "research"));
  activity = reduceWorkflowProjection(activity, {
    type: "workflow_title_updated",
    at: 2,
    run_id: "mgr",
    title: "Research authentication",
  });
  expect(activity?.nodes.get("mgr")?.title).toBe("Research authentication");
});

test("does not invent a running tree from a title event alone", () => {
  expect(
    reduceWorkflowProjection(null, {
      type: "workflow_title_updated",
      at: 2,
      run_id: "mgr",
      title: "Research authentication",
    }),
  ).toBeNull();
});

test("run_ended closes the manager root node", () => {
  let activity = reduceWorkflowProjection(null, started("leader-1", "mgr", "a"));
  activity = reduceWorkflowProjection(activity, runEnded("completed", 9));
  expect(activity!.nodes.get("mgr")?.status).toBe("ok");
  expect(activity!.nodes.get("mgr")?.endedAt).toBe(9);
});

test("run_ended preserves a cancelled manager root", () => {
  let activity = reduceWorkflowProjection(null, started("leader-1", "mgr", "a"));
  activity = reduceWorkflowProjection(activity, runEnded("cancelled", 9));
  expect(activity!.nodes.get("mgr")?.status).toBe("cancelled");
});

test("ignores run_ended before any leader has seeded the tree", () => {
  expect(reduceWorkflowProjection(null, runEnded("completed", 1))).toBeNull();
});
