import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import type { RunEvent } from "@clarvis/protocol";
import { createTranscriptStore, type TranscriptNode } from "../../src/adapters/store.ts";
import { applyRunEvent, runEvent } from "../helpers/run-events.ts";

const ev = runEvent;

const STORED: RunEvent[] = [
  ev({ type: "run_started", at: 0 }),
  ev({ type: "iteration_started", agent: "lead", iteration: 1, at: 1, model: "m" }),
  ev({
    type: "delegation_created",
    delegation_id: "w1",
    at: 1,
    title: "explorer",
    task: "look",
    tools: [],
  }),
  ev({
    type: "tool_call",
    agent: "lead",
    call_id: "c1",
    at: 2,
    server: "fs",
    tool: "grep",
    arguments: { pattern: "x" },
    result: "ok",
    ok: true,
  }),
  ev({
    type: "iteration_completed",
    agent: "lead",
    iteration: 1,
    at: 3,
    model: "m",
    input_tokens: 100,
    output_tokens: 20,
    response: "Hello, world!",
  }),
  ev({ type: "run_ended", status: "completed", at: 4, reason: "completed" }),
];

const LIVE: RunEvent[] = [
  STORED[0]!,
  STORED[1]!,
  STORED[2]!,
  STORED[3]!,
  ev({
    type: "text_delta",
    agent: "lead",
    iteration: 1,
    at: 2,
    model: "m",
    channel: "text",
    text: "Hello, ",
    reset: true,
  }),
  STORED[4]!,
  STORED[5]!,
];

function driver() {
  const store = createTranscriptStore();
  const sink = store.openRun("exec_1");
  return {
    store,
    sink,
    live: (stream: RunEvent[]) => {
      for (const e of stream) applyRunEvent(sink, e, "live");
    },
    reconcile: (stream: RunEvent[]) => {
      sink.beginReconcile();
      for (const e of stream) applyRunEvent(sink, e, "replay");
      sink.endReconcile();
    },
  };
}

const shape = (nodes: readonly TranscriptNode[]): unknown[] =>
  nodes.map((n) => ({
    ...n,
    startedAt: undefined,
    // A live cumulative reset intentionally bumps the renderer epoch; a trace
    // rebuilt from terminal events never saw that presentation-only history.
    ...(n.kind === "assistant" || n.kind === "reasoning" ? { textEpoch: undefined } : {}),
  }));

test("the end-of-run replay preserves node identity instead of remounting the run", () => {
  createRoot((dispose) => {
    const d = driver();
    d.live(LIVE);
    const before = new Map(d.store.nodes.map((n) => [n.key, n]));
    expect(before.size).toBeGreaterThan(3);

    d.reconcile(STORED);

    expect(d.store.nodes).toHaveLength(before.size);
    for (const n of d.store.nodes) {
      expect(before.has(n.key)).toBe(true);
      expect(n).toBe(before.get(n.key)!);
    }
    dispose();
  });
});

test("the reconciled transcript matches what a wipe-and-rebuild would have produced", () => {
  const reconciled = createRoot((dispose) => {
    const d = driver();
    d.live(LIVE);
    d.reconcile(STORED);
    const nodes = shape(d.store.nodes);
    dispose();
    return nodes;
  });

  const rebuilt = createRoot((dispose) => {
    const d = driver();
    d.live(STORED);
    const nodes = shape(d.store.nodes);
    dispose();
    return nodes;
  });

  expect(reconciled).toEqual(rebuilt);
});

test("a live-only stream node the stored trace never produced is dropped", () => {
  createRoot((dispose) => {
    const d = driver();
    d.live([
      ...LIVE,
      ev({ type: "iteration_started", agent: "lead", iteration: 2, at: 4, model: "m" }),
      ev({
        type: "text_delta",
        agent: "lead",
        iteration: 2,
        at: 4,
        model: "m",
        channel: "text",
        text: "partial from a lost attempt",
        reset: true,
      }),
    ]);
    expect(d.store.nodes.some((n) => n.text.includes("lost attempt"))).toBe(true);

    d.reconcile(STORED);

    expect(d.store.nodes.some((n) => n.text.includes("lost attempt"))).toBe(false);
    expect(d.store.nodes.find((n) => n.kind === "assistant")!.text).toBe("Hello, world!");
    dispose();
  });
});

