import { describe, it, expect } from "../bun-test.ts";
import { contentToText } from "@clarvis/capability";
import { runSubagent, toSubagentOutcome } from "../../src/runtime/subagents/run-subagent.ts";
import { createTrace } from "@clarvis/trace";
import { createTokenLedger } from "../../src/runtime/budget/index.ts";
import { buildRegistry } from "../../src/runtime/tools/mcp-registry.ts";
import type { CompactionConfig } from "../../src/runtime/context/index.ts";
import type {
  LLMProvider,
  LLMCallParams,
  LLMCallResult,
  ResolvedProviderConfig,
} from "@clarvis/capability";
import { MockLLM } from "../helpers/fixtures.ts";
import { ENV_SECTION } from "../env-section.ts";

const COMPACT_ON: CompactionConfig = {
  enabled: true,
  windowTokens: 1000,
  fraction: 0.8,
  targetFraction: 0.8,
  maxResultChars: 1_000_000,
  preserveRecentTokens: 0,
};

const PROVIDER_CONFIG: ResolvedProviderConfig = { kind: "anthropic" };

interface Step {
  text?: string;
  toolCalls?: Array<{ id?: string; name: string; arguments?: unknown }>;
  throw?: Error;
  abort?: boolean;
}

class ScriptedLLM implements LLMProvider {
  readonly calls: LLMCallParams[] = [];
  private cursor = 0;
  constructor(
    private readonly steps: Step[],
    private readonly controller?: AbortController,
  ) {}

  async call(params: LLMCallParams): Promise<LLMCallResult> {
    this.calls.push(params);
    const step = this.steps[this.cursor] ?? this.steps[this.steps.length - 1]!;
    this.cursor += 1;
    if (step.abort) this.controller?.abort();
    if (step.throw) throw step.throw;
    return {
      text: step.text,
      toolCalls: step.toolCalls?.map((tc, i) => ({
        id: tc.id ?? `call_${i}`,
        name: tc.name,
        arguments: tc.arguments ?? {},
      })),
      usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cache_write_tokens: 0 },
    };
  }
}

