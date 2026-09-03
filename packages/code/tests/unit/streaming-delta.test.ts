import { expect, test } from "bun:test";
import type { RunEvent } from "@clarvis/protocol";
import {
  createTranscriptStore,
  TRANSCRIPT_PROSE_MAX_CHARS,
  TRANSCRIPT_PROSE_RELEASED_NOTICE,
  TRANSCRIPT_PROSE_TRUNCATED_NOTICE,
} from "../../src/adapters/store.ts";
import { applyRunEvent, runEvent } from "../helpers/run-events.ts";

const ev = runEvent;

const delta = (channel: "text" | "reasoning", text: string, reset: boolean): RunEvent =>
  ev({
    type: "text_delta",
    agent: "lead",
    iteration: 1,
    at: 3,
    model: "m",
    channel,
    text,
    reset,
  });

/** A sub-agent's text delta on iteration 1 — the same iteration the lead uses. */
const subDelta = (wid: string | undefined, text: string, reset: boolean): RunEvent =>
  ev({
    type: "text_delta",
    agent: "subagent",
    ...(wid !== undefined ? { subagent_id: wid } : {}),
    iteration: 1,
    at: 3,
    model: "m",
    channel: "text",
    text,
    reset,
  });

const spawn = (wid: string, title: string): RunEvent =>
  ev({
    type: "delegation_created",
    delegation_id: wid,
    at: 2,
    title,
    task: "work",
    tools: [],
  });

const subIterationStarted = (wid: string): RunEvent =>
  ev({
    type: "iteration_started",
    agent: "subagent",
    subagent_id: wid,
    iteration: 1,
    at: 2,
    model: "m",
  });

function driver() {
  const store = createTranscriptStore();
  const sink = store.openRun("exec_test");
  const apply = (e: RunEvent): void => applyRunEvent(sink, e, "live");
  apply(ev({ type: "run_started", at: 1 }));
  apply(ev({ type: "iteration_started", agent: "lead", iteration: 1, at: 2, model: "m" }));
  return { store, apply };
}

test("assistant text streams live then reconciles to the authoritative response", () => {
  const { store, apply } = driver();
  apply(delta("text", "Hel", true));
  apply(delta("text", "lo", false));

  let asst = store.nodes.filter((n) => n.kind === "assistant");
  expect(asst).toHaveLength(1);
  expect(asst[0]!.text).toBe("Hello");
  expect(asst[0] && "textEpoch" in asst[0] ? asst[0].textEpoch : undefined).toBe(1);
  expect(asst[0]!.status).toBe("running");
  expect(store.nodes.some((n) => n.kind === "thinking")).toBe(false);

  apply(
    ev({
      type: "iteration_completed",
      agent: "lead",
      iteration: 1,
      at: 3,
      model: "m",
      response: "Hello, world!",
      response_phase: "commentary",
      input_tokens: 0,
      output_tokens: 0,
    }),
  );
  asst = store.nodes.filter((n) => n.kind === "assistant");
  expect(asst).toHaveLength(1);
  expect(asst[0]!.text).toBe("Hello, world!");
  expect(asst[0] && "textEpoch" in asst[0] ? asst[0].textEpoch : undefined).toBe(2);
  expect(asst[0]!.status).toBe("ok");
  expect(asst[0] && "assistantPhase" in asst[0] ? asst[0].assistantPhase : undefined).toBe(
    "commentary",
  );
});

test("a final response beyond the former trace-summary cap remains intact", () => {
  const { store, apply } = driver();
  const response = "complete answer ".repeat(500);
  apply(delta("text", response, true));
  apply(
    ev({
      type: "iteration_completed",
      agent: "lead",
      iteration: 1,
      at: 4,
      model: "m",
      response,
      input_tokens: 0,
      output_tokens: 0,
    }),
  );

  const assistant = store.nodes.find((node) => node.kind === "assistant")!;
  if (assistant.kind !== "assistant") throw new Error("expected assistant node");
  expect(response.length).toBeGreaterThan(5_000);
  expect(assistant.text).toBe(response);
  expect(assistant.textTruncated).toBeUndefined();
  expect(assistant.status).toBe("ok");
});

