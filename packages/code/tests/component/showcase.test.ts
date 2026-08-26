import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import type { PlanProjection, RunEvent } from "@clarvis/protocol";
import { applyRunEvents, runEvent } from "../helpers/run-events.ts";
import {
  createTranscriptStore,
  teeSink,
  type TranscriptNode,
  type TranscriptStore,
} from "../../src/adapters/store.ts";
import {
  ACTIVITY_SUBAGENT_SUMMARIES_MAX,
  ACTIVITY_SUBAGENT_SUMMARY_MAX_CHARS,
  createActivityStore,
} from "../../src/adapters/activity-store.ts";
import type { LegacyCollapsibleNode } from "../helpers/transcript-fixtures.ts";

const ev = runEvent;

/** The plan projection every plan event carries (the file is the authority; the
 * event ships enough for a remote client to render without reading it). */
const plan = (tasks: PlanProjection["tasks"]): PlanProjection => ({
  id: "audit-auth",
  path: ".clarvis/plans/2026-07-25T14-08-31-audit-auth.md",
  title: "Audit the auth flow",
  status: "active",
  retention: "discard",
  revision: 1,
  spec_revision: 1,
  tasks,
});

const STREAM: RunEvent[] = [
  ev({ type: "run_started", at: 1 }),
  ev({
    type: "plan_created",
    at: 2,
    ...plan([
      { id: "t1", title: "Explore auth", status: "pending" },
      { id: "t2", title: "Write report", status: "pending" },
    ]),
  }),
  ev({
    type: "delegation_created",
    at: 3,
    delegation_id: "w1",
    task_id: "t1",
    title: "explorer",
    task: "look at auth",
    profile: "researcher",
    tools: [],
  }),
  ev({
    type: "delegation_started",
    at: 4,
    delegation_id: "w1",
    task_id: "t1",
    model: "anthropic/claude-sonnet-4-5",
  }),
  ev({
    type: "iteration_completed",
    agent: "subagent",
    subagent_id: "w1",
    iteration: 1,
    at: 6,
    model: "anthropic/claude-sonnet-4-5",
    input_tokens: 800,
    output_tokens: 200,
    response: "auth uses JWT",
  }),
  ev({
    type: "plan_updated",
    at: 7,
    change: "task",
    ...plan([
      { id: "t1", title: "Explore auth", status: "done" },
      { id: "t2", title: "Write report", status: "pending" },
    ]),
    revision: 2,
  }),
  ev({
    type: "delegation_completed",
    at: 9,
    delegation_id: "w1",
    task_id: "t1",
    status: "completed",
    summary: "auth uses JWT",
  }),
  ev({ type: "run_ended", status: "completed", at: 10, reason: "completed" }),
];

function drive(stream: RunEvent[]): {
  nodes: TranscriptNode[];
  store: TranscriptStore;
  activity: ReturnType<typeof createActivityStore>;
} {
  return createRoot(() => {
    const store = createTranscriptStore();
    const activity = createActivityStore();
    const sink = teeSink(store.openRun("exec_1"), activity.openRun());
    applyRunEvents(sink, stream, "live");
    return { nodes: store.nodes, store, activity };
  });
}

test("activity store: the subagent roster reflects spawn → started → iteration tokens → completed", () => {
  const { activity } = drive(STREAM);
  expect(activity.subagents).toHaveLength(1);
  expect(activity.subagents[0]).toMatchObject({
    id: "w1",
    title: "explorer",
    profile: "researcher",
    model: "anthropic/claude-sonnet-4-5",
    status: "done",
    summary: "auth uses JWT",
    input: 800,
    output: 200,
  });
});

test("activity store: does not duplicate delegated briefs and bounds its terminal-summary window", () => {
  createRoot((dispose) => {
    const activity = createActivityStore();
    const sink = activity.openRun();
    applyRunEvents(sink, [ev({ type: "run_started", at: 1 })], "live");
    applyRunEvents(
      sink,
      [
        ev({
          type: "delegation_created",
          delegation_id: "brief",
          at: 2,
          title: "large brief",
          task: "x".repeat(100_000),
          tools: [],
        }),
      ],
      "live",
    );
    expect("task" in activity.subagents[0]!).toBe(false);

    for (let index = 0; index <= ACTIVITY_SUBAGENT_SUMMARIES_MAX; index += 1) {
      applyRunEvents(
        sink,
        [
          ev({
            type: "delegation_failed",
            delegation_id: `summary-${String(index)}`,
            at: 3 + index,
            status: "error",
            summary: "s".repeat(ACTIVITY_SUBAGENT_SUMMARY_MAX_CHARS + 1),
          }),
        ],
        "live",
      );
    }

    const firstSummary = activity.subagents.find((entry) => entry.id === "summary-0")?.summary;
    const lastSummary = activity.subagents.at(-1)?.summary;
    expect(firstSummary).toBeUndefined();
    expect(lastSummary).toHaveLength(ACTIVITY_SUBAGENT_SUMMARY_MAX_CHARS);
    expect(lastSummary?.endsWith("...[display truncated]")).toBe(true);
    dispose();
  });
});

