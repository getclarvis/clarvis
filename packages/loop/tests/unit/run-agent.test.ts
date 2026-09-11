import { describe, it, expect } from "../bun-test.ts";
import {
  runAgent,
  type AgentBuildContext,
  type RunAgentInput,
} from "../../src/runtime/loop/run-agent.ts";
import type { EngineHandlerVerdict, HandlerVerdict } from "../../src/runtime/loop/loop-contract.ts";
import type { LiveContext } from "../../src/runtime/context/context-compaction.ts";
import type { AgentCapability, AgentLoopContribution, Logger } from "@clarvis/capability";
import { contentToText } from "@clarvis/capability";
import { askUserAgentCapability } from "../../src/runtime/capabilities/ask-user.ts";
import type { AskUser } from "../../src/runtime/tools/ask-user-tool.ts";
import type { LifecycleHook } from "@clarvis/capability";
import { createTrace, type TraceHandle } from "@clarvis/trace";
import { createTokenLedger, createIterationCounter } from "../../src/runtime/budget/index.ts";
import { buildRegistry } from "../../src/runtime/tools/mcp-registry.ts";
import { compileResultContract } from "../../src/runtime/tools/index.ts";
import { DISABLED_COMPACTION } from "../../src/runtime/context/index.ts";
import { MockLLM } from "../helpers/fixtures.ts";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { name: { type: "string" } },
  required: ["name"],
};

const CHECKPOINT = {
  mode: "checkpoint" as const,
  disposition: "checkpoint" as const,
  checkpoint: { summary: "First change applied", next_step: "Verify the change" },
};

describe("context preparation admission", () => {
  it.each(["stop", "cancel"] as const)(
    "awaits iteration preparation and honors %s before inference",
    async (mode) => {
      const llm = new MockLLM({ script: [] });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const controller = new AbortController();
      const input = makeInput(llm, {
        signal: controller.signal,
        buildContribution: () => ({
          hooks: {
            async beforeIteration() {
              entered.resolve();
              await release.promise;
              return {
                status: "error",
                partialText: "",
                error: { code: "state_unavailable", message: "Unavailable" },
              };
            },
          },
        }),
      });
      const pending = runAgent(input);
      try {
        await entered.promise;
        expect(llm.calls).toEqual([]);
        if (mode === "cancel") controller.abort();
        else release.resolve();
        expect(await pending).toMatchObject(
          mode === "cancel"
            ? { status: "cancelled" }
            : { status: "error", error: { code: "state_unavailable" } },
        );
        expect(llm.calls).toEqual([]);
      } finally {
        release.resolve();
      }
    },
  );

  it("preserves cancellation when preparation also exhausts the shared budget", async () => {
    const llm = new MockLLM({ script: [] });
    const controller = new AbortController();
    const input = makeInput(llm, { maxTokens: 1, signal: controller.signal });
    const result = await runAgent({
      ...input,
      prepareContext: async () => {
        input.budget.ledger.consume({
          input_tokens: 1,
          output_tokens: 0,
          cached_tokens: 0,
          cache_write_tokens: 0,
        });
        controller.abort();
      },
    });
    expect(result.status).toBe("cancelled");
    expect(llm.calls).toEqual([]);
    expect(input.budget.ledger.consumed()).toBe(1);
  });

  it("attaches once before preparation and appends notes after the existing context", async () => {
    const llm = new MockLLM({
      script: [{ toolCalls: [{ name: "submit_result", arguments: { name: "done" } }] }],
    });
    const order: string[] = [];
    const input = makeInput(llm, {
      buildContribution: (bc) => {
        order.push("attach");
        bc.ctx.appendNote("Capability reminder");
        return {};
      },
    });
    const result = await runAgent({
      ...input,
      prepareContext: async (ctx) => {
        order.push("prepare");
        ctx.appendNote("Auxiliary reading");
      },
    });
    expect(result.status).toBe("completed");
    expect(order).toEqual(["attach", "prepare"]);
    expect(llm.calls[0]!.messages.map((message) => message.content)).toEqual([
      "go",
      "Capability reminder",
      "Auxiliary reading",
    ]);
  });

  it.each(["before", "after"] as const)("checks the shared budget %s preparation", async (when) => {
    const llm = new MockLLM({ script: [] });
    const input = makeInput(llm, { maxTokens: when === "before" ? 0 : 1 });
    let prepared = false;
    const result = await runAgent({
      ...input,
      prepareContext: async () => {
        prepared = true;
        input.budget.ledger.consume({
          input_tokens: 1,
          output_tokens: 0,
          cached_tokens: 0,
          cache_write_tokens: 0,
        });
      },
    });
    expect(result.status).toBe("budget_exhausted");
    expect(prepared).toBe(when === "after");
    expect(llm.calls).toEqual([]);
  });
});