test("a reset delta restarts the streamed buffer (retry within the iteration)", () => {
  const { store, apply } = driver();
  apply(delta("text", "partial from the failed attempt", true));
  apply(delta("text", "Fresh ", true));
  apply(delta("text", "start", false));

  const asst = store.nodes.filter((n) => n.kind === "assistant");
  expect(asst).toHaveLength(1);
  expect(asst[0]!.text).toBe("Fresh start");
  expect(asst[0] && "textEpoch" in asst[0] ? asst[0].textEpoch : undefined).toBe(2);
});

test("assistant prose stops growing at the TUI retention cap and reports truncation", () => {
  const { store, apply } = driver();
  apply(delta("text", "x".repeat(TRANSCRIPT_PROSE_MAX_CHARS - 10), true));
  apply(delta("text", "y".repeat(100), false));
  apply(delta("text", "ignored", false));

  const assistant = store.nodes.find((node) => node.kind === "assistant")!;
  expect(assistant.kind).toBe("assistant");
  if (assistant.kind !== "assistant") throw new Error("expected assistant node");
  expect(assistant.text).toHaveLength(TRANSCRIPT_PROSE_MAX_CHARS);
  expect(assistant.text.endsWith(TRANSCRIPT_PROSE_TRUNCATED_NOTICE)).toBe(true);
  expect(assistant.textTruncated).toBe(true);

  apply(delta("text", "fresh", true));
  const reset = store.nodes.find((node) => node.kind === "assistant")!;
  if (reset.kind !== "assistant") throw new Error("expected assistant node");
  expect(reset.text).toBe("fresh");
  expect(reset.textTruncated).toBeUndefined();
});

test("authoritative iteration text is bounded before replacing the live node", () => {
  const { store, apply } = driver();
  apply(delta("text", "partial", true));
  apply(
    ev({
      type: "iteration_completed",
      agent: "lead",
      iteration: 1,
      at: 4,
      model: "m",
      response: "z".repeat(TRANSCRIPT_PROSE_MAX_CHARS + 1),
      input_tokens: 0,
      output_tokens: 0,
    }),
  );

  const assistant = store.nodes.find((node) => node.kind === "assistant")!;
  if (assistant.kind !== "assistant") throw new Error("expected assistant node");
  expect(assistant.text).toHaveLength(TRANSCRIPT_PROSE_MAX_CHARS);
  expect(assistant.textTruncated).toBe(true);
  expect(assistant.status).toBe("ok");
});

test("settled prose shares an aggregate budget while the newest message remains resident", () => {
  const store = createTranscriptStore({ proseTotalLimitBytes: 400 });
  store.appendUserMessage("a".repeat(120));
  store.appendUserMessage("b".repeat(120));

  const users = store.nodes.filter((node) => node.kind === "user");
  expect(users).toHaveLength(2);
  if (users[0]?.kind !== "user" || users[1]?.kind !== "user")
    throw new Error("expected user nodes");
  expect(users[0]!.text).toBe(TRANSCRIPT_PROSE_RELEASED_NOTICE);
  expect(users[0]!.textTruncated).toBe(true);
  expect(users[1]!.text).toBe("b".repeat(120));
});

test("reconciliation enforces the prose budget before the replay finishes", () => {
  const store = createTranscriptStore({ proseTotalLimitBytes: 400 });
  const sink = store.openRun("replay");
  sink.beginReconcile();
  for (let iteration = 1; iteration <= 2; iteration += 1) {
    applyRunEvent(
      sink,
      ev({
        type: "iteration_completed",
        agent: "lead",
        iteration,
        at: iteration,
        model: "m",
        response: String(iteration).repeat(120),
        input_tokens: 0,
        output_tokens: 0,
      }),
      "replay",
    );
  }

  const assistants = store.nodes.filter((node) => node.kind === "assistant");
  expect(assistants).toHaveLength(2);
  expect(assistants[0]!.text).toBe(TRANSCRIPT_PROSE_RELEASED_NOTICE);
  expect(assistants[1]!.text).toBe("2".repeat(120));
  sink.endReconcile();
});

