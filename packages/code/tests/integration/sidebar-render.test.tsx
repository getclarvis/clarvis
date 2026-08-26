import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import { rgbToHex, type RGBA } from "@opentui/core";
import type { TestRendererSetup } from "@opentui/core/testing";
import { createMutable } from "solid-js/store";
import {
  PLAN_SIDEBAR_TASK_LIMIT,
  planTaskWindow,
  PlanStrip,
  rosterSummary,
  Sidebar,
  subagentProgress,
} from "../../src/views/Sidebar.tsx";
import { truncateEnd } from "../../src/views/truncate.ts";
import { createActivityStore, type ActivityStore } from "../../src/adapters/activity-store.ts";
import { applyEvent } from "../../src/adapters/store.ts";
import type { WorkflowActivity } from "../../src/adapters/workflow-projection.ts";
import { runEvent } from "../helpers/run-events.ts";
import { tokens } from "../../src/theme/tokens.ts";
import { selectionBg } from "../../src/theme/surfaces.ts";

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
    workflow?: () => WorkflowActivity | null;
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
          width={() => width}
          workflow={opts.workflow}
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

test("agent progress counts settled work and surfaces running/failure states in text", () => {
  expect(
    subagentProgress([{ status: "done" }, { status: "running" }, { status: "error" }]),
  ).toMatchObject({
    total: 3,
    settled: 2,
    running: 1,
    failed: 1,
    label: "2/3 finished · 1 running",
  });
});

test("agent rows keep stable ids and let essential titles wrap", async () => {
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
  expect(rows.join(" ")).toContain("verify typecheck");
  expect(rows.join(" ")).toContain("and the whole test suite");
  expect(rows.join(" ")).toContain("A1");
  expect(rows.join(" ")).toContain("Running");
  expect(rows.join(" ")).toContain("All transcripts");
  expect(rows.join(" ")).not.toContain("Activity: working");
  expect(rows.join(" ").match(/0\/1 finished/g)?.length).toBe(1);
  expect(rows.join(" ")).not.toContain("glm-5.2");
  expect(rows.join(" ")).not.toContain("26k");
});

