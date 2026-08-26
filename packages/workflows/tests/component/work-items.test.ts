import { describe, expect, test } from "bun:test";
import {
  createSemaphore,
  type AgentHandle,
  type AgentRegistration,
  type LLMToolCall,
  type RunCapabilityContext,
  type RunRequest,
  type Usage,
} from "@clarvis/capability";
import type { ExecuteRunArgs, ExecuteRunOutcome } from "@clarvis/loop";
import { createAgentRegistry } from "@clarvis/supervision";
import { createWorkflowsCapability } from "../../src/capability.ts";
import { createWorkflowLedger } from "../../src/ledger.ts";
import { WORKFLOW_LIMITS } from "../../src/limits.ts";
import type { WorkItem } from "../../src/schedule.ts";
import type { LeaderSpec, WorkflowRunDeps } from "../../src/types.ts";
import { RUN_WORK_ITEMS_TOOL_NAME } from "../../src/work-items.ts";
import {
  makeCtx,
  promptFrom,
  recordingBc,
  requestWithPrompt,
  runContextWithAgents,
  scope,
  workflowRunDeps,
} from "../helpers/workflow.ts";

type AgentsLimits = Parameters<typeof createAgentRegistry>[0]["limits"];

const TEST_LIMITS: AgentsLimits = {
  bufferLines: 500,
  bufferBytes: 131_072,
  maxTotalBufferBytes: 6_291_456,
  pollMaxBytes: 8192,
  awaitTimeoutMs: 5000,
  maxLiveChildren: 16,
  maxRetainedChildren: 32,
  maxNoticesPerIteration: 8,
  maxConsecutiveFailedChildren: 3,
  finishNudges: 2,
};

function usage(output: number): Usage {
  return {
    iterations_used: 1,
    elapsed_ms: 0,
    by_agent: [
      {
        type: "lead",
        model: "m",
        input_tokens: 0,
        output_tokens: output,
        cached_tokens: 0,
        cache_write_tokens: 0,
        iterations: 1,
        subagents_spawned: 0,
      },
    ],
  };
}

function completed(result: unknown, output = 1): ExecuteRunOutcome {
  return {
    executionId: "ignored",
    response: { status: "completed", result, usage: usage(output) },
  };
}

function cancelled(): ExecuteRunOutcome {
  return {
    executionId: "ignored",
    response: { status: "cancelled", result: "", usage: usage(0) },
  };
}

function errored(message: string): ExecuteRunOutcome {
  return {
    executionId: "ignored",
    response: {
      status: "error",
      error: { code: "boom", message },
      usage: usage(0),
    },
  };
}

function promptRunDeps(
  execute: (prompt: string, args: ExecuteRunArgs) => Promise<ExecuteRunOutcome>,
): WorkflowRunDeps {
  return workflowRunDeps((args) => {
    return execute(promptFrom(args), args);
  });
}

/** The assembler used throughout: carries the brief so the per-context fake can key on it. */
const assembler = (spec: LeaderSpec): RunRequest => requestWithPrompt(spec.prompt);

/**
 * A run context whose registry records, for every settlement, how many children
 * were still live afterwards — which is exactly what the wave-boundary baton is
 * supposed to keep above zero.
 */
function instrumentedRunCtx(over: Partial<AgentsLimits> = {}): {
  runCtx: RunCapabilityContext;
  registry: ReturnType<typeof createAgentRegistry>;
  registrations: number;
  events: string[];
  liveAfterSettle: number[];
  settle: () => Promise<void>;
} {
  const registry = createAgentRegistry({ limits: { ...TEST_LIMITS, ...over } });
  let registrations = 0;
  const events: string[] = [];
  const liveAfterSettle: number[] = [];
  const tasks: Promise<unknown>[] = [];
  const wrapped = {
    ...registry,
    register(registration: AgentRegistration): AgentHandle | null {
      registrations += 1;
      const handle = registry.register(registration);
      if (handle === null) return null;
      events.push(`register:${registration.title}`);
      return {
        ...handle,
        settled(settlement) {
          handle.settled(settlement);
          events.push(`settle:${registration.title}`);
          liveAfterSettle.push(registry.liveCount());
        },
      } satisfies AgentHandle;
    },
    adopt(id: string, task: Promise<unknown>): void {
      tasks.push(task);
      registry.adopt(id, task);
    },
  };
  return {
    runCtx: runContextWithAgents(wrapped),
    registry,
    get registrations(): number {
      return registrations;
    },
    events,
    liveAfterSettle,
    settle: async (): Promise<void> => {
      await Promise.allSettled([...tasks]);
    },
  };
}