test("reasoning deltas are NOT streamed to a live node (avoids flicker); text still is", () => {
  const { store, apply } = driver();
  apply(delta("reasoning", "think", true));
  apply(delta("reasoning", "ing", false));
  apply(delta("text", "answer", true));

  expect(store.nodes.filter((n) => n.kind === "reasoning")).toHaveLength(0);
  const asst = store.nodes.filter((n) => n.kind === "assistant");
  expect(asst).toHaveLength(1);
  expect(asst[0]!.text).toBe("answer");
});

test("a subagent's stream lands on its own attributed node, not the lead's", () => {
  const { store, apply } = driver();
  apply(spawn("w1", "explorer"));
  apply(subIterationStarted("w1"));
  apply(subDelta("w1", "sub says hi", true));

  const asst = store.nodes.filter((n) => n.kind === "assistant");
  expect(asst).toHaveLength(1);
  expect(asst[0]!.text).toBe("sub says hi");
  expect(asst[0]!.subagentOrder).toBe(0);
  expect(asst[0]!.agentLabel).toBe("explorer");
});

test("lead and subagent streaming the same iteration number never share a node", () => {
  const { store, apply } = driver();
  apply(spawn("w1", "explorer"));
  apply(subIterationStarted("w1"));
  apply(delta("text", "lead words", true));
  apply(subDelta("w1", "sub words", true));

  const asst = store.nodes.filter((n) => n.kind === "assistant");
  expect(asst).toHaveLength(2);
  const lead = asst.find((n) => n.subagentOrder === undefined)!;
  const sub = asst.find((n) => n.subagentOrder === 0)!;
  expect(lead.text).toBe("lead words");
  expect(sub.text).toBe("sub words");
});

test("two subagents streaming the same iteration number keep separate nodes", () => {
  const { store, apply } = driver();
  apply(spawn("w1", "explorer"));
  apply(spawn("w2", "coder"));
  apply(subIterationStarted("w1"));
  apply(subIterationStarted("w2"));
  apply(subDelta("w1", "from ", true));
  apply(subDelta("w2", "from ", true));
  apply(subDelta("w1", "explorer", false));
  apply(subDelta("w2", "coder", false));

  const asst = store.nodes.filter((n) => n.kind === "assistant");
  expect(asst).toHaveLength(2);
  expect(asst.find((n) => n.agentLabel === "explorer")!.text).toBe("from explorer");
  expect(asst.find((n) => n.agentLabel === "coder")!.text).toBe("from coder");
});

test("a subagent's delta leaves the lead's thinking spinner alone", () => {
  const { store, apply } = driver();
  apply(spawn("w1", "explorer"));
  apply(subIterationStarted("w1"));
  apply(subDelta("w1", "working", true));

  const thinking = store.nodes.filter((n) => n.kind === "thinking");
  expect(thinking).toHaveLength(1);
  expect(thinking[0]!.subagentOrder).toBeUndefined();
});

const toolStart = (callId: string, startedAt = 2): RunEvent =>
  ev({
    type: "tool_call_started",
    agent: "lead",
    call_id: callId,
    at: startedAt,
    server: "",
    tool: "shell",
    arguments: { command: "bun test" },
  });

const outDelta = (callId: string, chunk: string): RunEvent =>
  ev({ type: "tool_output_delta", agent: "lead", call_id: callId, at: 3, chunk });

