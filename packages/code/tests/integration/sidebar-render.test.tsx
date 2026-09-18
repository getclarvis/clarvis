import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import { rgbToHex, type RGBA } from "@opentui/core";
import type { TestRendererSetup } from "@opentui/core/testing";
import { createSignal } from "solid-js";
import { createMutable } from "solid-js/store";
import type { GoalChange } from "@clarvis/protocol";
import {
  AGENT_SIDEBAR_ROW_LIMIT,
  PLAN_SIDEBAR_TASK_LIMIT,
  WORKFLOW_SIDEBAR_ROW_LIMIT,
  planTaskWindow,
  rosterSummary,
  Sidebar,
  subagentProgress,
  workflowProgress,
} from "../../src/views/Sidebar.tsx";
import { truncateEnd } from "../../src/views/truncate.ts";
import { createActivityStore, type ActivityStore } from "../../src/adapters/activity-store.ts";
import { applyEvent } from "../../src/adapters/store.ts";
import type {
  WorkflowActivity,
  WorkflowNodeActivity,
} from "../../src/adapters/workflow-projection.ts";
import { runEvent } from "../helpers/run-events.ts";
import { tokens } from "../../src/theme/tokens.ts";
import { selectionBg } from "../../src/theme/surfaces.ts";
import { glyph } from "../../src/theme/glyphs.ts";
import { taskTone } from "../../src/views/blocks.tsx";
import { createGoalController, type GoalController } from "../../src/features/goal/controller.ts";
import { goalView } from "../helpers/goals.ts";

function fgOf(frame: { lines: { spans: { text: string; fg: RGBA }[] }[] }, needle: string): string {
  for (const line of frame.lines) {
    const span = line.spans.find((item) => item.text.includes(needle));
    if (span) return rgbToHex(span.fg).toLowerCase();
  }
  throw new Error(`no span containing ${JSON.stringify(needle)}`);
}

function activity(over: Partial<ActivityStore>): ActivityStore {
  return createMutable({
    subagents: [],
    plan: null,
    context: null,
    usage: null,
    budget: null,
    ...over,
  }) as unknown as ActivityStore;
}

async function mount(
  a: ActivityStore,
  opts: {
    width?: number;
    selected?: () => string | null;
    onSelectSubagent?: (id: string) => void;
    onOpenDetail?: () => void;
    workflow?: () => WorkflowActivity | null;
    goals?: GoalController;
    onOpenGoal?: () => void;
  } = {},
): Promise<TestRendererSetup> {
  const width = opts.width ?? 28;
  const t = await openRender(
    () => (
      <box flexDirection="row" width={width} height={24}>
        <Sidebar
          activity={a}
          focused={() => false}
          contextWindow={() => 1_024_000}
          selected={opts.selected}
          onSelectSubagent={opts.onSelectSubagent}
          onOpenDetail={opts.onOpenDetail}
          width={() => width}
          workflow={opts.workflow}
          goals={opts.goals}
          onOpenGoal={opts.onOpenGoal}
        />
      </box>
    ),
    { width, height: 24 },
  );
  for (let i = 0; i < 5; i++) await t.renderOnce();
  return t;
}

async function frame(a: ActivityStore, width = 28): Promise<string[]> {
  const t = await mount(a, { width });
  const out = t.captureCharFrame();
  t.renderer.destroy();
  return out.split("\n");
}

test("truncateEnd caps with an ellipsis", () => {
  expect(truncateEnd("hello world", 20)).toBe("hello world");
  expect(truncateEnd("hello world", 8)).toBe("hello w…");
  expect(truncateEnd("hello", 0)).toBe("");
  expect(truncateEnd("hello", 1)).toBe("…");
});

test("the roster turns a Markdown result into one bounded navigation summary", () => {
  expect(rosterSummary("## Done\n\n| check | status |\n| --- | --- |\n| tests | **pass** |")).toBe(
    "Done check status --- --- tests pass",
  );
  expect(rosterSummary("`0123456789`", 6)).toBe("01234…");
});

test("agent progress counts settled work and only surfaces active work in text", () => {
  expect(
    subagentProgress([{ status: "done" }, { status: "running" }, { status: "error" }]),
  ).toMatchObject({
    total: 3,
    settled: 2,
    running: 1,
    label: "2/3 finished · 1 running",
  });
});

test("workflow progress matches the compact settled and running vocabulary", () => {
  expect(workflowProgress([{ status: "ok" }, { status: "running" }, { status: "error" }])).toEqual({
    total: 3,
    settled: 2,
    running: 1,
    label: "2/3 finished · 1 running",
  });
});