function item(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    title: `Do ${id}`,
    goal: `goal ${id}`,
    files: [],
    dependencies: [],
    mutation: false,
    ...over,
  };
}

function call(args: Record<string, unknown>): LLMToolCall {
  return { id: "call", name: RUN_WORK_ITEMS_TOOL_NAME, arguments: args };
}

/** Build the `run_work_items` handler over the given context, ready to call. */
async function harness(
  execute?: (prompt: string, args: ExecuteRunArgs) => Promise<ExecuteRunOutcome>,
  ctxOver: Parameters<typeof makeCtx>[0] = {},
  limits: Partial<AgentsLimits> = {},
): Promise<{
  handle: (args: Record<string, unknown>) => Promise<{ text: string; progress: boolean }>;
  records: Array<{ kind: string; detail: unknown }>;
  run: ReturnType<typeof instrumentedRunCtx>;
  ledger: ReturnType<typeof createWorkflowLedger>;
}> {
  const ledger = ctxOver.ledger ?? createWorkflowLedger(null);
  const ctx = makeCtx({
    assemble: assembler,
    ledger,
    ...(execute !== undefined ? { runDeps: promptRunDeps(execute) } : {}),
    ...ctxOver,
  });
  const run = instrumentedRunCtx(limits);
  const { bc, records } = recordingBc();
  const capability = await createWorkflowsCapability(ctx).forRun(run.runCtx);
  const handler = capability!.forAgent(scope())!.attach(bc).handlers![1]!;
  return {
    handle: async (args) => {
      const verdict = await handler.handle(call(args), 0);
      if (verdict.kind !== "result") throw new Error(`expected a result, got ${verdict.kind}`);
      return { text: verdict.text, progress: verdict.progress };
    },
    records,
    run,
    ledger,
  };
}

/** Trace kinds recorded for a given run, in order. */
function kinds(records: Array<{ kind: string; detail: unknown }>, kind: string): unknown[] {
  return records.filter((r) => r.kind === kind).map((r) => r.detail);
}

describe("run_work_items — calls it refuses without dispatching anything", () => {
  test.each([
    ["arguments that are not an object", "not an object" as unknown, "expected an object"],
    ["a missing items array", {}, "'items' is required"],
    ["an items entry that is not an object", { items: ["nope"] }, "items[0] is malformed"],
    ["an empty batch", { items: [] }, "nothing to run"],
  ])("rejects %s", async (_label, args, expected) => {
    const h = await harness();
    const verdict = await h.handle(args as Record<string, unknown>);
    expect(verdict.text).toContain(expected);
    expect(verdict.progress).toBe(false);
    expect(h.run.registrations).toBe(0);
    expect(h.run.events).toEqual([]);
  });

  test("propagates a scheduling failure instead of guessing", async () => {
    const h = await harness();
    const verdict = await h.handle({ items: [item("a"), item("a")] });
    expect(verdict.text).toContain("duplicate_id");
    expect(verdict.progress).toBe(false);
    expect(h.run.registrations).toBe(0);
    expect(h.run.events).toEqual([]);
  });

  test.each([
    [
      "an oversized work-item array",
      {
        items: Array.from({ length: WORKFLOW_LIMITS.workItems + 1 }, (_, index) =>
          item(`i${index}`),
        ),
      },
      "no more than",
    ],
    [
      "an oversized file list",
      {
        items: [
          item("a", {
            files: Array(WORKFLOW_LIMITS.filesPerWorkItem + 1).fill("src/a.ts"),
          }),
        ],
      },
      "malformed",
    ],
    [
      "an oversized dependency list",
      {
        items: [
          item("a", {
            dependencies: Array(WORKFLOW_LIMITS.dependenciesPerWorkItem + 1).fill("b"),
          }),
        ],
      },
      "malformed",
    ],
    [
      "an oversized goal",
      { items: [item("a", { goal: "x".repeat(WORKFLOW_LIMITS.textChars + 1) })] },
      "malformed",
    ],
  ])("rejects %s before the registry is called", async (_label, args, expected) => {
    const h = await harness();
    const verdict = await h.handle(args);
    expect(verdict.text).toContain(expected);
    expect(verdict.progress).toBe(false);
    expect(h.run.registrations).toBe(0);
    expect(h.run.events).toEqual([]);
  });

  test.each([
    ["an empty profile", { items: [item("a")], profile: "" }, "'profile'"],
    [
      "an oversized profile",
      { items: [item("a")], profile: "x".repeat(WORKFLOW_LIMITS.identifierChars + 1) },
      "'profile'",
    ],
    ["a non-string brief prefix", { items: [item("a")], brief_prefix: 1 }, "'brief_prefix'"],
    [
      "an oversized brief prefix",
      { items: [item("a")], brief_prefix: "x".repeat(WORKFLOW_LIMITS.textChars + 1) },
      "'brief_prefix'",
    ],
    [
      "a rendered brief above the retained ceiling",
      {
        items: [item("a", { goal: "x".repeat(WORKFLOW_LIMITS.textChars - 1) })],
        brief_prefix: "prefix",
      },
      "renders a brief longer",
    ],
  ])("rejects %s before registry admission", async (_label, args, expected) => {
    const h = await harness();
    const verdict = await h.handle(args);
    expect(verdict.text).toContain(expected);
    expect(verdict.progress).toBe(false);
    expect(h.run.registrations).toBe(0);
  });

  test("refuses the whole batch when the registry has no room for even one child", async () => {
    const h = await harness(undefined, {}, { maxLiveChildren: 0 });
    const verdict = await h.handle({ items: [item("a")] });
    expect(verdict.text).toContain("too many child agents");
    expect(verdict.progress).toBe(false);
  });
});