const toolClose = (callId: string, endedAt = 9): Extract<RunEvent, { type: "tool_call" }> =>
  ev({
    type: "tool_call",
    agent: "lead",
    call_id: callId,
    at: endedAt,
    server: "",
    tool: "shell",
    arguments: { command: "bun test" },
    result: "authoritative output",
    ok: true,
  });

test("a running tool's streamed output accumulates on its node and clears on close", () => {
  const { store, apply } = driver();
  apply(toolStart("c1"));
  apply(outDelta("c1", "tick 1\nti"));
  apply(outDelta("c1", "ck 2\n"));

  const running = store.nodes.find((n) => n.kind === "tool_call")!;
  expect(running.status).toBe("running");
  expect(running.liveOutput).toBe("tick 1\ntick 2\n");

  apply(toolClose("c1"));
  const closed = store.nodes.find((n) => n.kind === "tool_call")!;
  expect(closed.status).toBe("ok");
  expect(closed.liveOutput).toBeUndefined();
  expect(closed.result).toBe("authoritative output");
  expect(closed.elapsedMs).toBe(7);
});

test("a terminal shell call retains its auto-guard verdict for rendering and replay", () => {
  const { store, apply } = driver();
  apply(toolStart("guarded"));
  apply({
    ...toolClose("guarded"),
    guard: { mode: "auto", outcome: "allowed", answerer: "judge" },
  });
  const closed = store.nodes.find((n) => n.kind === "tool_call")!;
  expect(closed.guard).toEqual({ mode: "auto", outcome: "allowed", answerer: "judge" });
});

test("the live tail keeps only the last ~50 lines of a verbose command", () => {
  const { store, apply } = driver();
  apply(toolStart("c1"));
  for (let i = 1; i <= 60; i++) apply(outDelta("c1", `line-${String(i).padStart(2, "0")}\n`));

  const tail = store.nodes.find((n) => n.kind === "tool_call")!.liveOutput!;
  expect(tail).toContain("line-60");
  expect(tail).not.toContain("line-01");
  expect(tail.split("\n").length).toBeLessThanOrEqual(50);
});

test("a single giant chunk is capped by bytes, keeping the end of the stream", () => {
  const { store, apply } = driver();
  apply(toolStart("c1"));
  apply(outDelta("c1", "HEAD-" + "x".repeat(10_000) + "-TAIL"));

  const tail = store.nodes.find((n) => n.kind === "tool_call")!.liveOutput!;
  expect(tail.length).toBeLessThanOrEqual(8192);
  expect(tail.endsWith("-TAIL")).toBe(true);
  expect(tail).not.toContain("HEAD-");
});

test("a delta arriving after the call closed does not resurrect the tail", () => {
  const { store, apply } = driver();
  apply(toolStart("c1"));
  apply(toolClose("c1"));
  apply(outDelta("c1", "late chunk"));

  const closed = store.nodes.find((n) => n.kind === "tool_call")!;
  expect(closed.status).toBe("ok");
  expect(closed.liveOutput).toBeUndefined();
});

test("an unattributable subagent delta is dropped rather than spliced into another span", () => {
  const { store, apply } = driver();
  apply(delta("text", "lead words", true));
  apply(subDelta(undefined, " and stolen sub words", false));

  const asst = store.nodes.filter((n) => n.kind === "assistant");
  expect(asst).toHaveLength(1);
  expect(asst[0]!.text).toBe("lead words");
});

const inputDelta = (callId: string, tool: string, chars: number, complete = false): RunEvent =>
  ev({
    type: "tool_input_delta",
    agent: "lead",
    call_id: callId,
    at: 4,
    tool: tool,
    chars,
    ...(complete ? { complete: true } : {}),
  });

const callStarted = (callId: string, tool: string, args: Record<string, unknown>): RunEvent =>
  ev({
    type: "tool_call_started",
    agent: "lead",
    call_id: callId,
    at: 5,
    server: "fs",
    tool: tool,
    arguments: args,
  });