function makeInput(
  llm: MockLLM,
  opts: {
    maxIterations?: number;
    maxTokens?: number;
    noProgressLimit?: number;
    textNoSubmitMessage?: (streak: number) => string;
    askUser?: AskUser;
    signal?: AbortSignal;
    onStart?: () => void;
    buildContribution?: (bc: AgentBuildContext) => AgentLoopContribution;
    trace?: TraceHandle;
    hooks?: LifecycleHook[];
    onContext?: (ctx: LiveContext) => void;
  } = {},
): RunAgentInput {
  const agentCapabilities: AgentCapability[] = [
    ...(opts.buildContribution
      ? [
          {
            attach: (bc: AgentBuildContext) => ({
              ...opts.buildContribution!(bc),
              advertised: false,
            }),
          },
        ]
      : []),
    ...(opts.askUser ? [askUserAgentCapability(opts.askUser)] : []),
  ];
  return {
    agent: "subagent",
    subagentInstanceId: "w1",
    messages: [{ role: "user", content: "go" }],
    target: {
      llm,
      model: "m",
      provider: "anthropic",
      capabilities: new Set(["tool_calling", "vision"]),
    },
    budget: {
      ledger: createTokenLedger(opts.maxTokens ?? 1_000_000),
      counter: createIterationCounter(opts.maxIterations ?? 50),
      usage: { input: 0, output: 0, cached: 0, cache_write: 0 },
    },
    runtime: {
      trace: opts.trace ?? createTrace(),
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
    compaction: DISABLED_COMPACTION,
    registry: buildRegistry([], []),
    contract: compileResultContract(SCHEMA),
    ...(agentCapabilities.length > 0 ? { agentCapabilities } : {}),
    mcpProgress: (r) => r.errText === null,
    allToolsUnavailable: () => false,
    noProgressLimit: opts.noProgressLimit ?? 6,
    noProgressMessage: (streak) => `Subagent made no progress for ${streak} iterations.`,
    ...(opts.textNoSubmitMessage ? { textNoSubmitMessage: opts.textNoSubmitMessage } : {}),
    emptyResponseAgent: "LLM",
    ...(opts.onStart ? { onStart: opts.onStart } : {}),
    ...(opts.hooks ? { hooks: opts.hooks } : {}),
    ...(opts.onContext ? { onContext: opts.onContext } : {}),
  };
}

describe("gated checkpoint finalization", () => {
  it("keeps post-tool hook redaction when the handler requests a checkpoint", async () => {
    let context: LiveContext;
    const result = await runAgent(
      makeInput(new MockLLM({ script: [{ toolCalls: [{ name: "checkpoint", arguments: {} }] }] }), {
        onContext: (value) => {
          context = value;
        },
        hooks: [{ afterToolUse: async () => ({ kind: "deny", message: "sensitive image" }) }],
        buildContribution: () => ({
          handlers: [
            {
              matches: () => true,
              handle: async () => ({
                kind: "finalize",
                attempt: CHECKPOINT,
                text: "stage data",
                progress: false,
                images: [{ data: "AAAA", mediaType: "image/png" }],
              }),
            },
          ],
        }),
      }),
    );
    expect(result.disposition).toBe("checkpoint");
    const tool = context!.messages.find((message) => message.role === "tool");
    expect(tool?.content).toBe("DENIED by a workspace hook: sensitive image");
    expect(tool?.images ?? []).toEqual([]);
  });

  it("joins deferred work and records every call before consulting gates, without producing a final schema value", async () => {
    const release = Promise.withResolvers<void>();
    const requested = Promise.withResolvers<void>();
    let gates = 0;
    let afterDispatch = 0;
    let tailCalls = 0;
    let context: LiveContext;
    const accepted: unknown[] = [];
    const hookAttempts: unknown[] = [];
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            { id: "job", name: "job", arguments: {} },
            { id: "checkpoint", name: "checkpoint", arguments: {} },
            { id: "tail", name: "tail", arguments: {} },
          ],
        },
      ],
    });
    const running = runAgent(
      makeInput(llm, {
        onContext: (value) => {
          context = value;
        },
        hooks: [
          {
            preFinalize: async (attempt) => {
              hookAttempts.push(attempt);
              return { kind: "pass" };
            },
          },
        ],
        buildContribution: () => ({
          handlers: [
            {
              matches: () => true,
              async handle(call) {
                if (call.name === "job")
                  return {
                    kind: "deferred",
                    run: async () => {
                      await release.promise;
                      return { text: "job settled", progress: true };
                    },
                  };
                if (call.name === "tail") {
                  tailCalls++;
                  return { kind: "result", text: "unexpected", progress: false };
                }
                requested.resolve();
                return {
                  kind: "finalize",
                  attempt: CHECKPOINT,
                  text: "checkpoint requested",
                  progress: false,
                };
              },
            },
          ],
          gates: [
            {
              async check(attempt) {
                gates++;
                expect(afterDispatch).toBe(1);
                expect(attempt).toEqual(CHECKPOINT);
                const messages = context.messages;
                expect(
                  messages
                    .filter((message) => message.role === "tool")
                    .map((message) => message.content),
                ).toEqual([
                  "job settled",
                  "checkpoint requested",
                  "Tool 'tail' was not completed (the dispatch ended before its result).",
                ]);
                return { kind: "pass" };
              },
            },
          ],
          hooks: {
            afterDispatch: () => {
              afterDispatch++;
            },
            onFinalizeAccepted: (attempt) => {
              accepted.push(attempt);
            },
          },
        }),
      }),
    );
    await requested.promise;
    expect(gates).toBe(0);
    release.resolve();
    const result = await running;
    expect(result).toMatchObject({
      status: "completed",
      disposition: "checkpoint",
      checkpoint: CHECKPOINT.checkpoint,
    });
    expect(result.structuredResult).toBeUndefined();
    expect(result.text).toBeUndefined();
    expect(tailCalls).toBe(0);
    expect(gates).toBe(1);
    expect(accepted).toEqual([CHECKPOINT]);
    expect(hookAttempts).toEqual([
      {
        agent: "subagent",
        subagentInstanceId: "w1",
        mode: "checkpoint",
        checkpoint: CHECKPOINT.checkpoint,
      },
    ]);
  });

  it("bounds a denied checkpoint without manufacturing success", async () => {
    let accepted = 0;
    const llm = new MockLLM({
      script: Array.from({ length: 4 }, () => ({
        toolCalls: [{ name: "checkpoint", arguments: {} }],
      })),
    });
    const result = await runAgent(
      makeInput(llm, {
        noProgressLimit: 2,
        hooks: [
          { preFinalize: async () => ({ kind: "deny", message: "verification still required" }) },
        ],
        buildContribution: () => ({
          handlers: [
            {
              matches: () => true,
              handle: async () => ({
                kind: "finalize",
                attempt: CHECKPOINT,
                text: "requested",
                progress: false,
              }),
            },
          ],
          hooks: {
            onFinalizeAccepted: () => {
              accepted++;
            },
          },
        }),
      }),
    );
    expect(result).toMatchObject({ status: "error", error: { code: "no_progress" } });
    expect(result.checkpoint).toBeUndefined();
    expect(accepted).toBe(0);
    expect(llm.calls).toHaveLength(2);
  });

  it.each(["error", "cancelled"] as const)("preserves a gate's %s status", async (status) => {
    const result = await runAgent(
      makeInput(new MockLLM({ script: [{ toolCalls: [{ name: "checkpoint", arguments: {} }] }] }), {
        buildContribution: () => ({
          handlers: [
            {
              matches: () => true,
              handle: async () => ({
                kind: "finalize",
                attempt: CHECKPOINT,
                text: "requested",
                progress: false,
              }),
            },
          ],
          gates: [
            {
              check: async () => ({
                kind: "terminal",
                result: { status, partialText: "stage stopped" },
              }),
            },
          ],
        }),
      }),
    );
    expect(result).toEqual({ status, partialText: "stage stopped" });
  });

  it("does not accept a checkpoint if cancellation arrives during a gate", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    let accepted = false;
    const running = runAgent(
      makeInput(new MockLLM({ script: [{ toolCalls: [{ name: "checkpoint", arguments: {} }] }] }), {
        signal: controller.signal,
        buildContribution: () => ({
          handlers: [
            {
              matches: () => true,
              handle: async () => ({
                kind: "finalize",
                attempt: CHECKPOINT,
                text: "requested",
                progress: false,
              }),
            },
          ],
          gates: [
            {
              check: async () => {
                entered.resolve();
                await release.promise;
                return { kind: "pass" };
              },
            },
          ],
          hooks: {
            onFinalizeAccepted: () => {
              accepted = true;
            },
          },
        }),
      }),
    );
    await entered.promise;
    controller.abort();
    release.resolve();
    expect(await running).toMatchObject({ status: "cancelled" });
    expect(accepted).toBe(false);
  });

  it("rejects malformed checkpoint metadata before any gate sees it", async () => {
    let gateCalls = 0;
    const result = await runAgent(
      makeInput(new MockLLM({ script: [{ toolCalls: [{ name: "checkpoint", arguments: {} }] }] }), {
        noProgressLimit: 1,
        buildContribution: () => ({
          handlers: [
            {
              matches: () => true,
              handle: async () => ({
                kind: "finalize",
                attempt: {
                  ...CHECKPOINT,
                  checkpoint: { summary: " ", next_step: "x".repeat(4097) },
                },
                text: "requested",
                progress: false,
              }),
            },
          ],
          gates: [
            {
              check: async () => {
                gateCalls++;
                return { kind: "pass" };
              },
            },
          ],
        }),
      }),
    );
    expect(result).toMatchObject({ status: "error", error: { code: "no_progress" } });
    expect(result.checkpoint).toBeUndefined();
    expect(gateCalls).toBe(0);
  });
});