describe("run_work_items — dispatch", () => {
  test("answers immediately with the wave plan and runs the graph in dependency order", async () => {
    const started: string[] = [];
    const h = await harness((prompt) => {
      started.push(prompt.split("\n")[0]!);
      return Promise.resolve(completed("ok"));
    });
    const verdict = await h.handle({
      items: [item("b", { dependencies: ["a"] }), item("a"), item("c", { dependencies: ["a"] })],
    });

    expect(verdict.progress).toBe(true);
    expect(verdict.text).toContain("2 wave(s)");
    expect(verdict.text).toContain("wave 1: a");
    expect(verdict.text).toContain("wave 2: b, c");

    await h.run.settle();
    expect(started).toEqual(["goal a", "goal b", "goal c"]);
    expect(kinds(h.records, "workflow_run_started")).toHaveLength(3);
    expect(kinds(h.records, "workflow_run_completed")).toHaveLength(3);
  });

  test("folds every leader's usage into the tree ledger", async () => {
    const h = await harness(() => Promise.resolve(completed("ok", 7)), {
      ledger: createWorkflowLedger(1000),
    });
    await h.handle({ items: [item("a"), item("b")] });
    await h.run.settle();
    expect(h.ledger.spent()).toBe(14);
  });

  test("threads profile and expect_schema through to every leader in the batch", async () => {
    const specs: LeaderSpec[] = [];
    const h = await harness(() => Promise.resolve(completed("ok")), {
      assemble: (spec) => {
        specs.push(spec);
        return assembler(spec);
      },
    });
    await h.handle({
      items: [item("a"), item("b")],
      profile: "explorer",
      brief_prefix: "Audit the parser.",
      expect_schema: { type: "object" },
    });
    await h.run.settle();
    expect(specs.map((s) => s.profile)).toEqual(["explorer", "explorer"]);
    expect(specs.map((s) => s.expectSchema)).toEqual([{ type: "object" }, { type: "object" }]);
    expect(specs.every((s) => s.prompt.startsWith("Audit the parser."))).toBe(true);
  });
});

describe("run_work_items — a first wave wider than the registry", () => {
  const SIX = ["a", "b", "c", "d", "e", "f"].map((id) => item(id));

  test("runs every item and says how many are queued rather than listing only the started ones", async () => {
    const h = await harness(() => Promise.resolve(completed("ok")), {}, { maxLiveChildren: 3 });
    const answer = await h.handle({ items: SIX });

    expect(answer.text).toContain("queued and start as slots free");
    await h.run.settle();
    expect(kinds(h.records, "workflow_run_started")).toHaveLength(6);
    expect(kinds(h.records, "workflow_run_completed")).toHaveLength(6);
  });

  test("a first wave that fits reports no queue at all", async () => {
    const h = await harness(() => Promise.resolve(completed("ok")));
    const answer = await h.handle({ items: SIX });

    expect(answer.text).not.toContain("queued");
    await h.run.settle();
    expect(kinds(h.records, "workflow_run_started")).toHaveLength(6);
  });
});