test("Goal uses the same compact sidebar pattern and opens its complete screen from the row", async () => {
  const goals = createGoalController({
    binding: () => ({ sessionId: "goal-session", generation: 1 }),
    prepare: async () => ({ sessionId: "goal-session", generation: 1 }),
    service: () => ({
      availability: async () => ({ available: true }),
      get: async () => goalView({ objective: "Ship the observable result", status: "active" }),
      subscribe: async () => () => {},
      receipt: async () => null,
      formulate: async () => {
        throw new Error("not used");
      },
      control: async () => {
        throw new Error("not used");
      },
    }),
  });
  try {
    await goals.refresh();
    let opened = 0;
    const t = await mount(activity({}), { width: 44, goals, onOpenGoal: () => opened++ });
    const out = t.captureCharFrame();
    const spans = t.captureSpans();
    expect(out).toContain("Goal");
    expect(out).toContain("[Ctrl+X O] full goal");
    expect(out.replace(/\s+/gu, " ")).toContain("Ship the observable result");
    expect(out).toContain("[Ctrl+X O] full goal");
    expect(fgOf(spans, "Ship the observable result")).toBe(tokens.accent2.toLowerCase());
    expect(fgOf(spans, "Running")).toBe(tokens.add.toLowerCase());
    const goalRow = out.split("\n").findIndex((row) => row.includes("Goal"));
    await t.mockMouse.click(2, goalRow);
    expect(opened).toBe(1);
    t.renderer.destroy();
  } finally {
    goals.dispose();
  }
});

test("Goal formulation shows live semantic activity instead of an undifferentiated loader", async () => {
  const listeners = new Set<(change: GoalChange) => void>();
  const gate = Promise.withResolvers<void>();
  const goals = createGoalController({
    binding: () => ({ sessionId: "goal-session", generation: 1 }),
    prepare: async () => ({ sessionId: "goal-session", generation: 1 }),
    service: () => ({
      availability: async () => ({ available: true }),
      get: async () => ({ state: { version: 1, revision: 0, archive: [], receipts: [] } }),
      subscribe: async (_sessionId, listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      receipt: async () => null,
      formulate: async (request) => {
        await gate.promise;
        return {
          operation_id: request.operation_id,
          fingerprint: "fixture",
          revision: 1,
          formulation: { mode: request.mode, outcome: "failed" },
        };
      },
      control: async () => {
        throw new Error("not used");
      },
    }),
  });
  try {
    await goals.refresh();
    const pending = goals.formulate("guided", "Implement the named proposal");
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const listener of listeners)
      listener({
        session_id: "goal-session",
        formulation_activity: {
          phase: "thinking",
          iteration: 2,
          last_workspace_activity: "searching",
        },
      });
    const t = await mount(activity({}), { width: 44, goals });
    expect(t.captureCharFrame()).toContain("Searched workspace · done");
    expect(t.captureCharFrame()).toContain("Thinking about the Goal · iteration 2");
    t.renderer.destroy();
    gate.resolve();
    await pending;
  } finally {
    gate.resolve();
    goals.dispose();
  }
});

test("agent rows reuse plan glyphs and tones without a failure header", async () => {
  const a = activity({
    subagents: [
      { id: "done", order: 0, status: "done", title: "Done worker", input: 0, output: 0 },
      { id: "failed", order: 1, status: "error", title: "Failed worker", input: 0, output: 0 },
    ] as ActivityStore["subagents"],
  });
  const t = await mount(a, { width: 40 });
  const frame = t.captureCharFrame();
  const spans = t.captureSpans();
  expect(frame).toContain(`${taskTone("done").glyph} A1`);
  expect(frame).toContain(`${taskTone("failed").glyph} A2`);
  expect(frame).toContain("Agents  2/2 finished");
  expect(frame).not.toContain("2 failed");
  expect(fgOf(spans, taskTone("done").glyph)).toBe(taskTone("done").fg.toLowerCase());
  expect(fgOf(spans, taskTone("failed").glyph)).toBe(taskTone("failed").fg.toLowerCase());
  t.renderer.destroy();
});

test("agent rows follow Plan status priority without renumbering handles", async () => {
  const a = activity({
    subagents: [
      { id: "failed", order: 0, status: "error", title: "Failed", input: 0, output: 0 },
      { id: "done", order: 1, status: "done", title: "Done", input: 0, output: 0 },
      { id: "pending", order: 2, status: "spawned", title: "Pending", input: 0, output: 0 },
      { id: "running", order: 3, status: "running", title: "Running", input: 0, output: 0 },
    ] as ActivityStore["subagents"],
  });
  const rendered = (await frame(a, 44)).join("\n");
  expect(rendered.indexOf("A4  Running")).toBeLessThan(rendered.indexOf("A3  Pending"));
  expect(rendered.indexOf("A3  Pending")).toBeLessThan(rendered.indexOf("A2  Done"));
  expect(rendered.indexOf("A2  Done")).toBeLessThan(rendered.indexOf("A1  Failed"));
});