describe("runSubagent wrapper", () => {
  const common = {
    model: "m",
    provider: "anthropic",
    capabilities: new Set(["tool_calling", "vision"]),
    subagentInstanceId: "w1",
    registry: buildRegistry([], []),
    maxIterations: 5,
  };

  it("seeds from task and reports a completed outcome", async () => {
    const llm = new MockLLM({ script: [{ text: "hello" }] });
    const res = await runSubagent({
      ...common,
      task: "do it",
      llm,
      ledger: createTokenLedger(1_000_000),
      trace: createTrace(),
    });
    expect(res.outcome).toEqual({ status: "completed", text: "hello" });
    expect(res.usage.iterations).toBe(1);
    const seeded = llm.calls[0]!.messages.map((m) => contentToText(m.content)).join("\n");
    expect(seeded).toContain("do it");
  });

  it("uses the task, providerConfig and compaction prompt", async () => {
    const llm = new MockLLM({ script: [{ text: "ok" }] });
    const res = await runSubagent({
      ...common,
      task: "use me",
      providerConfig: PROVIDER_CONFIG,
      compaction: COMPACT_ON,
      compactionPrompt: "summarize",
      llm,
      ledger: createTokenLedger(1_000_000),
      trace: createTrace(),
    });
    expect(res.outcome.status).toBe("completed");
    expect(llm.calls[0]!.providerConfig).toEqual(PROVIDER_CONFIG);
    const sent = llm.calls[0]!.messages.map((m) => contentToText(m.content)).join("\n");
    expect(sent).toContain("use me");
  });

  it("seeds with basePrompt as a system message when no messages are provided", async () => {
    const llm = new MockLLM({ script: [{ text: "ok" }] });
    await runSubagent({
      ...common,
      task: "the task",
      basePrompt: "system rules",
      llm,
      ledger: createTokenLedger(1_000_000),
      trace: createTrace(),
    });
    expect(llm.calls[0]!.messages[0]).toEqual({ role: "system", content: "system rules" });
  });

  it("places the shared prompt between the environment section and the profile prompt", async () => {
    const llm = new MockLLM({ script: [{ text: "ok" }] });
    await runSubagent({
      ...common,
      task: "the task",
      sharedPrompt: "SHARED",
      basePrompt: "system rules",
      workspaceRoot: "/fake/ws",
      llm,
      ledger: createTokenLedger(1_000_000),
      trace: createTrace(),
    });
    expect(llm.calls[0]!.messages[0]).toEqual({
      role: "system",
      content: `${ENV_SECTION("/fake/ws")}\n\nSHARED\n\nsystem rules`,
    });
  });

  it("prepends workspace preamble to basePrompt when workspaceRoot is provided", async () => {
    const llm = new MockLLM({ script: [{ text: "ok" }] });
    await runSubagent({
      ...common,
      task: "the task",
      basePrompt: "system rules",
      workspaceRoot: "/fake/ws",
      llm,
      ledger: createTokenLedger(1_000_000),
      trace: createTrace(),
    });
    expect(llm.calls[0]!.messages[0]).toEqual({
      role: "system",
      content: ENV_SECTION("/fake/ws") + "\n\nsystem rules",
    });
  });

  it("injects workspace preamble as system message when no basePrompt but workspaceRoot is provided", async () => {
    const llm = new MockLLM({ script: [{ text: "ok" }] });
    await runSubagent({
      ...common,
      task: "the task",
      workspaceRoot: "/fake/ws",
      llm,
      ledger: createTokenLedger(1_000_000),
      trace: createTrace(),
    });
    expect(llm.calls[0]!.messages[0]).toEqual({
      role: "system",
      content: ENV_SECTION("/fake/ws"),
    });
    expect(llm.calls[0]!.messages[1]).toEqual({ role: "user", content: "the task" });
  });

  it("maps the sub-agent's own iteration cap to an iteration_limit_reached outcome", async () => {
    const llm = new MockLLM({ script: [{ toolCalls: [{ name: "foo.bar", arguments: {} }] }] });
    const res = await runSubagent({
      ...common,
      maxIterations: 1,
      task: "go",
      llm,
      ledger: createTokenLedger(1_000_000),
      trace: createTrace(),
    });
    expect(res.outcome.status).toBe("iteration_limit_reached");
    if (res.outcome.status === "iteration_limit_reached") expect(res.outcome.iterations).toBe(1);
  });

  it.each([64, 512])(
    "contains three children at their own %i iteration limit while a sibling stays live",
    async (limit) => {
      const ledger = createTokenLedger(1_000_000);
      const parent = new AbortController();
      const arrived = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let siblingFinished = false;
      const sibling = runSubagent({
        ...common,
        subagentInstanceId: "live-sibling",
        task: "Independent remaining work",
        signal: parent.signal,
        ledger,
        trace: createTrace(),
        llm: {
          call: async () => {
            arrived.resolve();
            await release.promise;
            return {
              text: "Sibling completed",
              usage: {
                input_tokens: 10,
                output_tokens: 5,
                cached_tokens: 0,
                cache_write_tokens: 0,
              },
            };
          },
        },
      }).then((result) => {
        siblingFinished = true;
        return result;
      });
      await arrived.promise;
      try {
        const children = await Promise.all(
          Array.from({ length: 3 }, async (_, child) => {
            const llm = new ScriptedLLM(
              Array.from({ length: limit + 1 }, (_, step) => ({
                text: `child ${String(child)} retained step ${String(step + 1)}`,
                toolCalls: [{ name: "inspect_step", arguments: { step } }],
              })),
            );
            const result = await runSubagent({
              ...common,
              subagentInstanceId: `limited-${String(child)}`,
              maxIterations: limit,
              task: "Inspect successive records",
              signal: parent.signal,
              ledger,
              trace: createTrace(),
              llm,
              agentCapabilities: [
                {
                  attach: () => ({
                    tools: [
                      {
                        fullName: "inspect_step",
                        wireName: "inspect_step",
                        mcpName: "",
                        toolName: "inspect_step",
                        inputSchema: { type: "object", properties: { step: { type: "number" } } },
                      },
                    ],
                    handlers: [
                      {
                        matches: (call) => call.name === "inspect_step",
                        handle: async (call) => ({
                          kind: "result",
                          text: JSON.stringify(call.arguments),
                          progress: true,
                        }),
                      },
                    ],
                  }),
                },
              ],
            });
            expect(llm.calls).toHaveLength(limit);
            expect(result.outcome).toMatchObject({
              status: "iteration_limit_reached",
              iterations: limit,
              partialText: `child ${String(child)} retained step ${String(limit)}`,
            });
            return result;
          }),
        );
        expect(children.every((child) => child.usage.iterations === limit)).toBe(true);
        expect(siblingFinished).toBe(false);
        expect(parent.signal.aborted).toBe(false);
      } finally {
        release.resolve();
      }
      expect((await sibling).outcome).toEqual({ status: "completed", text: "Sibling completed" });
      expect(ledger.consumed()).toBe(15 * (3 * limit + 1));
    },
  );

  it("keeps a run-wide token cap as a budget_exhausted outcome", async () => {
    const llm = new MockLLM({
      script: [
        {
          text: "spending",
          toolCalls: [{ name: "foo.bar", arguments: {} }],
          usage: { input_tokens: 400, output_tokens: 200 },
        },
        { text: "more" },
      ],
    });
    const res = await runSubagent({
      ...common,
      maxIterations: 64,
      task: "go",
      llm,
      ledger: createTokenLedger(100),
      trace: createTrace(),
    });
    expect(res.outcome.status).toBe("budget_exhausted");
  });

  it("maps cancellation to a cancelled outcome", async () => {
    const controller = new AbortController();
    const llm = new ScriptedLLM([{ abort: true, throw: new Error("boom") }], controller);
    const res = await runSubagent({
      ...common,
      task: "go",
      llm,
      ledger: createTokenLedger(1_000_000),
      trace: createTrace(),
      signal: controller.signal,
    });
    expect(res.outcome.status).toBe("cancelled");
  });

  it("maps an empty response to an error outcome", async () => {
    const llm = new MockLLM({ script: [{}, {}] });
    const res = await runSubagent({
      ...common,
      task: "go",
      llm,
      ledger: createTokenLedger(1_000_000),
      trace: createTrace(),
    });
    expect(res.outcome).toEqual({
      status: "error",
      code: "empty_response",
      message: "LLM returned neither text nor tool calls in consecutive completions.",
      partialText: "",
    });
  });
});

