import { describe, expect, test } from "bun:test";
import type {
  AgentHandle,
  AgentRegistration,
  AgentRegistryPort,
  LLMToolCall,
  RunCapabilityContext,
  RunRequest,
  Usage,
} from "@clarvis/capability";
import { TASK_TITLE_MAX } from "@clarvis/capability";
import type { ExecuteRunOutcome } from "@clarvis/loop";
import { createAgentRegistry } from "@clarvis/supervision";
import { createWorkflowsCapability } from "../../src/capability.ts";
import { createWorkflowLedger } from "../../src/ledger.ts";
import { WORKFLOW_LIMITS } from "../../src/limits.ts";
import {
  buildRunRoundTool,
  RUN_ROUND_TOOL_NAME,
  startRounds,
  type RoundCall,
  type RoundInput,
} from "../../src/run-round.ts";
import type { LeaderSpec } from "../../src/types.ts";
import type { WorkflowRunDeps } from "../../src/types.ts";
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

function completed(result: unknown): ExecuteRunOutcome {
  return {
    executionId: "ignored",
    response: { status: "completed", result, usage: usage(1) },
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
    executionId: "x",
    response: {
      status: "error",
      error: { code: "boom", message },
      usage: usage(0),
    },
  };
}

function promptRunDeps(execute: (prompt: string) => Promise<ExecuteRunOutcome>): WorkflowRunDeps {
  return workflowRunDeps((args) => {
    return execute(promptFrom(args));
  });
}

const assembler = (spec: LeaderSpec): RunRequest => requestWithPrompt(spec.prompt);