test("agent rows use one compact glyph-and-title line", async () => {
  const a = activity({
    subagents: [
      {
        id: "w0",
        order: 0,
        status: "running",
        title: "verify typecheck and the whole test suite",
        model: "z-ai/glm-5.2",
        input: 26_000,
        output: 704,
        startedAt: undefined,
      },
    ] as ActivityStore["subagents"],
  });
  const rows = await frame(a);
  const joined = rows.join(" ");
  const agentRows = rows.filter((row) => row.includes("A1"));
  expect(agentRows).toHaveLength(1);
  expect(agentRows[0]).toContain("test suite");
  expect(joined).not.toContain("and the whole test suite");
  expect(joined).not.toContain("Running");
  expect(joined).toContain("Lead transcript");
  expect(joined.match(/0\/1 finished/g)?.length).toBe(1);
  expect(joined).not.toContain("glm-5.2");
  expect(joined).not.toContain("26k");
});

test("parallel-work metadata stays on one line at the standard inspector width", async () => {
  const workflow: WorkflowActivity = {
    root: "manager-run",
    nodes: new Map<string, WorkflowNodeActivity>([
      [
        "manager-run",
        {
          runId: "manager-run",
          kind: "manager",
          title: "Manager",
          status: "running",
        },
      ],
      [
        "leader-run",
        {
          runId: "leader-run",
          parentRunId: "manager-run",
          kind: "leader",
          title: "Inspect temporary workspace",
          status: "running",
        },
      ],
    ]),
  };
  const t = await mount(activity({}), { width: 44, workflow: () => workflow });
  const rows = t.captureCharFrame().split("\n");
  const header = rows.find((row) => row.includes("Parallel work"));
  expect(header).toContain("0/1 finished");
  expect(header).toContain("1 running");
  expect(rows.filter((row) => row.includes("L1")).length).toBe(1);
  expect(rows.join(" ")).not.toContain("Running");
  expect(rows.some((row) => row.trim() === "s")).toBe(false);
  t.renderer.destroy();
});

test("workflow leaders reuse plan glyphs and an isolated bounded scroll", async () => {
  const statuses = ["running", "ok", "error", "cancelled"] as const;
  const leaders = Array.from({ length: WORKFLOW_SIDEBAR_ROW_LIMIT + 8 }, (_, index) => ({
    runId: `leader-${index}`,
    parentRunId: "manager-run",
    kind: "leader" as const,
    title: `Leader ${index + 1}`,
    status: statuses[index % statuses.length]!,
    startedAt: index,
    endedAt: index + 10,
    iterations: index + 1,
  }));
  const workflow: WorkflowActivity = {
    root: "manager-run",
    nodes: new Map<string, WorkflowNodeActivity>([
      [
        "manager-run",
        { runId: "manager-run", kind: "manager", title: "Manager", status: "running" },
      ],
      ...leaders.map((leader) => [leader.runId, leader] as const),
    ]),
  };
  const t = await mount(activity({}), { width: 44, workflow: () => workflow });
  const frame = t.captureCharFrame();
  const spans = t.captureSpans();
  const scroll = t.renderer.root.findDescendantById("sidebar-workflow-scroll");
  expect(scroll).toBeDefined();
  expect(scroll!.height).toBeLessThanOrEqual(WORKFLOW_SIDEBAR_ROW_LIMIT);
  expect(frame).toContain(`${taskTone("in_progress").glyph} L1`);
  expect(frame).toContain(`${taskTone("done").glyph} L2`);
  expect(frame).toContain(`${taskTone("failed").glyph} L3`);
  expect(frame).toContain(`${taskTone("abandoned").glyph} L4`);
  expect(frame).not.toContain("iterations");
  expect(fgOf(spans, taskTone("failed").glyph)).toBe(taskTone("failed").fg.toLowerCase());
  expect(frame.indexOf("L1")).toBeLessThan(frame.indexOf("L2"));
  expect(frame.indexOf("L2")).toBeLessThan(frame.indexOf("L3"));
  expect(frame.indexOf("L3")).toBeLessThan(frame.indexOf("L4"));
  t.renderer.destroy();
});