describe("runAgent terminal outcomes", () => {
  it("routes model calls through a contributed shared output budget", async () => {
    let reservations = 0;
    const llm = new MockLLM({
      script: [{ toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] }],
    });

    const result = await runAgent(
      makeInput(llm, {
        buildContribution: () => ({
          outputBudget: {
            remaining: () => Number.POSITIVE_INFINITY,
            reserveOutput: (amount) => {
              reservations += 1;
              return { amount, settle: () => {}, release: () => {} };
            },
          },
        }),
      }),
    );

    expect(result.status).toBe("completed");
    expect(reservations).toBeGreaterThanOrEqual(0);
  });

  it("drains steering, notifies hooks, and combines capability progress", async () => {
    let drained = false;
    let closed = false;
    const observed: string[] = [];
    const llm = new MockLLM({
      script: [{ toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] }],
    });
    const input = makeInput(llm, {
      buildContribution: () => ({
        hooks: {
          contributesProgress: () => true,
        },
        tools: [],
        handlers: [],
        gates: [],
      }),
      hooks: [
        {
          onUserSteer: async (context) => {
            observed.push(String(context.message));
          },
        },
      ],
    });
    input.steer = {
      drain: () => {
        if (drained) return [];
        drained = true;
        return [{ id: "steer-1", content: "new direction" }];
      },
      close: () => {
        closed = true;
      },
    };

    const result = await runAgent(input);

    expect(result.status).toBe("completed");
    expect(observed).toEqual(["new direction"]);
    expect(closed).toBeTrue();
  });

  it("returns budget_exhausted before calling the model when the iteration cap is already reached", async () => {
    const llm = new MockLLM({ script: [] });
    const res = await runAgent(makeInput(llm, { maxIterations: 0 }));
    expect(res.status).toBe("budget_exhausted");
    expect(res.partialText).toBe("");
    expect(llm.calls).toHaveLength(0);
  });

  it("returns a no_progress error with textNoSubmitMessage when text-only replies never submit", async () => {
    const llm = new MockLLM({
      script: [{ text: "thinking" }, { text: "still thinking" }],
    });
    const res = await runAgent(
      makeInput(llm, {
        noProgressLimit: 2,
        textNoSubmitMessage: (streak) => `No submit after ${streak} text-only turns.`,
      }),
    );
    expect(res.status).toBe("error");
    expect(res.error?.code).toBe("no_progress");
    expect(res.error?.message).toBe("No submit after 2 text-only turns.");
    expect(llm.calls).toHaveLength(2);
  });

  it("returns a no_progress error from noProgressMessage when no textNoSubmitMessage is set", async () => {
    const llm = new MockLLM({
      script: [{ text: "thinking" }, { text: "still thinking" }],
    });
    const res = await runAgent(makeInput(llm, { noProgressLimit: 2 }));
    expect(res.status).toBe("error");
    expect(res.error?.code).toBe("no_progress");
    expect(res.error?.message).toBe("Subagent made no progress for 2 iterations.");
    expect(llm.calls).toHaveLength(2);
  });

  it("returns the budget checkpoint result when tokens run out after a text-only turn", async () => {
    const llm = new MockLLM({ script: [{ text: "thinking" }] });
    const res = await runAgent(makeInput(llm, { maxTokens: 15 }));
    expect(res.status).toBe("budget_exhausted");
    expect(res.partialText).toBe("thinking");
    expect(llm.calls).toHaveLength(1);
  });

  it("relays an accepted ask_user answer and finishes when the subagent has no abort signal", async () => {
    const askUser: AskUser = async () => ({ action: "accept", answer: "yes" });
    const llm = new MockLLM({
      script: [
        { toolCalls: [{ name: "ask_user", arguments: { question: "ready?" } }] },
        { toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] },
      ],
    });
    const res = await runAgent(makeInput(llm, { askUser }));
    expect(res.status).toBe("completed");
    expect(res.structuredResult).toEqual({ value: { name: "Ada" } });
    expect(llm.calls).toHaveLength(2);
  });

  it("returns cancelled when the ask_user handler is interrupted by an aborted signal", async () => {
    const ac = new AbortController();
    const askUser: AskUser = async () => {
      ac.abort();
      throw new Error("aborted");
    };
    const llm = new MockLLM({
      script: [{ toolCalls: [{ name: "ask_user", arguments: { question: "are you sure?" } }] }],
    });
    const res = await runAgent(makeInput(llm, { askUser, signal: ac.signal }));
    expect(res.status).toBe("cancelled");
    expect(llm.calls).toHaveLength(1);
  });
});

