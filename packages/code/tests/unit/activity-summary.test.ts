import { expect, test } from "bun:test";
import {
  ACTIVITY_SUMMARY_MAX_ROWS,
  ACTIVITY_SUMMARY_SINGLE_ROW_MAX_HEIGHT,
  activitySummaryFacts,
  activitySummaryRowBudget,
  activitySummaryRowText,
  activitySummaryRoute,
  activitySummaryRows,
  planDisplayLifecycle,
  type ActivitySummaryFact,
  type ActivitySummaryInput,
  type ActivitySummaryTone,
} from "../../src/views/activity-summary.ts";
import type { PlanActivity, PlanTaskActivity } from "../../src/adapters/activity-store.ts";
import type {
  WorkflowActivity,
  WorkflowNodeActivity,
} from "../../src/adapters/workflow-projection.ts";

function task(status: string, id = `t${status}`): PlanTaskActivity {
  return { id, title: `Task ${id}`, status };
}

function plan(over: Partial<PlanActivity> = {}): PlanActivity {
  return {
    id: "p1",
    title: "A plan",
    status: "active",
    retention: "keep",
    revision: 1,
    spec_revision: 1,
    tasks: [],
    ...over,
  };
}

function leader(runId: string, over: Partial<WorkflowNodeActivity> = {}): WorkflowNodeActivity {
  return { runId, kind: "leader", title: `Leader ${runId}`, status: "running", ...over };
}

function workflow(
  leaders: WorkflowNodeActivity[],
  over: Partial<WorkflowActivity> = {},
): WorkflowActivity {
  return {
    root: "workflow-1",
    nodes: new Map<string, WorkflowNodeActivity>([
      ["workflow-1", { runId: "workflow-1", kind: "manager", title: "manager", status: "running" }],
      ...leaders.map((entry) => [entry.runId, entry] as const),
    ]),
    ...over,
  };
}

function input(over: Partial<ActivitySummaryInput> = {}): ActivitySummaryInput {
  return {
    goal: { formulating: false },
    plan: null,
    workflow: null,
    subagents: [],
    ...over,
  };
}

function texts(facts: readonly ActivitySummaryFact[]): string[] {
  return facts.map((entry) => entry.text);
}

test("an idle run states nothing at all", () => {
  expect(activitySummaryFacts(input())).toEqual([]);
});

test("an absent section contributes no fact while the present ones keep their canonical words", () => {
  expect(
    texts(activitySummaryFacts(input({ plan: plan({ tasks: [task("done"), task("pending")] }) }))),
  ).toEqual(["Plan 1/2"]);
  expect(
    texts(activitySummaryFacts(input({ goal: { formulating: false, status: "active" } }))),
  ).toEqual(["Goal Running"]);
  expect(texts(activitySummaryFacts(input({ goal: { formulating: true } })))).toEqual([
    "Goal Formulating",
  ]);
});

test("every Goal outcome keeps its canonical vocabulary and reads its own attention", () => {
  const cases: [
    NonNullable<ActivitySummaryInput["goal"]["status"]>,
    string,
    ActivitySummaryTone,
  ][] = [
    ["active", "Goal Running", "running"],
    ["complete", "Goal Completed", "completed"],
    ["paused", "Goal Paused", "paused"],
    ["blocked", "Goal Blocked", "attention"],
    ["budget_limited", "Goal Limit reached", "attention"],
    ["usage_limited", "Goal Limit reached", "attention"],
    ["cancelled", "Goal Canceled", "canceled"],
  ];
  for (const [status, text, tone] of cases) {
    const facts = activitySummaryFacts(input({ goal: { formulating: false, status } }));
    expect([status, texts(facts)]).toEqual([status, [text]]);
    expect([status, facts[0]!.tone]).toEqual([status, tone]);
  }
});

test("a completed plan states progress without inventing success from a finished count", () => {
  const allDone = activitySummaryFacts(
    input({ plan: plan({ status: "completed", tasks: [task("done"), task("done")] }) }),
  );
  expect(texts(allDone)).toEqual(["Plan 2/2"]);
  expect(allDone[0]!.tone).toBe("completed");

  const left = activitySummaryFacts(
    input({ plan: plan({ status: "active", tasks: [task("done"), task("pending")] }) }),
  );
  expect(texts(left)).toEqual(["Plan 1/2"]);
  expect(left[0]!.tone).toBe("running");
});

