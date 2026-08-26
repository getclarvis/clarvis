import { describe, it, expect } from "../bun-test.ts";
import { contentToText, loadEnv } from "@clarvis/capability";
import { runOrchestrator, type OrchestratorDeps } from "../../src/runtime/orchestrator.ts";
import { runAgent, type RunAgentInput } from "../../src/runtime/loop/run-agent.ts";
import type { AgentBuildContext } from "../../src/runtime/loop/run-agent.ts";
import type { AgentCapability, AgentLoopContribution, Capability } from "@clarvis/capability";
import {
  prepareSpawn,
  runPreparedSubagent,
  type DelegateTaskContext,
} from "../../src/runtime/subagents/delegate-task.ts";
import type { ResolvedSubagentProfile } from "../../src/runtime/subagents/subagent-profiles.ts";
import { createTrace } from "@clarvis/trace";
import { createTokenLedger, createIterationCounter } from "../../src/runtime/budget/index.ts";
import { buildRegistry } from "../../src/runtime/tools/mcp-registry.ts";
import { DISABLED_COMPACTION } from "../../src/runtime/context/index.ts";
import { ProviderError } from "@clarvis/capability";
import type { RunRequest } from "@clarvis/capability";
import type {
  LifecycleHook,
  RunStartContext,
  RunEndContext,
  SubagentCompleteContext,
  PreCompactContext,
  ModelCallErrorContext,
  BudgetExhaustedContext,
  UserSteerContext,
} from "@clarvis/capability";
import { MockLLM, mockConnections, mockMCPFactory } from "../helpers/fixtures.ts";

const env = loadEnv({
  ANTHROPIC_API_KEY: "k",
  CLARVIS_MCP_CONNECT_TIMEOUT_MS: "2000",
});

const anthropicProviders = [{ name: "anthropic", kind: "anthropic" as const }];

function makeDeps(
  over: Partial<OrchestratorDeps> & { llm: MockLLM; hooks?: LifecycleHook[] },
): OrchestratorDeps {
  const { hooks, ...rest } = over;
  const capability: Capability | undefined =
    hooks === undefined
      ? undefined
      : {
          name: "fake-lifecycle",
          forRun: () => ({
            name: "fake-lifecycle",
            lifecycle: hooks,
            forAgent: () => null,
          }),
        };
  return {
    env,
    connections: mockConnections(mockMCPFactory({}), env),
    workspaceRoot: process.cwd(),
    owner: "test",
    ...(capability !== undefined ? { capabilities: [capability] } : {}),
    ...rest,
  };
}

function soloRequest(): RunRequest {
  return {
    messages: [{ role: "user", content: "go" }],
    servers: [],
    profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 3 }],
    entry: "solo",
    budget: { on_exceed: "stop", total_token_limit: 1_000_000 },
    providers: anthropicProviders,
  };
}

function makeAgentInput(
  llm: MockLLM,
  opts: {
    hooks?: LifecycleHook[];
    buildContribution?: (bc: AgentBuildContext) => AgentLoopContribution;
    maxTokens?: number;
    steer?: RunAgentInput["steer"];
    compaction?: RunAgentInput["compaction"];
    compactionSource?: RunAgentInput["compactionSource"];
    compactionPrompt?: string;
    trace?: ReturnType<typeof createTrace>;
  } = {},
): RunAgentInput {
  const capability: AgentCapability | undefined =
    opts.buildContribution === undefined
      ? undefined
      : {
          attach: (bc: AgentBuildContext): AgentLoopContribution => ({
            ...opts.buildContribution!(bc),
            advertised: false,
          }),
        };
  return {
    agent: "subagent",
    subagentInstanceId: "w1",
    messages: [{ role: "user", content: "go" }],
    ...(opts.hooks ? { hooks: opts.hooks } : {}),
    ...(opts.steer ? { steer: opts.steer } : {}),
    ...(opts.compactionSource ? { compactionSource: opts.compactionSource } : {}),
    ...(opts.compactionPrompt !== undefined ? { compactionPrompt: opts.compactionPrompt } : {}),
    target: {
      llm,
      model: "m",
      provider: "anthropic",
      capabilities: new Set(["tool_calling", "vision"]),
    },
    budget: {
      ledger: createTokenLedger(opts.maxTokens ?? 1_000_000),
      counter: createIterationCounter(50),
      usage: { input: 0, output: 0, cached: 0, cache_write: 0 },
    },
    runtime: { trace: opts.trace ?? createTrace() },
    compaction: opts.compaction ?? DISABLED_COMPACTION,
    registry: buildRegistry([], []),
    mcpProgress: (r) => r.errText === null,
    allToolsUnavailable: () => false,
    noProgressLimit: 6,
    noProgressMessage: (streak) => `no progress for ${streak}.`,
    emptyResponseAgent: "LLM",
    ...(capability !== undefined ? { agentCapabilities: [capability] } : {}),
  };
}