describe("runAgent cancellation edges", () => {
  it("returns cancelled when the signal aborts before the first iteration preamble", async () => {
    const controller = new AbortController();
    const llm = new MockLLM({
      script: [{ toolCalls: [{ name: "submit_result", arguments: { name: "x" } }] }],
    });
    const res = await runAgent(
      makeInput(llm, { signal: controller.signal, onStart: () => controller.abort() }),
    );
    expect(res.status).toBe("cancelled");
    expect(llm.calls).toHaveLength(0);
  });

  it("records the cancellation exactly once when the abort is detected at the iteration preamble (finding 19)", async () => {
    const trace = createTrace();
    const controller = new AbortController();
    let iterCount = 0;
    const contribution: AgentLoopContribution = {
      tools: [
        {
          fullName: "noop",
          wireName: "noop",
          mcpName: "",
          toolName: "noop",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      handlers: [
        {
          matches: (call) => call.name === "noop",
          handle: async () => ({ kind: "result", text: "ok", progress: true }),
        },
      ],
      gates: [],
      hooks: {
        beforeIteration: () => {
          iterCount += 1;
          if (iterCount >= 2) controller.abort();
        },
      },
    };
    const llm = new MockLLM({
      script: [{ toolCalls: [{ name: "noop", arguments: {} }] }],
    });
    const res = await runAgent(
      makeInput(llm, { signal: controller.signal, buildContribution: () => contribution, trace }),
    );
    expect(res.status).toBe("cancelled");
    expect(llm.calls).toHaveLength(1);
    const cancellations = trace.entries().filter((e) => e.kind === "cancellation");
    expect(cancellations).toHaveLength(1);
  });

  it("returns cancelled (not no_progress) when an abort lands mid-dispatch at the no-progress threshold", async () => {
    const controller = new AbortController();
    const tool = (name: string) => ({
      fullName: name,
      wireName: name,
      mcpName: "",
      toolName: name,
      inputSchema: { type: "object" as const, properties: {} },
    });
    const contribution: AgentLoopContribution = {
      tools: [tool("noop1"), tool("noop2")],
      handlers: [
        {
          matches: (call) => call.name === "noop1",
          handle: async () => {
            controller.abort();
            return { kind: "result", text: "ok", progress: false };
          },
        },
        {
          matches: (call) => call.name === "noop2",
          handle: async () => ({ kind: "result", text: "ok2", progress: false }),
        },
      ],
      gates: [],
      hooks: {},
    };
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            { name: "noop1", arguments: {} },
            { name: "noop2", arguments: {} },
          ],
        },
      ],
    });
    const res = await runAgent(
      makeInput(llm, {
        signal: controller.signal,
        buildContribution: () => contribution,
        noProgressLimit: 1,
      }),
    );
    expect(res.status).toBe("cancelled");
    expect(res.error?.code).toBeUndefined();
    expect(llm.calls).toHaveLength(1);
  });

  it("continues past a tool handler that reports cancelled while the run is not aborted, pairing the tool_call with a tool result (finding 16)", async () => {
    const contribution: AgentLoopContribution = {
      tools: [
        {
          fullName: "noop_cancel",
          wireName: "noop_cancel",
          mcpName: "",
          toolName: "noop_cancel",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      handlers: [
        {
          matches: (call) => call.name === "noop_cancel",
          handle: async () => ({ kind: "cancelled" }),
        },
      ],
      gates: [],
      hooks: {},
    };
    const llm = new MockLLM({
      script: [
        { toolCalls: [{ id: "tc_cancel", name: "noop_cancel", arguments: {} }] },
        { toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] },
      ],
    });
    const res = await runAgent(makeInput(llm, { buildContribution: () => contribution }));
    expect(res.status).toBe("completed");
    expect(res.structuredResult).toEqual({ value: { name: "Ada" } });
    expect(llm.calls).toHaveLength(2);

    const second = llm.calls[1]!.messages as ReadonlyArray<{
      role: string;
      tool_calls?: ReadonlyArray<{ id: string }>;
      tool_call_id?: string;
    }>;
    const asstIdx = second.findIndex(
      (m) => m.role === "assistant" && (m.tool_calls?.some((c) => c.id === "tc_cancel") ?? false),
    );
    expect(asstIdx).toBeGreaterThanOrEqual(0);
    expect(second.some((m) => m.role === "tool" && m.tool_call_id === "tc_cancel")).toBe(true);
  });
});

