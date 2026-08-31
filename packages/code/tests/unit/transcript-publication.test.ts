import { describe, expect, test } from "bun:test";
import type { RunDetail, RunEvent } from "@clarvis/protocol";
import { $RAW } from "solid-js/store";
import {
  applyEvent,
  createTranscriptStore,
  type TranscriptNode,
  type TranscriptRunSink,
  type TranscriptStore,
} from "../../src/adapters/store.ts";
import {
  TranscriptPublisher,
  TRANSCRIPT_TOOL_GROUP_LATENCY_MS,
  TRANSCRIPT_TOOL_GROUP_MAX_ENTRIES,
  snapshotTranscriptNode,
  type TranscriptPublicationScheduler,
  type TranscriptPublisherHost,
} from "../../src/adapters/transcript-publication.ts";
import { TRANSCRIPT_MOUNTED_TEXT_MAX_CHARS } from "../../src/core/transcript/presenters.ts";

class ManualPublicationScheduler implements TranscriptPublicationScheduler {
  readonly #jobs = new Map<number, () => void>();
  readonly delays: number[] = [];
  #next = 0;

  schedule(callback: () => void, delayMs: number): number {
    const id = this.#next++;
    this.#jobs.set(id, callback);
    this.delays.push(delayMs);
    return id;
  }

  cancel(handle: unknown): void {
    if (typeof handle === "number") this.#jobs.delete(handle);
  }

  get pendingJobs(): number {
    return this.#jobs.size;
  }