describe("run_work_items — failure is propagated, never hidden", () => {
  test("a cancelled item stops later waves instead of replacing the stopped work", async () => {
    const h = await harness(() => Promise.resolve(cancelled()));
    await h.handle({ items: [item("a"), item("b", { dependencies: ["a"] })] });
    await h.run.settle();

    expect(h.run.registrations).toBe(1);
    expect(kinds(h.records, "workflow_run_started")).toHaveLength(1);
    expect(kinds(h.records, "workflow_run_failed")).toHaveLength(1);
    expect(kinds(h.records, "workflow_run_failed")[0]).toMatchObject({ status: "cancelled" });
  });

  test("a dependent of a failed item is not dispatched and says which ancestor stopped it", async () => {
    const h = await harness((prompt) =>
      Promise.resolve(prompt.startsWith("goal a") ? errored("a exploded") : completed("ok")),
    );
    await h.handle({ items: [item("a"), item("b", { dependencies: ["a"] })] });
    await h.run.settle();

    expect(kinds(h.records, "workflow_run_started")).toHaveLength(1);
    expect(kinds(h.records, "workflow_run_failed")).toHaveLength(1);
    expect(h.run.events).toContain("settle:Do b");
  });

  test("a leader that throws after resolving still settles the item as failed", async () => {
    const runDeps = promptRunDeps(() => Promise.resolve(completed("ok")));
    const { bc, records } = recordingBc();
    const record = bc.trace.record.bind(bc.trace);
    bc.trace.record = (kind: string, detail: unknown): void => {
      if (kind === "workflow_run_completed") throw new Error("trace sink exploded");
      record(kind, detail);
    };
    const run = instrumentedRunCtx();
    const capability = await createWorkflowsCapability(
      makeCtx({ runDeps, assemble: assembler }),
    ).forRun(run.runCtx);
    const handler = capability!.forAgent(scope())!.attach(bc).handlers![1]!;
    await handler.handle(call({ items: [item("a")] }), 0);
    await run.settle();

    expect(kinds(records, "workflow_run_failed")).toHaveLength(1);
    expect(run.events).toContain("settle:Do a");
  });

  test("once the ledger refuses, the item and everything after it stop being dispatched", async () => {
    const h = await harness(() => Promise.resolve(completed("ok")), {
      ledger: createWorkflowLedger(0),
    });
    await h.handle({ items: [item("a"), item("b", { dependencies: ["a"] })] });
    await h.run.settle();
    expect(kinds(h.records, "workflow_run_started")).toHaveLength(0);
    expect(h.run.events.filter((e) => e.startsWith("settle:"))).toHaveLength(2);
  });

  test("a sibling in the same wave is refused off the remembered flag, not by asking again", async () => {
    const reserves: number[] = [];
    const ledger = createWorkflowLedger(0);
    const counting = {
      ...ledger,
      reserve: (n: number) => {
        reserves.push(n);
        return ledger.reserve(n);
      },
    };
    const h = await harness(() => Promise.resolve(completed("ok")), { ledger: counting });
    await h.handle({ items: [item("a"), item("b")] });
    await h.run.settle();

    // Two independent items, one refusal: the second never reaches the ledger.
    expect(reserves).toHaveLength(1);
    expect(kinds(h.records, "workflow_run_started")).toHaveLength(0);
    expect(h.run.events.filter((e) => e.startsWith("settle:"))).toHaveLength(2);
  });

  test("a leader's trace events reach its own handle and the workflow-level listener", async () => {
    const emitted = { type: "run_ended", occurred_at: 0, reason: "completed" };
    const forwarded: string[] = [];
    const h = await harness(
      (_prompt, args) => {
        args.onEvent?.(emitted as never);
        return Promise.resolve(completed("ok"));
      },
      { onLeaderEvent: (id) => forwarded.push(id) },
    );
    await h.handle({ items: [item("a")] });
    await h.run.settle();

    const started = kinds(h.records, "workflow_run_started")[0] as { run_id: string };
    expect(forwarded).toEqual([started.run_id]);
    const row = h.run.registry.list().find((r) => r.title === "Do a");
    expect(h.run.registry.poll(row!.id, {})?.output).toContain("ended completed");
  });

  test("an item cancelled while queued for a concurrency slot is settled, not left hanging", async () => {
    const controller = new AbortController();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await harness(
      async (prompt) => {
        if (prompt.startsWith("goal a")) {
          controller.abort();
          await gate;
        }
        return completed("ok");
      },
      { semaphore: createSemaphore(1), signal: controller.signal },
    );
    await h.handle({ items: [item("a"), item("b")] });
    release();
    await h.run.settle();
    expect(h.run.events.filter((e) => e.startsWith("settle:"))).toHaveLength(2);
    expect(kinds(h.records, "workflow_run_started")).toHaveLength(1);
  });

  test("an item cancelled with its slot grant stops before starting the leader", async () => {
    const controller = new AbortController();
    let executed = 0;
    let semaphoreReleases = 0;
    const h = await harness(
      () => {
        executed += 1;
        return Promise.resolve(completed("must not run"));
      },
      {
        signal: controller.signal,
        semaphore: {
          acquire: async () => {
            controller.abort(new Error("workflow cancelled at grant"));
          },
          release: () => {
            semaphoreReleases += 1;
          },
        },
      },
    );

    await h.handle({ items: [item("a")] });
    await h.run.settle();

    expect(executed).toBe(0);
    expect(semaphoreReleases).toBe(1);
    expect(h.run.registry.list().map((row) => row.status)).toEqual(["stopped"]);
    expect(kinds(h.records, "workflow_run_started")).toHaveLength(0);
  });
});