test("an idle round checkpoint remains visible below compact workflow progress", async () => {
  const workflow: WorkflowActivity = {
    root: "manager-run",
    nodes: new Map([
      [
        "manager-run",
        { runId: "manager-run", kind: "manager", title: "Manager", status: "running" },
      ],
    ]),
    sequence: {
      sessionId: "wfseq-1",
      status: "awaiting_manager",
      revision: 2,
      roundId: "review",
      pass: 0,
      nextRoundId: "verify",
      nextPass: 0,
      leadersStarted: 4,
      maxTotalLeaders: 32,
    },
  };
  const t = await mount(activity({}), { width: 38, workflow: () => workflow });
  const out = t.captureCharFrame();
  expect(out).toContain("0/0 finished");
  expect(out).toContain("Checkpoint r2: next verify");
  t.renderer.destroy();
});

test("workflow leaders and sub-agents use separate run-local handle namespaces", async () => {
  const workflowOf = (suffix: string): WorkflowActivity => ({
    root: `manager-${suffix}`,
    nodes: new Map([
      [
        `manager-${suffix}`,
        {
          runId: `manager-${suffix}`,
          kind: "manager",
          title: `Manager ${suffix}`,
          status: "running",
        },
      ],
      [
        `leader-${suffix}`,
        {
          runId: `leader-${suffix}`,
          parentRunId: `manager-${suffix}`,
          kind: "leader",
          title: `Leader ${suffix}`,
          status: "running",
        },
      ],
    ]),
  });
  const a = activity({
    subagents: [
      { id: "agent-first", order: 0, status: "running", title: "Agent first", input: 0, output: 0 },
    ] as ActivityStore["subagents"],
  });
  const [workflow, setWorkflow] = createSignal<WorkflowActivity | null>(workflowOf("first"));
  const t = await mount(a, { width: 36, workflow });

  let rows = t.captureCharFrame().split("\n");
  expect(rows.some((row) => row.includes("L1") && row.includes("Leader first"))).toBe(true);
  expect(rows.some((row) => row.includes("A1") && row.includes("Agent first"))).toBe(true);
  expect(rows.some((row) => row.includes("A2") && row.includes("Agent first"))).toBe(false);

  a.subagents = [
    { id: "agent-next", order: 0, status: "running", title: "Agent next", input: 0, output: 0 },
  ] as ActivityStore["subagents"];
  setWorkflow(workflowOf("next"));
  await t.renderOnce();
  await t.renderOnce();

  rows = t.captureCharFrame().split("\n");
  expect(rows.some((row) => row.includes("L1") && row.includes("Leader next"))).toBe(true);
  expect(rows.some((row) => row.includes("A1") && row.includes("Agent next"))).toBe(true);
  expect(rows.join(" ")).not.toContain("Leader first");
  expect(rows.join(" ")).not.toContain("Agent first");
  t.renderer.destroy();
});

test("the selected sub-agent's textual cursor follows the native id", async () => {
  const a = activity({
    subagents: [
      { id: "scout-id", order: 0, status: "running", title: "Worker", input: 0, output: 0 },
      { id: "fixer-id", order: 1, status: "running", title: "Worker", input: 0, output: 0 },
    ] as ActivityStore["subagents"],
  });
  const t = await mount(a, { selected: () => "fixer-id" });
  const rows = t.captureCharFrame().split("\n");
  const workerRows = rows.filter((r) => r.includes("Worker"));
  expect(workerRows.length).toBe(2);
  expect(workerRows[0]).toContain("A1");
  expect(workerRows[0]?.includes("> ")).toBe(false);
  expect(workerRows[1]).toContain("> ");
  expect(workerRows[1]).toContain("A2");
  t.renderer.destroy();
});

test("clicking a sub-agent row calls onSelectSubagent with that instance's id", async () => {
  const calls: string[] = [];
  const a = activity({
    subagents: [
      { id: "scout-id", order: 0, status: "running", title: "Scout", input: 0, output: 0 },
      { id: "fixer-id", order: 1, status: "running", title: "Fixer", input: 0, output: 0 },
    ] as ActivityStore["subagents"],
  });
  const t = await mount(a, { onSelectSubagent: (id) => calls.push(id) });
  const rows = t.captureCharFrame().split("\n");
  const scoutRow = rows.findIndex((r) => r.includes("Scout"));
  const fixerRow = rows.findIndex((r) => r.includes("Fixer"));
  expect(scoutRow).toBeGreaterThan(-1);
  expect(fixerRow).toBeGreaterThan(-1);

  await t.mockMouse.click(2, scoutRow);
  await t.renderOnce();
  expect(calls).toEqual(["scout-id"]);

  await t.mockMouse.click(2, fixerRow);
  await t.renderOnce();
  expect(calls).toEqual(["scout-id", "fixer-id"]);
  expect(t.renderer.hasSelection).toBe(false);
  t.renderer.destroy();
});