  flush(): void {
    const jobs = [...this.#jobs.values()];
    this.#jobs.clear();
    for (const job of jobs) job();
  }
}

function fixture(): {
  store: TranscriptStore;
  scheduler: ManualPublicationScheduler;
  sink: TranscriptRunSink;
} {
  const scheduler = new ManualPublicationScheduler();
  const store = createTranscriptStore({
    publicationScheduler: scheduler,
    publicationToolGroupLatencyMs: 80,
  });
  return { store, scheduler, sink: store.openRun("exec") };
}

function event(sink: TranscriptRunSink, value: RunEvent, source: "live" | "replay" = "live"): void {
  applyEvent(sink, value, source);
}

function revealAll(store: TranscriptStore): void {
  for (const publication of store.publicationBatches) store.markPublicationReady(publication.id);
}

function runStarted(): RunEvent {
  return { type: "run_started", at: 1, lead_model: "openai/gpt-5" };
}

function iterationStarted(iteration: number): RunEvent {
  return {
    type: "iteration_started",
    at: iteration * 10,
    agent: "lead",
    iteration,
    model: "openai/gpt-5",
  };
}

function iterationCompleted(
  iteration: number,
  response: string,
  response_phase?: "commentary" | "final_answer",
): RunEvent {
  return {
    type: "iteration_completed",
    at: iteration * 10 + 5,
    agent: "lead",
    iteration,
    model: "openai/gpt-5",
    response,
    ...(response_phase === undefined ? {} : { response_phase }),
    input_tokens: 10,
    output_tokens: 5,
  };
}

function toolCall(
  call_id: string,
  tool: string,
  result: string,
  subagent_id?: string,
  server = "builtin",
): RunEvent {
  return {
    type: "tool_call",
    at: 20,
    agent: subagent_id === undefined ? "lead" : "subagent",
    ...(subagent_id === undefined ? {} : { subagent_id }),
    call_id,
    tool,
    server,
    arguments: { path: `${call_id}.md`, content: `# ${call_id}` },
    ok: true,
    result,
  };
}

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

function runEnded(): RunEvent {
  return { type: "run_ended", at: 100, status: "completed", reason: "completed" };
}

function runDetail(events: RunEvent[]): RunDetail {
  return {
    execution_id: "exec",
    status: "completed",
    created_at: 1,
    messages: [],
    events,
  };
}

describe("transcript publication", () => {
  test("the terminal sweep cannot freeze a bare orchestration node that escaped the reducer", () => {
    const nodes: TranscriptNode[] = [
      {
        key: "exec::escaped-await",
        kind: "tool_call",
        status: "ok",
        text: "",
        mcpName: "await_agents",
        toolName: "",
        result: "private orchestration result",
      },
    ];
    const published: TranscriptNode[] = [];
    const publisher = new TranscriptPublisher({
      nodes: () => nodes,
      defaultFolded: () => false,
      toolArguments: () => undefined,
      append: (batch) => published.push(...batch.nodes),
    });

    publisher.completeRun("exec");

    expect(published).toEqual([]);
    expect(publisher.knownKeyCount()).toBe(0);
  });

  test("discard release keeps resident identities and forgets only removed publication keys", () => {
    let nodes: TranscriptNode[] = [
      { key: "user:retained", kind: "user", status: "ok", text: "retained" },
    ];
    const publisher = new TranscriptPublisher({
      nodes: () => nodes,
      defaultFolded: () => false,
      toolArguments: () => undefined,
      append: () => undefined,
    });

    publisher.publishImmediate("user:retained", "user");
    expect(publisher.knownKeyCount()).toBe(1);

    publisher.forgetDiscarded(["user:retained"]);
    expect(publisher.knownKeyCount()).toBe(1);

    nodes = [];
    publisher.forgetDiscarded(["user:retained"]);
    expect(publisher.knownKeyCount()).toBe(0);
  });

  test("retention cancels discarded staging and cannot resurrect it on a later scheduler flush", () => {
    const { store, scheduler, sink } = fixture();
    store.appendUserMessage("discarded turn", undefined, "exec");
    event(sink, runStarted());
    event(sink, toolCall("pending", "read_file", "discarded result"));
    const boundary = store.appendUserMessage("retained turn");

    expect(scheduler.pendingJobs).toBe(1);
    expect(store.memory?.().publication_known_keys).toBe(3);
    expect(store.foldPrefixBefore(boundary, "1 earlier turn folded")).toBe(true);
    expect(scheduler.pendingJobs).toBe(0);
    expect(store.memory?.()).toMatchObject({
      transcript_nodes: 2,
      publication_batches: 2,
      publication_known_keys: 1,
    });

    scheduler.flush();
    expect(
      store.publicationBatches
        .flatMap((publication) => publication.nodes)
        .some((node) => node.key === "exec::pending"),
    ).toBe(false);
  });

  test("publication retains only the bounded inline prose projection", () => {
    const snapshot = snapshotTranscriptNode({
      key: "user:large",
      kind: "user",
      status: "ok",
      text: "x".repeat(TRANSCRIPT_MOUNTED_TEXT_MAX_CHARS + 10_000),
    });
    expect(snapshot.text).toHaveLength(TRANSCRIPT_MOUNTED_TEXT_MAX_CHARS);
    expect(snapshot.text).toContain("Display shortened to keep the terminal responsive");
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  test("committed history remains an identity-preserving prefix after every later event", () => {
    const { store, scheduler, sink } = fixture();
    const events: RunEvent[] = [
      runStarted(),
      iterationStarted(1),
      toolCall("read-1", "read_file", "one"),
      iterationCompleted(1, "intermediate", "commentary"),
      iterationStarted(2),
      iterationCompleted(2, "final", "final_answer"),
      runEnded(),
    ];
    let previous = store.committedNodes();
    for (const value of events) {
      event(sink, value);
      scheduler.flush();
      revealAll(store);
      const next = store.committedNodes();
      expect(next.slice(0, previous.length)).toEqual([...previous]);
      for (let index = 0; index < previous.length; index += 1)
        expect(next[index]).toBe(previous[index]);
      previous = next;
    }
    sink.complete();
    revealAll(store);
    const next = store.committedNodes();
    for (let index = 0; index < previous.length; index += 1)
      expect(next[index]).toBe(previous[index]);
  });

  test("a reserved tool snapshot cannot be patched by later replay reconciliation", () => {
    const { store, scheduler, sink } = fixture();
    event(sink, runStarted());
    event(sink, toolCall("memory", "write_memory", "original"));
    scheduler.flush();
    revealAll(store);
    const published = store.committedNodes().find((node) => node.key === "exec::memory");
    expect(published?.kind).toBe("tool_call");
    if (published?.kind !== "tool_call") throw new Error("tool publication missing");
    expect(published.result).toBe("original");
    const rawPublished = (published as unknown as { [$RAW]?: object })[$RAW] ?? published;
    const rawArguments =
      published.args === undefined
        ? undefined
        : ((published.args as Record<PropertyKey, unknown>)[$RAW] ?? published.args);
    expect(Object.isFrozen(rawPublished)).toBe(true);
    expect(Object.isFrozen(rawArguments)).toBe(true);

    sink.beginReconcile();
    event(sink, runStarted(), "replay");
    event(sink, toolCall("memory", "write_memory", "changed by replay"), "replay");
    event(sink, runEnded(), "replay");
    sink.endReconcile();
    sink.complete();
    revealAll(store);

    const after = store.committedNodes().find((node) => node.key === "exec::memory");
    expect(after).toBe(published);
    expect(after?.kind === "tool_call" ? after.result : undefined).toBe("original");
    const mutable = store.nodes.find((node) => node.key === "exec::memory");
    expect(mutable?.kind === "tool_call" ? mutable.result : undefined).toBe("changed by replay");
  });

  test("same-tool calls seal as one prepublication group and a different tool closes it", () => {
    const { store, scheduler, sink } = fixture();
    event(sink, runStarted());
    event(sink, toolCall("a", "read_file", "A"));
    event(sink, toolCall("b", "read_file", "B"));
    expect(store.publicationBatches).toHaveLength(0);
    expect(scheduler.delays).toEqual([TRANSCRIPT_TOOL_GROUP_LATENCY_MS]);

    event(sink, toolCall("c", "search", "C"));
    expect(store.publicationBatches).toHaveLength(1);
    expect(store.publicationBatches[0]!.kind).toBe("tool_group");
    expect(store.publicationBatches[0]!.nodes.map((node) => node.key)).toEqual([
      "exec::a",
      "exec::b",
    ]);
    expect(store.publicationBatches[0]!.toolGroups["exec::a"]?.role).toBe("head");
    expect(store.publicationBatches[0]!.toolGroups["exec::b"]?.role).toBe("member");
    expect(
      store.publicationBatches[0]!.toolGroups["exec::a"]?.members?.map((node) => node.key),
    ).toEqual(store.publicationBatches[0]!.nodes.map((node) => node.key));
    const firstPublished = store.publicationBatches[0]!.nodes[0];
    expect(firstPublished?.kind).toBe("tool_call");
    if (firstPublished?.kind !== "tool_call") throw new Error("tool group head missing");
    expect(store.publicationBatches[0]!.toolGroups["exec::a"]?.members?.[0]).toBe(firstPublished);
    expect(Object.isFrozen(store.publicationBatches[0]!.toolGroups)).toBe(true);

    scheduler.flush();
    expect(store.publicationBatches[1]!.nodes.map((node) => node.key)).toEqual(["exec::c"]);
    expect(store.publicationBatches[1]!.toolGroups["exec::c"]).toEqual({
      role: "solo",
      ordinal: 0,
      size: 1,
    });

    event(sink, toolCall("d", "read_file", "D"));
    event(sink, iterationStarted(1));
    expect(store.publicationBatches[2]!.nodes.map((node) => node.key)).toEqual(["exec::d"]);
  });

  test("live publication never groups the same leaf name from different MCP servers", () => {
    const { store, scheduler, sink } = fixture();
    event(sink, runStarted());
    event(sink, toolCall("alpha-run", "run", "A", undefined, "alpha"));
    event(sink, toolCall("beta-run", "run", "B", undefined, "beta"));

    scheduler.flush();
    expect(store.publicationBatches).toHaveLength(2);
    expect(store.publicationBatches[0]!.nodes.map((node) => node.key)).toEqual(["exec::alpha-run"]);
    expect(store.publicationBatches[0]!.toolGroups["exec::alpha-run"]?.role).toBe("solo");

    expect(store.publicationBatches[1]!.nodes.map((node) => node.key)).toEqual(["exec::beta-run"]);
    expect(store.publicationBatches[1]!.toolGroups["exec::beta-run"]?.role).toBe("solo");
  });

  test("terminal sweep never groups the same leaf name from different MCP servers", () => {
    const nodes: TranscriptNode[] = [
      {
        key: "exec::alpha-run",
        kind: "tool_call",
        status: "ok",
        text: "",
        mcpName: "alpha",
        toolName: "run",
        result: "A",
      },
      {
        key: "exec::beta-run",
        kind: "tool_call",
        status: "ok",
        text: "",
        mcpName: "beta",
        toolName: "run",
        result: "B",
      },
    ];
    const publications: Parameters<TranscriptPublisherHost["append"]>[0][] = [];
    const publisher = new TranscriptPublisher({
      nodes: () => nodes,
      defaultFolded: () => false,
      toolArguments: () => undefined,
      append: (batch) => publications.push(batch),
    });

    publisher.completeRun("exec");

    const toolPublications = publications.filter((batch) => batch.kind === "tool_group");
    expect(toolPublications.map((batch) => batch.nodes.map((node) => node.key))).toEqual([
      ["exec::alpha-run"],
      ["exec::beta-run"],
    ]);
    expect(toolPublications[0]!.toolGroups["exec::alpha-run"]?.role).toBe("solo");
    expect(toolPublications[1]!.toolGroups["exec::beta-run"]?.role).toBe("solo");
  });

  test("continuous same-tool traffic seals at the default pressure ceiling", () => {
    const scheduler = new ManualPublicationScheduler();
    const store = createTranscriptStore({
      publicationScheduler: scheduler,
      publicationToolGroupLatencyMs: 80,
    });
    const sink = store.openRun("exec");
    event(sink, runStarted());
    for (let index = 0; index < TRANSCRIPT_TOOL_GROUP_MAX_ENTRIES - 1; index += 1)
      event(sink, toolCall(`call-${index}`, "read_file", `result-${index}`));
    expect(store.publicationBatches).toHaveLength(0);
    event(
      sink,
      toolCall(`call-${TRANSCRIPT_TOOL_GROUP_MAX_ENTRIES - 1}`, "read_file", "ceiling result"),
    );
    expect(store.publicationBatches).toHaveLength(1);
    expect(store.publicationBatches[0]!.nodes).toHaveLength(TRANSCRIPT_TOOL_GROUP_MAX_ENTRIES);

    event(sink, toolCall("after-ceiling", "read_file", "after"));
    expect(store.publicationBatches).toHaveLength(1);
    scheduler.flush();
    expect(store.publicationBatches[1]!.nodes.map((node) => node.key)).toEqual([
      "exec::after-ceiling",
    ]);
  });

  test("tool staging freezes the bounded terminal body before mutable retention dehydrates it", () => {
    const scheduler = new ManualPublicationScheduler();
    const store = createTranscriptStore({
      publicationScheduler: scheduler,
      publicationToolGroupLatencyMs: 80,
      hydratedToolLimit: 1,
    });
    const sink = store.openRun("exec");
    event(sink, runStarted());
    event(sink, toolCall("a", "read_file", "original-a"));
    event(sink, toolCall("b", "read_file", "original-b"));
    const mutableA = store.nodes.find((node) => node.key === "exec::a");
    expect(mutableA?.kind === "tool_call" ? mutableA.dehydrated : undefined).toBe(true);

    scheduler.flush();
    revealAll(store);
    const publishedA = store.committedNodes().find((node) => node.key === "exec::a");
    expect(publishedA?.kind === "tool_call" ? publishedA.result : undefined).toBe("original-a");
    expect(publishedA?.kind === "tool_call" ? publishedA.dehydrated : true).toBeUndefined();
    if (publishedA?.kind !== "tool_call") throw new Error("published tool missing");
    for (const field of ["liveOutput", "inputChars", "dehydrated", "hydrationNotice"] as const)
      expect(Object.prototype.hasOwnProperty.call(publishedA, field)).toBe(false);
  });

  test("sub-agent tool staging also freezes before delegation completion and dehydration", () => {
    const scheduler = new ManualPublicationScheduler();
    const store = createTranscriptStore({
      publicationScheduler: scheduler,
      publicationToolGroupLatencyMs: 80,
      hydratedToolLimit: 1,
    });
    const sink = store.openRun("exec");
    event(sink, runStarted());
    event(sink, {
      type: "delegation_created",
      at: 2,
      delegation_id: "worker",
      title: "worker",
      task: "inspect",
    });
    event(sink, toolCall("child", "read_file", "original-child", "worker"));
    event(sink, toolCall("lead", "read_file", "lead-body"));
    const mutableChild = store.nodes.find((node) => node.key === "exec::child");
    expect(mutableChild?.kind === "tool_call" ? mutableChild.dehydrated : undefined).toBe(true);

    event(sink, {
      type: "delegation_completed",
      at: 30,
      delegation_id: "worker",
      status: "completed",
    });
    const child = store.publicationBatches
      .find((publication) => publication.kind === "subagent")
      ?.nodes.find((node) => node.key === "exec::child");
    expect(child?.kind === "tool_call" ? child.result : undefined).toBe("original-child");
    expect(child?.kind === "tool_call" ? child.dehydrated : true).toBeUndefined();
  });

  test("one sub-agent batch keeps equal leaf names from different MCP servers separate", () => {
    const { store, sink } = fixture();
    event(sink, runStarted());
    event(sink, {
      type: "delegation_created",
      at: 2,
      delegation_id: "worker",
      title: "worker",
      task: "inspect",
    });
    event(sink, toolCall("alpha-run", "run", "A", "worker", "alpha"));
    event(sink, toolCall("beta-run", "run", "B", "worker", "beta"));
    event(sink, {
      type: "delegation_completed",
      at: 30,
      delegation_id: "worker",
      status: "completed",
    });

    const child = store.publicationBatches.find((batch) => batch.kind === "subagent");
    expect(child?.nodes.map((node) => node.key)).toEqual([
      "exec::subagent:worker",
      "exec::alpha-run",
      "exec::beta-run",
    ]);
    expect(child?.toolGroups["exec::alpha-run"]?.role).toBe("solo");
    expect(child?.toolGroups["exec::beta-run"]?.role).toBe("solo");
  });

  test("Lead orchestration lifecycles never publish while child ordinary tools stay isolated", () => {
    const { store, scheduler, sink } = fixture();
    event(sink, runStarted());

    for (const [index, tool] of transcriptExternalOrchestrationTools.entries()) {
      const callId = `orchestration-${index}`;
      event(sink, {
        type: "tool_input_delta",
        at: index * 3 + 2,
        agent: "lead",
        call_id: callId,
        tool,
        chars: 64,
      });
      event(sink, {
        type: "tool_call_started",
        at: index * 3 + 3,
        agent: "lead",
        call_id: callId,
        server: tool,
        tool: "",
        arguments: { task: "private orchestration payload" },
      });
      event(sink, {
        type: "tool_call",
        at: index * 3 + 4,
        agent: "lead",
        call_id: callId,
        server: tool,
        tool: "",
        arguments: { task: "private orchestration payload" },
        result: "private orchestration result",
        ok: true,
      });
      expect(store.nodes.some((node) => node.kind === "tool_call")).toBe(false);
      expect(scheduler.pendingJobs).toBe(0);
    }

    expect(
      store.publicationBatches
        .flatMap((publication) => publication.nodes)
        .some((node) => node.kind === "tool_call"),
    ).toBe(false);

    event(sink, {
      type: "delegation_created",
      at: 40,
      delegation_id: "worker",
      title: "Explorer",
      task: "inspect ordinary tool attribution",
    });
    event(sink, toolCall("child-read", "read_file", "ordinary child result", "worker"));
    event(sink, {
      type: "delegation_completed",
      at: 42,
      delegation_id: "worker",
      status: "completed",
    });

    const publishedTools = store.publicationBatches
      .flatMap((publication) => publication.nodes)
      .filter((node) => node.kind === "tool_call");
    expect(publishedTools).toEqual([
      expect.objectContaining({
        key: "exec::child-read",
        toolName: "read_file",
        subagentId: "worker",
      }),
    ]);
  });

  test("delegation lifecycle markers publish once and replay cannot duplicate them", () => {
    for (const terminalType of ["delegation_completed", "delegation_failed"] as const) {
      const { store, sink } = fixture();
      const created: RunEvent = {
        type: "delegation_created",
        at: 2,
        delegation_id: "worker",
        title: "Research authentication",
        task: "SECRET CHILD BRIEF",
      };
      const started: RunEvent = {
        type: "delegation_started",
        at: 3,
        delegation_id: "worker",
        model: "openai/gpt-5",
      };
      const childTool = toolCall("child", "read_file", "SECRET CHILD RESULT", "worker");
      const terminal: RunEvent =
        terminalType === "delegation_completed"
          ? {
              type: terminalType,
              at: 4,
              delegation_id: "worker",
              status: "completed",
              summary: "SECRET CHILD SUMMARY",
            }
          : {
              type: terminalType,
              at: 4,
              delegation_id: "worker",
              status: "error",
              summary: "SECRET CHILD SUMMARY",
            };
      const leadMarkers = (): TranscriptNode[] =>
        store.publicationBatches
          .flatMap((publication) => publication.nodes)
          .filter(
            (node) =>
              node.subagentId === undefined &&
              node.text.toLowerCase().includes("research authentication"),
          );

      event(sink, runStarted());
      event(sink, created);
      const [spawned] = leadMarkers();
      expect(leadMarkers()).toHaveLength(1);
      expect(spawned?.text.toLowerCase()).toContain("spawned");
      expect(spawned?.text).toContain("A1");
      expect(spawned?.text).not.toContain("worker");
      expect(Object.isFrozen(spawned)).toBe(true);

      event(sink, started);
      expect(leadMarkers()).toEqual([spawned!]);
      event(sink, childTool);
      event(sink, terminal);

      const firstPublication = leadMarkers();
      expect(firstPublication).toHaveLength(2);
      expect(firstPublication[0]).toBe(spawned);
      expect(firstPublication[1]?.text.toLowerCase()).toContain(
        terminalType === "delegation_completed" ? "completed" : "failed",
      );
      expect(firstPublication.every((node) => !node.text.includes("SECRET CHILD"))).toBe(true);
      expect(firstPublication.every((node) => !node.text.includes("worker"))).toBe(true);
      const markerKeys = firstPublication.map((node) => node.key);
      expect(new Set(markerKeys).size).toBe(2);
      for (const key of markerKeys)
        expect(
          store.publicationBatches
            .flatMap((publication) => publication.nodes)
            .filter((node) => node.key === key),
        ).toHaveLength(1);

      sink.beginReconcile();
      for (const replayed of [runStarted(), created, started, childTool, terminal])
        event(sink, replayed, "replay");
      sink.endReconcile();

      const afterReplay = leadMarkers();
      expect(afterReplay).toEqual(firstPublication);
      expect(afterReplay[0]).toBe(firstPublication[0]);
      expect(afterReplay[1]).toBe(firstPublication[1]);
      for (const key of markerKeys)
        expect(
          store.publicationBatches
            .flatMap((publication) => publication.nodes)
            .filter((node) => node.key === key),
        ).toHaveLength(1);
    }
  });

  test("a reserved sub-agent terminal survives a stored replay that omits its live node", () => {
    const { store, sink } = fixture();
    event(sink, runStarted());
    event(sink, {
      type: "delegation_created",
      at: 2,
      delegation_id: "worker",
      title: "worker",
      task: "inspect",
    });
    event(sink, toolCall("child", "read_file", "live-terminal", "worker"));

    sink.beginReconcile();
    event(sink, runStarted(), "replay");
    event(sink, runEnded(), "replay");
    sink.endReconcile();
    expect(store.nodes.some((node) => node.key === "exec::child")).toBe(false);
    sink.complete();

    const child = store.publicationBatches
      .find((publication) => publication.kind === "subagent")
      ?.nodes.find((node) => node.key === "exec::child");
    expect(child?.kind === "tool_call" ? child.result : undefined).toBe("live-terminal");
    expect(Object.isFrozen(child)).toBe(true);
  });

  test("explicit detail hydration never mutates the bounded committed tool snapshot", async () => {
    const first = toolCall("a", "read_file", "persisted-a");
    const scheduler = new ManualPublicationScheduler();
    const store = createTranscriptStore({
      publicationScheduler: scheduler,
      publicationToolGroupLatencyMs: 80,
      hydratedToolLimit: 1,
      fetchRun: async () => runDetail([first]),
    });
    const sink = store.openRun("exec");
    event(sink, runStarted());
    event(sink, first);
    event(sink, toolCall("b", "read_file", "persisted-b"));
    scheduler.flush();
    revealAll(store);

    const before = store.committedNodes().find((node) => node.key === "exec::a");
    expect(before?.kind === "tool_call" ? before.result : undefined).toBe("persisted-a");
    expect(
      store.nodes.find((node) => node.key === "exec::a")?.kind === "tool_call"
        ? (store.nodes.find((node) => node.key === "exec::a") as { dehydrated?: true }).dehydrated
        : undefined,
    ).toBe(true);

    await store.rehydrate("exec::a");
    const after = store.committedNodes().find((node) => node.key === "exec::a");
    expect(after).toBe(before);
    expect(after?.kind === "tool_call" ? after.result : undefined).toBe("persisted-a");
    expect(Object.isFrozen(after)).toBe(true);
  });

  test("sub-agent sections append in terminal completion order", () => {
    const { store, sink } = fixture();
    event(sink, runStarted());
    event(sink, {
      type: "delegation_created",
      at: 2,
      delegation_id: "a",
      title: "first",
      task: "first task",
    });
    event(sink, {
      type: "delegation_created",
      at: 3,
      delegation_id: "b",
      title: "second",
      task: "second task",
    });
    event(sink, toolCall("a-tool", "read_file", "A", "a"));
    event(sink, toolCall("b-tool", "read_file", "B", "b"));
    event(sink, {
      type: "delegation_completed",
      at: 30,
      delegation_id: "b",
      status: "completed",
    });
    event(sink, {
      type: "delegation_completed",
      at: 40,
      delegation_id: "a",
      status: "completed",
    });

    const sections = store.publicationBatches.filter(
      (publication) => publication.kind === "subagent",
    );
    expect(sections).toHaveLength(2);
    expect(sections[0]!.nodes.every((node) => node.subagentId === "b")).toBe(true);
    expect(sections[1]!.nodes.every((node) => node.subagentId === "a")).toBe(true);
    expect(Object.values(sections[0]!.sectionHeaders)).toHaveLength(1);
    expect(Object.values(sections[0]!.sectionHeaders)[0]?.status).toBe("ok");
    expect(Object.isFrozen(sections[0]!.sectionHeaders)).toBe(true);
  });

  test("unfinished sub-agent sections seal in spawn order at the run boundary", () => {
    const { store, sink } = fixture();
    event(sink, runStarted());
    event(sink, {
      type: "delegation_created",
      at: 2,
      delegation_id: "first",
      title: "first",
      task: "first task",
    });
    event(sink, {
      type: "delegation_created",
      at: 3,
      delegation_id: "second",
      title: "second",
      task: "second task",
    });
    event(sink, toolCall("second-tool", "read_file", "second", "second"));
    event(sink, toolCall("first-tool", "read_file", "first", "first"));
    event(sink, runEnded());
    sink.complete();

    const sections = store.publicationBatches.filter(
      (publication) => publication.kind === "subagent",
    );
    expect(sections).toHaveLength(2);
    expect(sections.map((section) => section.nodes[0]?.subagentId)).toEqual(["first", "second"]);
  });

  test("final answer and run outcome share one continuity-preserving atomic batch", () => {
    const { store, sink } = fixture();
    event(sink, runStarted());
    event(sink, iterationStarted(1));
    event(sink, iterationCompleted(1, "the final answer", "final_answer"));
    expect(store.publicationBatches.flatMap((publication) => publication.nodes)).toHaveLength(0);
    expect(store.frontierNodes().some((node) => node.kind === "assistant")).toBe(true);

    event(sink, runEnded());
    expect(
      store.publicationBatches.some((publication) => publication.kind === "run_terminal"),
    ).toBe(false);
    sink.complete();

    const terminal = store.publicationBatches.find(
      (publication) => publication.kind === "run_terminal",
    );
    expect(terminal?.nodes.map((node) => node.kind)).toEqual(["assistant", "run"]);
    expect(terminal).toMatchObject({ phase: "committed", ready: true });
    store.markPublicationReady(terminal!.id);
    const committedTerminal = store.publicationBatches.find(
      (publication) => publication.id === terminal?.id,
    );
    expect(committedTerminal?.phase).toBe("committed");
    expect(committedTerminal).toBe(terminal);
    expect(committedTerminal?.nodes).toBe(terminal?.nodes);
    expect(store.frontierNodes().some((node) => node.kind === "assistant")).toBe(false);
  });

  test("a completed sink cannot resurrect discarded or terminal run state", () => {
    const { store, scheduler, sink } = fixture();
    event(sink, runStarted());
    event(sink, iterationStarted(1));
    event(sink, iterationCompleted(1, "settled", "final_answer"));
    event(sink, runEnded());
    sink.complete();
    const nodes = [...store.nodes];
    const publications = [...store.publicationBatches];

    event(sink, iterationStarted(2));
    event(sink, iterationCompleted(2, "must never return", "commentary"));
    event(sink, toolCall("late", "write_file", "late mutation"));
    sink.beginReconcile();
    sink.endReconcile();
    sink.complete();
    sink.queueSteer?.("late steer")?.();
    scheduler.flush();

    expect([...store.nodes]).toEqual(nodes);
    expect([...store.publicationBatches]).toEqual(publications);
    expect(store.nodes.some((node) => node.text.includes("must never return"))).toBe(false);
    expect(store.nodes.some((node) => node.key.includes("late"))).toBe(false);
  });

  test("live, replay-only, and session restoration seal equal degraded ledgers", () => {
    const storedStream: RunEvent[] = [
      runStarted(),
      iterationStarted(1),
      {
        type: "reasoning",
        at: 12,
        agent: "lead",
        iteration: 1,
        text: "inspect before answering",
      },
      toolCall("read", "read_file", "read result"),
      iterationCompleted(1, "commentary", "commentary"),
      iterationStarted(2),
      iterationCompleted(2, "final", "final_answer"),
      runEnded(),
    ];
    const liveOnly: RunEvent[] = [
      {
        type: "plan_created",
        at: 16,
        id: "11111111-1111-1111-1111-111111111111",
        path: ".clarvis/plans/work.md",
        title: "Live plan",
        status: "active",
        retention: "keep",
        revision: 1,
        spec_revision: 1,
        tasks: [{ id: "t1", title: "Work", status: "in_progress" }],
      },
      {
        type: "workflow_run_progress",
        at: 17,
        run_id: "leader",
        parent_run_id: "manager",
        iterations: 2,
        input_tokens: 100,
        output_tokens: 20,
      },
    ];
    const degraded = {
      degraded: "Stored run reconciliation was unavailable in this fixture.",
    };

    const live = fixture();
    live.store.appendUserMessage("do the work", undefined, "exec");
    for (const value of [...storedStream.slice(0, 4), ...liveOnly, ...storedStream.slice(4)])
      event(live.sink, value);
    live.sink.beginReconcile();
    for (const value of storedStream) event(live.sink, value, "replay");
    live.sink.endReconcile();
    live.sink.complete(degraded);

    const restored = fixture();
    restored.store.appendUserMessage("do the work", undefined, "exec");
    restored.sink.beginReconcile();
    for (const value of storedStream) event(restored.sink, value, "replay");
    restored.sink.endReconcile();
    restored.sink.complete(degraded);

    const session = fixture();
    session.store.appendUserMessage("do the work", undefined, "exec");
    session.sink.beginReconcile();
    for (const value of storedStream) event(session.sink, value, "replay");
    session.sink.endReconcile();
    session.sink.complete(degraded);

    const shape = (store: TranscriptStore) =>
      store.publicationBatches.map((publication) => ({
        kind: publication.kind,
        defaultFolded: publication.defaultFolded,
        toolGroups: publication.toolGroups,
        sectionHeaders: publication.sectionHeaders,
        nodes: publication.nodes.map((node) => ({
          key: node.key,
          kind: node.kind,
          status: node.status,
          text: node.text,
        })),
      }));
    expect(shape(restored.store)).toEqual(shape(live.store));
    expect(shape(session.store)).toEqual(shape(live.store));
    expect(shape(live.store).filter((batch) => batch.kind === "degraded")).toHaveLength(1);
    expect(
      live.store.publicationBatches
        .flatMap((publication) => publication.nodes)
        .some((node) => node.kind === "plan"),
    ).toBe(false);
  });

  test("generated mixed streams retain the exact committed identity prefix", () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      const { store, scheduler, sink } = fixture();
      event(sink, runStarted());
      let random = seed;
      let iteration = 0;
      let call = 0;
      let delegation = 0;
      let previous = store.committedNodes();
      const nextRandom = (): number => {
        random = (random * 1_664_525 + 1_013_904_223) >>> 0;
        return random;
      };

      for (let step = 0; step < 24; step += 1) {
        const choice = nextRandom() % 3;
        if (choice === 0) {
          const id = `call-${call++}`;
          event(sink, toolCall(id, nextRandom() % 2 === 0 ? "read_file" : "search", id));
        } else if (choice === 1) {
          iteration += 1;
          event(sink, iterationStarted(iteration));
          event(sink, iterationCompleted(iteration, `commentary ${iteration}`, "commentary"));
        } else {
          const id = `worker-${delegation++}`;
          event(sink, {
            type: "delegation_created",
            at: step * 10 + 2,
            delegation_id: id,
            title: id,
            task: `task ${id}`,
          });
          event(sink, toolCall(`child-${id}`, "read_file", id, id));
          event(sink, {
            type: "delegation_completed",
            at: step * 10 + 3,
            delegation_id: id,
            status: "completed",
          });
        }
        if (step % 3 === 0) scheduler.flush();
        revealAll(store);
        const next = store.committedNodes();
        for (let index = 0; index < previous.length; index += 1)
          expect(next[index]).toBe(previous[index]);
        previous = next;
      }

      scheduler.flush();
      event(sink, runEnded());
      sink.complete();
      revealAll(store);
      const final = store.committedNodes();
      for (let index = 0; index < previous.length; index += 1)
        expect(final[index]).toBe(previous[index]);
    }
  });
});