describe("runDispatch converts tool handler failures into error results", () => {
  const tool = (name: string) => ({
    fullName: name,
    wireName: name,
    mcpName: "",
    toolName: name,
    inputSchema: { type: "object" as const, properties: {} },
  });

  const assertNoOrphans = (
    messages: ReadonlyArray<{
      role: string;
      tool_calls?: ReadonlyArray<{ id: string }>;
      tool_call_id?: string;
    }>,
  ): void => {
    for (const m of messages) {
      for (const c of m.tool_calls ?? []) {
        expect(messages.some((t) => t.role === "tool" && t.tool_call_id === c.id)).toBe(true);
      }
    }
  };

  it("continues the run when a handler throws synchronously, pairing the tool_call with a failure result", async () => {
    const contribution: AgentLoopContribution = {
      tools: [tool("boom")],
      handlers: [
        {
          matches: (c) => c.name === "boom",
          handle: (): Promise<HandlerVerdict> => {
            throw new Error("kapow");
          },
        },
      ],
      gates: [],
      hooks: {},
    };
    const llm = new MockLLM({
      script: [
        { toolCalls: [{ id: "tc_boom", name: "boom", arguments: {} }] },
        { toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] },
      ],
    });
    const res = await runAgent(makeInput(llm, { buildContribution: () => contribution }));
    expect(res.status).toBe("completed");
    expect(llm.calls).toHaveLength(2);

    const second = llm.calls[1]!.messages as ReadonlyArray<{
      role: string;
      content?: unknown;
      tool_calls?: ReadonlyArray<{ id: string }>;
      tool_call_id?: string;
    }>;
    const toolMsg = second.find((m) => m.role === "tool" && m.tool_call_id === "tc_boom");
    expect(toolMsg).toBeDefined();
    expect(String(toolMsg!.content)).toBe("Tool 'boom' failed: kapow");
    assertNoOrphans(second);
  });

  it("converts a rejecting deferred run into a failure result instead of a dangling slot", async () => {
    const contribution: AgentLoopContribution = {
      tools: [tool("later")],
      handlers: [
        {
          matches: (c) => c.name === "later",
          handle: async (): Promise<HandlerVerdict> => ({
            kind: "deferred",
            run: async () => {
              throw new Error("deferred kapow");
            },
          }),
        },
      ],
      gates: [],
      hooks: {},
    };
    const llm = new MockLLM({
      script: [
        { toolCalls: [{ id: "tc_later", name: "later", arguments: {} }] },
        { toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] },
      ],
    });
    const res = await runAgent(makeInput(llm, { buildContribution: () => contribution }));
    expect(res.status).toBe("completed");
    expect(llm.calls).toHaveLength(2);

    const second = llm.calls[1]!.messages as ReadonlyArray<{
      role: string;
      content?: unknown;
      tool_calls?: ReadonlyArray<{ id: string }>;
      tool_call_id?: string;
    }>;
    const toolMsg = second.find((m) => m.role === "tool" && m.tool_call_id === "tc_later");
    expect(toolMsg).toBeDefined();
    expect(String(toolMsg!.content)).toBe("Tool 'later' failed: deferred kapow");
    expect(String(toolMsg!.content)).not.toContain("was not completed");
    assertNoOrphans(second);
  });
});

