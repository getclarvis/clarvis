import { describe, it, expect, vi } from "../bun-test.ts";
import { callModelWithRecovery } from "../../src/runtime/loop/model-call.ts";
import {
  ProviderError,
  type LLMCallParams,
  type LLMCallResult,
  type LLMProvider,
} from "@clarvis/capability";
import { createTrace } from "@clarvis/trace";
import { contentToText } from "@clarvis/capability";
import { runAgent, type RunAgentInput } from "../../src/runtime/loop/run-agent.ts";
import { createTokenLedger, createIterationCounter } from "../../src/runtime/budget/index.ts";
import { buildRegistry } from "../../src/runtime/tools/mcp-registry.ts";
import { compileResultContract } from "../../src/runtime/tools/index.ts";
import { DISABLED_COMPACTION, type CompactionConfig } from "../../src/runtime/context/index.ts";
import { MockLLM } from "../helpers/fixtures.ts";

type CallBehavior = { throw: ProviderError } | { return: LLMCallResult };

class FakeLLM implements LLMProvider {
  readonly calls: LLMCallParams[] = [];
  constructor(private readonly behaviors: CallBehavior[]) {}
  async call(params: LLMCallParams): Promise<LLMCallResult> {
    this.calls.push(params);
    const behavior = this.behaviors[this.calls.length - 1];
    if (behavior && "throw" in behavior) throw behavior.throw;
    if (behavior && "return" in behavior) return behavior.return;
    throw new Error("FakeLLM received an unexpected call");
  }
}

const baseCall: LLMCallParams = {
  model: "m",
  messages: [],
  tools: [],
  provider: "anthropic",
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { name: { type: "string" } },
  required: ["name"],
};

const COMPACT_ON: CompactionConfig = {
  enabled: true,
  windowTokens: 1000,
  fraction: 0.8,
  targetFraction: 0.8,
  maxResultChars: 1_000_000,
  preserveRecentTokens: 0,
};

function makeInput(
  llm: MockLLM,
  opts: { compaction?: CompactionConfig; maxIterations?: number } = {},
): RunAgentInput {
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
      ledger: createTokenLedger(1_000_000),
      counter: createIterationCounter(opts.maxIterations ?? 50),
      usage: { input: 0, output: 0, cached: 0, cache_write: 0 },
    },
    runtime: { trace: createTrace() },
    compaction: opts.compaction ?? DISABLED_COMPACTION,
    registry: buildRegistry([], []),
    contract: compileResultContract(SCHEMA),
    mcpProgress: (r) => r.errText === null,
    allToolsUnavailable: () => false,
    noProgressLimit: 6,
    noProgressMessage: (streak) => `Subagent made no progress for ${streak} iterations.`,
    emptyResponseAgent: "LLM",
  };
}

const overflow = (): ProviderError =>
  new ProviderError("context length exceeded", { kind: "context_overflow", status: 400 });

const invalidSubmit = (age: number) => ({
  toolCalls: [{ name: "submit_result", arguments: { age } }],
});

describe("context_overflow recovery", () => {
  it("force-evicts an older tool result and retries the same iteration to completion", async () => {
    const llm = new MockLLM({
      script: [
        invalidSubmit(1),
        invalidSubmit(2),
        { throw: overflow() },
        { toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] },
      ],
    });
    const res = await runAgent(makeInput(llm, { compaction: COMPACT_ON }));
    expect(res.status).toBe("completed");
    expect(res.structuredResult).toEqual({ value: { name: "Ada" } });
    expect(llm.calls).toHaveLength(4);
    const retryMsgs = llm.calls[3]!.messages.map((m) => contentToText(m.content)).join("\n");
    expect(retryMsgs).toContain("earlier tool result evicted to fit context");
  });

  it("rethrows the context_overflow ProviderError when nothing is evictable", async () => {
    const llm = new MockLLM({ script: [{ throw: overflow() }] });
    await expect(runAgent(makeInput(llm))).rejects.toMatchObject({
      name: "ProviderError",
      kind: "context_overflow",
    });
    expect(llm.calls).toHaveLength(1);
  });

  it("throws a legible context_overflow diagnostic when nothing is evictable", async () => {
    const llm = new FakeLLM([{ throw: overflow() }]);
    const recordError = vi.fn();
    let thrown: unknown;
    try {
      await callModelWithRecovery({
        llm,
        baseCall,
        evict: () => undefined,
        overflowDiagnostic: () =>
          "context does not fit: subagent's non-evictable context (~5000 tokens) exceeds the " +
          "model context window (1000 tokens); eviction cannot recover.",
        trace: createTrace(),
        maybeCancelled: () => null,
        recordError,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      name: "ProviderError",
      kind: "context_overflow",
      status: 400,
    });
    expect(String((thrown as ProviderError).message)).toContain("exceeds the model context window");
    expect(recordError).toHaveBeenCalledTimes(1);
    expect(String((recordError.mock.calls[0]![0] as ProviderError).message)).toContain(
      "eviction cannot recover",
    );
  });

  it("hands the original provider error to the diagnostic so its text survives", async () => {
    const llm = new FakeLLM([{ throw: overflow() }]);
    await expect(
      callModelWithRecovery({
        llm,
        baseCall,
        evict: () => undefined,
        overflowDiagnostic: (original) => `cannot recover. Provider error: ${original.message}`,
        trace: createTrace(),
        maybeCancelled: () => null,
        recordError: vi.fn(),
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("Provider error: context length exceeded"),
    });
  });

  it("without a diagnostic, rethrows the raw provider error unchanged", async () => {
    const raw = overflow();
    const llm = new FakeLLM([{ throw: raw }]);
    const recordError = vi.fn();
    await expect(
      callModelWithRecovery({
        llm,
        baseCall,
        evict: () => undefined,
        trace: createTrace(),
        maybeCancelled: () => null,
        recordError,
      }),
    ).rejects.toBe(raw);
    expect(recordError).toHaveBeenCalledWith(raw);
  });

  it("stops after MAX_OVERFLOW_RECOVERIES retries even with evictable results remaining", async () => {
    const llm = new MockLLM({
      script: [
        invalidSubmit(1),
        invalidSubmit(2),
        invalidSubmit(3),
        invalidSubmit(4),
        { throw: overflow() },
        { throw: overflow() },
        { throw: overflow() },
        { throw: overflow() },
      ],
    });
    await expect(runAgent(makeInput(llm, { compaction: COMPACT_ON }))).rejects.toMatchObject({
      kind: "context_overflow",
    });
    expect(llm.calls).toHaveLength(8);
  });
});