test("clicking a settled sub-agent selects its transcript without opening ActivityDetail", async () => {
  const selected: string[] = [];
  let detailsOpened = 0;
  const a = activity({
    subagents: [
      {
        id: "reviewer-id",
        order: 0,
        status: "done",
        title: "Review auth",
        summary: "Authentication review complete",
        input: 0,
        output: 0,
      },
    ] as ActivityStore["subagents"],
  });
  const t = await mount(a, {
    width: 44,
    onSelectSubagent: (id) => selected.push(id),
    onOpenDetail: () => (detailsOpened += 1),
  });
  const rows = t.captureCharFrame().split("\n");
  const agentRow = rows.findIndex((row) => row.includes("Review auth"));
  expect(agentRow).toBeGreaterThan(-1);
  expect(rows.join(" ")).not.toContain("Authentication review complete");
  expect(rows.join(" ")).not.toContain("click to read");

  await t.mockMouse.click(2, agentRow);
  await t.renderOnce();
  expect(selected).toEqual(["reviewer-id"]);
  expect(detailsOpened).toBe(0);
  t.renderer.destroy();
});

test("the selected glyph and title remain one click target", async () => {
  const calls: string[] = [];
  const a = activity({
    subagents: [
      {
        id: "scout-id",
        order: 0,
        status: "running",
        title: "Scout",
        model: "z-ai/glm-5.2",
        input: 12_000,
        output: 34_000,
      },
    ] as ActivityStore["subagents"],
  });
  const t = await mount(a, {
    selected: () => "scout-id",
    onSelectSubagent: (id) => calls.push(id),
  });
  const rows = t.captureCharFrame().split("\n");
  const titleRow = rows.findIndex((r) => r.includes("Scout"));
  expect(titleRow).toBeGreaterThan(-1);
  expect(rows.some((r) => r.includes("Running"))).toBe(false);

  await t.mockMouse.click(2, titleRow);
  await t.renderOnce();
  expect(calls).toEqual(["scout-id"]);
  t.renderer.destroy();
});

test("the selected sub-agent keeps profile and terminal failure copy out of the roster", async () => {
  const a = activity({
    subagents: [
      {
        id: "reviewer-id",
        order: 0,
        status: "error",
        title: "Review auth",
        profile: "security-reviewer",
        model: "deepseek/deepseek-chat-v3-0324",
        summary: "Typecheck failed in the authentication adapter",
        input: 0,
        output: 0,
      },
    ] as ActivityStore["subagents"],
  });
  const rows = await frame(a, 44);
  expect(rows.join(" ")).not.toContain("security-reviewer");

  const selected = await mount(a, { width: 44, selected: () => "reviewer-id" });
  const selectedFrame = selected.captureCharFrame();
  expect(selectedFrame).not.toContain("Agent Profile security-reviewer");
  expect(selectedFrame).not.toContain("Typecheck failed");
  expect(selectedFrame).not.toContain("failed");
  selected.renderer.destroy();
});

test("the agent roster owns a bounded scroll and follows the selected worker", async () => {
  const agents = Array.from({ length: AGENT_SIDEBAR_ROW_LIMIT + 8 }, (_, index) => ({
    id: `agent-${index}`,
    order: index,
    status: index === 0 ? "running" : "done",
    title: `Worker ${index + 1}`,
    input: 0,
    output: 0,
  })) as ActivityStore["subagents"];
  const a = activity({ subagents: agents });
  const t = await mount(a, { width: 44, selected: () => "agent-23" });
  const rendered = t.captureCharFrame();
  expect(rendered).toContain("Worker 24");
  expect(rendered).not.toContain("Worker 1 ");
  t.renderer.destroy();
});

test("unscoped run context and token totals are absent from the sidebar", async () => {
  const a = activity({
    context: { used: 45_000, model: "m" },
    usage: { input: 940_000, output: 25_000 },
  });
  const rows = await frame(a);
  expect(rows.join("\n")).toContain("No run activity to");
  expect(rows.join("\n")).toContain("inspect");
  expect(rows.join("\n")).not.toContain("context");
  expect(rows.join("\n")).not.toContain("tokens");
});