function noopContribution(resultText = "ok"): AgentLoopContribution {
  return {
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
        handle: async () => ({ kind: "result", text: resultText, progress: true }),
      },
    ],
    gates: [],
    hooks: {},
  };
}

describe("run_start / run_end observers", () => {
  it("fire once per run, in order, with the expected contexts", async () => {
    const order: string[] = [];
    const starts: RunStartContext[] = [];
    const ends: RunEndContext[] = [];
    class OrderedLLM extends MockLLM {
      override async call(p: Parameters<MockLLM["call"]>[0]): ReturnType<MockLLM["call"]> {
        order.push("llm_call");
        return super.call(p);
      }
    }
    const llm = new OrderedLLM({ script: [{ text: "done" }] });
    const hooks: LifecycleHook[] = [
      {
        onRunStart: async (c) => {
          order.push("run_start");
          starts.push(c);
        },
        onRunEnd: async (c) => {
          order.push("run_end");
          ends.push(c);
        },
      },
    ];
    const result = await runOrchestrator(soloRequest(), makeDeps({ llm, hooks }));
    expect(result.response.status).toBe("completed");
    expect(order).toEqual(["run_start", "llm_call", "run_end"]);
    expect(starts).toEqual([
      { mode: "subagent-only", entry: "solo", subagentModel: "anthropic/x" },
    ]);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ status: "completed", iterationsUsed: 1 });
    expect(typeof ends[0]!.elapsedMs).toBe("number");
  });

  it("run_end fires on an error outcome and carries the error code", async () => {
    const ends: RunEndContext[] = [];
    const llm = new MockLLM({
      script: [{ throw: new ProviderError("provider down", { kind: "client", status: 400 }) }],
    });
    const hooks: LifecycleHook[] = [{ onRunEnd: async (c) => void ends.push(c) }];
    const result = await runOrchestrator(soloRequest(), makeDeps({ llm, hooks }));
    expect(result.response.status).toBe("error");
    expect(ends).toHaveLength(1);
    expect(ends[0]!.status).toBe("error");
    expect(typeof ends[0]!.errorCode).toBe("string");
  });
});

describe("subagent_complete observer", () => {
  function makeProfile(): ResolvedSubagentProfile {
    return {
      name: "coder",
      model: "m",
      modelRef: "anthropic:m",
      provider: "anthropic",
      tools: [],
      contextWindowTokens: 200_000,
      stagnationThreshold: 3,
      callTimeoutMs: 60_000,
      reasoningSummary: "off",
      maxRetries: 0,
      maxRetryAfterMs: 0,
      compaction: DISABLED_COMPACTION,
      stream: true,
    };
  }

  function makeCtx(llm: MockLLM, hooks: LifecycleHook[]): DelegateTaskContext {
    return {
      env,
      opened: [],
      profiles: new Map([["coder", makeProfile()]]),
      iterationLimitDefault: 5,
      llm,
      ledger: createTokenLedger(1_000_000),
      trace: createTrace(),
      subagentAggByModel: new Map(),
      hooks,
    };
  }

  it("fires with the instance id, status, and result text", async () => {
    const seen: SubagentCompleteContext[] = [];
    const llm = new MockLLM({ script: [{ text: "done" }] });
    const ctx = makeCtx(llm, [{ onSubagentComplete: async (c) => void seen.push(c) }]);
    const prep = await prepareSpawn({ title: "w", task: "t", profile: "coder" }, ctx);
    expect(prep.ok).toBe(true);
    if (prep.ok) {
      const r = await runPreparedSubagent(prep.prepared, ctx);
      expect(r.text).toBe("done");
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ status: "completed", result: "done" });
      expect(seen[0]!.subagentInstanceId.length).toBeGreaterThan(0);
    }
  });

  it("fires with status error when the subagent run throws", async () => {
    const seen: SubagentCompleteContext[] = [];
    const llm = new MockLLM({ script: [{ throw: new Error("llm exploded") }] });
    const ctx = makeCtx(llm, [{ onSubagentComplete: async (c) => void seen.push(c) }]);
    const prep = await prepareSpawn({ title: "w", task: "t", profile: "coder" }, ctx);
    expect(prep.ok).toBe(true);
    if (prep.ok) {
      const r = await runPreparedSubagent(prep.prepared, ctx);
      expect(r.failed).toBe(true);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ status: "error" });
      expect(seen[0]!.result).toContain("llm exploded");
    }
  });
});