test("terminal plan outcomes stay distinct and unsuccessful tasks are counted separately", () => {
  const failed = activitySummaryFacts(
    input({
      plan: plan({
        status: "failed",
        tasks: [task("done"), task("failed"), task("pending")],
      }),
    }),
  );
  expect(texts(failed)).toEqual(["Plan 1/3 Failed", "1 failed"]);
  expect(failed.map((entry) => entry.tone)).toEqual(["failed", "failed"]);

  const cancelled = activitySummaryFacts(
    input({ plan: plan({ status: "cancelled", tasks: [task("done"), task("abandoned")] }) }),
  );
  expect(texts(cancelled)).toEqual(["Plan 1/2 Canceled", "1 canceled"]);

  const completedWithPending = activitySummaryFacts(
    input({ plan: plan({ status: "completed", tasks: [task("done"), task("pending")] }) }),
  );
  expect(texts(completedWithPending)).toEqual(["Plan 1/2 Completed"]);
});

test("a plan awaiting approval states the proposal rather than a progress ratio", () => {
  const facts = activitySummaryFacts(
    input({
      plan: plan({ status: "awaiting_approval", tasks: [task("pending"), task("pending")] }),
    }),
  );
  expect(texts(facts)).toEqual(["Plan 2 proposed"]);
  expect(facts[0]!.tone).toBe("attention");
});

test("a removed plan is unavailable only when its removal was not the retention policy", () => {
  const expected = activitySummaryFacts(
    input({
      plan: plan({
        status: "completed",
        retention: "discard",
        removed: true,
        tasks: [task("done")],
      }),
    }),
  );
  expect(texts(expected)).toEqual(["Plan 1/1"]);

  const unexpected = activitySummaryFacts(
    input({ plan: plan({ status: "active", removed: true, tasks: [task("in_progress")] }) }),
  );
  expect(texts(unexpected)).toEqual(["Plan unavailable"]);
  expect(unexpected[0]!.tone).toBe("failed");
});

test("workflow facts count leaders only and never add the manager to their own group", () => {
  const three = workflow([
    leader("l1", { status: "running" }),
    leader("l2", { status: "ok" }),
    leader("l3", { status: "error" }),
  ]);
  const facts = activitySummaryFacts(input({ workflow: three }));
  expect(texts(facts)).toEqual(["Workflow 2/3", "1 failed"]);
  expect(facts[0]!.tone).toBe("running");
});

test("a workflow with no leader states its checkpoint or terminal state instead of a ratio", () => {
  const checkpoint = workflow([], {
    sequence: {
      sessionId: "s1",
      status: "awaiting_manager",
      revision: 3,
      leadersStarted: 2,
      maxTotalLeaders: 8,
    },
  });
  expect(texts(activitySummaryFacts(input({ workflow: checkpoint })))).toEqual([
    "Workflow checkpoint r3",
  ]);

  const failed = workflow([], {
    sequence: {
      sessionId: "s1",
      status: "failed",
      revision: 4,
      leadersStarted: 2,
      maxTotalLeaders: 8,
    },
  });
  expect(texts(activitySummaryFacts(input({ workflow: failed })))).toEqual(["Workflow Failed"]);

  const bare = workflow([]);
  expect(activitySummaryFacts(input({ workflow: bare }))).toEqual([]);
});

test("agent facts count children only, never the Lead", () => {
  const facts = activitySummaryFacts(
    input({
      subagents: [{ status: "running" }, { status: "running" }, { status: "done" }],
    }),
  );
  expect(texts(facts)).toEqual(["Agents 1/3"]);
  expect(facts[0]!.tone).toBe("running");

  const failed = activitySummaryFacts(
    input({ subagents: [{ status: "error" }, { status: "done" }] }),
  );
  expect(texts(failed)).toEqual(["Agents 2/2", "1 failed"]);
});

test("the whole summary keeps one fact per group and repeats no work across groups", () => {
  const facts = activitySummaryFacts(
    input({
      goal: { formulating: false, status: "complete" },
      plan: plan({ status: "active", tasks: [task("done"), task("pending")] }),
      workflow: workflow([leader("l1", { status: "running" })]),
      subagents: [{ status: "running" }],
    }),
  );
  expect(texts(facts)).toEqual(["Goal Completed", "Plan 1/2", "Workflow 0/1", "Agents 0/1"]);
  expect(facts.map((entry) => entry.section)).toEqual(["goal", "plan", "workflow", "agents"]);
});