function runCtx(over: Partial<AgentsLimits> = {}): {
  runCtx: RunCapabilityContext;
  agents: AgentRegistryPort;
  registrations: number;
  settlements: string[];
  liveAfterSettle: number[];
  settle: () => Promise<void>;
} {
  const registry = createAgentRegistry({ limits: { ...TEST_LIMITS, ...over } });
  let registrations = 0;
  const settlements: string[] = [];
  const liveAfterSettle: number[] = [];
  const tasks: Promise<unknown>[] = [];
  const wrapped = {
    ...registry,
    register(registration: AgentRegistration): AgentHandle | null {
      registrations += 1;
      const handle = registry.register(registration);
      if (handle === null) return null;
      return {
        ...handle,
        settled(settlement) {
          handle.settled(settlement);
          settlements.push(settlement.result ?? "");
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
    agents: wrapped,
    get registrations(): number {
      return registrations;
    },
    settlements,
    liveAfterSettle,
    settle: async (): Promise<void> => {
      await Promise.allSettled([...tasks]);
    },
  };
}

async function harness(
  execute?: (prompt: string) => Promise<ExecuteRunOutcome>,
  ctxOver: Parameters<typeof makeCtx>[0] = {},
  limits: Partial<AgentsLimits> = {},
): Promise<{
  handle: (args: Record<string, unknown>) => Promise<{ text: string; progress: boolean }>;
  briefs: string[];
  specs: LeaderSpec[];
  run: ReturnType<typeof runCtx>;
  records: Array<{ kind: string; detail: unknown }>;
}> {
  const specs: LeaderSpec[] = [];
  const briefs: string[] = [];
  const ctx = makeCtx({
    assemble: (spec) => {
      specs.push(spec);
      briefs.push(spec.prompt);
      return assembler(spec);
    },
    ...(execute !== undefined ? { runDeps: promptRunDeps(execute) } : {}),
    ...ctxOver,
  });
  const run = runCtx(limits);
  const capability = await createWorkflowsCapability(ctx).forRun(run.runCtx);
  const { bc, records } = recordingBc();
  const handler = capability!.forAgent(scope())!.attach(bc).handlers![2]!;
  return {
    handle: async (args) => {
      const call: LLMToolCall = { id: "call", name: RUN_ROUND_TOOL_NAME, arguments: args };
      const verdict = await handler.handle(call, 0);
      if (verdict.kind !== "result") throw new Error(`expected a result, got ${verdict.kind}`);
      return { text: verdict.text, progress: verdict.progress };
    },
    briefs,
    specs,
    run,
    records,
  };
}

const DISCOVER = {
  id: "discover",
  title: "Map work",
  type: "discovery",
  over: "once",
  brief: "Map the work.",
};

describe("run_round — the tool schema", () => {
  test("requires rounds and offers a profile selector only when profiles exist", () => {
    const bare = buildRunRoundTool().inputSchema as {
      required: string[];
      properties: {
        rounds: {
          maxItems: number;
          items: { properties: { fanout: { maximum: number }; [key: string]: unknown } };
        };
        repeat: {
          properties: {
            dry_rounds: { maximum: number };
            max_rounds: { maximum: number };
          };
        };
      };
    };
    expect(bare.required).toEqual(["rounds"]);
    expect(bare.properties.rounds.items.properties.profile).toBeUndefined();
    expect(bare.properties.rounds.maxItems).toBe(WORKFLOW_LIMITS.rounds);
    expect(bare.properties.rounds.items.properties.fanout.maximum).toBe(WORKFLOW_LIMITS.fanout);
    expect(bare.properties.repeat.properties.max_rounds.maximum).toBe(
      WORKFLOW_LIMITS.repeatMaxRounds,
    );
    expect(bare.properties.repeat.properties.dry_rounds.maximum).toBe(
      WORKFLOW_LIMITS.repeatDryRounds,
    );

    const withProfiles = buildRunRoundTool([{ name: "explorer" }]).inputSchema as {
      properties: { rounds: { items: { properties: { profile?: { enum: string[] } } } } };
    };
    expect(withProfiles.properties.rounds.items.properties.profile?.enum).toEqual(["explorer"]);
  });
});

describe("run_round — dispatch selection", () => {
  test("the handler claims run_round calls and nothing else", async () => {
    const run = await createWorkflowsCapability(makeCtx()).forRun(runCtx().runCtx);
    const handler = run!.forAgent(scope())!.attach(recordingBc().bc).handlers![2]!;
    expect(handler.matches({ name: RUN_ROUND_TOOL_NAME, arguments: {} } as never)).toBe(true);
    expect(handler.matches({ name: "run_leader", arguments: {} } as never)).toBe(false);
  });
});

describe("run_round — calls it refuses", () => {
  test.each([
    ["arguments that are not an object", "nope" as unknown, "expected an object"],
    ["a missing rounds array", {}, "'rounds' is required"],
    ["an empty rounds array", { rounds: [] }, "'rounds' is required"],
    ["a round that is not an object", { rounds: ["x"] }, "rounds[0] must be an object"],
    ["a round with no id", { rounds: [{ ...DISCOVER, id: "" }] }, "rounds[0].id is required"],
    ["a round with no title", { rounds: [{ ...DISCOVER, title: "" }] }, "rounds[0].title"],
    ["an unknown type", { rounds: [{ ...DISCOVER, type: "guess" }] }, "rounds[0].type must be"],
    ["an empty brief", { rounds: [{ ...DISCOVER, brief: "" }] }, "rounds[0].brief is required"],
    ["a non-string over", { rounds: [{ ...DISCOVER, over: 7 }] }, "rounds[0].over is required"],
    [
      "an over that is not a selector",
      { rounds: [{ ...DISCOVER, over: "sometimes(x)" }] },
      "is not a selector",
    ],
    [
      "a non-string accept",
      { rounds: [{ ...DISCOVER, accept: 3 }] },
      "rounds[0].accept must be a string",
    ],
    [
      "an accept that is not a rule",
      { rounds: [{ ...DISCOVER, accept: "vibes(a, b)" }] },
      "is not a rule",
    ],
    ["a fractional fanout", { rounds: [{ ...DISCOVER, fanout: 1.5 }] }, "must be a positive"],
    ["an empty profile", { rounds: [{ ...DISCOVER, profile: "" }] }, "profile must be"],
    ["an empty when guard", { rounds: [{ ...DISCOVER, when: "" }] }, "when must be"],
    [
      "two rounds sharing an id",
      { rounds: [DISCOVER, { ...DISCOVER, over: "once" }] },
      "share the id",
    ],
  ])("rejects %s", async (_label, args, expected) => {
    const h = await harness();
    const verdict = await h.handle(args as Record<string, unknown>);
    expect(verdict.text).toContain(expected);
    expect(verdict.progress).toBe(false);
  });

  test.each([
    [
      "an oversized round array",
      {
        rounds: Array.from({ length: WORKFLOW_LIMITS.rounds + 1 }, (_, index) => ({
          ...DISCOVER,
          id: `r${index}`,
        })),
      },
      "no more than",
    ],
    [
      "an enormous fanout",
      { rounds: [{ ...DISCOVER, fanout: Number.MAX_SAFE_INTEGER }] },
      "fanout",
    ],
    [
      "an oversized brief",
      { rounds: [{ ...DISCOVER, brief: "x".repeat(WORKFLOW_LIMITS.textChars + 1) }] },
      "brief",
    ],
    [
      "too many args",
      {
        rounds: [DISCOVER],
        args: Object.fromEntries(
          Array.from({ length: WORKFLOW_LIMITS.args + 1 }, (_, index) => [`k${index}`, "x"]),
        ),
      },
      "'args'",
    ],
    ["args that are not an object", { rounds: [DISCOVER], args: "nope" }, "must be an object"],
    ["an empty arg name", { rounds: [DISCOVER], args: { "": true } }, "property names"],
    [
      "an oversized arg value",
      {
        rounds: [DISCOVER],
        args: { target: "x".repeat(WORKFLOW_LIMITS.textChars + 1) },
      },
      "args.target",
    ],
  ])("rejects %s before planning or registry admission", async (_label, args, expected) => {
    const h = await harness();
    const verdict = await h.handle(args as Record<string, unknown>);
    expect(verdict.text).toContain(expected);
    expect(verdict.progress).toBe(false);
    expect(h.run.registrations).toBe(0);
    expect(h.specs).toEqual([]);
  });

  test("the programmatic executor rechecks fanout before planning or registry admission", () => {
    const run = runCtx();
    const ctx = makeCtx();
    const result = startRounds(
      { ctx, bc: recordingBc().bc, clock: undefined, agents: run.agents },
      {
        rounds: [
          {
            id: "discover",
            title: "Map work",
            type: "discovery",
            over: { kind: "once" },
            brief: "Map the work.",
            fanout: Number.MAX_SAFE_INTEGER,
          },
        ],
        args: {},
      },
    );
    expect(result).toEqual({
      error: `rounds[0].fanout must be between 1 and ${String(WORKFLOW_LIMITS.fanout)}`,
    });
    expect(run.registrations).toBe(0);
  });

  test("the programmatic executor rechecks every retained string and repeat bound", () => {
    const round: RoundInput = {
      id: "discover",
      title: "Map work",
      type: "discovery",
      over: { kind: "once" },
      brief: "Map the work.",
      fanout: 1,
    };
    const validRepeat = {
      rounds: ["discover"],
      until: "no_new" as const,
      dedupe_by: ["claim"],
      max_rounds: 2,
    };
    const cases: Array<[string, RoundCall, string]> = [
      ["empty round sequence", { rounds: [], args: {} }, "1-"],
      [
        "round id",
        {
          rounds: [{ ...round, id: "x".repeat(WORKFLOW_LIMITS.identifierChars + 1) }],
          args: {},
        },
        ".id",
      ],
      [
        "round brief",
        {
          rounds: [{ ...round, brief: "x".repeat(WORKFLOW_LIMITS.textChars + 1) }],
          args: {},
        },
        ".brief",
      ],
      [
        "round title",
        {
          rounds: [{ ...round, title: "x".repeat(TASK_TITLE_MAX * 2 + 1) }],
          args: {},
        },
        ".title",
      ],
      [
        "round profile",
        {
          rounds: [{ ...round, profile: "x".repeat(WORKFLOW_LIMITS.identifierChars + 1) }],
          args: {},
        },
        ".profile",
      ],
      [
        "round guard",
        {
          rounds: [{ ...round, when: "x".repeat(WORKFLOW_LIMITS.pathChars + 1) }],
          args: {},
        },
        ".when",
      ],
      [
        "selector source",
        {
          rounds: [
            {
              ...round,
              over: { kind: "each", source: "x".repeat(WORKFLOW_LIMITS.pathChars + 1) },
            },
          ],
          args: {},
        },
        ".over",
      ],
      [
        "selector filter",
        {
          rounds: [
            {
              ...round,
              over: {
                kind: "each",
                source: "discover.items",
                where: { field: "x".repeat(WORKFLOW_LIMITS.identifierChars + 1) },
              },
            },
          ],
          args: {},
        },
        "filter",
      ],
      [
        "accept rule",
        {
          rounds: [
            {
              ...round,
              accept: {
                kind: "all",
                field: "x".repeat(WORKFLOW_LIMITS.identifierChars + 1),
                value: "accepted",
              },
            },
          ],
          args: {},
        },
        ".accept",
      ],
      [
        "repeat rounds",
        { rounds: [round], repeat: { ...validRepeat, rounds: [] }, args: {} },
        "repeat.rounds",
      ],
      [
        "repeat dedupe fields",
        { rounds: [round], repeat: { ...validRepeat, dedupe_by: [] }, args: {} },
        "repeat.dedupe_by",
      ],
      [
        "repeat max rounds",
        { rounds: [round], repeat: { ...validRepeat, max_rounds: 0 }, args: {} },
        "repeat.max_rounds",
      ],
      [
        "repeat dry rounds",
        { rounds: [round], repeat: { ...validRepeat, dry_rounds: 0 }, args: {} },
        "repeat.dry_rounds",
      ],
    ];

    for (const [label, call, expected] of cases) {
      const run = runCtx();
      const result = startRounds(
        { ctx: makeCtx(), bc: recordingBc().bc, clock: undefined, agents: run.agents },
        call,
      );
      expect(result, label).toEqual({ error: expect.stringContaining(expected) });
      expect(run.registrations, label).toBe(0);
    }
  });

  test("refuses interpolated titles and briefs that grow beyond retained bounds", async () => {
    const title = await harness();
    const titleVerdict = await title.handle({
      rounds: [{ ...DISCOVER, title: "{{args.long}}{{args.long}}" }],
      args: { long: "x".repeat(TASK_TITLE_MAX + 1) },
    });
    expect(titleVerdict.text).toContain("display-title size");
    expect(title.run.registrations).toBe(0);

    const brief = await harness();
    const briefVerdict = await brief.handle({
      rounds: [{ ...DISCOVER, brief: "{{args.long}}{{args.long}}" }],
      args: { long: "x".repeat(Math.floor(WORKFLOW_LIMITS.textChars / 2) + 1) },
    });
    expect(briefVerdict.text).toContain("rendered brief exceeds");
    expect(brief.run.registrations).toBe(0);
  });

  test.each([
    ["a repeat that is not an object", 7, "'repeat' must be an object"],
    ["a repeat naming an unknown round", { rounds: ["ghost"] }, "must name rounds declared"],
    ["a repeat with no rounds", { rounds: [] }, "must name rounds declared"],
    [
      "a repeat with no dedupe_by",
      { rounds: ["discover"], max_rounds: 2 },
      "'repeat.dedupe_by' must be",
    ],
    [
      "a repeat with no max_rounds",
      { rounds: ["discover"], dedupe_by: ["claim"] },
      "it is the backstop",
    ],
    [
      "a repeat with a zero dry_rounds",
      { rounds: ["discover"], dedupe_by: ["claim"], max_rounds: 2, dry_rounds: 0 },
      "'repeat.dry_rounds' must be",
    ],
    [
      "a repeat with an enormous max_rounds",
      {
        rounds: ["discover"],
        dedupe_by: ["claim"],
        max_rounds: Number.MAX_SAFE_INTEGER,
      },
      "'repeat.max_rounds'",
    ],
    [
      "a repeat with an enormous dry_rounds",
      {
        rounds: ["discover"],
        dedupe_by: ["claim"],
        max_rounds: 2,
        dry_rounds: Number.MAX_SAFE_INTEGER,
      },
      "'repeat.dry_rounds'",
    ],
    [
      "a repeat with too many round references",
      {
        rounds: Array(WORKFLOW_LIMITS.repeatRounds + 1).fill("discover"),
        dedupe_by: ["claim"],
        max_rounds: 2,
      },
      "'repeat.rounds'",
    ],
    [
      "a repeat with too many dedupe fields",
      {
        rounds: ["discover"],
        dedupe_by: Array(WORKFLOW_LIMITS.repeatDedupeFields + 1).fill("claim"),
        max_rounds: 2,
      },
      "'repeat.dedupe_by'",
    ],
  ])("rejects %s", async (_label, repeat, expected) => {
    const h = await harness();
    const verdict = await h.handle({ rounds: [DISCOVER], repeat });
    expect(verdict.text).toContain(expected);
    expect(h.run.registrations).toBe(0);
  });

  test("refuses when the first round's brief references something that is not there", async () => {
    const h = await harness();
    const verdict = await h.handle({
      rounds: [{ ...DISCOVER, brief: "Audit {{args.target}}." }],
    });
    expect(verdict.text).toContain("did not resolve");
  });

  test("refuses when the first round consumes anything — there is nothing yet to consume", async () => {
    const h = await harness();
    const verdict = await h.handle({
      rounds: [{ ...DISCOVER, over: "each(ghost.items)" }],
    });
    expect(verdict.text).toContain("must be 'once'");
  });

  test("refuses when the first round is guarded on something empty", async () => {
    const h = await harness();
    const verdict = await h.handle({
      rounds: [{ ...DISCOVER, when: "ghost.gaps" }],
    });
    expect(verdict.text).toContain("guarded on");
  });

  test("refuses when the registry has no room for the first round", async () => {
    const h = await harness(undefined, {}, { maxLiveChildren: 0 });
    const verdict = await h.handle({ rounds: [DISCOVER] });
    expect(verdict.text).toContain("too many child agents");
  });
});

describe("run_round — the barrier follows from what a round consumes", () => {
  test("each fans out one leader per item and all collapses the set into one", async () => {
    const h = await harness((prompt) => {
      if (prompt.startsWith("Map")) {
        return Promise.resolve(
          completed({
            scope: "s",
            evidence: [],
            unknowns: [],
            work_items: [
              {
                id: "a",
                title: "Do a",
                goal: "do a",
                files: [],
                dependencies: [],
                mutation: false,
              },
              {
                id: "b",
                title: "Do b",
                goal: "do b",
                files: [],
                dependencies: [],
                mutation: false,
              },
            ],
          }),
        );
      }
      if (prompt.startsWith("Review")) {
        return Promise.resolve(
          completed({ findings: [{ id: "x", claim: "c" }], coverage_gaps: ["g"] }),
        );
      }
      return Promise.resolve(completed({ findings: [], coverage_gaps: [] }));
    });
    const verdict = await h.handle({
      rounds: [
        DISCOVER,
        {
          id: "review",
          title: "Review {{item.title}}",
          type: "findings",
          over: "each(discover.work_items)",
          brief: "Review {{item.goal}}.",
        },
        {
          id: "gaps",
          title: "Close gaps",
          type: "findings",
          over: "all(review.coverage_gaps)",
          brief: "Close {{item}}.",
        },
      ],
    });
    expect(verdict.progress).toBe(true);
    expect(verdict.text).toContain("discover (discovery, once)");
    expect(verdict.text).toContain("review (findings, each(discover.work_items))");
    await h.run.settle();

    // one discovery leader, one per work item, then a single leader over the
    // whole concatenated coverage_gaps list.
    expect(h.briefs.filter((b) => b.startsWith("Map"))).toHaveLength(1);
    expect(h.briefs.filter((b) => b.startsWith("Review"))).toHaveLength(2);
    const closing = h.briefs.filter((b) => b.startsWith("Close"));
    expect(closing).toHaveLength(1);
    expect(closing[0]).toContain('["g","g"]');
  });

  test("each over a plain string list renders the authored title", async () => {
    const h = await harness((prompt) =>
      Promise.resolve(
        prompt.startsWith("Review")
          ? completed({ findings: [], coverage_gaps: ["the parser", "the lexer"] })
          : completed({ findings: [], coverage_gaps: [] }),
      ),
    );
    await h.handle({
      rounds: [
        { id: "review", title: "Review gaps", type: "findings", over: "once", brief: "Review it." },
        {
          id: "gaps",
          title: "Cover {{item}}",
          type: "findings",
          profile: "explorer",
          over: "each(review.coverage_gaps)",
          brief: "Cover {{item}}.",
        },
      ],
    });
    await h.run.settle();
    expect(h.briefs.filter((b) => b.startsWith("Cover"))).toEqual([
      "Cover the parser.",
      "Cover the lexer.",
    ]);
    expect(h.specs.at(-1)?.profile).toBe("explorer");
    expect(h.specs.slice(-2).map((spec) => spec.title)).toEqual([
      "Cover the parser",
      "Cover the lexer",
    ]);
  });

  test("a round's type binds its leaders to the shipped result schema", async () => {
    const h = await harness(() =>
      Promise.resolve(completed({ scope: "s", evidence: [], work_items: [], unknowns: [] })),
    );
    await h.handle({
      rounds: [
        DISCOVER,
        { id: "free", title: "Say anything", type: "free", over: "once", brief: "Say anything." },
      ],
    });
    await h.run.settle();
    expect(h.specs[0]?.expectSchema).toMatchObject({ type: "object" });
    expect(h.specs[1]?.expectSchema).toBeUndefined();
  });

  test("work items inside a round are scheduled, not fanned out flat", async () => {
    const order: string[] = [];
    const h = await harness((prompt) => {
      order.push(prompt.split("\n")[0]!);
      return prompt.startsWith("Map")
        ? Promise.resolve(
            completed({
              scope: "s",
              evidence: [],
              unknowns: [],
              work_items: [
                {
                  id: "w2",
                  title: "Second",
                  goal: "second",
                  files: ["src/a.ts"],
                  dependencies: [],
                  mutation: true,
                },
                {
                  id: "w1",
                  title: "First",
                  goal: "first",
                  files: ["src/a.ts"],
                  dependencies: [],
                  mutation: true,
                },
              ],
            }),
          )
        : Promise.resolve(completed({ findings: [], coverage_gaps: [] }));
    });
    await h.handle({
      rounds: [
        DISCOVER,
        {
          id: "work",
          title: "{{item.title}}",
          type: "findings",
          over: "each(discover.work_items)",
          brief: "{{item.goal}}",
        },
      ],
    });
    await h.run.settle();
    // Both write src/a.ts, so the scheduler serializes them into two waves.
    expect(order.filter((o) => o === "second" || o === "first")).toEqual(["second", "first"]);
  });
});

describe("run_round — fanout and accept", () => {
  test("fanout runs independent replicas and accept folds them into a decision", async () => {
    const verdicts = ["refuted", "refuted", "inconclusive"];
    let served = 0;
    const h = await harness((prompt) =>
      Promise.resolve(
        prompt.startsWith("Review")
          ? completed({
              findings: [{ id: "f1", claim: "A", needs_verification: true }],
              coverage_gaps: [],
            })
          : completed({
              finding_id: "f1",
              verdict: verdicts[served++ % verdicts.length],
              evidence: [],
              reason: "r",
            }),
      ),
    );
    await h.handle({
      rounds: [
        {
          id: "review",
          title: "Review finding",
          type: "findings",
          over: "once",
          brief: "Review it.",
        },
        {
          id: "verify",
          title: "Verify {{item.claim}}",
          type: "verdict",
          over: "each(review.findings)",
          fanout: 3,
          accept: "threshold(verdict, refuted, 2)",
          brief: "Refute {{item.claim}}.",
        },
      ],
    });
    await h.run.settle();
    expect(h.briefs.filter((b) => b.startsWith("Refute"))).toHaveLength(3);
    const starts = h.records
      .filter((event) => event.kind === "workflow_run_started")
      .map((event) => event.detail);
    expect(starts).toContainEqual(
      expect.objectContaining({
        round_id: "review",
        pass: 0,
        item_index: 0,
        replica: 0,
        replica_count: 1,
      }),
    );
    expect(
      starts.filter((event) => (event as { round_id?: string }).round_id === "verify"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ item_index: 0, replica: 0, replica_count: 3 }),
        expect.objectContaining({ item_index: 0, replica: 1, replica_count: 3 }),
        expect.objectContaining({ item_index: 0, replica: 2, replica_count: 3 }),
      ]),
    );
    const summary = h.run.settlements.at(-1) ?? "";
    expect(summary).toContain("verify: 3 leader(s), 1 accepted / 0 rejected");
    void verdicts;
  });

  test("each item gets its own panel, and the decisions keep the items' order", async () => {
    const h = await harness((prompt) =>
      Promise.resolve(
        prompt.startsWith("Review")
          ? completed({
              findings: [
                { id: "f1", claim: "keep" },
                { id: "f2", claim: "drop" },
              ],
              coverage_gaps: [],
            })
          : completed({
              finding_id: "x",
              verdict: prompt.includes("drop") ? "refuted" : "confirmed",
              evidence: [],
              reason: "r",
            }),
      ),
    );
    await h.handle({
      rounds: [
        {
          id: "review",
          title: "Review findings",
          type: "findings",
          over: "once",
          brief: "Review it.",
        },
        {
          id: "verify",
          title: "Verify {{item.claim}}",
          type: "verdict",
          over: "each(review.findings)",
          fanout: 2,
          accept: "all(verdict, refuted)",
          brief: "Refute {{item.claim}}.",
        },
        {
          id: "report",
          title: "Report verdicts",
          type: "free",
          over: "once",
          brief: "rejected={{state.verify.rejected}}",
        },
      ],
    });
    await h.run.settle();
    expect(h.briefs.filter((b) => b.startsWith("Refute"))).toHaveLength(4);
    expect(h.run.settlements.at(-1)).toContain("verify: 4 leader(s), 1 accepted / 1 rejected");
    expect(h.briefs.at(-1)).toContain('"claim":"keep"');
  });
});