describe("pre_compact hook", () => {
  it("fires before a scheduled compaction pass with the estimated token count", async () => {
    const seen: PreCompactContext[] = [];
    const big = "x".repeat(4_000);
    const contribution: AgentLoopContribution = noopContribution(big);
    const llm = new MockLLM({
      script: [{ toolCalls: [{ name: "noop", arguments: {} }] }, { text: "done" }],
    });
    const hooks: LifecycleHook[] = [{ onPreCompact: async (c) => void seen.push(c) }];
    const res = await runAgent(
      makeAgentInput(llm, {
        hooks,
        buildContribution: () => contribution,
        compaction: {
          enabled: true,
          windowTokens: 300,
          fraction: 0.5,
          targetFraction: 0.25,
          maxResultChars: Number.MAX_SAFE_INTEGER,
          preserveRecentTokens: 0,
        },
      }),
    );
    expect(res.status).toBe("completed");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ agent: "subagent", subagentInstanceId: "w1" });
    expect(seen[0]!.estimatedTokens).toBeGreaterThan(300);
  });

  it("does not fire when compaction is disabled or unnecessary", async () => {
    const seen: PreCompactContext[] = [];
    const llm = new MockLLM({ script: [{ text: "done" }] });
    const hooks: LifecycleHook[] = [{ onPreCompact: async (c) => void seen.push(c) }];
    const res = await runAgent(makeAgentInput(llm, { hooks }));
    expect(res.status).toBe("completed");
    expect(seen).toHaveLength(0);
  });

  it("forces a queued compaction below the automatic threshold and appends user text after hooks", async () => {
    const observed: Array<{ kind: string; durable: boolean }> = [];
    const trace = createTrace(undefined, (entry, durable) =>
      observed.push({ kind: entry.kind, durable }),
    );
    let drains = 0;
    let closed = false;
    const llm = new MockLLM({
      script: [
        { toolCalls: [{ name: "noop", arguments: {} }] },
        { text: "compact summary" },
        { text: "done" },
      ],
    });
    const res = await runAgent(
      makeAgentInput(llm, {
        trace,
        hooks: [
          {
            onPreCompact: async () => [{ source: "hook", text: "keep the mapping" }],
          },
        ],
        buildContribution: () => noopContribution("x".repeat(4_000)),
        compactionPrompt: "BASE COMPACTION PROMPT.",
        compactionSource: {
          drain: () =>
            ++drains === 2
              ? [{ request: "keep the failing assertion" }, { request: "preserve auth context" }]
              : [],
          close: () => void (closed = true),
        },
        compaction: {
          enabled: true,
          windowTokens: 100_000,
          fraction: 0.9,
          targetFraction: 0.8,
          maxResultChars: Number.MAX_SAFE_INTEGER,
          preserveRecentTokens: 0,
        },
      }),
    );

    expect(res.status).toBe("completed");
    expect(closed).toBe(true);
    expect(llm.calls).toHaveLength(3);
    const instructions = contentToText(llm.calls[1]!.messages[0]!.content);
    expect(instructions.startsWith("BASE COMPACTION PROMPT.")).toBe(true);
    expect(instructions.indexOf("keep the mapping")).toBeLessThan(
      instructions.indexOf("keep the failing assertion"),
    );
    expect(instructions.indexOf("keep the failing assertion")).toBeLessThan(
      instructions.indexOf("preserve auth context"),
    );
    const compacted = trace.entries().find((entry) => entry.kind === "compaction");
    expect(compacted?.detail).toMatchObject({
      requested: true,
      contribution_count: 3,
      user_contribution_count: 2,
    });
    expect(trace.entries().some((entry) => entry.kind === "user_steering")).toBe(false);
    expect(observed.find((entry) => entry.kind === "compaction_started")).toEqual({
      kind: "compaction_started",
      durable: false,
    });
    expect(observed.findIndex((entry) => entry.kind === "compaction_started")).toBeLessThan(
      observed.findIndex((entry) => entry.kind === "compaction"),
    );
    expect(trace.entries().some((entry) => entry.kind === "compaction_started")).toBe(false);
  });

  it("does not blindly evict when user text cannot be summarized", async () => {
    const trace = createTrace();
    let drains = 0;
    const resultText = "important-result-" + "x".repeat(2_000);
    const llm = new MockLLM({
      script: [{ toolCalls: [{ name: "noop", arguments: {} }] }, { text: "done" }],
    });
    const res = await runAgent(
      makeAgentInput(llm, {
        trace,
        buildContribution: () => noopContribution(resultText),
        compactionSource: {
          drain: () => (++drains === 2 ? [{ request: "keep this result" }] : []),
        },
        compaction: {
          enabled: true,
          windowTokens: 100_000,
          fraction: 0.9,
          targetFraction: 0.8,
          maxResultChars: Number.MAX_SAFE_INTEGER,
          preserveRecentTokens: 0,
        },
      }),
    );

    expect(res.status).toBe("completed");
    expect(llm.calls).toHaveLength(2);
    expect(JSON.stringify(llm.calls[1]!.messages)).toContain("important-result-");
    expect(
      trace.entries().find((entry) => entry.kind === "compaction_skipped")?.detail,
    ).toMatchObject({ reason: "summarization_disabled" });
    expect(trace.entries().some((entry) => entry.kind === "compaction")).toBe(false);
  });

  it("lets a bare request use forced mechanical eviction below the automatic threshold", async () => {
    const trace = createTrace();
    let drains = 0;
    const llm = new MockLLM({
      script: [{ toolCalls: [{ name: "noop", arguments: {} }] }, { text: "done" }],
    });
    const res = await runAgent(
      makeAgentInput(llm, {
        trace,
        buildContribution: () => noopContribution("evict-me-" + "x".repeat(2_000)),
        compactionSource: {
          drain: () => (++drains === 2 ? [{}] : []),
        },
        compaction: {
          enabled: true,
          windowTokens: 100_000,
          fraction: 0.9,
          targetFraction: 0.8,
          maxResultChars: Number.MAX_SAFE_INTEGER,
          preserveRecentTokens: 0,
        },
      }),
    );

    expect(res.status).toBe("completed");
    expect(JSON.stringify(llm.calls[1]!.messages)).not.toContain("evict-me-");
    expect(trace.entries().find((entry) => entry.kind === "compaction")?.detail).toMatchObject({
      requested: true,
      operation: "eviction",
    });
  });

  it("reports a queued request as disabled without calling the summarizer", async () => {
    const trace = createTrace();
    let drained = false;
    const llm = new MockLLM({ script: [{ text: "done" }] });
    const res = await runAgent(
      makeAgentInput(llm, {
        trace,
        compactionPrompt: "Summarize.",
        compactionSource: {
          drain: () => {
            if (drained) return [];
            drained = true;
            return [{ request: "keep auth context" }];
          },
        },
      }),
    );

    expect(res.status).toBe("completed");
    expect(llm.calls).toHaveLength(1);
    expect(
      trace.entries().find((entry) => entry.kind === "compaction_skipped")?.detail,
    ).toMatchObject({ reason: "disabled" });
  });
});