test("parallel-work metadata stays on one line at the minimum inspector width", async () => {
  const workflow: WorkflowActivity = {
    root: "manager-run",
    nodes: new Map([
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
  const t = await mount(activity({}), { width: 32, workflow: () => workflow });
  const rows = t.captureCharFrame().split("\n");
  const header = rows.find((row) => row.includes("Parallel work"));
  expect(header).toContain("1 leader");
  expect(rows.some((row) => row.trim() === "s")).toBe(false);
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
  expect(workerRows[1]).toContain("> A2");
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

test("the selected title and status remain one click target without a redundant activity line", async () => {
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
  const statusRow = rows.findIndex((r) => r.includes("Running"));
  expect(statusRow).toBeGreaterThan(titleRow);
  expect(rows.some((r) => r.includes("Activity: working"))).toBe(false);

  await t.mockMouse.click(2, titleRow);
  await t.mockMouse.click(2, statusRow);
  await t.renderOnce();
  expect(calls).toEqual(["scout-id", "scout-id"]);
  t.renderer.destroy();
});

test("the selected sub-agent exposes its profile and bounded terminal failure summary", async () => {
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
  expect(selectedFrame).toContain("Profile security-reviewer");
  expect(selectedFrame.replace(/[│\s]+/g, " ")).toContain("Failed: Typecheck");
  selected.renderer.destroy();
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

test("plan hierarchy remains visible without relying on color alone", async () => {
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
        { title: "Current task", status: "in_progress", exit_condition: "Checks pass" },
        { title: "Future task", status: "pending" },
      ],
    } as ActivityStore["plan"],
  });
  const t = await mount(a, { width: 40 });
  const frame = t.captureCharFrame();
  const spans = t.captureSpans();
  const activeTitle = spans.lines
    .flatMap((line) => line.spans)
    .find((span) => span.text.includes("Current task"));
  expect(frame).toContain("Done  Finished task");
  expect(frame).toContain("Running  Current task");
  expect(frame).toContain("Next  Future task");
  expect(frame).toContain("Last result");
  expect(frame).toContain("Ctrl+P full plan");
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
  const rows = await frame(a);
  const joined = rows.join(" ");
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
  expect(joined).toMatch(/Exit\s+The focused task is visible/);
  expect(joined).toContain("Ctrl+P full plan");
});

test("the compact plan strip keeps current work visible when the split inspector is closed", async () => {
  const plan = {
    id: "compact-plan",
    title: "Compact plan",
    status: "active" as const,
    retention: "keep" as const,
    revision: 1,
    spec_revision: 1,
    tasks: [
      { id: "one", title: "Done task", status: "done" },
      { id: "two", title: "Current responsive task", status: "in_progress" },
    ],
  };
  let opens = 0;
  const t = await openRender(() => <PlanStrip plan={() => plan} onOpen={() => (opens += 1)} />, {
    width: 80,
    height: 4,
  });
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Plan 1/2 completed · Current responsive task");
  expect(frame).toContain("Ctrl+P");
  await t.mockMouse.click(5, 1);
  expect(opens).toBe(1);
  t.renderer.destroy();
});

test("a retained terminal plan stays openable and is labelled as the latest plan", async () => {
  const plan = {
    id: "completed-plan",
    title: "Completed plan",
    status: "completed" as const,
    retention: "keep" as const,
    revision: 3,
    spec_revision: 1,
    tasks: [{ id: "one", title: "Shipped task", status: "done" }],
  };
  let opens = 0;
  const t = await openRender(() => <PlanStrip plan={() => plan} onOpen={() => (opens += 1)} />, {
    width: 80,
    height: 4,
  });
  try {
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("Latest plan 1/1 completed");
    expect(frame).toContain("Completed");
    expect(frame).toContain("Ctrl+P");
    await t.mockMouse.click(5, 1);
    expect(opens).toBe(1);
  } finally {
    t.renderer.destroy();
  }
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
  expect(updated).toContain("Last result");
  expect(updated).toContain("finished");
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
  expect(joined).not.toContain("Ctrl+P full plan");
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
  expect(joined).toContain("Plan history deleted after success");
  expect(joined).not.toContain("Unavailable");
  expect(joined).not.toContain("plan file unavailable");
  expect(joined).not.toContain("Restore the plan file");
  expect(fgOf(spans, "Plan history deleted after success")).toBe(tokens.muted.toLowerCase());
});

test("the compact strip also presents an expected discard without an unavailable warning", async () => {
  const plan = {
    id: "discarded-plan",
    title: "Disposable plan",
    status: "completed" as const,
    retention: "discard" as const,
    revision: 2,
    spec_revision: 1,
    removed: true,
    tasks: [{ id: "t1", title: "Finish work", status: "done" }],
  };
  const t = await openRender(() => <PlanStrip plan={() => plan} />, { width: 80, height: 4 });
  await t.renderOnce();
  const out = t.captureCharFrame();
  t.renderer.destroy();
  expect(out).toContain("Plan completed history discarded");
  expect(out).not.toContain("unavailable");
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

test("a long plan mounts a bounded task window centered on current work", async () => {
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
  expect(window.entries.some((entry) => entry.task.id === "t30")).toBe(true);
  expect(window.hiddenBefore).toBeGreaterThan(0);
  expect(window.hiddenAfter).toBeGreaterThan(0);

  const rows = await frame(activity({ plan }), 44);
  const joined = rows.join(" ");
  expect(joined).toContain("Task 30");
  expect(joined).toContain("earlier tasks");
  expect(joined).toContain("later tasks");
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

test("plan section shows the most recent terminal outcome without hiding the next task", async () => {
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
  expect(rows.join("\n")).toContain("Last result");
  expect(rows.join("\n")).toContain("adapter wired");
  expect(rows.join("\n")).toContain("Verify it");
});