describe("run_round — skipping, budget and repeat", () => {
  test("a decomposition that cannot be scheduled is reported against its round", async () => {
    const h = await harness((prompt) =>
      Promise.resolve(
        prompt.startsWith("Map")
          ? completed({
              scope: "s",
              evidence: [],
              unknowns: [],
              work_items: [
                {
                  id: "dup",
                  title: "Do a",
                  goal: "a",
                  files: [],
                  dependencies: [],
                  mutation: false,
                },
                {
                  id: "dup",
                  title: "Do b",
                  goal: "b",
                  files: [],
                  dependencies: [],
                  mutation: false,
                },
              ],
            })
          : completed({ findings: [], coverage_gaps: [] }),
      ),
    );
    await h.handle({
      rounds: [
        DISCOVER,
        {
          id: "work",
          title: "{{item.title}}",
          type: "findings",
          over: "each(discover.work_items)",
          brief: "{{item.goal}}",
        },
      ],
    });
    await h.run.settle();
    expect(h.run.settlements.at(-1)).toContain("work: skipped");
    expect(h.run.settlements.at(-1)).toContain("duplicate_id");
  });

  test("free-text results from several leaders are kept side by side, not merged", async () => {
    let served = 0;
    const h = await harness((prompt) => {
      if (prompt.startsWith("Map")) {
        return Promise.resolve(
          completed({
            scope: "s",
            evidence: [],
            unknowns: [],
            work_items: [
              { id: "a", title: "Do a", goal: "a", files: [], dependencies: [], mutation: false },
              { id: "b", title: "Do b", goal: "b", files: [], dependencies: [], mutation: false },
            ],
          }),
        );
      }
      served += 1;
      return Promise.resolve(completed(`plain ${String(served)}`));
    });
    await h.handle({
      rounds: [
        DISCOVER,
        {
          id: "work",
          title: "{{item.title}}",
          type: "free",
          over: "each(discover.work_items)",
          brief: "{{item.goal}}",
        },
        { id: "read", title: "Read work", type: "free", over: "once", brief: "got {{state.work}}" },
      ],
    });
    await h.run.settle();
    expect(h.briefs.at(-1)).toBe('got ["plain 1","plain 2"]');
  });

  test("merging several leaders keeps a field only one of them reported", async () => {
    let served = 0;
    const h = await harness((prompt) => {
      if (prompt.startsWith("Map")) {
        return Promise.resolve(
          completed({
            scope: "s",
            evidence: [],
            unknowns: [],
            work_items: [
              { id: "a", title: "Do a", goal: "a", files: [], dependencies: [], mutation: false },
              { id: "b", title: "Do b", goal: "b", files: [], dependencies: [], mutation: false },
            ],
          }),
        );
      }
      served += 1;
      return Promise.resolve(
        served === 1 ? completed({ shared: 1, only_first: 2 }) : completed({ shared: 3 }),
      );
    });
    await h.handle({
      rounds: [
        DISCOVER,
        {
          id: "work",
          title: "{{item.title}}",
          type: "free",
          over: "each(discover.work_items)",
          brief: "{{item.goal}}",
        },
        {
          id: "read",
          title: "Read merged work",
          type: "free",
          over: "once",
          brief: "shared={{state.work.shared}} only={{state.work.only_first}}",
        },
      ],
    });
    await h.run.settle();
    // `shared` was reported by both leaders and becomes the pair; `only_first`
    // came from one and is kept as the scalar it was, not wrapped in an array.
    expect(h.briefs.at(-1)).toBe("shared=[1,3] only=2");
  });

  test("a later round whose source is unusable is reported, not silently dropped", async () => {
    const h = await harness(() => Promise.resolve(completed("free text")));
    await h.handle({
      rounds: [
        { id: "one", title: "Go once", type: "free", over: "once", brief: "Go." },
        {
          id: "two",
          title: "Read {{item}}",
          type: "free",
          over: "each(one.items)",
          brief: "{{item}}",
        },
      ],
    });
    await h.run.settle();
    expect(h.run.settlements.at(-1)).toContain("two: skipped");
  });

  test("a later round refuses a retained source larger than the fan-out bound", async () => {
    const h = await harness((prompt) =>
      Promise.resolve(
        prompt === "Produce items."
          ? completed({
              items: Array.from({ length: WORKFLOW_LIMITS.workItems + 1 }, (_, index) => index),
            })
          : completed("unexpected"),
      ),
    );
    await h.handle({
      rounds: [
        { id: "one", title: "Produce items", type: "free", over: "once", brief: "Produce items." },
        {
          id: "two",
          title: "Read {{item}}",
          type: "free",
          over: "each(one.items)",
          brief: "Read {{item}}.",
        },
      ],
    });
    await h.run.settle();

    expect(h.briefs).toEqual(["Produce items."]);
    expect(h.run.settlements.at(-1)).toContain(
      `contains ${String(WORKFLOW_LIMITS.workItems + 1)} items`,
    );
  });

  test("once the ledger refuses, the remaining rounds are skipped and named", async () => {
    const h = await harness(() => Promise.resolve(completed({ findings: [], coverage_gaps: [] })), {
      ledger: createWorkflowLedger(0),
    });
    await h.handle({
      rounds: [
        { id: "one", title: "Go once", type: "findings", over: "once", brief: "Go." },
        { id: "two", title: "Go again", type: "findings", over: "once", brief: "Again." },
      ],
    });
    await h.run.settle();
    expect(h.run.settlements.at(-1)).toContain("two: skipped (the token budget was exhausted)");
  });

  test("a repeat block stops once a pass produces nothing new", async () => {
    const h = await harness(() =>
      Promise.resolve(completed({ findings: [{ id: "f1", claim: "same" }], coverage_gaps: [] })),
    );
    await h.handle({
      rounds: [
        {
          id: "review",
          title: "Review finding",
          type: "findings",
          over: "once",
          brief: "Review it.",
        },
      ],
      repeat: { rounds: ["review"], dedupe_by: ["claim"], max_rounds: 5, dry_rounds: 1 },
    });
    await h.run.settle();
    expect(h.run.settlements.at(-1)).toContain("repeat: skipped (stopped: dry_rounds)");
  });

  test("a cancelled leader stops the automatic repeat instead of spawning a replacement", async () => {
    let calls = 0;
    const h = await harness(() => {
      calls += 1;
      return Promise.resolve(cancelled());
    });
    await h.handle({
      rounds: [
        {
          id: "review",
          title: "Review finding",
          type: "findings",
          over: "once",
          brief: "Review it.",
        },
      ],
      repeat: { rounds: ["review"], dedupe_by: ["claim"], max_rounds: 5, dry_rounds: 1 },
    });
    await h.run.settle();

    expect(calls).toBe(1);
    expect(h.run.registrations).toBe(1);
    expect(h.run.settlements.at(-1)).toContain("workflow: skipped (stopped after cancellation)");
  });
});