test("plan section shows every task and highlights the current one", async () => {
  const a = activity({
    plan: {
      path: ".clarvis/plans/ui.md",
      title: "UI plan",
      status: "active",
      retention: "keep",
      revision: 3,
      spec_revision: 2,
      tasks: [{ title: "Update App.tsx with all seven features", status: "in_progress" }],
    } as ActivityStore["plan"],
  });
  const rows = await frame(a);
  const joined = rows.join(" ");
  expect(rows.some((r) => r.includes("Running") && r.includes("0/1 completed"))).toBe(true);
  expect(joined).toContain("Update");
  expect(joined).toContain("features");
  expect(joined).toContain("Running");
});

test("plan tasks render compactly in status priority order", async () => {
  const a = activity({
    plan: {
      path: ".clarvis/plans/hierarchy.md",
      title: "Hierarchy plan",
      status: "active",
      retention: "keep",
      revision: 1,
      spec_revision: 1,
      tasks: [
        { title: "Finished task", status: "done", result: "ready" },
        { title: "Failed task", status: "failed", error: "not ready" },
        { title: "Future task", status: "pending" },
        {
          title: "Current task",
          status: "in_progress",
          exit_condition: "Checks pass",
          assignee: "marshall",
        },
      ],
    } as ActivityStore["plan"],
  });
  const t = await mount(a, { width: 40 });
  const frame = t.captureCharFrame();
  const spans = t.captureSpans();
  const activeTitle = spans.lines
    .flatMap((line) => line.spans)
    .find((span) => span.text.includes("Current task"));
  const current = frame.indexOf("Current task");
  const future = frame.indexOf("Future task");
  const finished = frame.indexOf("Finished task");
  const failed = frame.indexOf("Failed task");
  expect(current).toBeGreaterThanOrEqual(0);
  expect(current).toBeLessThan(future);
  expect(future).toBeLessThan(finished);
  expect(finished).toBeLessThan(failed);
  expect(frame).toContain(`${glyph("chevronRight")} Current task`);
  expect(frame).toContain(`${taskTone("pending").glyph} Future task`);
  expect(frame).toContain(`${taskTone("done").glyph} Finished task`);
  expect(frame).toContain(`${taskTone("failed").glyph} Failed task`);
  expect(frame).not.toMatch(
    /(?:Done|Running|Next|Failed) {2}(?:Finished|Current|Future|Failed) task/,
  );
  expect(frame).not.toContain("marshall");
  expect(frame).not.toContain("Exit");
  expect(frame).not.toContain("Checks pass");
  expect(frame).not.toContain("Last result");
  expect(frame).toContain("[Ctrl+X P]");
  expect(fgOf(spans, "Hierarchy plan")).toBe(tokens.accent2.toLowerCase());
  expect(rgbToHex(activeTitle!.bg).toLowerCase()).toBe(selectionBg().toLowerCase());
  t.renderer.destroy();
});

test("plan section keeps the full task list visible without review detail", async () => {
  const a = activity({
    plan: {
      path: ".clarvis/plans/build.md",
      title: "Build plan",
      status: "active",
      retention: "discard",
      revision: 1,
      spec_revision: 1,
      reviewOutcome: "approved",
      tasks: [
        { title: "Init the repo", status: "done" },
        { title: "Wire the toolchain", status: "done" },
        { title: "Implement the feature", status: "in_progress" },
      ],
    } as ActivityStore["plan"],
  });
  const rows = await frame(a, 44);
  const joined = rows.join(" ");
  expect(joined).toContain("[Ctrl+X P] full plan");
  expect(rows.some((r) => r.includes("Running") && r.includes("2/3 completed"))).toBe(true);
  expect(joined).toContain("Init the repo");
  expect(joined).toContain("Implement the");
  expect(joined).not.toContain("review: approved");
  expect(joined).not.toContain("validation");
});

test("plan section: with nothing running, the next pending task remains visible", async () => {
  const a = activity({
    plan: {
      path: ".clarvis/plans/docs.md",
      title: "Docs plan",
      status: "active",
      retention: "keep",
      revision: 1,
      spec_revision: 1,
      tasks: [
        { title: "Ship it", status: "done" },
        { title: "Document it", status: "pending" },
      ],
    } as ActivityStore["plan"],
  });
  const rows = await frame(a);
  expect(rows.join(" ")).toContain("Document");
});

test("a long plan scrolls the current task into view and keeps full-plan navigation visible", async () => {
  const tasks = Array.from({ length: 20 }, (_, index) => ({
    id: `task-${index + 1}`,
    title: `Plan task ${index + 1}`,
    status: index < 18 ? "done" : index === 18 ? "in_progress" : "pending",
    ...(index === 18 ? { exit_condition: "The focused task is visible" } : {}),
  }));
  const a = activity({
    plan: {
      id: "long-plan",
      title: "Long plan",
      status: "active",
      retention: "keep",
      revision: 2,
      spec_revision: 1,
      tasks,
    },
  });
  const rows = await frame(a, 40);
  const joined = rows.join(" ");
  expect(joined).toContain("Plan task 19");
  expect(joined).not.toContain("The focused task is visible");
  expect(joined).not.toContain("Exit");
  expect(joined).toContain("[Ctrl+X P]");
});

