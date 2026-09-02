import { describe, expect, test } from "bun:test";
import type {
  AgentHandle,
  AgentRegistration,
  ElicitParams,
  LLMToolCall,
  RunCapabilityContext,
  Usage,
} from "@clarvis/capability";
import { createComputeClock, ElicitTimeoutError } from "@clarvis/capability";
import type { ExecuteRunOutcome } from "@clarvis/loop";
import { createAgentRegistry } from "@clarvis/supervision";
import type { WorkflowDefinition } from "../../src/artifact.ts";
import { createWorkflowsCapability } from "../../src/capability.ts";
import { WORKFLOW_LIMITS } from "../../src/limits.ts";
import { RUN_WORKFLOW_TOOL_NAME } from "../../src/run-workflow.ts";
import type { LeaderSpec, WorkflowRunDeps } from "../../src/types.ts";
import { WORKFLOW_DEFINITIONS } from "../helpers/definitions.ts";
import {
  makeCtx,
  promptFrom,
  recordingBc,
  requestWithPrompt,
  runContextWithAgents,
  scope,
  workflowRunDeps,
} from "../helpers/workflow.ts";

const WORKFLOWS: readonly WorkflowDefinition[] = WORKFLOW_DEFINITIONS;

function usage(): Usage {
  return {
    iterations_used: 1,
    elapsed_ms: 0,
    by_agent: [
      {
        type: "lead",
        model: "m",
        input_tokens: 0,
        output_tokens: 1,
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
    executionId: "x",
    response: { status: "completed", result, usage: usage() },
  };
}

function promptRunDeps(execute: (prompt: string) => Promise<ExecuteRunOutcome>): WorkflowRunDeps {
  return workflowRunDeps((args) => {
    return execute(promptFrom(args));
  });
}

function runCtx(maxLiveChildren = 16): {
  runCtx: RunCapabilityContext;
  settle: () => Promise<void>;
} {
  const registry = createAgentRegistry({
    limits: {
      bufferLines: 500,
      bufferBytes: 131_072,
      maxTotalBufferBytes: 6_291_456,
      pollMaxBytes: 8192,
      awaitTimeoutMs: 5000,
      maxLiveChildren,
      maxRetainedChildren: 32,
      maxNoticesPerIteration: 8,
      maxConsecutiveFailedChildren: 3,
      finishNudges: 2,
    },
  });
  const tasks: Promise<unknown>[] = [];
  const wrapped = {
    ...registry,
    register: (r: AgentRegistration): AgentHandle | null => registry.register(r),
    adopt(id: string, task: Promise<unknown>): void {
      tasks.push(task);
      registry.adopt(id, task);
    },
  };
  return {
    runCtx: runContextWithAgents(wrapped),
    settle: async (): Promise<void> => {
      await Promise.allSettled([...tasks]);
    },
  };
}

async function harness(
  defs = WORKFLOWS,
  maxLiveChildren = 16,
  execute?: (prompt: string) => Promise<ExecuteRunOutcome>,
  approval: "run" | "cancel" | "none" | "timeout" = "cancel",
): Promise<{
  handle: (args: Record<string, unknown>) => Promise<{ text: string; progress: boolean }>;
  briefs: string[];
  toolNames: string[];
  run: ReturnType<typeof runCtx>;
  reviews: ElicitParams[];
}> {
  const briefs: string[] = [];
  const ctx = makeCtx({
    workflowDefs: defs,
    ...(execute !== undefined ? { runDeps: promptRunDeps(execute) } : {}),
    assemble: (spec: LeaderSpec) => {
      briefs.push(spec.prompt);
      return requestWithPrompt(spec.prompt);
    },
  });
  const run = runCtx(maxLiveChildren);
  const capability = await createWorkflowsCapability(ctx).forRun(run.runCtx);
  const reviews: ElicitParams[] = [];
  const contribution = capability!
    .forAgent(
      scope({
        clock: createComputeClock(60_000),
        ...(approval === "none"
          ? {}
          : {
              elicit: async (params) => {
                reviews.push(params);
                if (approval === "timeout") throw new ElicitTimeoutError();
                return {
                  action: "accept" as const,
                  content: { decision: approval },
                };
              },
            }),
      }),
    )!
    .attach(recordingBc().bc);
  const handler = contribution.handlers!.at(-1)!;
  return {
    handle: async (args) => {
      const call: LLMToolCall = { id: "call", name: RUN_WORKFLOW_TOOL_NAME, arguments: args };
      const verdict = await handler.handle(call, 0);
      if (verdict.kind !== "result") throw new Error("expected a result");
      return { text: verdict.text, progress: verdict.progress };
    },
    briefs,
    toolNames: contribution.tools!.map((t) => t.wireName),
    run,
    reviews,
  };
}

describe("run_workflow — the tool exists only when there is something to run", () => {
  test("is not contributed at all when the host supplies no workflows", async () => {
    const h = await harness([]);
    expect(h.toolNames).not.toContain(RUN_WORKFLOW_TOOL_NAME);
    const capability = createWorkflowsCapability(makeCtx({ workflowDefs: [] }));
    expect(capability.reservedWireNames).not.toContain(RUN_WORKFLOW_TOOL_NAME);
    expect(capability.toolEffects?.[RUN_WORKFLOW_TOOL_NAME]).toBeUndefined();
  });

  test("its handler claims run_workflow calls and nothing else", async () => {
    const ctx = makeCtx({ workflowDefs: WORKFLOWS });
    const topLevelCapability = createWorkflowsCapability(ctx);
    expect(topLevelCapability.reservedWireNames).toContain(RUN_WORKFLOW_TOOL_NAME);
    expect(topLevelCapability.toolEffects?.[RUN_WORKFLOW_TOOL_NAME]).toBe("spawn_run");
    const capability = await topLevelCapability.forRun(runCtx().runCtx);
    const handler = capability!.forAgent(scope())!.attach(recordingBc().bc).handlers!.at(-1)!;
    expect(handler.matches({ name: RUN_WORKFLOW_TOOL_NAME, arguments: {} } as never)).toBe(true);
    expect(handler.matches({ name: "run_round", arguments: {} } as never)).toBe(false);
  });

  test("contributes the workflow selected from the local catalogue", async () => {
    const h = await harness();
    expect(h.toolNames).toContain(RUN_WORKFLOW_TOOL_NAME);
  });
});

describe("run_workflow — calls it refuses", () => {
  test.each([
    ["arguments that are not an object", "nope" as unknown, "expected an object"],
    ["a missing name", {}, "'name' is required"],
    ["an unknown workflow", { name: "ghost" }, "no workflow named 'ghost'"],
    ["a missing declared arg", { name: "audit" }, "needs these args"],
    [
      "too many workflow args",
      {
        name: "audit",
        args: Object.fromEntries(
          Array.from({ length: WORKFLOW_LIMITS.args + 1 }, (_, index) => [`k${index}`, "x"]),
        ),
      },
      "'args'",
    ],
    [
      "an oversized workflow arg",
      { name: "audit", args: { subject: "x".repeat(WORKFLOW_LIMITS.textChars + 1) } },
      "args.subject",
    ],
  ])("rejects %s", async (_label, args, expected) => {
    const h = await harness();
    const verdict = await h.handle(args as Record<string, unknown>);
    expect(verdict.text).toContain(expected);
    expect(verdict.progress).toBe(false);
    expect(h.briefs).toEqual([]);
    expect(h.reviews).toEqual([]);
  });

  test.each([
    ["an args value that is not an object", []],
    ["a null args value", null],
  ])("rejects %s", async (_label, args) => {
    const h = await harness();
    const verdict = await h.handle({ name: "audit", args });
    expect(verdict.text).toContain("'args' must be an object");
    expect(verdict.progress).toBe(false);
    expect(h.reviews).toEqual([]);
  });

  test("rejects an oversized args property name", async () => {
    const h = await harness();
    const verdict = await h.handle({
      name: "audit",
      args: { ["k".repeat(WORKFLOW_LIMITS.identifierChars + 1)]: "x" },
    });
    expect(verdict.text).toContain("oversized property name");
    expect(verdict.progress).toBe(false);
  });

  test.each([
    ["no rounds", { ...WORKFLOWS[1]!, rounds: [] }],
    [
      "too many rounds",
      {
        ...WORKFLOWS[1]!,
        rounds: Array.from({ length: WORKFLOW_LIMITS.rounds + 1 }, () => WORKFLOWS[1]!.rounds[0]!),
      },
    ],
    [
      "too many declared args",
      {
        ...WORKFLOWS[1]!,
        args: Array.from({ length: WORKFLOW_LIMITS.args + 1 }, (_, index) => `arg-${index}`),
      },
    ],
    [
      "an oversized declared arg",
      { ...WORKFLOWS[1]!, args: ["x".repeat(WORKFLOW_LIMITS.identifierChars + 1)] },
    ],
    [
      "an oversized synthesis",
      { ...WORKFLOWS[1]!, synthesis: "x".repeat(WORKFLOW_LIMITS.textChars + 1) },
    ],
  ])("rechecks programmatic workflow definitions with %s", async (_label, malformed) => {
    const h = await harness([malformed as WorkflowDefinition]);
    // Keep malformed declared names out of the wire object: `toRoundCall` must
    // reject the loaded/programmatic definition itself, independently of the
    // call parser's property-name guard.
    const suppliedArgs = Object.fromEntries(
      malformed.args
        .filter((name) => name.length <= WORKFLOW_LIMITS.identifierChars)
        .map((name) => [name, "x"]),
    );
    const verdict = await h.handle({ name: malformed.name, args: suppliedArgs });
    expect(verdict.progress).toBe(false);
    expect(verdict.text).toMatch(/must contain|workflow limits|synthesis exceeds/u);
    expect(h.reviews).toEqual([]);
  });
});

describe("run_workflow — explain costs nothing and runs nothing", () => {
  test("describes each round, its fan-out and what the cost scales with", async () => {
    const h = await harness();
    const verdict = await h.handle({ name: "audit", explain: true });
    expect(verdict.progress).toBe(false);
    expect(verdict.text).toContain("discover (discovery): 1 leader");
    expect(verdict.text).toContain("1 leader per item of discover.work_items");
    expect(verdict.text).toContain("×3 replicas each");
    expect(verdict.text).toContain("only if review.coverage_gaps is non-empty");
    expect(verdict.text).toContain("accepted by threshold");
    expect(verdict.text).toContain("Repeat: [review, verify]");
    expect(verdict.text).toContain("scales with what the earlier rounds return");
    // Nothing was started, and no arg was needed to find that out.
    expect(h.briefs).toEqual([]);
  });
});

describe("run_workflow — running one", () => {
  test("starts the first round, interpolates the declared args, and carries the synthesis", async () => {
    const h = await harness(
      WORKFLOWS,
      16,
      () => Promise.resolve(completed({ scope: "s", evidence: [], work_items: [], unknowns: [] })),
      "run",
    );
    const verdict = await h.handle({ name: "audit", args: { subject: "the parser" } });

    expect(verdict.progress).toBe(true);
    expect(verdict.text).toContain("running workflow 'audit'");
    expect(h.reviews).toHaveLength(1);
    expect(h.reviews[0]?.kind).toBe("workflow_review");
    expect(h.reviews[0]?.message).toContain("No leader has been launched yet");
    expect(verdict.text).toContain("discover (discovery, once)");
    // The document's Markdown body is the synthesis brief handed back at the end.
    expect(verdict.text).toContain("Report the findings that survived verification");
    await h.run.settle();
    expect(h.briefs[0]).toContain("Map the parser");
  });

  test("does not start a leader when the human declines the preflight", async () => {
    const h = await harness(WORKFLOWS, 16, undefined, "cancel");
    const verdict = await h.handle({ name: "audit", args: { subject: "the parser" } });
    expect(verdict.progress).toBe(false);
    expect(verdict.text).toContain("was not started");
    expect(h.briefs).toEqual([]);
  });

  test("fails closed when no interactive approval channel is available", async () => {
    const h = await harness(WORKFLOWS, 16, undefined, "none");
    const verdict = await h.handle({ name: "audit", args: { subject: "the parser" } });
    expect(verdict.progress).toBe(false);
    expect(verdict.text).toContain("no interactive approval channel");
    expect(h.briefs).toEqual([]);
    expect(h.reviews).toEqual([]);
  });

  test("fails closed when the workflow approval wait times out", async () => {
    const h = await harness(WORKFLOWS, 16, undefined, "timeout");
    const verdict = await h.handle({ name: "audit", args: { subject: "the parser" } });
    expect(verdict.progress).toBe(false);
    expect(verdict.text).toContain("was not started");
    expect(h.briefs).toEqual([]);
    expect(h.reviews).toHaveLength(1);
  });
});