test("activity store: an out-of-order terminal subagent event still leaves a stable failure row", () => {
  const { activity } = drive([
    ev({ type: "run_started", at: 1 }),
    ev({
      type: "delegation_failed",
      at: 9,
      delegation_id: "late-worker",
      task_id: "task-late",
      status: "error",
      summary: "worker transport failed before its creation event arrived",
    }),
  ]);

  expect(activity.subagents).toHaveLength(1);
  expect(activity.subagents[0]).toMatchObject({
    id: "late-worker",
    title: "subagent",
    status: "error",
    endedAt: 9,
    summary: "worker transport failed before its creation event arrived",
    input: 0,
    output: 0,
  });
});

test("activity store: the plan tracks the file's identity and per-task status changes", () => {
  const { activity } = drive(STREAM);
  expect(activity.plan?.path).toBe(".clarvis/plans/2026-07-25T14-08-31-audit-auth.md");
  expect(activity.plan?.title).toBe("Audit the auth flow");
  expect(activity.plan?.retention).toBe("discard");
  expect(activity.plan?.revision).toBe(2);
  const tasks = activity.plan!.tasks;
  expect(tasks.find((t) => t.id === "t1")!.status).toBe("done");
  expect(tasks.find((t) => t.id === "t2")!.status).toBe("pending");
});

test("activity store: the token total sums per-iteration tokens and ignores the per-agent budget_check snap", () => {
  const { activity } = drive(STREAM);
  expect(activity.usage).toEqual({ input: 800, output: 200 });
  expect(activity.context).toBeNull();
});

test("activity store: the token total sums lead + subagent and the context bar tracks only the lead", () => {
  const { activity } = drive([
    ev({ type: "run_started", at: 1 }),
    ev({
      type: "iteration_completed",
      agent: "lead",
      iteration: 1,
      at: 3,
      model: "m",
      input_tokens: 5000,
      output_tokens: 1000,
      response: "",
    }),
    ev({
      type: "delegation_created",
      delegation_id: "w1",
      at: 4,
      title: "explorer",
      task: "",
      tools: [],
    }),
    ev({
      type: "iteration_completed",
      agent: "subagent",
      subagent_id: "w1",
      iteration: 1,
      at: 6,
      model: "m",
      input_tokens: 3000,
      output_tokens: 500,
      response: "",
    }),
    ev({
      type: "soft_limit_check",
      at: 7,
      dimension: "tokens",
      used: 9500,
      limit: 150000,
      outcome: "continued",
    }),
    ev({ type: "run_ended", status: "completed", at: 8, reason: "completed" }),
  ]);
  expect(activity.usage).toEqual({ input: 8000, output: 1500 });
  expect(activity.context!.used).toBe(5000);
});

test("activity store: the token total accumulates lead tokens with no budget event at all", () => {
  const { activity } = drive([
    ev({ type: "run_started", at: 1 }),
    ev({
      type: "iteration_completed",
      agent: "lead",
      iteration: 1,
      at: 3,
      model: "m",
      input_tokens: 2000,
      output_tokens: 400,
      response: "",
    }),
    ev({
      type: "iteration_completed",
      agent: "lead",
      iteration: 2,
      at: 5,
      model: "m",
      input_tokens: 1000,
      output_tokens: 100,
      response: "",
    }),
    ev({ type: "run_ended", status: "completed", at: 6, reason: "completed" }),
  ]);
  expect(activity.usage).toEqual({ input: 3000, output: 500 });
  expect(activity.context!.used).toBe(1000);
});

test("transcript: a subagent card, a plan block, and subagent-attributed assistant text all render", () => {
  const { nodes, store } = drive(STREAM);
  const subagent = nodes.find((n) => n.kind === "subagent");
  expect(subagent).toMatchObject({ title: "explorer", status: "ok" });
  expect(store.defaultFolded(subagent!.key)).toBe(true);
  const plan = nodes.find((n) => n.kind === "plan");
  expect(plan?.tasks?.find((t) => t.id === "t1")?.status).toBe("done");
  const msg = nodes.find((n) => n.kind === "assistant" && n.text === "auth uses JWT");
  expect(msg?.agentLabel).toBe("explorer");
});