const bareCallStarted = (callId: string, tool: string, args: Record<string, unknown>): RunEvent =>
  ev({
    type: "tool_call_started",
    agent: "lead",
    call_id: callId,
    at: 5,
    server: tool,
    tool: "",
    arguments: args,
  });

const bareCallCompleted = (callId: string, tool: string): RunEvent =>
  ev({
    type: "tool_call",
    agent: "lead",
    call_id: callId,
    at: 6,
    server: tool,
    tool: "",
    arguments: {},
    result: "ok",
    ok: true,
  });

const transcriptExternalOrchestrationTools = [
  "spawn_subagent",
  "delegate_task",
  "agent_list",
  "agent_poll",
  "agent_stop",
  "agent_steer",
  "await_agents",
  "run_leader",
  "run_workflow",
  "run_round",
  "run_work_items",
  "workflow_status",
  "workflow_decide",
] as const;

test("a tool call the model is still composing gets a node before the call exists", () => {
  // The window this covers is most of a real run's wall clock, and until
  // `tool_input_delta` existed nothing was on screen for any of it: the first
  // event a tool call otherwise produces is `tool_call_started`, which cannot
  // be recorded until the whole model call has returned.
  const { store, apply } = driver();
  apply(inputDelta("c1", "write_file", 0));

  const nodes = store.nodes.filter((n) => n.kind === "tool_call");
  expect(nodes).toHaveLength(1);
  expect(nodes[0]).toMatchObject({
    kind: "tool_call",
    status: "running",
    toolName: "write_file",
    inputChars: 0,
  });
});

test("the composing node tracks the growing payload without duplicating itself", () => {
  const { store, apply } = driver();
  apply(inputDelta("c1", "write_file", 0));
  apply(inputDelta("c1", "write_file", 1024));
  apply(inputDelta("c1", "write_file", 4096));

  expect(store.nodes.filter((n) => n.kind === "tool_call")).toHaveLength(1);
  expect(store.nodes.filter((n) => n.kind === "tool_call")[0]).toMatchObject({ inputChars: 4096 });
});

test("tool-input end marks arguments ready until the real tool call starts", () => {
  const { store, apply } = driver();
  apply(inputDelta("c1", "write_file", 4096));
  apply(inputDelta("c1", "write_file", 8192, true));

  let node = store.nodes.find((n) => n.kind === "tool_call")!;
  expect(node).toMatchObject({ status: "pending", inputChars: 8192, inputComplete: true });

  apply(inputDelta("c2", "read_file", 0));
  node = store.nodes
    .filter((n) => n.kind === "tool_call")
    .find((n) => n.toolName === "write_file")!;
  expect(node).toMatchObject({ status: "pending", inputChars: 8192, inputComplete: true });

  apply(callStarted("c1", "write_file", { path: "src/App.tsx" }));
  node = store.nodes
    .filter((n) => n.kind === "tool_call")
    .find((n) => n.toolName === "write_file")!;
  expect(node).toMatchObject({ status: "running", args: { path: "src/App.tsx" } });
  expect(node.inputChars).toBeUndefined();
  expect(node.inputComplete).toBeUndefined();
});

test("the real call reconciles onto the placeholder instead of leaving it empty", () => {
  // `upsert` only runs its factory when the node is absent, so without an
  // explicit patch the placeholder's empty args would survive the real call.
  const { store, apply } = driver();
  apply(inputDelta("c1", "write_file", 2048));
  apply(callStarted("c1", "write_file", { path: "src/App.tsx" }));

  const nodes = store.nodes.filter((n) => n.kind === "tool_call");
  expect(nodes).toHaveLength(1);
  expect(nodes[0]).toMatchObject({
    kind: "tool_call",
    status: "running",
    toolName: "write_file",
    mcpName: "fs",
    args: { path: "src/App.tsx" },
  });
  // Cleared, so a completed call never shows a size beside its real arguments.
  expect((nodes[0] as { inputChars?: number }).inputChars).toBeUndefined();
});