describe("run_work_items — the wave-boundary baton", () => {
  test("never lets the live-child count reach zero while a wave is still pending", async () => {
    const h = await harness(() => Promise.resolve(completed("ok")));
    await h.handle({
      items: [item("a"), item("b", { dependencies: ["a"] }), item("c", { dependencies: ["b"] })],
    });
    await h.run.settle();

    // The finish gate accepts a lone submit_result whenever liveCount() === 0, so
    // a zero anywhere but the final settlement would let the manager finish on top
    // of a half-run graph.
    const counts = h.run.liveAfterSettle;
    expect(counts).toHaveLength(3);
    expect(counts.slice(0, -1).every((n) => n > 0)).toBe(true);
    expect(counts.at(-1)).toBe(0);
    expect(h.run.events).toEqual([
      "register:Do a",
      "register:Do b",
      "settle:Do a",
      "register:Do c",
      "settle:Do b",
      "settle:Do c",
    ]);
  });

  test("the baton costs exactly one live slot, and a wave it crowds out is reported", async () => {
    const h = await harness(() => Promise.resolve(completed("ok")), {}, { maxLiveChildren: 1 });
    await h.handle({ items: [item("a"), item("b", { dependencies: ["a"] })] });
    await h.run.settle();

    expect(h.run.events).toEqual(["register:Do a", "settle:Do a"]);
    expect(kinds(h.records, "workflow_run_started")).toHaveLength(1);
  });

  test("the last child to settle carries the batch tally", async () => {
    const runDeps = promptRunDeps((prompt) =>
      Promise.resolve(prompt.startsWith("goal a") ? errored("nope") : completed("ok")),
    );
    const settlements: string[] = [];
    const registry = createAgentRegistry({ limits: TEST_LIMITS });
    const tasks: Promise<unknown>[] = [];
    const wrapped = {
      ...registry,
      register(registration: AgentRegistration): AgentHandle | null {
        const handle = registry.register(registration);
        if (handle === null) return null;
        return {
          ...handle,
          settled(settlement) {
            settlements.push(settlement.result ?? "");
            handle.settled(settlement);
          },
        } satisfies AgentHandle;
      },
      adopt(id: string, task: Promise<unknown>): void {
        tasks.push(task);
        registry.adopt(id, task);
      },
    };
    const capability = await createWorkflowsCapability(
      makeCtx({ runDeps, assemble: assembler }),
    ).forRun(runContextWithAgents(wrapped));
    const handler = capability!.forAgent(scope())!.attach(recordingBc().bc).handlers![1]!;
    await handler.handle(call({ items: [item("a"), item("b", { dependencies: ["a"] })] }), 0);
    await Promise.allSettled([...tasks]);

    expect(settlements.at(-1)).toContain("work item batch finished");
    expect(settlements.at(-1)).toContain("failed: a");
    expect(settlements.at(-1)).toContain("blocked: b");
  });
});