test("transcript: a model_error becomes an error block; compaction/soft-limit become annotations", () => {
  const { nodes } = drive([
    ev({ type: "run_started", at: 1 }),
    ev({
      type: "model_error",
      agent: "lead",
      iteration: 1,
      at: 2,
      model: "m",
      kind: "server_error",
      message: "503 upstream",
    }),
    ev({
      type: "compaction",
      agent: "lead",
      operation: "summarization",
      at: 3,
      freed_chars: 12000,
    }),
    ev({
      type: "soft_limit_check",
      at: 4,
      dimension: "tokens",
      used: 90,
      limit: 100,
      outcome: "continued",
    }),
    ev({ type: "run_ended", status: "completed", at: 5, reason: "completed" }),
  ]);
  const err = nodes.find((n) => n.kind === "error");
  expect(err?.text).toContain("503 upstream");
  const annotations = nodes.filter((n) => n.kind === "annotation");
  expect(annotations.some((n) => n.text.includes("compaction") && n.tone === "info")).toBe(true);
  expect(annotations.some((n) => n.text.includes("soft tokens 90/100") && n.tone === "warn")).toBe(
    true,
  );
});

test("transcript: finished and errored tool calls auto-collapse", () => {
  const { nodes, store } = drive([
    ev({ type: "run_started", at: 1 }),
    ev({
      type: "tool_call",
      call_id: "c1",
      agent: "lead",
      at: 2,
      server: "clarvis",
      tool: "read_file",
      arguments: { path: "a.ts" },
      result: "     1\tconst a = 1",
      ok: true,
    }),
    ev({
      type: "tool_call",
      ok: false,
      call_id: "c2",
      agent: "lead",
      at: 3,
      server: "clarvis",
      tool: "shell",
      arguments: { command: "false" },
      result: "",
      error: "boom",
    }),
    ev({ type: "run_ended", status: "completed", at: 4, reason: "completed" }),
  ]);
  const done = nodes.find((n) => n.kind === "tool_call" && n.toolName === "read_file");
  expect(done?.status).toBe("ok");
  expect(store.defaultFolded(done!.key)).toBe(true);
  const failed = nodes.find((n) => n.kind === "tool_call" && n.toolName === "shell");
  expect(failed?.status).toBe("error");
  expect(store.defaultFolded(failed!.key)).toBe(true);
});

test("transcript: steering_applied renders as an inline steer annotation", () => {
  const { nodes } = drive([
    ev({ type: "run_started", at: 1 }),
    ev({
      type: "steering_applied",
      agent: "lead",
      at: 2,
      message: "actually, prefer the async API",
    }),
    ev({ type: "run_ended", status: "completed", at: 3, reason: "completed" }),
  ]);
  const steer = nodes.find(
    (n): n is Extract<TranscriptNode, { kind: "annotation" }> =>
      n.kind === "annotation" && n.text.startsWith("Steer delivered"),
  );
  expect(steer?.text).toContain("prefer the async API");
  expect(steer?.tone).toBe("accent");
});

test("transcript: a queued steer becomes delivered in place and stays singular after replay", () => {
  createRoot((dispose) => {
    const store = createTranscriptStore();
    const sink = store.openRun("exec_1");
    applyRunEvents(sink, [ev({ type: "run_started", at: 1 })], "live");

    const rollback = sink.queueSteer!("prefer the async API");
    expect(store.nodes.filter((node) => node.kind === "annotation")).toHaveLength(1);
    expect(store.nodes[0]!.text).toContain("Steer queued");

    const applied = ev({
      type: "steering_applied",
      agent: "lead",
      at: 2,
      message: "prefer the async API",
    });
    applyRunEvents(sink, [applied], "live");
    rollback();

    let steers = store.nodes.filter(
      (node) => node.kind === "annotation" && node.text.includes("prefer the async API"),
    );
    expect(steers).toHaveLength(1);
    expect(steers[0]!.text).toContain("Steer delivered");

    sink.beginReconcile();
    applyRunEvents(sink, [ev({ type: "run_started", at: 1 }), applied], "replay");
    sink.endReconcile();
    steers = store.nodes.filter(
      (node) => node.kind === "annotation" && node.text.includes("prefer the async API"),
    );
    expect(steers).toHaveLength(1);
    expect(steers[0]!.text).toContain("Steer delivered");
    dispose();
  });
});