test("the end-of-run replay preserves the live-only plan projection", () => {
  createRoot((dispose) => {
    const d = driver();
    const created = ev({
      type: "plan_created",
      at: 2,
      id: "plan-1",
      path: ".clarvis/plans/plan-1.md",
      title: "Ship the TUI",
      status: "active",
      retention: "keep",
      revision: 1,
      spec_revision: 1,
      tasks: [{ id: "t1", title: "Keep the plan visible", status: "in_progress" }],
    });
    d.live([STORED[0]!, created, ...STORED.slice(1)]);

    const before = d.store.nodes.find((node) => node.kind === "plan");
    expect(before?.tasks?.[0]?.status).toBe("in_progress");

    d.reconcile(STORED);

    const after = d.store.nodes.find((node) => node.kind === "plan");
    expect(after).toBe(before);
    expect(after?.tasks?.[0]?.status).toBe("in_progress");
    expect(d.store.nodes.indexOf(after!)).toBeLessThan(
      d.store.nodes.findIndex((node) => node.kind === "tool_call"),
    );
    dispose();
  });
});

test("the end-of-run replay does not double the reasoning text", () => {
  createRoot((dispose) => {
    const d = driver();
    const stream: RunEvent[] = [
      ev({ type: "run_started", at: 0 }),
      ev({ type: "iteration_started", agent: "lead", iteration: 1, at: 1, model: "m" }),
      ev({
        type: "reasoning",
        agent: "lead",
        iteration: 1,
        at: 2,
        model: "m",
        text: "I should read the tests first.",
      }),
      ev({
        type: "iteration_completed",
        agent: "lead",
        iteration: 1,
        at: 3,
        model: "m",
        input_tokens: 10,
        output_tokens: 2,
        response: "Done.",
      }),
      ev({ type: "run_ended", status: "completed", at: 4, reason: "completed" }),
    ];
    d.live(stream);
    d.reconcile(stream);

    const reasoning = d.store.nodes.filter((n) => n.kind === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]!.text).toBe("I should read the tests first.");
    dispose();
  });
});

test("the end-of-run replay never resurrects a live output tail", () => {
  createRoot((dispose) => {
    const d = driver();
    const start = ev({
      type: "tool_call_started",
      agent: "lead",
      call_id: "c9",
      at: 1,
      server: "fs",
      tool: "shell",
      arguments: { command: "loop" },
    });
    const stored: RunEvent[] = [
      ev({ type: "run_started", at: 0 }),
      ev({ type: "iteration_started", agent: "lead", iteration: 1, at: 1, model: "m" }),
      start,
      ev({
        type: "tool_call",
        agent: "lead",
        call_id: "c9",
        at: 2,
        server: "fs",
        tool: "shell",
        arguments: { command: "loop" },
        result: "tick 1\ntick 2",
        ok: true,
      }),
      ev({
        type: "iteration_completed",
        agent: "lead",
        iteration: 1,
        at: 3,
        model: "m",
        input_tokens: 1,
        output_tokens: 1,
        response: "Done.",
      }),
      ev({ type: "run_ended", status: "completed", at: 4, reason: "completed" }),
    ];
    const live: RunEvent[] = [
      stored[0]!,
      stored[1]!,
      start,
      ev({
        type: "tool_output_delta",
        agent: "lead",
        call_id: "c9",
        at: 1,
        chunk: "tick 1\n",
      }),
      ev({
        type: "tool_output_delta",
        agent: "lead",
        call_id: "c9",
        at: 2,
        chunk: "tick 2\n",
      }),
      ...stored.slice(3),
    ];
    d.live(live.slice(0, 5));
    expect(d.store.nodes.find((n) => n.kind === "tool_call")!.liveOutput).toBe("tick 1\ntick 2\n");

    d.live(live.slice(5));
    d.reconcile(stored);

    const call = d.store.nodes.find((n) => n.kind === "tool_call")!;
    expect(call.liveOutput).toBeUndefined();
    expect(call.result).toBe("tick 1\ntick 2");
    dispose();
  });
});

test("a node only the stored trace has is inserted in the replay's position", () => {
  createRoot((dispose) => {
    const d = driver();
    d.live(LIVE.filter((e) => e !== STORED[3]));
    expect(d.store.nodes.some((n) => n.kind === "tool_call")).toBe(false);

    d.reconcile(STORED);

    const kinds = d.store.nodes.map((n) => n.kind);
    expect(kinds.indexOf("tool_call")).toBeLessThan(kinds.indexOf("assistant"));
    dispose();
  });
});