describe("run_round — the wave-boundary baton spans rounds too", () => {
  test("the live-child count only reaches zero at the very end", async () => {
    const h = await harness((prompt) =>
      Promise.resolve(
        prompt.startsWith("Map")
          ? completed({
              scope: "s",
              evidence: [],
              unknowns: [],
              work_items: [
                {
                  id: "a",
                  title: "Do a",
                  goal: "do a",
                  files: [],
                  dependencies: [],
                  mutation: false,
                },
              ],
            })
          : completed({ findings: [], coverage_gaps: [] }),
      ),
    );
    await h.handle({
      rounds: [
        DISCOVER,
        {
          id: "review",
          title: "{{item.title}}",
          type: "findings",
          over: "each(discover.work_items)",
          brief: "{{item.goal}}",
        },
      ],
    });
    await h.run.settle();
    const counts = h.run.liveAfterSettle;
    expect(counts).toHaveLength(2);
    expect(counts.slice(0, -1).every((n) => n > 0)).toBe(true);
    expect(counts.at(-1)).toBe(0);
  });
});

describe("run_round — a batch wider than the registry is queued, not dropped", () => {
  /** A `once` round returning six plain items, then a round consuming each of them. */
  const SIX_ITEMS = {
    rounds: [
      { id: "discover", title: "Map work", type: "free", over: "once", brief: "Map the work." },
      {
        id: "review",
        title: "Review {{item.name}}",
        type: "findings",
        over: "each(discover.items)",
        brief: "Review {{item.name}}.",
      },
    ],
  };

  const sixItems = (prompt: string): Promise<ExecuteRunOutcome> =>
    Promise.resolve(
      prompt.startsWith("Map")
        ? completed({ items: [1, 2, 3, 4, 5, 6].map((n) => ({ name: `i${String(n)}` })) })
        : completed({ findings: [{ claim: prompt }], coverage_gaps: [] }),
    );

  test("every unit runs even when the live-child ceiling admits only part of the batch", async () => {
    const h = await harness(sixItems, {}, { maxLiveChildren: 3 });
    await h.handle(SIX_ITEMS);
    await h.run.settle();

    const started = h.records.filter((e) => e.kind === "workflow_run_started");
    expect(started).toHaveLength(7);
    expect(h.run.settlements.at(-1)).toContain("review: 6 leader(s)");
  });

  test("the live-child count still only reaches zero at the very end", async () => {
    const h = await harness(sixItems, {}, { maxLiveChildren: 3 });
    await h.handle(SIX_ITEMS);
    await h.run.settle();

    const counts = h.run.liveAfterSettle;
    expect(counts).toHaveLength(7);
    expect(counts.slice(0, -1).every((n) => n > 0)).toBe(true);
    expect(counts.at(-1)).toBe(0);
  });

  test("a cancellation drains the queue instead of starting what it had not paid for", async () => {
    const h = await harness(
      (prompt) => (prompt.startsWith("Map") ? sixItems(prompt) : Promise.resolve(cancelled())),
      {},
      { maxLiveChildren: 3 },
    );
    await h.handle(SIX_ITEMS);
    await h.run.settle();

    const started = h.records.filter((e) => e.kind === "workflow_run_started");
    // The queue keeps the registry full, so some leaders were already running when
    // the first cancellation landed — but the rest of the queue is never started.
    expect(started.length).toBeLessThan(7);
    // Still six outcomes: the ones never started are reported, not lost.
    expect(h.run.settlements.at(-1)).toContain("review: 6 leader(s)");
    expect(h.run.settlements.at(-1)).toContain("stopped after cancellation");
  });
});