test("transcript: a steer the run never applied settles instead of reading queued forever", () => {
  createRoot((dispose) => {
    const store = createTranscriptStore();
    const sink = store.openRun("exec_1");
    applyRunEvents(sink, [ev({ type: "run_started", at: 1 })], "live");

    sink.queueSteer!("prefer the async API");
    expect(store.nodes[0]!.text).toContain("Steer queued");
    expect(store.nodes[0]!.status).toBe("pending");

    // The run ends without a `steering_applied` ever arriving — the kernel
    // accepted the steer, then had nowhere left to apply it.
    applyRunEvents(
      sink,
      [ev({ type: "run_ended", status: "cancelled", at: 2, reason: "cancelled" })],
      "live",
    );

    const steer = store.nodes.find(
      (node) => node.kind === "annotation" && node.text.includes("prefer the async API"),
    )!;
    expect(steer.text).toContain("Steer not delivered");
    expect(steer.status).not.toBe("pending");
    dispose();
  });
});

test("reset (run-end reconcile replay) rebuilds identically — no double subagents", () => {
  const { activity } = createRoot(() => {
    const activity = createActivityStore();
    const sink = activity.openRun();
    applyRunEvents(sink, STREAM, "live");
    sink.beginReconcile();
    applyRunEvents(sink, STREAM, "replay");
    sink.endReconcile();
    return { activity };
  });
  expect(activity.subagents).toHaveLength(1);
  expect(activity.subagents[0]!.output).toBe(200);
});

test("activity: run-end trace replay keeps the live-only plan in the sidebar", () => {
  const { activity } = createRoot(() => {
    const activity = createActivityStore();
    const sink = activity.openRun();
    applyRunEvents(sink, STREAM, "live");
    sink.beginReconcile();
    applyRunEvents(
      sink,
      STREAM.filter(
        (event) =>
          event.type !== "plan_created" &&
          event.type !== "plan_updated" &&
          event.type !== "plan_removed" &&
          event.type !== "plan_review_requested" &&
          event.type !== "plan_review_resolved",
      ),
      "replay",
    );
    sink.endReconcile();
    return { activity };
  });

  expect(activity.plan?.id).toBe("audit-auth");
  expect(activity.plan?.tasks).toEqual([
    { id: "t1", title: "Explore auth", status: "done" },
    { id: "t2", title: "Write report", status: "pending" },
  ]);
});

test("transcript: a subagent that errored stays failed at run end even when the run completes", () => {
  const { nodes } = drive([
    ev({ type: "run_started", at: 1 }),
    ev({
      type: "delegation_created",
      delegation_id: "w1",
      at: 2,
      title: "explorer",
      task: "look",
      tools: [],
    }),
    ev({
      type: "iteration_started",
      agent: "subagent",
      subagent_id: "w1",
      iteration: 1,
      at: 3,
      model: "m",
    }),
    ev({
      type: "model_error",
      agent: "subagent",
      subagent_id: "w1",
      iteration: 1,
      at: 4,
      model: "m",
      kind: "server_error",
      message: "HTTP 404",
    }),
    ev({ type: "run_ended", status: "completed", at: 5, reason: "completed" }),
  ]);
  const subagent = nodes.find((n) => n.kind === "subagent");
  expect(subagent?.status).toBe("error");
  expect((subagent as LegacyCollapsibleNode | undefined)?.collapsed).not.toBe(true);
});

test("transcript: a lead iteration_started shows a live thinking placeholder", () => {
  const { nodes } = drive([
    ev({ type: "run_started", at: 1 }),
    ev({ type: "iteration_started", agent: "lead", iteration: 1, at: 2, model: "m" }),
  ]);
  const thinking = nodes.find((n) => n.kind === "thinking");
  expect(thinking).toMatchObject({ status: "running" });
  expect(thinking?.agentLabel).toBeUndefined();
});

test("transcript: the iteration end drops the 'thinking' placeholder and leaves the answer", () => {
  const { nodes } = drive([
    ev({ type: "run_started", at: 1 }),
    ev({ type: "iteration_started", agent: "lead", iteration: 1, at: 2, model: "m" }),
    ev({
      type: "iteration_completed",
      agent: "lead",
      iteration: 1,
      at: 3,
      model: "m",
      input_tokens: 10,
      output_tokens: 5,
      response: "here you go",
    }),
  ]);
  expect(nodes.find((n) => n.kind === "thinking")).toBeUndefined();
  expect(nodes.find((n) => n.kind === "assistant" && n.text === "here you go")).toBeTruthy();
});