const planCall = (callId: string, tool: string): RunEvent =>
  ev({
    type: "tool_call",
    agent: "lead",
    call_id: callId,
    at: 6,
    server: tool,
    tool: "",
    arguments: {},
    result: "the plan",
    ok: true,
  });

const leadIterationStarted = (iteration: number): RunEvent =>
  ev({ type: "iteration_started", agent: "lead", iteration, at: 7, model: "m" });

test("a call closed without ever having started drops its composing label", () => {
  // The plan tools are dispatched by a handler that records only the terminal
  // `tool_call` -- there is no `tool_call_started` to clear `inputChars`, so
  // the finished call sat there reading `✓ read_plan(composing… 2 chars)`.
  const { store, apply } = driver();
  apply(inputDelta("c1", "read_plan", 2));
  apply(planCall("c1", "read_plan"));

  const nodes = store.nodes.filter((n) => n.kind === "tool_call");
  expect(nodes).toHaveLength(1);
  expect(nodes[0]).toMatchObject({ status: "ok", result: "the plan" });
  expect((nodes[0] as { inputChars?: number }).inputChars).toBeUndefined();
});

test("a placeholder the trace never confirms does not outlive the model call", () => {
  const { store, apply } = driver();
  apply(inputDelta("c1", "write_file", 512));
  expect(store.nodes.filter((n) => n.kind === "tool_call")).toHaveLength(1);

  apply(leadIterationStarted(2));
  expect(store.nodes.filter((n) => n.kind === "tool_call")).toHaveLength(0);
});

test("a retry drops composing placeholders from the failed provider attempt", () => {
  const { store, apply } = driver();
  apply(inputDelta("c1", "write_file", 48_147));

  apply(
    ev({
      type: "model_retry",
      agent: "lead",
      iteration: 1,
      at: 180_000,
      kind: "transient",
      attempt: 1,
      max_retries: 3,
      delay_ms: 1_000,
    }),
  );

  expect(store.nodes.filter((n) => n.kind === "tool_call")).toHaveLength(0);
  expect(store.nodes).toContainEqual(
    expect.objectContaining({ kind: "annotation", text: expect.stringContaining("retrying") }),
  );
});

test("Lead-owned orchestration tools never create composing, started, or terminal nodes", () => {
  for (const [index, tool] of transcriptExternalOrchestrationTools.entries()) {
    const { store, apply } = driver();
    const callId = `orchestration-${index}`;

    apply(inputDelta(callId, tool, 128));
    expect(store.nodes.filter((node) => node.kind === "tool_call")).toHaveLength(0);

    apply(bareCallStarted(callId, tool, { task: "private orchestration payload" }));
    expect(store.nodes.filter((node) => node.kind === "tool_call")).toHaveLength(0);

    apply(bareCallCompleted(callId, tool));
    expect(store.nodes.filter((node) => node.kind === "tool_call")).toHaveLength(0);
  }
});

test("an MCP leaf colliding with orchestration stays continuous from wire composition to terminal", () => {
  const { store, apply } = driver();
  apply(inputDelta("mcp-collision", "server_await_agents", 64));
  expect(store.nodes.filter((node) => node.kind === "tool_call")).toEqual([
    expect.objectContaining({ toolName: "server_await_agents", status: "running" }),
  ]);

  apply(
    ev({
      type: "tool_call_started",
      agent: "lead",
      call_id: "mcp-collision",
      at: 5,
      server: "server",
      tool: "await_agents",
      arguments: { query: "real downstream tool" },
    }),
  );
  expect(store.nodes.filter((node) => node.kind === "tool_call")).toEqual([
    expect.objectContaining({
      mcpName: "server",
      toolName: "await_agents",
      status: "running",
    }),
  ]);

  apply(
    ev({
      type: "tool_call",
      agent: "lead",
      call_id: "mcp-collision",
      at: 6,
      server: "server",
      tool: "await_agents",
      arguments: { query: "real downstream tool" },
      result: "downstream result",
      ok: true,
    }),
  );
  expect(store.nodes.filter((node) => node.kind === "tool_call")).toEqual([
    expect.objectContaining({
      mcpName: "server",
      toolName: "await_agents",
      status: "ok",
      result: "downstream result",
    }),
  ]);
});