test("a completed plan does not leave its final task looking active", async () => {
  const a = activity({
    plan: {
      id: "complete",
      title: "Complete plan",
      status: "completed",
      retention: "keep",
      revision: 1,
      spec_revision: 1,
      tasks: [{ id: "one", title: "Shipped task", status: "done" }],
    },
  });
  const rows = await frame(a, 36);
  expect(rows.join("\n")).toContain("Shipped task");
  expect(rows.join("\n")).not.toContain("› Shipped task");
});

test("an active projection with every task done renders as completed without an active row", async () => {
  const a = activity({
    plan: {
      id: "settling",
      title: "Settling plan",
      status: "active",
      retention: "keep",
      revision: 3,
      spec_revision: 1,
      tasks: [
        { id: "one", title: "First task", status: "done" },
        { id: "two", title: "Final task", status: "done" },
      ],
    },
  });
  const rows = await frame(a, 44);
  const joined = rows.join("\n");
  expect(joined.replace(/[│\s]+/gu, " ")).toContain(
    "Completed · 2/2 completed [Ctrl+X P] full plan",
  );
  expect(joined).not.toContain("Running");
  expect(joined).not.toContain("› Final task");
});

test("a live plan transition updates the already-mounted sidebar task list", async () => {
  const live = createActivityStore();
  const sink = live.openRun();
  applyEvent(sink, runEvent({ type: "run_started", at: 1 }), "live");
  applyEvent(
    sink,
    runEvent({
      type: "plan_created",
      at: 2,
      id: "reactive-plan",
      title: "Reactive plan",
      status: "active",
      retention: "keep",
      revision: 1,
      spec_revision: 1,
      tasks: [
        { id: "t1", title: "First task", status: "in_progress" },
        { id: "t2", title: "Second task", status: "pending" },
      ],
    }),
    "live",
  );
  const t = await mount(live, { width: 36 });
  expect(t.captureCharFrame()).toContain("First task");

  applyEvent(
    sink,
    runEvent({
      type: "plan_updated",
      change: "task",
      at: 3,
      id: "reactive-plan",
      title: "Reactive plan",
      status: "active",
      retention: "keep",
      revision: 2,
      spec_revision: 1,
      tasks: [
        { id: "t1", title: "First task", status: "done", result: "finished" },
        { id: "t2", title: "Second task", status: "in_progress" },
      ],
    }),
    "live",
  );
  for (let i = 0; i < 3; i++) await t.renderOnce();
  const updated = t.captureCharFrame();
  expect(updated).toContain("1/2 completed");
  expect(updated).toContain("Second task");
  expect(updated).toContain("[Ctrl+X P]");
  expect(updated).not.toContain("Last result");
  expect(updated).not.toContain("finished");
  t.renderer.destroy();
});

test("a removed active plan becomes an explicit unavailable state, not stale progress", async () => {
  const unavailable = activity({
    plan: {
      id: "missing-plan",
      title: "Missing plan",
      status: "active",
      retention: "keep",
      revision: 2,
      spec_revision: 1,
      removed: true,
      tasks: [{ id: "t1", title: "Historical task", status: "in_progress" }],
    },
  });
  const rows = await frame(unavailable, 40);
  const joined = rows.join(" ");
  expect(joined).toContain("plan file unavailable");
  expect(joined).toContain("Restore the plan file or create a");
  expect(joined).toContain("replacement");
  expect(joined).not.toContain("Running");
  expect(joined).not.toContain("[Ctrl+X P] full plan");
});