describe("runDispatch abort boundaries", () => {
  const tool = (name: string) => ({
    fullName: name,
    wireName: name,
    mcpName: "",
    toolName: name,
    inputSchema: { type: "object" as const, properties: {} },
  });

  it("returns cancelled when a sequential handler never settles", async () => {
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const contribution: AgentLoopContribution = {
      tools: [tool("stuck")],
      handlers: [
        {
          matches: (call) => call.name === "stuck",
          handle: () => {
            markStarted();
            return new Promise<HandlerVerdict>(() => {});
          },
        },
      ],
      gates: [],
      hooks: {},
    };
    const llm = new MockLLM({
      script: [{ toolCalls: [{ id: "tc_stuck", name: "stuck", arguments: {} }] }],
    });

    const running = runAgent(
      makeInput(llm, {
        signal: controller.signal,
        buildContribution: () => contribution,
      }),
    );
    await started;
    controller.abort();

    const res = await running;
    expect(res.status).toBe("cancelled");
    expect(llm.calls).toHaveLength(1);
  }, 1_000);

  it("does not wait for pending deferreds and observes a rejection that arrives after abort", async () => {
    const controller = new AbortController();
    let startedCount = 0;
    let markAllStarted!: () => void;
    const allStarted = new Promise<void>((resolve) => {
      markAllStarted = resolve;
    });
    const markStarted = (): void => {
      startedCount += 1;
      if (startedCount === 2) markAllStarted();
    };
    const never = new Promise<never>(() => {});
    let rejectLate!: (reason?: unknown) => void;
    const lateRejection = new Promise<never>((_resolve, reject) => {
      rejectLate = reject;
    });
    const contribution: AgentLoopContribution = {
      tools: [tool("never"), tool("late_rejection")],
      handlers: [
        {
          matches: (call) => call.name === "never",
          handle: async (): Promise<HandlerVerdict> => ({
            kind: "deferred",
            run: () => {
              markStarted();
              return never;
            },
          }),
        },
        {
          matches: (call) => call.name === "late_rejection",
          handle: async (): Promise<HandlerVerdict> => ({
            kind: "deferred",
            run: () => {
              markStarted();
              return lateRejection;
            },
          }),
        },
      ],
      gates: [],
      hooks: {},
    };
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            { id: "tc_never", name: "never", arguments: {} },
            { id: "tc_late", name: "late_rejection", arguments: {} },
          ],
        },
      ],
    });
    const warnings: unknown[][] = [];
    const logger = {
      debug: () => {},
      info: () => {},
      error: () => {},
      warn: (...args: unknown[]) => warnings.push(args),
    } as unknown as Logger;

    const running = runAgent({
      ...makeInput(llm, {
        signal: controller.signal,
        buildContribution: () => contribution,
      }),
      logger,
    });
    await allStarted;
    controller.abort();

    const res = await running;
    expect(res.status).toBe("cancelled");
    expect(llm.calls).toHaveLength(1);

    rejectLate(new Error("rejected after cancellation"));
    await Bun.sleep(0);
    expect(JSON.stringify(warnings)).toContain("rejected after cancellation");
  }, 1_000);
});