test("a subagent tool lifecycle without its required id cannot leak into Lead history", () => {
  const { store, apply } = driver();
  const events: RunEvent[] = [
    ev({
      type: "tool_input_delta",
      agent: "subagent",
      call_id: "missing-child",
      at: 4,
      tool: "read_file",
      chars: 64,
    }),
    ev({
      type: "tool_call_started",
      agent: "subagent",
      call_id: "missing-child",
      at: 5,
      server: "read_file",
      tool: "",
      arguments: { path: "private.md" },
    }),
    ev({
      type: "tool_call",
      agent: "subagent",
      call_id: "missing-child",
      at: 6,
      server: "read_file",
      tool: "",
      arguments: { path: "private.md" },
      result: "private child result",
      ok: true,
    }),
  ];

  for (const event of events) {
    apply(event);
    expect(store.nodes.filter((node) => node.kind === "tool_call")).toHaveLength(0);
  }
});

test("a real call is never swept, however long it runs across iterations", () => {
  const { store, apply } = driver();
  apply(toolStart("c1"));
  apply(leadIterationStarted(2));

  expect(store.nodes.filter((n) => n.kind === "tool_call")).toHaveLength(1);
});

test("the lead's next iteration leaves a subagent's live placeholder alone", () => {
  const { store, apply } = driver();
  apply(spawn("w1", "explorer"));
  apply(subIterationStarted("w1"));
  apply(
    ev({
      type: "tool_input_delta",
      agent: "subagent",
      subagent_id: "w1",
      call_id: "c2",
      at: 4,
      tool: "read_file",
      chars: 64,
    }),
  );
  apply(inputDelta("c1", "write_file", 64));
  expect(store.nodes.filter((n) => n.kind === "tool_call")).toHaveLength(2);

  apply(leadIterationStarted(2));
  const left = store.nodes.filter((n) => n.kind === "tool_call");
  expect(left).toHaveLength(1);
  expect(left[0]!.subagentOrder).toBe(0);
});

test("a placeholder left by the final model call does not survive the run", () => {
  const { store, apply } = driver();
  apply(inputDelta("c1", "write_file", 300));
  apply(ev({ type: "run_ended", status: "completed", at: 9, reason: "completed" }));

  expect(store.nodes.filter((n) => n.kind === "tool_call")).toHaveLength(0);
});

test("two calls composed in one completion stay separate nodes", () => {
  const { store, apply } = driver();
  apply(inputDelta("c1", "write_file", 100));
  apply(inputDelta("c2", "read_file", 20));

  expect(
    store.nodes
      .filter((n) => n.kind === "tool_call")
      .map((n) => (n as { toolName?: string }).toolName),
  ).toEqual(["write_file", "read_file"]);
});

test("the transcript memory ledger follows resident prose and clears atomically", () => {
  const store = createTranscriptStore();
  store.appendUserMessage("ledger payload");
  expect(store.memory?.()).toMatchObject({
    transcript_nodes: 1,
    transcript_prose_bytes: "ledger payload".length * 2,
    publication_batches: 1,
    publication_known_keys: 1,
    hydrated_tool_nodes: 0,
    hydrated_tool_bytes: 0,
  });

  store.clear();
  expect(store.memory?.()).toMatchObject({
    transcript_nodes: 0,
    transcript_prose_bytes: 0,
    publication_batches: 0,
    publication_known_keys: 0,
    hydrated_tool_nodes: 0,
    hydrated_tool_bytes: 0,
  });
});