describe("model_call_error observer", () => {
  it("fires when the provider call fails terminally", async () => {
    const seen: ModelCallErrorContext[] = [];
    const llm = new MockLLM({
      script: [{ throw: new ProviderError("rate limited", { kind: "client", status: 429 }) }],
    });
    const hooks: LifecycleHook[] = [{ onModelCallError: async (c) => void seen.push(c) }];
    await expect(runAgent(makeAgentInput(llm, { hooks }))).rejects.toThrow("rate limited");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      agent: "subagent",
      subagentInstanceId: "w1",
      iteration: 1,
      model: "m",
      message: "rate limited",
    });
  });
});

describe("budget_exhausted observer", () => {
  it("fires with reason exhausted when the hard token budget is consumed", async () => {
    const seen: BudgetExhaustedContext[] = [];
    const llm = new MockLLM({
      script: [{ toolCalls: [{ name: "noop", arguments: {} }] }, { text: "done" }],
    });
    const hooks: LifecycleHook[] = [{ onBudgetExhausted: async (c) => void seen.push(c) }];
    const res = await runAgent(
      makeAgentInput(llm, {
        hooks,
        buildContribution: () => noopContribution(),
        maxTokens: 12,
      }),
    );
    expect(res.status).toBe("budget_exhausted");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ agent: "subagent", reason: "exhausted" });
    expect(seen[0]!.tokensUsed).toBeGreaterThanOrEqual(12);
    expect(seen[0]!.iterationsUsed).toBeGreaterThanOrEqual(1);
  });
});

describe("user_steer observer", () => {
  it("fires once per drained steer message", async () => {
    const seen: UserSteerContext[] = [];
    let drained = false;
    const llm = new MockLLM({ script: [{ text: "done" }] });
    const hooks: LifecycleHook[] = [{ onUserSteer: async (c) => void seen.push(c) }];
    const res = await runAgent(
      makeAgentInput(llm, {
        hooks,
        steer: {
          drain: () => {
            if (drained) return [];
            drained = true;
            return [{ content: "focus on the tests", id: "s1" }, { content: "and keep it short" }];
          },
        },
      }),
    );
    expect(res.status).toBe("completed");
    expect(seen).toEqual([
      {
        agent: "subagent",
        subagentInstanceId: "w1",
        iteration: 1,
        message: "focus on the tests",
        id: "s1",
      },
      {
        agent: "subagent",
        subagentInstanceId: "w1",
        iteration: 1,
        message: "and keep it short",
      },
    ]);
  });
});