test("transcript: a streamed reasoning delta supersedes the 'thinking' placeholder", () => {
  const { nodes } = drive([
    ev({ type: "run_started", at: 1 }),
    ev({ type: "iteration_started", agent: "lead", iteration: 1, at: 2, model: "m" }),
    ev({
      type: "reasoning",
      agent: "lead",
      iteration: 1,
      at: 3,
      model: "m",
      text: "let me look",
    }),
  ]);
  expect(nodes.find((n) => n.kind === "thinking")).toBeUndefined();
  expect(nodes.find((n) => n.kind === "reasoning")?.text).toBe("let me look");
});

test("transcript: a subagent's 'thinking' placeholder is attributed to the subagent title", () => {
  const { nodes } = drive([
    ev({ type: "run_started", at: 1 }),
    ev({
      type: "delegation_created",
      delegation_id: "w1",
      at: 2,
      title: "explorer",
      task: "look",
      tools: [],
    }),
    ev({
      type: "iteration_started",
      agent: "subagent",
      subagent_id: "w1",
      iteration: 1,
      at: 3,
      model: "m",
    }),
  ]);
  expect(nodes.find((n) => n.kind === "thinking")?.agentLabel).toBe("explorer");
});

test("transcript: run_ended sweeps a 'thinking' placeholder left by a cancelled iteration", () => {
  const { nodes } = drive([
    ev({ type: "run_started", at: 1 }),
    ev({ type: "iteration_started", agent: "lead", iteration: 1, at: 2, model: "m" }),
    ev({ type: "run_ended", status: "cancelled", at: 3, reason: "cancelled" }),
  ]);
  expect(nodes.find((n) => n.kind === "thinking")).toBeUndefined();
  expect(nodes.find((n) => n.kind === "run" && n.reason === "cancelled")).toBeTruthy();
});

test("activity store: a new run clears the previous run's subagent roster (no stale spinner)", () => {
  createRoot((dispose) => {
    const activity = createActivityStore();
    const s1 = activity.openRun();
    applyRunEvents(s1, [ev({ type: "run_started", at: 1 })], "live");
    applyRunEvents(
      s1,
      [
        ev({
          type: "delegation_created",
          delegation_id: "w1",
          at: 2,
          title: "old",
          task: "",
          tools: [],
        }),
      ],
      "live",
    );
    applyRunEvents(
      s1,
      [ev({ type: "delegation_started", delegation_id: "w1", at: 3, model: "m" })],
      "live",
    );
    expect(activity.subagents).toHaveLength(1);
    const s2 = activity.openRun();
    applyRunEvents(s2, [ev({ type: "run_started", at: 10 })], "live");
    expect(activity.subagents).toHaveLength(0);
    dispose();
  });
});

test("transcript: a subagent-attributed block never shows the raw instance id (falls back to 'subagent')", () => {
  const { nodes } = drive([
    ev({ type: "run_started", at: 1 }),
    ev({
      type: "iteration_completed",
      agent: "subagent",
      subagent_id: "8f3c-uuid",
      iteration: 1,
      at: 3,
      model: "m",
      input_tokens: 1,
      output_tokens: 1,
      response: "done",
    }),
  ]);
  const msg = nodes.find((n) => n.kind === "assistant");
  expect(msg?.agentLabel).toBe("subagent");
});

test("activity store: delegation_created applies the real title even if delegation_started arrived first", () => {
  createRoot((dispose) => {
    const activity = createActivityStore();
    const s = activity.openRun();
    applyRunEvents(s, [ev({ type: "run_started", at: 1 })], "live");
    applyRunEvents(
      s,
      [ev({ type: "delegation_started", delegation_id: "uuid-1", at: 2, model: "m" })],
      "live",
    );
    expect(activity.subagents[0]?.title).toBe("subagent");
    applyRunEvents(
      s,
      [
        ev({
          type: "delegation_created",
          delegation_id: "uuid-1",
          at: 3,
          title: "explore auth",
          task: "t",
          tools: [],
        }),
      ],
      "live",
    );
    expect(activity.subagents[0]?.title).toBe("explore auth");
    dispose();
  });
});

test("activity store: delegation_started stamps startedAt from the protocol timestamp", () => {
  const { activity } = drive([
    ev({ type: "run_started", at: 1 }),
    ev({
      type: "delegation_created",
      delegation_id: "w1",
      at: 2,
      title: "explorer",
      task: "",
      tools: [],
    }),
    ev({ type: "delegation_started", delegation_id: "w1", at: 42, model: "m" }),
  ]);
  expect(activity.subagents[0]?.startedAt).toBe(42);
  expect(activity.subagents[0]?.status).toBe("running");
});