describe("run_round — defects the review caught", () => {
  /** A discovery result carrying the given work items. */
  function discovery(items: { id: string; deps?: string[] }[]): unknown {
    return {
      scope: "s",
      evidence: [],
      unknowns: [],
      work_items: items.map((i) => ({
        id: i.id,
        title: `Do ${i.id}`,
        goal: `do ${i.id}`,
        files: [],
        dependencies: i.deps ?? [],
        mutation: false,
      })),
    };
  }

  test("fanout is honoured for a work-item round, not collapsed to one leader per item", async () => {
    const h = await harness((prompt) =>
      Promise.resolve(
        prompt.startsWith("Map")
          ? completed(discovery([{ id: "a" }, { id: "b" }]))
          : completed({ finding_id: "x", verdict: "refuted", evidence: [], reason: "r" }),
      ),
    );
    await h.handle({
      rounds: [
        DISCOVER,
        {
          id: "judge",
          title: "Judge {{item.title}}",
          type: "verdict",
          over: "each(discover.work_items)",
          fanout: 3,
          accept: "majority(verdict, refuted)",
          brief: "{{item.goal}}",
        },
      ],
    });
    await h.run.settle();

    // Two items × three replicas. Collapsing to one leader per item would fold a
    // "majority" over a single vote, which reads as unanimous confirmation.
    expect(h.briefs.filter((b) => b.startsWith("do "))).toHaveLength(6);
    expect(h.run.settlements.at(-1)).toContain("judge: 6 leader(s), 2 accepted / 0 rejected");
  });

  test("a work item whose dependency failed is not dispatched, only ordered after it", async () => {
    const h = await harness((prompt) => {
      if (prompt.startsWith("Map")) {
        return Promise.resolve(completed(discovery([{ id: "a" }, { id: "b", deps: ["a"] }])));
      }
      return prompt.startsWith("do a")
        ? Promise.resolve(errored("a exploded"))
        : Promise.resolve(completed({ findings: [], coverage_gaps: [] }));
    });
    await h.handle({
      rounds: [
        DISCOVER,
        {
          id: "work",
          title: "{{item.title}}",
          type: "findings",
          over: "each(discover.work_items)",
          brief: "{{item.goal}}",
        },
      ],
    });
    await h.run.settle();

    // 'b' declared a dependency on 'a'; wave ordering alone would still run it.
    expect(h.briefs.filter((b) => b.startsWith("do b"))).toEqual([]);
    expect(h.run.settlements.some((s) => s.includes("'a' did not finish"))).toBe(true);
  });

  test("a round the registry cannot admit leaves the live count above zero and still reports", async () => {
    const h = await harness(
      (prompt) =>
        Promise.resolve(
          prompt.startsWith("Map")
            ? completed(discovery([{ id: "a" }]))
            : completed({ findings: [], coverage_gaps: [] }),
        ),
      {},
      { maxLiveChildren: 1 },
    );
    await h.handle({
      rounds: [
        DISCOVER,
        {
          id: "work",
          title: "{{item.title}}",
          type: "findings",
          over: "each(discover.work_items)",
          brief: "{{item.goal}}",
        },
      ],
    });
    await h.run.settle();

    // The second round could not register (the baton holds the only slot). The
    // baton must not be released for it, or the manager may finish mid-sequence.
    const counts = h.run.liveAfterSettle;
    expect(counts.slice(0, -1).every((n) => n > 0)).toBe(true);
    expect(counts.at(-1)).toBe(0);
    // And the summary still lands, rather than the driver going quiet.
    expect(h.run.settlements.at(-1)).toContain("rounds finished");
  });

  test("a fault mid-sequence still settles the held handle and reports what ran", async () => {
    const runDeps = promptRunDeps(() => Promise.resolve(completed(discovery([{ id: "a" }]))));
    const { bc, records } = recordingBc();
    let calls = 0;
    const trace = bc.trace;
    const original = trace.record.bind(trace);
    trace.record = (kind: string, detail: unknown): void => {
      calls += 1;
      // Fail once the second round is under way, after the first has settled.
      if (kind === "workflow_run_started" && calls > 3) throw new Error("trace sink exploded");
      original(kind, detail);
    };
    const run = runCtx();
    const capability = await createWorkflowsCapability(
      makeCtx({ runDeps, assemble: assembler }),
    ).forRun(run.runCtx);
    const handler = capability!.forAgent(scope())!.attach(bc).handlers![2]!;
    await handler.handle(
      {
        id: "call",
        name: RUN_ROUND_TOOL_NAME,
        arguments: {
          rounds: [
            DISCOVER,
            {
              id: "work",
              title: "{{item.title}}",
              type: "findings",
              over: "each(discover.work_items)",
              brief: "{{item.goal}}",
            },
          ],
        },
      } satisfies LLMToolCall,
      0,
    );
    await run.settle();

    // agents.adopt swallows the rejection, so an unsettled baton would block
    // await_agents until teardown with nothing reported at all.
    expect(run.settlements.at(-1)).toContain("rounds finished");
    expect(records.length).toBeGreaterThan(0);
  });
});

describe("run_round — round ids are keys, not free text", () => {
  test.each([
    ["a bracketed index, which foldRound's key parsing would confuse", "pass[1]"],
    ["whitespace", "my round"],
    ["a path separator", "a/b"],
  ])("refuses an id with %s", async (_label, id) => {
    const h = await harness();
    const verdict = await h.handle({ rounds: [{ ...DISCOVER, id }] });
    expect(verdict.text).toContain("rounds[0].id is required");
    expect(verdict.progress).toBe(false);
  });
});