describe("a terminal verdict's own context entry", () => {
  const tool = (name: string) => ({
    fullName: name,
    wireName: name,
    mcpName: "",
    toolName: name,
    inputSchema: { type: "object" as const, properties: {} },
  });

  const runStop = async (
    verdict: EngineHandlerVerdict,
    trailing = false,
  ): Promise<{ status: string; texts: string[] }> => {
    const contribution: AgentLoopContribution = {
      tools: trailing ? [tool("stop"), tool("never")] : [tool("stop")],
      handlers: [
        { matches: (c) => c.name === "stop", handle: async () => verdict },
        {
          matches: (c) => c.name === "never",
          handle: async (): Promise<HandlerVerdict> => ({
            kind: "result",
            text: "the batch reached me",
            progress: true,
          }),
        },
      ],
      gates: [],
      hooks: {},
    };
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            { id: "tc_stop", name: "stop", arguments: {} },
            ...(trailing ? [{ id: "tc_never", name: "never", arguments: {} }] : []),
          ],
        },
      ],
    });
    const contexts: LiveContext[] = [];
    const res = await runAgent(
      makeInput(llm, {
        buildContribution: () => contribution,
        onContext: (c) => {
          contexts.push(c);
        },
      }),
    );
    const snap = contexts[0]!.snapshot();
    const texts = snap
      .filter((e) => e.message.role === "tool")
      .map((e) => contentToText(e.message.content));
    return { status: res.status, texts };
  };

  it("uses the text the handler framed when the terminal verdict carries one", async () => {
    const out = await runStop({
      kind: "terminal",
      result: { status: "completed", partialText: "" },
      text: "Tool 'stop' result: handled",
    });
    expect(out.status).toBe("completed");
    expect(out.texts).toEqual(["Tool 'stop' result: handled"]);
  });

  it("derives the error message when the terminal verdict carries no text", async () => {
    const out = await runStop({
      kind: "terminal",
      result: { status: "error", partialText: "", error: { code: "no_progress", message: "boom" } },
    });
    expect(out.status).toBe("error");
    expect(out.texts).toEqual(["Tool 'stop' result (error): boom"]);
    expect(out.texts[0]).not.toContain("was not completed");
  });

  it("names the cancellation when the terminal result is a cancelled one", async () => {
    const out = await runStop({
      kind: "terminal",
      result: { status: "cancelled", partialText: "" },
    });
    expect(out.status).toBe("cancelled");
    expect(out.texts).toEqual(["Tool 'stop' was cancelled."]);
  });

  it("records a plain acceptance for an error-free terminal result", async () => {
    const out = await runStop({
      kind: "terminal",
      result: { status: "completed", partialText: "" },
    });
    expect(out.status).toBe("completed");
    expect(out.texts).toEqual(["Tool 'stop' result: accepted (the run ended with this call)."]);
  });

  it("still fills the calls the terminated batch never reached", async () => {
    const out = await runStop(
      { kind: "terminal", result: { status: "completed", partialText: "" } },
      true,
    );
    expect(out.texts).toEqual([
      "Tool 'stop' result: accepted (the run ended with this call).",
      "Tool 'never' was not completed (the dispatch ended before its result).",
    ]);
  });
});