test("retention discard ends as completed history instead of a red unavailable warning", async () => {
  const live = createActivityStore();
  const sink = live.openRun();
  applyEvent(sink, runEvent({ type: "run_started", at: 1 }), "live");
  applyEvent(
    sink,
    runEvent({
      type: "plan_created",
      at: 2,
      id: "discarded-plan",
      path: ".clarvis/plans/discarded-plan.md",
      title: "Disposable plan",
      status: "active",
      retention: "discard",
      revision: 1,
      spec_revision: 1,
      tasks: [{ id: "t1", title: "Finish work", status: "in_progress" }],
    }),
    "live",
  );
  applyEvent(
    sink,
    runEvent({
      type: "plan_updated",
      change: "status",
      at: 3,
      id: "discarded-plan",
      path: ".clarvis/plans/discarded-plan.md",
      title: "Disposable plan",
      status: "completed",
      retention: "discard",
      revision: 2,
      spec_revision: 1,
      tasks: [{ id: "t1", title: "Finish work", status: "done", result: "finished" }],
    }),
    "live",
  );
  applyEvent(
    sink,
    runEvent({
      type: "plan_removed",
      at: 4,
      id: "discarded-plan",
      path: ".clarvis/plans/discarded-plan.md",
      revision: 2,
      spec_revision: 1,
    }),
    "live",
  );

  const t = await mount(live, { width: 40 });
  const joined = t.captureCharFrame().replace(/[│\s]+/g, " ");
  const spans = t.captureSpans();
  t.renderer.destroy();
  expect(joined).toContain("Completed");
  expect(joined).toContain("1/1 completed");
  expect(joined).toContain("history discarded");
  expect(joined).toContain("Plan deleted after success");
  expect(joined).not.toContain("Unavailable");
  expect(joined).not.toContain("plan file unavailable");
  expect(joined).not.toContain("Restore the plan file");
  expect(fgOf(spans, "Plan deleted after success")).toBe(tokens.muted.toLowerCase());
});

test("an orphan plan removal keeps an unavailable sidebar across continuation", async () => {
  const live = createActivityStore();
  const sink = live.openRun();
  applyEvent(sink, runEvent({ type: "run_started", at: 1 }), "live");
  applyEvent(
    sink,
    runEvent({
      type: "plan_removed",
      at: 2,
      id: "missing-plan",
      path: ".clarvis/plans/missing-plan.md",
      revision: 4,
      spec_revision: 2,
    }),
    "live",
  );

  const rows = await frame(live, 40);
  const joined = rows.join(" ");
  expect(joined).toContain("Plan unavailable");
  expect(joined).toContain("Unavailable");
  expect(joined).toContain("Restore the plan file");
});

test("a long plan mounts a bounded status-prioritized task window", async () => {
  const tasks = Array.from({ length: 50 }, (_, index) => ({
    id: `t${index + 1}`,
    title: `Task ${index + 1}`,
    status: index < 29 ? "done" : index === 29 ? "in_progress" : "pending",
  }));
  const plan = {
    id: "long-plan",
    title: "Long plan",
    status: "active" as const,
    retention: "keep" as const,
    revision: 30,
    spec_revision: 1,
    tasks,
  };
  const window = planTaskWindow(plan);
  expect(window.entries).toHaveLength(PLAN_SIDEBAR_TASK_LIMIT);
  expect(window.entries[0]?.task.id).toBe("t30");
  expect(window.entries.slice(1).every((entry) => entry.task.status === "pending")).toBe(true);
  expect(window.hiddenBefore).toBe(0);
  expect(window.hiddenAfter).toBeGreaterThan(0);

  const rows = await frame(activity({ plan }), 44);
  const joined = rows.join(" ");
  expect(joined).toContain("Task 30");
  expect(joined).toContain("later tasks");
  expect(joined).not.toContain("earlier tasks");
  expect(joined).not.toContain("Task 1 ");
});

test("pathless plan section renders its title once and never an implementation id", async () => {
  const rows = await frame(
    activity({
      plan: {
        id: "remote-plan-42",
        title: "Remote rollout",
        status: "active",
        retention: "keep",
        revision: 1,
        spec_revision: 1,
        tasks: [],
      },
    }),
  );
  expect(rows.some((row) => row.includes("Remote rollout"))).toBe(true);
  expect(rows.some((row) => row.includes("remote-plan-42"))).toBe(false);
  expect(rows.join("\n")).not.toContain("undefined");
});

test("plan section omits terminal outcome detail without hiding the next task", async () => {
  const a = activity({
    plan: {
      path: ".clarvis/plans/judge.md",
      title: "Judge plan",
      status: "active",
      retention: "keep",
      revision: 5,
      spec_revision: 2,
      tasks: [
        { title: "Wire it", status: "returned", result: "adapter wired" },
        { title: "Verify it", status: "pending" },
      ],
    } as ActivityStore["plan"],
  });
  const rows = await frame(a, 40);
  expect(rows.join("\n")).toContain("Wire it");
  expect(rows.join("\n")).toContain("Verify it");
  expect(rows.join("\n")).toContain("[Ctrl+X P]");
  expect(rows.join("\n")).not.toContain("Last result");
  expect(rows.join("\n")).not.toContain("adapter wired");
});