test("rows break between whole facts and never split one", () => {
  const facts: ActivitySummaryFact[] = [
    { section: "goal", text: "Goal Completed", tone: "completed", priority: "settled" },
    { section: "plan", text: "Plan 8/8", tone: "completed", priority: "settled" },
    { section: "agents", text: "Agents 0/1", tone: "running", priority: "running" },
  ];
  const rows = activitySummaryRows(facts, 25, 2);
  expect(rows.map(activitySummaryRowText)).toEqual(["Goal Completed · Plan 8/8", "Agents 0/1"]);
});

test("a row that is only settled work is shed before attention or in-flight work", () => {
  const facts: ActivitySummaryFact[] = [
    { section: "goal", text: "Goal Completed", tone: "completed", priority: "settled" },
    { section: "plan", text: "Plan 8/8", tone: "completed", priority: "settled" },
    { section: "plan", text: "1 failed", tone: "failed", priority: "attention" },
  ];
  const rows = activitySummaryRows(facts, 12, 1);
  expect(rows.map(activitySummaryRowText)).toEqual(["1 failed"]);
});

test("one row keeps the strip's own route beside the work still in flight", () => {
  const facts: ActivitySummaryFact[] = [
    { section: "plan", text: "Plan 1/2", tone: "running", priority: "running" },
    { section: "agents", text: "Agents 0/1", tone: "running", priority: "running" },
    activitySummaryRoute("[Ctrl+X S] activity"),
  ];
  expect(activitySummaryRows(facts, 36, 1).map(activitySummaryRowText)).toEqual([
    "Plan 1/2 · [Ctrl+X S] activity",
  ]);
});

test("a summary that fits its budget states every fact", () => {
  const facts: ActivitySummaryFact[] = [
    { section: "goal", text: "Goal Completed", tone: "completed", priority: "settled" },
    { section: "plan", text: "Plan 8/8", tone: "completed", priority: "settled" },
    activitySummaryRoute("[Ctrl+X S] activity"),
  ];
  expect(activitySummaryRows(facts, 38, 2).map(activitySummaryRowText)).toEqual([
    "Goal Completed · Plan 8/8",
    "[Ctrl+X S] activity",
  ]);
});

test("the strip's own route survives the row budget", () => {
  const facts: ActivitySummaryFact[] = [
    { section: "goal", text: "Goal Completed", tone: "completed", priority: "settled" },
    { section: "agents", text: "Agents 0/2", tone: "running", priority: "running" },
    activitySummaryRoute("[Ctrl+X S] activity"),
  ];
  const rows = activitySummaryRows(facts, 12, 1);
  const joined = rows.map(activitySummaryRowText);
  expect(joined).toContain("[Ctrl+X S] activity");
  expect(joined.every((row) => !row.includes("Goal Completed"))).toBe(true);
});

test("the row budget is one row at extreme heights and the target of two above them", () => {
  expect(activitySummaryRowBudget(6)).toBe(1);
  expect(activitySummaryRowBudget(ACTIVITY_SUMMARY_SINGLE_ROW_MAX_HEIGHT)).toBe(1);
  expect(activitySummaryRowBudget(ACTIVITY_SUMMARY_SINGLE_ROW_MAX_HEIGHT + 1)).toBe(
    ACTIVITY_SUMMARY_MAX_ROWS,
  );
  expect(activitySummaryRowBudget(24)).toBe(ACTIVITY_SUMMARY_MAX_ROWS);
});

test("planDisplayLifecycle reads a fully done plan as completed whatever its status says", () => {
  expect(planDisplayLifecycle(plan({ status: "active", tasks: [task("done")] }))).toBe("completed");
  expect(
    planDisplayLifecycle(plan({ status: "active", tasks: [task("done"), task("pending")] })),
  ).toBe("running");
  expect(planDisplayLifecycle(plan({ status: "failed", tasks: [task("failed")] }))).toBe("failed");
  expect(
    planDisplayLifecycle(plan({ status: "awaiting_approval", tasks: [task("pending")] })),
  ).toBe("needs-approval");
});
