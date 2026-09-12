import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import type { RunEvent } from "@clarvis/protocol";
import { createTranscriptStore, type TranscriptNode } from "../../src/adapters/store.ts";
import { applyRunEvent, runEvent } from "../helpers/run-events.ts";

const ev = runEvent;

function replay(stream: RunEvent[]): TranscriptNode[] {
  return createRoot(() => {
    const store = createTranscriptStore();
    const sink = store.openRun("exec_1");
    for (const event of stream) applyRunEvent(sink, event, "live");
    return store.nodes;
  });
}

function replayStore(stream: RunEvent[]) {
  return createRoot(() => {
    const store = createTranscriptStore();
    const sink = store.openRun("exec_1");
    for (const event of stream) applyRunEvent(sink, event, "live");
    return store;
  });
}

const leadIter = (iteration: number, input: number, output: number): RunEvent =>
  ev({
    type: "iteration_completed",
    agent: "lead",
    iteration,
    at: iteration + 1,
    model: "m",
    input_tokens: input,
    output_tokens: output,
    response: "",
  });

const leadTool = (id: string): RunEvent =>
  ev({
    type: "tool_call",
    agent: "lead",
    call_id: id,
    at: 2,
    server: "fs",
    tool: "grep",
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
] as const;

function liveThenReplay(stream: RunEvent[]): TranscriptNode[] {
  return createRoot(() => {
    const store = createTranscriptStore();
    const sink = store.openRun("exec_1");
    for (const event of stream) applyRunEvent(sink, event, "live");
    sink.beginReconcile();
    for (const event of stream) applyRunEvent(sink, event, "replay");
    sink.endReconcile();
    return store.nodes;
  });
}

test("run totals are not doubled when a stored-trace replay follows the live stream on the same sink", () => {
  const stream = [
    ev({ type: "run_started", at: 0 }),
    leadIter(1, 1000, 100),
    leadTool("c1"),
    leadIter(2, 2000, 200),
    ev({ type: "run_ended", status: "completed", at: 10, reason: "completed" }),
  ];
  const run = liveThenReplay(stream).find((n) => n.kind === "run")!;
  expect(run.inputTokens).toBe(3000);
  expect(run.outputTokens).toBe(300);
  expect(run.toolCalls).toBe(1);
});

test("MCP degradation is retained as run telemetry but never becomes transcript content", () => {
  const store = replayStore([
    ev({ type: "run_started", at: 0 }),
    ev({
      type: "mcp_degraded",
      at: 1,
      servers: [{ name: "docs", reason: "missing DOCS_TOKEN" }],
    }),
  ]);

  expect(store.nodes.some((node) => node.text.includes("missing DOCS_TOKEN"))).toBe(false);
  expect(store.publicationBatches).toHaveLength(0);
});

test("settleRun sweeps leftover running nodes when a run is cancelled or lost", () => {
  createRoot(() => {
    const store = createTranscriptStore();
    const sink = store.openRun("exec_1");
    const stream = [
      ev({ type: "run_started", at: 0 }),
      ev({ type: "iteration_started", agent: "lead", iteration: 1, at: 1, model: "m" }),
      ev({
        type: "delegation_created",
        delegation_id: "w1",
        at: 2,
        title: "explorer",
        task: "look",
        tools: [],
      }),
    ];
    for (const event of stream) applyRunEvent(sink, event, "live");
    expect(store.nodes.some((n) => n.kind === "thinking")).toBe(true);
    expect(store.nodes.find((n) => n.kind === "subagent")?.status).toBe("running");

    store.settleRun("exec_1");
    expect(store.nodes.some((n) => n.kind === "thinking")).toBe(false);
    expect(store.nodes.find((n) => n.kind === "subagent")?.status).toBe("error");
  });
});

test("settleRun keeps a cancelled run's streamed partial text, but stops it spinning", () => {
  createRoot((dispose) => {
    const store = createTranscriptStore();
    const sink = store.openRun("exec_1");
    applyRunEvent(sink, ev({ type: "run_started", at: 0 }), "live");
    applyRunEvent(
      sink,
      ev({ type: "iteration_started", agent: "lead", iteration: 1, at: 1, model: "m" }),
      "live",
    );
    applyRunEvent(
      sink,
      ev({
        type: "text_delta",
        agent: "lead",
        iteration: 1,
        at: 2,
        model: "m",
        channel: "text",
        text: "half an answ",
        reset: true,
      }),
      "live",
    );
    store.settleRun("exec_1");

    const asst = store.nodes.find((n) => n.kind === "assistant")!;
    expect(asst.status).toBe("ok");
    expect(asst.text).toBe("half an answ");
    dispose();
  });
});

const bashCall = (result: string, error: string | null = null): RunEvent =>
  ev({
    type: "tool_call",
    agent: "lead",
    call_id: "c1",
    at: 2,
    server: "shell",
    tool: "",
    arguments: { command: "npm test" },
    result,
    ok: error === null,
    ...(error === null ? {} : { error }),
  });

test("bash exit≠0 is marked warn and never auto-collapses (no green ✓ over a failing command)", () => {
  const store = replayStore([
    ev({ type: "run_started", at: 0 }),
    bashCall(JSON.stringify({ exit_code: 1, stdout: "", stderr: "1 test failed" })),
  ]);
  const tool = store.nodes.find((n) => n.kind === "tool_call")!;
  expect(tool.status).toBe("ok");
  expect(tool.warn).toBe(true);
  expect(store.defaultFolded(tool.key)).toBe(false);
});

test("bash exit 0 stays a normal collapsed success", () => {
  const store = replayStore([
    ev({ type: "run_started", at: 0 }),
    bashCall(JSON.stringify({ exit_code: 0, stdout: "ok", stderr: "" })),
  ]);
  const tool = store.nodes.find((n) => n.kind === "tool_call")!;
  expect(tool.warn).toBe(false);
  expect(store.defaultFolded(tool.key)).toBe(true);
});

test("a finished tool call keeps its duration; a close that never saw its start invents none", () => {
  const started = ev({
    type: "tool_call_started",
    agent: "lead",
    call_id: "c1",
    at: 1000,
    server: "fs",
    tool: "grep",
    arguments: { pattern: "x" },
  });
  const closed = ev({
    type: "tool_call",
    agent: "lead",
    call_id: "c1",
    at: 3500,
    server: "fs",
    tool: "grep",
    arguments: { pattern: "x" },
    result: "ok",
    ok: true,
  });
  const timed = replay([ev({ type: "run_started", at: 0 }), started, closed]);
  expect(timed.find((n) => n.kind === "tool_call")!.elapsedMs).toBe(2500);

  const startless = replay([ev({ type: "run_started", at: 0 }), closed]);
  expect(startless.find((n) => n.kind === "tool_call")!.elapsedMs).toBeUndefined();
});

test("a completed run gets a terminal ✓ marker; a failed one keeps the engine reason", () => {
  const done = replay([
    ev({ type: "run_started", at: 0 }),
    ev({ type: "run_ended", status: "completed", at: 1, reason: "completed" }),
  ]);
  const marker = done.find((n) => n.kind === "run")!;
  expect(marker.status).toBe("ok");
  expect(marker.reason).toBe("done");

  const cut = replay([
    ev({ type: "run_started", at: 0 }),
    ev({ type: "run_ended", status: "failed", at: 1, reason: "budget_exceeded" }),
  ]);
  const bad = cut.find((n) => n.kind === "run")!;
  expect(bad.status).toBe("error");
  expect(bad.reason).toBe("budget_exceeded");
});

test("subagent-attributed annotations carry subagentOrder (no Lead flush-barrier mid-section)", () => {
  const nodes = replay([
    ev({ type: "run_started", at: 0 }),
    ev({
      type: "delegation_created",
      delegation_id: "w1",
      at: 1,
      title: "explorer",
      task: "look",
      tools: [],
    }),
    ev({
      type: "compaction",
      agent: "subagent",
      subagent_id: "w1",
      operation: "truncation",
      at: 2,
      freed_chars: 12000,
    }),
    ev({ type: "steering_applied", agent: "lead", at: 3, message: "go" }),
  ]);
  const compaction = nodes.find((n) => n.kind === "annotation" && n.text.startsWith("compaction"))!;
  expect(compaction.subagentOrder).toBe(0);
  const steer = nodes.find((n) => n.kind === "annotation" && n.text.includes("Steer"))!;
  expect(steer.subagentOrder).toBeUndefined();
});

test("typed delegation lifecycle emits one friendly Lead marker per semantic boundary", () => {
  for (const terminalType of ["delegation_completed", "delegation_failed"] as const) {
    createRoot((dispose) => {
      const store = createTranscriptStore();
      const sink = store.openRun(`exec_${terminalType}`);
      const apply = (event: RunEvent): void => applyRunEvent(sink, event, "live");
      const lifecycleMarkers = (): TranscriptNode[] =>
        store.nodes.filter(
          (node) =>
            node.subagentId === undefined &&
            node.text.toLowerCase().includes("research authentication"),
        );

      apply(ev({ type: "run_started", at: 0 }));
      apply(
        ev({
          type: "delegation_created",
          delegation_id: "worker",
          at: 1,
          title: "Research authentication",
          task: "SECRET CHILD BRIEF",
          tools: [],
        }),
      );

      const [spawned] = lifecycleMarkers();
      expect(lifecycleMarkers()).toHaveLength(1);
      expect(spawned?.text.toLowerCase()).toContain("spawned");
      expect(spawned?.text).toContain("A1");
      expect(spawned?.text).not.toContain("SECRET CHILD BRIEF");
      const immutableSpawn = spawned && {
        key: spawned.key,
        text: spawned.text,
        status: spawned.status,
      };

      apply(
        ev({
          type: "delegation_started",
          delegation_id: "worker",
          at: 2,
          model: "openai/gpt-5",
        }),
      );
      expect(lifecycleMarkers()).toHaveLength(1);

      apply(
        ev({
          type: "tool_call",
          at: 3,
          agent: "subagent",
          subagent_id: "worker",
          call_id: "child-read",
          server: "builtin",
          tool: "read_file",
          arguments: { path: "private.ts" },
          result: "SECRET CHILD TOOL RESULT",
          ok: true,
        }),
      );
      apply(
        terminalType === "delegation_completed"
          ? ev({
              type: terminalType,
              delegation_id: "worker",
              at: 4,
              status: "completed",
              summary: "SECRET CHILD SUMMARY",
            })
          : ev({
              type: terminalType,
              delegation_id: "worker",
              at: 4,
              status: "error",
              summary: "SECRET CHILD SUMMARY",
            }),
      );

      const markers = lifecycleMarkers();
      expect(markers).toHaveLength(2);
      expect(new Set(markers.map((node) => node.key)).size).toBe(2);
      expect(markers[0]).toMatchObject(immutableSpawn ?? {});
      expect(markers[1]?.text.toLowerCase()).toContain(
        terminalType === "delegation_completed" ? "completed" : "failed",
      );
      expect(markers.every((node) => !node.text.includes("SECRET CHILD"))).toBe(true);
      expect(markers.every((node) => !node.text.includes("worker"))).toBe(true);
      expect(
        store.nodes.filter((node) => node.subagentId === "worker").map((node) => node.kind),
      ).toEqual(["subagent", "tool_call"]);
      dispose();
    });
  }
});

test("the delegation capability mirror never creates Lead transcript rows", () => {
  const store = replayStore([
    ev({ type: "run_started", at: 0 }),
    ev({
      type: "capability_event",
      at: 1,
      capability: "delegation",
      kind: "delegation_created",
      projection: "delegation_created",
      truncated: false,
    }),
    ev({
      type: "capability_event",
      at: 2,
      capability: "audit",
      kind: "checkpoint",
      projection: "ready",
      truncated: false,
    }),
  ]);

  expect(
    store.nodes
      .filter((node) => node.kind === "annotation" && node.subagentId === undefined)
      .map((node) => node.text),
  ).toEqual(["audit.checkpoint: ready"]);
  expect(
    store.publicationBatches
      .flatMap((publication) => publication.nodes)
      .filter((node) => node.kind === "annotation" && node.subagentId === undefined)
      .map((node) => node.text),
  ).toEqual(["audit.checkpoint: ready"]);
});

test("Lead orchestration tools remain absent across live replay while child tools stay isolated", () => {
  createRoot((dispose) => {
    const store = createTranscriptStore();
    const sink = store.openRun("exec_orchestration");
    const stream: RunEvent[] = [ev({ type: "run_started", at: 0 })];

    for (const [index, tool] of transcriptExternalOrchestrationTools.entries()) {
      const callId = `orchestration-${index}`;
      stream.push(
        ev({
          type: "tool_input_delta",
          agent: "lead",
          call_id: callId,
          at: index * 3 + 1,
          tool,
          chars: 64,
        }),
        ev({
          type: "tool_call_started",
          agent: "lead",
          call_id: callId,
          at: index * 3 + 2,
          server: tool,
          tool: "",
          arguments: { task: "private orchestration payload" },
        }),
        ev({
          type: "tool_call",
          agent: "lead",
          call_id: callId,
          at: index * 3 + 3,
          server: tool,
          tool: "",
          arguments: { task: "private orchestration payload" },
          result: "private orchestration result",
          ok: true,
        }),
      );
    }
    stream.push(
      ev({
        type: "delegation_created",
        delegation_id: "worker",
        at: 40,
        title: "Explorer",
        task: "inspect ordinary tool attribution",
        tools: [],
      }),
      ev({
        type: "tool_call_started",
        agent: "subagent",
        subagent_id: "worker",
        call_id: "child-read",
        at: 41,
        server: "read_file",
        tool: "",
        arguments: { path: "src/index.ts" },
      }),
      ev({
        type: "tool_call",
        agent: "subagent",
        subagent_id: "worker",
        call_id: "child-read",
        at: 42,
        server: "read_file",
        tool: "",
        arguments: { path: "src/index.ts" },
        result: "ordinary child result",
        ok: true,
      }),
    );

    for (const event of stream) applyRunEvent(sink, event, "live");
    expect(store.nodes.filter((node) => node.kind === "tool_call")).toEqual([
      expect.objectContaining({
        key: "exec_orchestration::child-read",
        status: "ok",
        mcpName: "read_file",
        toolName: "",
        subagentId: "worker",
      }),
    ]);

    sink.beginReconcile();
    for (const event of stream) applyRunEvent(sink, event, "replay");
    sink.endReconcile();
    expect(store.nodes.filter((node) => node.kind === "tool_call")).toEqual([
      expect.objectContaining({
        key: "exec_orchestration::child-read",
        status: "ok",
        mcpName: "read_file",
        toolName: "",
        subagentId: "worker",
      }),
    ]);
    dispose();
  });
});

test("an MCP leaf collision survives replay while a child lifecycle missing its id fails closed", () => {
  createRoot((dispose) => {
    const store = createTranscriptStore();
    const sink = store.openRun("exec_collision");
    const stream: RunEvent[] = [
      ev({ type: "run_started", at: 0 }),
      ev({
        type: "tool_input_delta",
        agent: "lead",
        call_id: "mcp",
        at: 1,
        tool: "server_await_agents",
        chars: 64,
      }),
      ev({
        type: "tool_call_started",
        agent: "lead",
        call_id: "mcp",
        at: 2,
        server: "server",
        tool: "await_agents",
        arguments: { query: "downstream" },
      }),
      ev({
        type: "tool_call",
        agent: "lead",
        call_id: "mcp",
        at: 3,
        server: "server",
        tool: "await_agents",
        arguments: { query: "downstream" },
        result: "visible downstream result",
        ok: true,
      }),
      ev({
        type: "tool_call_started",
        agent: "subagent",
        call_id: "missing-child",
        at: 4,
        server: "read_file",
        tool: "",
        arguments: { path: "private.md" },
      }),
      ev({
        type: "tool_call",
        agent: "subagent",
        call_id: "missing-child",
        at: 5,
        server: "read_file",
        tool: "",
        arguments: { path: "private.md" },
        result: "private child result",
        ok: true,
      }),
      ev({ type: "run_ended", status: "completed", at: 6, reason: "completed" }),
    ];

    for (const event of stream) applyRunEvent(sink, event, "live");
    sink.beginReconcile();
    for (const event of stream) applyRunEvent(sink, event, "replay");
    sink.endReconcile();
    sink.complete();

    expect(store.nodes.filter((node) => node.kind === "tool_call")).toEqual([
      expect.objectContaining({
        key: "exec_collision::mcp",
        mcpName: "server",
        toolName: "await_agents",
        result: "visible downstream result",
      }),
    ]);
    expect(
      store.publicationBatches
        .flatMap((publication) => publication.nodes)
        .filter((node) => node.kind === "tool_call"),
    ).toEqual([
      expect.objectContaining({
        key: "exec_collision::mcp",
        mcpName: "server",
        toolName: "await_agents",
      }),
    ]);
    dispose();
  });
});

test("manual compaction annotations distinguish applied and skipped requests", () => {
  const nodes = replay([
    ev({ type: "run_started", at: 0 }),
    ev({
      type: "compaction",
      agent: "lead",
      operation: "summarization",
      requested: true,
      user_contribution_count: 1,
      at: 1,
    }),
    ev({
      type: "compaction",
      agent: "lead",
      operation: "eviction",
      fallback_reason: "summarization_failed",
      at: 1.5,
    }),
    ev({
      type: "compaction_skipped",
      agent: "lead",
      reason: "summarization_failed",
      at: 2,
    }),
  ]);
  const annotations = nodes.filter((node) => node.kind === "annotation");
  expect(annotations[0]!.text).toContain("requested compaction");
  expect(annotations[0]!.text).toContain("1 user instruction");
  expect(annotations[1]!.text).toContain("summarization failed");
  expect(annotations[2]).toMatchObject({ tone: "warn", status: "error" });
  expect(annotations[2]!.text).toContain("summarization failed");
});

test("a vision pre-pass annotates the transcript, and a failed one reads as failed", () => {
  const nodes = replay([
    ev({ type: "run_started", at: 0 }),
    ev({
      type: "vision_analysis",
      at: 1,
      model: "anthropic/vision",
      image_count: 2,
      status: "completed",
      result: "two cats",
    }),
    ev({
      type: "vision_analysis",
      at: 2,
      model: "anthropic/vision",
      image_count: 1,
      status: "failed",
      result: "boom",
    }),
  ]);
  const annotations = nodes.filter((node) => node.kind === "annotation");
  expect(annotations[0]).toMatchObject({ tone: "info", status: "ok" });
  expect(annotations[0]!.text).toContain("read 2 images");
  expect(annotations[0]!.text).toContain("anthropic/vision");
  expect(annotations[1]).toMatchObject({ tone: "warn", status: "error" });
  expect(annotations[1]!.text).toContain("image reading failed");
});

test("two same-type annotations in the same millisecond both land (sequence keys, no drop)", () => {
  const soft = (used: number): RunEvent =>
    ev({
      type: "soft_limit_check",
      at: 5,
      dimension: "tokens",
      used,
      limit: 100,
      outcome: "continued",
    });
  const nodes = replay([ev({ type: "run_started", at: 0 }), soft(50), soft(90)]);
  const anns = nodes.filter((n) => n.kind === "annotation");
  expect(anns).toHaveLength(2);
});

test("an elicitation request remains a pending attributed frontier annotation", () => {
  const nodes = replay([
    ev({ type: "run_started", at: 0 }),
    ev({
      type: "elicitation_requested",
      at: 1,
      agent: "subagent",
      subagent_id: "worker-1",
      question: "Which environment?",
      options: ["staging", "production"],
    }),
  ]);

  expect(nodes.find((node) => node.kind === "annotation")).toMatchObject({
    status: "pending",
    tone: "info",
    text: "asked: Which environment?",
    subagentId: "worker-1",
  });
});

test("user message keys stay unique after a reconcile shrinks the transcript (no silent drop)", () => {
  createRoot((dispose) => {
    const store = createTranscriptStore();
    const sink = store.openRun("exec_1");
    applyRunEvent(sink, ev({ type: "run_started", at: 0 }), "live");
    applyRunEvent(sink, leadTool("c1"), "live");
    store.appendUserMessage("first");
    sink.beginReconcile();
    applyRunEvent(sink, ev({ type: "run_started", at: 0 }), "replay");
    sink.endReconcile();
    store.appendUserMessage("second");
    const users = store.nodes.filter((n) => n.kind === "user");
    expect(users.map((n) => n.text)).toEqual(["first", "second"]);
    expect(new Set(users.map((n) => n.key)).size).toBe(2);
    dispose();
  });
});

test("appendUserMessage: displayText overrides the shown text; without it, the content shows", () => {
  createRoot((dispose) => {
    const store = createTranscriptStore();
    store.appendUserMessage(
      'The user invoked the "opentui" skill…\n\n--- SKILL ---\n<body>',
      "/opentui",
    );
    store.appendUserMessage("just a normal message");
    const users = store.nodes.filter((n) => n.kind === "user");
    expect(users.map((n) => n.text)).toEqual(["/opentui", "just a normal message"]);
    dispose();
  });
});

test("foldPrefixBefore replaces an arbitrarily large semantic prefix with one notice", () => {
  createRoot((dispose) => {
    const store = createTranscriptStore();
    store.appendUserMessage("old prompt", undefined, "exec_old");
    const oldSink = store.openRun("exec_old");
    for (let index = 0; index < 200; index += 1)
      applyRunEvent(oldSink, leadTool(`old-${index}`), "replay");

    const boundary = store.appendUserMessage("kept prompt", undefined, "exec_kept");
    const keptSink = store.openRun("exec_kept");
    applyRunEvent(keptSink, leadTool("kept"), "replay");
    const keptNodes = store.nodes.slice(store.nodes.findIndex((node) => node.key === boundary));

    expect(store.foldPrefixBefore(boundary, "1 earlier turn folded; use /export")).toBe(true);
    expect(store.nodes[0]).toMatchObject({
      kind: "annotation",
      text: expect.stringContaining("/export"),
    });
    expect(store.nodes.slice(1)).toEqual(keptNodes);
    expect(store.nodes.filter((node) => node.kind === "annotation")).toHaveLength(1);
    expect(store.nodes.some((node) => node.key.startsWith("exec_old::"))).toBe(false);
    expect(
      store.publicationBatches
        .flatMap((publication) => publication.nodes)
        .some((node) => node.key.startsWith("exec_old::")),
    ).toBe(false);
    expect(store.publicationBatches[0]).toMatchObject({
      id: "publication:folded-prefix:0",
      phase: "committed",
      ready: true,
    });
    expect(Object.isFrozen(store.publicationBatches[0]?.nodes[0])).toBe(true);
    dispose();
  });
});

test("repeated 20-turn retention folds keep semantic and publication ledgers at a plateau", () => {
  createRoot((dispose) => {
    const store = createTranscriptStore();
    const residentTurnLimit = 20;
    const residentUserKeys: string[] = [];
    const foldedPublicationIds = new Set<string>();
    let previousFoldedPublication = store.publicationBatches[0];

    for (let turn = 1; turn <= 80; turn += 1) {
      const executionId = `retention_${turn}`;
      residentUserKeys.push(store.appendUserMessage(`turn ${turn}`, undefined, executionId));
      const sink = store.openRun(executionId);
      applyRunEvent(sink, ev({ type: "run_started", at: turn * 10 }), "live");
      applyRunEvent(
        sink,
        ev({
          type: "iteration_started",
          agent: "lead",
          iteration: 1,
          at: turn * 10 + 1,
          model: "m",
        }),
        "live",
      );
      applyRunEvent(
        sink,
        ev({
          type: "iteration_completed",
          agent: "lead",
          iteration: 1,
          at: turn * 10 + 2,
          model: "m",
          response: `answer ${turn}`,
          response_phase: "final_answer",
          input_tokens: 1,
          output_tokens: 1,
        }),
        "live",
      );
      applyRunEvent(
        sink,
        ev({
          type: "run_ended",
          at: turn * 10 + 3,
          status: "completed",
          reason: "completed",
        }),
        "live",
      );
      sink.complete();
      if (residentUserKeys.length <= residentTurnLimit) continue;

      const notice = `${turn - residentTurnLimit} earlier turns folded`;
      expect(store.foldPrefixBefore(residentUserKeys[1]!, notice)).toBe(true);
      residentUserKeys.shift();

      const foldedPublication = store.publicationBatches[0]!;
      expect(foldedPublication.id).toStartWith("publication:folded-prefix:");
      expect(foldedPublication.id).not.toBe(previousFoldedPublication?.id);
      expect(foldedPublication).not.toBe(previousFoldedPublication);
      expect(foldedPublication.nodes).toEqual([
        expect.objectContaining({
          key: "transcript:folded-prefix",
          text: notice,
        }),
      ]);
      if (previousFoldedPublication !== undefined)
        expect(
          store.publicationBatches.some(
            (publication) => publication.id === previousFoldedPublication?.id,
          ),
        ).toBe(false);
      foldedPublicationIds.add(foldedPublication.id);
      previousFoldedPublication = foldedPublication;

      expect(store.nodes).toHaveLength(residentTurnLimit * 3 + 1);
      expect(store.publicationBatches).toHaveLength(residentTurnLimit * 2 + 1);
      expect(new Set(store.publicationBatches.map((publication) => publication.id)).size).toBe(
        residentTurnLimit * 2 + 1,
      );
      expect(store.memory?.()).toMatchObject({
        transcript_nodes: residentTurnLimit * 3 + 1,
        publication_batches: residentTurnLimit * 2 + 1,
        publication_known_keys: residentTurnLimit * 3,
      });
    }

    expect(foldedPublicationIds.size).toBe(80 - residentTurnLimit);
    expect(store.nodes.filter((node) => node.kind === "user").map((node) => node.key)).toEqual(
      residentUserKeys,
    );
    dispose();
  });
});

test("a completed retention discard projects neutral history into the transcript node", () => {
  const nodes = replay([
    ev({
      type: "plan_created",
      at: 1,
      id: "discarded-plan",
      title: "Disposable plan",
      status: "active",
      retention: "discard",
      revision: 1,
      spec_revision: 1,
      tasks: [{ id: "t1", title: "Finish", status: "in_progress" }],
    }),
    ev({
      type: "plan_updated",
      change: "status",
      at: 2,
      id: "discarded-plan",
      title: "Disposable plan",
      status: "completed",
      retention: "discard",
      revision: 2,
      spec_revision: 1,
      tasks: [{ id: "t1", title: "Finish", status: "done" }],
    }),
    ev({
      type: "plan_removed",
      at: 3,
      id: "discarded-plan",
      revision: 2,
      spec_revision: 1,
    }),
  ]);

  expect(nodes.find((node) => node.kind === "plan")).toMatchObject({
    status: "ok",
    planStatus: "completed",
    planRemoved: true,
    planDiscarded: true,
  });
});

test("foldPrefixBefore rejects absent and first-node boundaries without mutating the transcript", () => {
  createRoot((dispose) => {
    const store = createTranscriptStore();
    const first = store.appendUserMessage("keep me");
    const before = store.nodes.slice();

    expect(store.foldPrefixBefore("missing", "not used")).toBe(false);
    expect(store.foldPrefixBefore(first, "not used")).toBe(false);
    expect(store.nodes).toEqual(before);
    dispose();
  });
});

test("foldPrefixBefore removes queued hydration work owned by the folded prefix", async () => {
  const firstFetch = new Promise<never>(() => {});
  await createRoot(async (dispose) => {
    const store = createTranscriptStore({
      hydratedToolLimit: 1,
      maxConcurrentRehydrates: 1,
      maxQueuedRehydrates: 1,
      fetchRun: () => firstFetch,
    });

    store.appendUserMessage("old 0", undefined, "exec_old_0");
    const first = store.openRun("exec_old_0");
    applyRunEvent(first, leadTool("c0"), "live");
    applyRunEvent(first, leadTool("c1"), "live");

    store.appendUserMessage("old 1", undefined, "exec_old_1");
    const second = store.openRun("exec_old_1");
    applyRunEvent(second, leadTool("c0"), "live");
    applyRunEvent(second, leadTool("c1"), "live");

    const active = store.rehydrate("exec_old_0::c0");
    const queued = store.rehydrate("exec_old_1::c0");
    const boundary = store.appendUserMessage("new", undefined, "exec_new");

    expect(store.foldPrefixBefore(boundary, "two turns folded")).toBe(true);
    await queued;
    expect(store.nodes.map((node) => node.key)).toEqual(["transcript:folded-prefix", boundary]);

    // The active fetch deliberately stays unresolved; disposal proves folding
    // does not need it to finish before releasing all queued-prefix state.
    void active;
    dispose();
  });
});

test("dropComposing settles a named composing tool instead of removing it", () => {
  const nodes = replay([
    ev({ type: "run_started", at: 1 }),
    ev({
      type: "tool_input_delta",
      agent: "lead",
      call_id: "read-1",
      at: 2,
      tool: "read_file",
      chars: 12,
    }),
    ev({ type: "iteration_started", agent: "lead", iteration: 2, at: 3, model: "m" }),
  ]);
  const tool = nodes.find((node) => node.kind === "tool_call");
  expect(tool).toMatchObject({
    key: "exec_1::read-1",
    kind: "tool_call",
    toolName: "read_file",
    status: "error",
  });
  expect(tool?.kind === "tool_call" ? tool.inputChars : "not-tool").toBeUndefined();
});

test("dropComposing still removes a nameless composing placeholder", () => {
  const nodes = replay([
    ev({ type: "run_started", at: 1 }),
    ev({
      type: "tool_input_delta",
      agent: "lead",
      call_id: "anon",
      at: 2,
      tool: "",
      chars: 4,
    }),
    ev({ type: "iteration_started", agent: "lead", iteration: 2, at: 3, model: "m" }),
  ]);
  expect(nodes.some((node) => node.key === "exec_1::anon")).toBe(false);
});