describe("pre-loop budget exhaustion mirrors the checkpoint exit path", () => {
  it("fires onBudgetExhausted and records a budget_check when the iteration cap is already reached", async () => {
    const seen: unknown[] = [];
    const hooks: LifecycleHook[] = [{ onBudgetExhausted: async (c) => void seen.push(c) }];
    const trace = createTrace();
    const llm = new MockLLM({ script: [] });
    const res = await runAgent(makeInput(llm, { maxIterations: 0, hooks, trace }));
    expect(res.status).toBe("budget_exhausted");
    expect(llm.calls).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ agent: "subagent", reason: "exhausted", iterationsUsed: 0 });
    expect(trace.entries().some((e) => e.kind === "budget_check")).toBe(true);
  });

  it("fires onBudgetExhausted and records a budget_check when the token budget is already spent", async () => {
    const seen: unknown[] = [];
    const hooks: LifecycleHook[] = [{ onBudgetExhausted: async (c) => void seen.push(c) }];
    const trace = createTrace();
    const llm = new MockLLM({ script: [] });
    const res = await runAgent(makeInput(llm, { maxTokens: 0, hooks, trace }));
    expect(res.status).toBe("budget_exhausted");
    expect(llm.calls).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ agent: "subagent", reason: "exhausted" });
    expect(trace.entries().some((e) => e.kind === "budget_check")).toBe(true);
  });
});

describe("empty-response runtime notes preserve history", () => {
  it("a second empty completion appends a fresh reminder", async () => {
    const contribution: AgentLoopContribution = {
      tools: [
        {
          fullName: "noop",
          wireName: "noop",
          mcpName: "",
          toolName: "noop",
          inputSchema: { type: "object" as const, properties: {} },
        },
      ],
      handlers: [
        {
          matches: (c) => c.name === "noop",
          handle: async () => ({ kind: "result", text: "ok", progress: true }),
        },
      ],
      gates: [],
      hooks: {},
    };
    const llm = new MockLLM({
      script: [
        {},
        { toolCalls: [{ name: "noop", arguments: {} }] },
        {},
        { toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] },
      ],
    });
    const res = await runAgent(makeInput(llm, { buildContribution: () => contribution }));
    expect(res.status).toBe("completed");
    expect(llm.calls).toHaveLength(4);
    const finalMessages = llm.calls[3]!.messages;
    const emptyNotes = finalMessages.filter(
      (m) =>
        typeof m.content === "string" && m.content.includes("the previous completion was empty"),
    );
    expect(emptyNotes).toHaveLength(2);
  });
});