describe("toSubagentOutcome", () => {
  it("maps completed to the final text (falling back to partial)", () => {
    expect(toSubagentOutcome({ status: "completed", text: "final", partialText: "p" })).toEqual({
      status: "completed",
      text: "final",
    });
    expect(toSubagentOutcome({ status: "completed", partialText: "p" })).toEqual({
      status: "completed",
      text: "p",
    });
  });

  it("maps budget_exhausted and cancelled to a partial outcome", () => {
    expect(toSubagentOutcome({ status: "budget_exhausted", partialText: "x" })).toEqual({
      status: "budget_exhausted",
      partialText: "x",
    });
    expect(toSubagentOutcome({ status: "cancelled", partialText: "y" })).toEqual({
      status: "cancelled",
      partialText: "y",
    });
  });

  it("maps soft_limit_declined to a partial (budget_exhausted) outcome, not a spurious error", () => {
    expect(toSubagentOutcome({ status: "soft_limit_declined", partialText: "z" })).toEqual({
      status: "budget_exhausted",
      partialText: "z",
    });
  });

  it("maps error to the carried code/message, defaulting to empty_response", () => {
    expect(
      toSubagentOutcome({
        status: "error",
        partialText: "Confirmed file inspection; remaining verification unfinished.",
        error: { code: "no_progress", message: "stuck" },
      }),
    ).toEqual({
      status: "error",
      code: "no_progress",
      message: "stuck",
      partialText: "Confirmed file inspection; remaining verification unfinished.",
    });
    expect(toSubagentOutcome({ status: "error", partialText: "" })).toEqual({
      status: "error",
      code: "empty_response",
      message: "Sub-agent terminated with no result.",
      partialText: "",
    });
  });
});
