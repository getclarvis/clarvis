import { describe, it, expect } from "../bun-test.ts";
import { loadEnv } from "@clarvis/capability";
import { runOrchestrator, type OrchestratorDeps } from "../../src/runtime/orchestrator.ts";
import { compileResultContract } from "../../src/runtime/tools/result-contract.ts";
import { ProviderError } from "@clarvis/capability";
import { MockLLM, mockConnections, mockMCPFactory } from "./_fixtures.ts";
import { createAgentToolsCapability } from "../../src/runtime/capabilities/tools.ts";
import { createAskUserCapability } from "../../src/runtime/capabilities/ask-user.ts";
import { createSkillsCapability } from "@clarvis/skills/capability";
import type { RunRequest } from "@clarvis/capability";
import type { Elicit, ElicitRawResult } from "../../src/runtime/tools/ask-user-tool.ts";
import type { ElicitationRelay, MCPClientFactory, MCPClientHandle } from "@clarvis/mcp-client";
import type { McpServerConfig } from "@clarvis/capability";

const env = loadEnv({
  ANTHROPIC_API_KEY: "k",
  OPENAI_API_KEY: "k",
  GOOGLE_API_KEY: "k",
  CLARVIS_MCP_CONNECT_TIMEOUT_MS: "2000",
});

const anthropicProviders = [{ name: "anthropic", kind: "anthropic" as const }];

function makeDeps(
  over: Partial<OrchestratorDeps> & { llm: MockLLM; mcpFactory?: MCPClientFactory },
): OrchestratorDeps {
  const { mcpFactory, env: overEnv, ...rest } = over;
  const resolvedEnv = overEnv ?? env;
  return {
    env: resolvedEnv,
    connections: mockConnections(mcpFactory ?? mockMCPFactory({}), resolvedEnv),
    workspaceRoot: process.cwd(),
    owner: "test",
    capabilities: [
      createAgentToolsCapability(),
      createAskUserCapability(),
      createSkillsCapability(),
    ],
    ...rest,
  };
}

function kinds(result: { trace: { entries: { kind: string }[] } }): string[] {
  return result.trace.entries.map((e) => e.kind);
}

const customProviders = [
  {
    name: "acme",
    kind: "openai-compatible" as const,
    base_url: "http://localhost:9/v1",
    api_key_env: "OPENAI_API_KEY",
  },
];

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { name: { type: "string" } },
  required: ["name"],
};

describe("subagent-only completions", () => {
  it("completes with text and defaults the budget when timeout/tokens are omitted", async () => {
    const llm = new MockLLM({ script: [{ text: "done" }] });
    const request: RunRequest = {
      messages: [{ role: "user", content: "go" }],
      servers: [],
      profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 3 }],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 1000000 },
      providers: anthropicProviders,
    };
    const result = await runOrchestrator(request, makeDeps({ llm }));
    expect(result.response).toMatchObject({ status: "completed", result: "done" });
    expect(kinds(result)[0]).toBe("init");
  });

  it("threads a custom (openai-compatible) providerConfig through to the model call", async () => {
    const llm = new MockLLM({ script: [{ text: "done" }] });
    const request: RunRequest = {
      messages: [{ role: "user", content: "go" }],
      servers: [],
      profiles: [
        {
          name: "solo",
          model: "acme/m",
          tools: [],
          iteration_limit: 3,
          compaction: { prompt: "tight" },
        },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
      providers: customProviders,
    };
    const result = await runOrchestrator(request, makeDeps({ llm }));
    expect(result.response.status).toBe("completed");
    expect(llm.calls[0]!.providerConfig).toMatchObject({
      kind: "openai-compatible",
      baseUrl: "http://localhost:9/v1",
    });
  });

  it("returns a structured object result when submit_result validates", async () => {
    const llm = new MockLLM({
      script: [{ toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] }],
    });
    const request: RunRequest = {
      messages: [{ role: "user", content: "go" }],
      servers: [],
      profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 5 }],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
      providers: anthropicProviders,
    };
    const result = await runOrchestrator(
      request,
      makeDeps({ llm, resultContract: compileResultContract(SCHEMA) }),
    );
    expect(result.response).toMatchObject({ status: "completed", result: { name: "Ada" } });
  });
});

describe("subagent-only terminal states", () => {
  it("budget_exhausted carries the last invalid submit as a partial structured result", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [{ name: "submit_result", arguments: { wrong: 1 } }],
          usage: { input_tokens: 70, output_tokens: 40 },
        },
        {
          toolCalls: [{ name: "submit_result", arguments: { wrong: 2 } }],
          usage: { input_tokens: 70, output_tokens: 40 },
        },
      ],
    });
    const request: RunRequest = {
      messages: [{ role: "user", content: "go" }],
      servers: [],
      profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 50 }],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100, timeout_ms: 30000 },
      providers: anthropicProviders,
    };
    const result = await runOrchestrator(
      request,
      makeDeps({ llm, resultContract: compileResultContract(SCHEMA) }),
    );
    expect(result.response.status).toBe("budget_exhausted");
    if (result.response.status === "budget_exhausted") {
      expect(result.response.result).toEqual({ wrong: 1 });
    }
  });

  it("budget_exhausted falls back to partial text without a contract", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [{ name: "noop.run", arguments: {} }],
          usage: { input_tokens: 70, output_tokens: 40 },
        },
        {
          toolCalls: [{ name: "noop.run", arguments: {} }],
          usage: { input_tokens: 70, output_tokens: 40 },
        },
      ],
    });
    const mcp = mockMCPFactory({
      noop: { tools: [{ name: "run", inputSchema: {}, call: () => "x" }] },
    });
    const servers: McpServerConfig[] = [
      { name: "noop", transport: "stdio", command: "node", args: ["-e", ""] },
    ];
    const request: RunRequest = {
      messages: [{ role: "user", content: "go" }],
      servers,
      profiles: [{ name: "solo", model: "anthropic/x", tools: ["noop.run"], iteration_limit: 50 }],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100, timeout_ms: 30000 },
      providers: anthropicProviders,
    };
    const result = await runOrchestrator(request, makeDeps({ llm, mcpFactory: mcp }));
    expect(result.response.status).toBe("budget_exhausted");
  });

  it("returns cancelled when the run signal is already aborted (no tools)", async () => {
    const llm = new MockLLM({ script: [{ text: "unused" }] });
    const request: RunRequest = {
      messages: [{ role: "user", content: "go" }],
      servers: [],
      profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 3 }],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
      providers: anthropicProviders,
    };
    const result = await runOrchestrator(request, makeDeps({ llm, signal: AbortSignal.abort() }));
    expect(result.response.status).toBe("cancelled");
    expect(llm.calls).toHaveLength(0);
  });

  it("returns soft_limit_declined when the user stops at a soft limit", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [{ name: "noop.run", arguments: {} }],
          usage: { input_tokens: 30, output_tokens: 20 },
        },
        {
          toolCalls: [{ name: "noop.run", arguments: {} }],
          usage: { input_tokens: 30, output_tokens: 20 },
        },
        {
          toolCalls: [{ name: "noop.run", arguments: {} }],
          usage: { input_tokens: 30, output_tokens: 20 },
        },
      ],
    });
    const mcp = mockMCPFactory({
      noop: { tools: [{ name: "run", inputSchema: {}, call: () => "x" }] },
    });
    const servers: McpServerConfig[] = [
      { name: "noop", transport: "stdio", command: "node", args: ["-e", ""] },
    ];
    const elicit: Elicit = async () => ({ action: "accept", content: { continue: "stop" } });
    const request: RunRequest = {
      messages: [{ role: "user", content: "go" }],
      servers,
      profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 1 }],
      entry: "solo",
      budget: {
        on_exceed: "escalate",
        total_token_limit: 5,
        max_escalations: 2,
        timeout_ms: 30000,
      },
      providers: anthropicProviders,
    };
    const result = await runOrchestrator(request, makeDeps({ llm, mcpFactory: mcp, elicit }));
    expect(result.response.status).toBe("soft_limit_declined");
  });

  it("reports empty_response as a guard_trip when the model returns nothing", async () => {
    const llm = new MockLLM({ script: [{}, {}] });
    const request: RunRequest = {
      messages: [{ role: "user", content: "go" }],
      servers: [],
      profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 3 }],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
      providers: anthropicProviders,
    };
    const result = await runOrchestrator(request, makeDeps({ llm }));
    expect(result.response.status).toBe("error");
    if (result.response.status === "error") {
      expect(result.response.error.code).toBe("empty_response");
    }
    const ended = result.trace.entries.find((e) => e.kind === "run_ended");
    expect((ended!.detail as { reason: string }).reason).toBe("guard_trip");
  });

  it("stalls out when a model call hangs past the deadline (no activity)", async () => {
    const llm = new MockLLM({ script: [{ text: "…hung…", delayMs: 5000 }] });
    const request: RunRequest = {
      messages: [{ role: "user", content: "go" }],
      servers: [],
      profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 5 }],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 400000, timeout_ms: 120 },
      providers: anthropicProviders,
    };
    const result = await runOrchestrator(
      request,
      makeDeps({ llm, mcpFactory: mockMCPFactory({}), env: env }),
    );
    expect(result.response.status).toBe("error");
    if (result.response.status === "error") {
      expect(result.response.error.code).toBe("timeout");
    }
    const ended = result.trace.entries.find((e) => e.kind === "run_ended");
    expect((ended!.detail as { reason: string }).reason).toBe("timeout");
  });
});

describe("error mapping", () => {
  it("maps a ProviderError with status + retry_after to provider_error", async () => {
    const llm = new MockLLM({
      script: [
        {
          throw: new ProviderError("rate limited", {
            kind: "transient",
            status: 429,
            retryAfterMs: 1000,
          }),
        },
      ],
    });
    const request: RunRequest = {
      messages: [{ role: "user", content: "go" }],
      servers: [],
      profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 3 }],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
      providers: anthropicProviders,
    };
    const result = await runOrchestrator(request, makeDeps({ llm }));
    expect(result.response.status).toBe("error");
    if (result.response.status === "error") {
      expect(result.response.error.code).toBe("provider_error");
      expect(result.response.error.details).toMatchObject({ status: 429, retry_after_ms: 1000 });
    }
    const ended = result.trace.entries.find((e) => e.kind === "run_ended");
    expect((ended!.detail as { reason: string }).reason).toBe("error");
  });

  it("maps a context_overflow ProviderError to context_overflow", async () => {
    const overflow = (): ProviderError =>
      new ProviderError("too big", { kind: "context_overflow" });
    const llm = new MockLLM({
      script: [
        { throw: overflow() },
        { throw: overflow() },
        { throw: overflow() },
        { throw: overflow() },
        { throw: overflow() },
        { throw: overflow() },
      ],
    });
    const request: RunRequest = {
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ],
      servers: [],
      profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 10 }],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
      providers: anthropicProviders,
    };
    const result = await runOrchestrator(request, makeDeps({ llm }));
    expect(result.response.status).toBe("error");
    if (result.response.status === "error") {
      expect(result.response.error.code).toBe("context_overflow");
    }
  });

  it("maps a thrown Error to internal_error", async () => {
    const llm = new MockLLM({ script: [{ throw: new Error("kaboom") }] });
    const request: RunRequest = {
      messages: [{ role: "user", content: "go" }],
      servers: [],
      profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 3 }],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
      providers: anthropicProviders,
    };
    const result = await runOrchestrator(request, makeDeps({ llm }));
    expect(result.response.status).toBe("error");
    if (result.response.status === "error") {
      expect(result.response.error.code).toBe("internal_error");
      expect(result.response.error.message).toBe("kaboom");
    }
  });

  it("maps an external cancellation during a compaction summary to cancelled, not provider_error", async () => {
    const ext = new AbortController();
    let calls = 0;
    const llm = {
      calls: [] as unknown[],
      async call(params: { tools: unknown[] }) {
        const i = calls++;
        if (params.tools.length === 0) {
          ext.abort({ source: "mcp" });
          throw new ProviderError("aborted upstream", { kind: "transient" });
        }
        return {
          toolCalls: [{ id: `c${i}`, name: "docs.fetch", arguments: {} }],
          usage: { input_tokens: 5, output_tokens: 5, cached_tokens: 0 },
        };
      },
    };
    const mcp = mockMCPFactory({
      docs: { tools: [{ name: "fetch", inputSchema: {}, call: () => "Z".repeat(2000) }] },
    });
    const servers: McpServerConfig[] = [
      { name: "docs", transport: "stdio", command: "node", args: ["-e", ""] },
    ];
    const lowWindowEnv = loadEnv({
      ANTHROPIC_API_KEY: "k",
      CLARVIS_DEFAULT_CONTEXT_WINDOW_TOKENS: "1",
    });
    const request: RunRequest = {
      messages: [{ role: "user", content: "go" }],
      servers,
      profiles: [
        {
          name: "solo",
          model: "anthropic/x",
          tools: ["docs.fetch"],
          iteration_limit: 5,
          compaction: { prompt: "t" },
        },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
      providers: anthropicProviders,
    };
    const result = await runOrchestrator(
      request,
      makeDeps({
        llm: llm as unknown as MockLLM,
        mcpFactory: mcp,
        env: lowWindowEnv,
        signal: ext.signal,
      }),
    );
    expect(result.response.status).toBe("cancelled");
  });

  it("maps a thrown non-Error value to internal_error with a generic message", async () => {
    const llm = new MockLLM({ script: [{ throw: "boom-string" as unknown as Error }] });
    const request: RunRequest = {
      messages: [{ role: "user", content: "go" }],
      servers: [],
      profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 3 }],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
      providers: anthropicProviders,
    };
    const result = await runOrchestrator(request, makeDeps({ llm }));
    expect(result.response.status).toBe("error");
    if (result.response.status === "error") {
      expect(result.response.error.code).toBe("internal_error");
      expect(result.response.error.message).toBe("Run terminated unexpectedly.");
    }
  });
});

describe("lead-subagent", () => {
  it("threads the entry lead's custom (openai-compatible) providerConfig through to its model call", async () => {
    const llm = new MockLLM({ script: [{ text: "final" }] });
    const request: RunRequest = {
      messages: [{ role: "user", content: "go" }],
      servers: [],
      profiles: [
        {
          name: "lead",
          model: "acme/lead",
          iteration_limit: 3,
          tools: [],
          compaction: { prompt: "lead" },
          can_spawn: ["subagent"],
        },
        {
          name: "subagent",
          model: "acme/wrk",
          tools: [],
          iteration_limit: 3,
          compaction: { prompt: "subagent" },
          base_prompt: "bp",
        },
      ],
      entry: "lead",
      budget: { on_exceed: "stop", total_token_limit: 200000, timeout_ms: 30000 },
      providers: customProviders,
    };
    const result = await runOrchestrator(request, makeDeps({ llm }));
    expect(result.response.status).toBe("completed");
    expect(llm.calls[0]!.providerConfig).toMatchObject({
      kind: "openai-compatible",
      baseUrl: "http://localhost:9/v1",
    });
  });

  it("completes with a lead structured result", async () => {
    const llm = new MockLLM({
      script: [{ toolCalls: [{ name: "submit_result", arguments: { name: "Lead" } }] }],
    });
    const request: RunRequest = {
      messages: [{ role: "user", content: "go" }],
      servers: [],
      profiles: [
        {
          name: "lead",
          model: "anthropic/lead",
          iteration_limit: 3,
          tools: [],
          can_spawn: ["subagent"],
        },
        { name: "subagent", model: "anthropic/wrk", tools: [], iteration_limit: 3 },
      ],
      entry: "lead",
      budget: { on_exceed: "stop", total_token_limit: 200000, timeout_ms: 30000 },
      providers: anthropicProviders,
    };
    const result = await runOrchestrator(
      request,
      makeDeps({ llm, resultContract: compileResultContract(SCHEMA) }),
    );
    expect(result.response).toMatchObject({ status: "completed", result: { name: "Lead" } });
  });

  it("carries a lead partial structured result on budget exhaustion", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [{ name: "submit_result", arguments: { wrong: 1 } }],
          usage: { input_tokens: 70, output_tokens: 40 },
        },
        {
          toolCalls: [{ name: "submit_result", arguments: { wrong: 2 } }],
          usage: { input_tokens: 70, output_tokens: 40 },
        },
        { text: "x", usage: { input_tokens: 70, output_tokens: 40 } },
      ],
    });
    const request: RunRequest = {
      messages: [{ role: "user", content: "go" }],
      servers: [],
      profiles: [
        {
          name: "lead",
          model: "anthropic/lead",
          iteration_limit: 50,
          tools: [],
          can_spawn: ["subagent"],
        },
        { name: "subagent", model: "anthropic/wrk", tools: [], iteration_limit: 50 },
      ],
      entry: "lead",
      budget: { on_exceed: "stop", total_token_limit: 100, timeout_ms: 30000 },
      providers: anthropicProviders,
    };
    const result = await runOrchestrator(
      request,
      makeDeps({ llm, resultContract: compileResultContract(SCHEMA) }),
    );
    expect(result.response.status).toBe("budget_exhausted");
    if (result.response.status === "budget_exhausted") {
      expect(result.response.result).toEqual({ wrong: 1 });
    }
  });

  it("routes a pool tool to the subagent profile only", async () => {
    const llm = new MockLLM({ script: [{ text: "final" }] });
    const mcp = mockMCPFactory({
      shared: { tools: [{ name: "read", inputSchema: {}, call: () => "x" }] },
    });
    const servers: McpServerConfig[] = [
      { name: "shared", transport: "stdio", command: "node", args: ["-e", ""] },
    ];
    const request: RunRequest = {
      messages: [{ role: "user", content: "go" }],
      servers,
      profiles: [
        {
          name: "lead",
          model: "anthropic/lead",
          iteration_limit: 3,
          tools: [],
          can_spawn: ["subagent"],
        },
        { name: "subagent", model: "anthropic/wrk", tools: ["shared.read"], iteration_limit: 3 },
      ],
      entry: "lead",
      budget: { on_exceed: "stop", total_token_limit: 200000, timeout_ms: 30000 },
      providers: anthropicProviders,
    };
    const result = await runOrchestrator(request, makeDeps({ llm, mcpFactory: mcp }));
    expect(result.response.status).toBe("completed");
    const leadTools = llm.calls[0]!.tools.map((t) => t.fullName);
    expect(leadTools).not.toContain("shared.read");
  });

  it("skips a soft budget when the finalizer (lead) declares no soft limits", async () => {
    const llm = new MockLLM({ script: [{ text: "final" }] });
    let elicitCalls = 0;
    const elicit: Elicit = async () => {
      elicitCalls += 1;
      return { action: "accept" };
    };
    const request: RunRequest = {
      messages: [{ role: "user", content: "go" }],
      servers: [],
      profiles: [
        {
          name: "lead",
          model: "anthropic/lead",
          iteration_limit: 3,
          tools: [],
          can_spawn: ["subagent"],
        },
        { name: "subagent", model: "anthropic/wrk", tools: [], iteration_limit: 5 },
      ],
      entry: "lead",
      budget: { on_exceed: "stop", total_token_limit: 200000, timeout_ms: 30000 },
      providers: anthropicProviders,
    };
    const result = await runOrchestrator(request, makeDeps({ llm, elicit }));
    expect(result.response.status).toBe("completed");
    expect(elicitCalls).toBe(0);
  });

  it("completes in soft (escalate) mode with an unbounded lead when it stays under the token limit", async () => {
    const llm = new MockLLM({
      script: [{ text: "final", usage: { input_tokens: 1, output_tokens: 1 } }],
    });
    let elicitCalls = 0;
    const elicit: Elicit = async () => {
      elicitCalls += 1;
      return { action: "accept" };
    };
    const request: RunRequest = {
      messages: [{ role: "user", content: "go" }],
      servers: [],
      profiles: [
        { name: "lead", model: "anthropic/lead", tools: [], can_spawn: ["subagent"] },
        { name: "subagent", model: "anthropic/wrk", tools: [] },
      ],
      entry: "lead",
      budget: { on_exceed: "escalate", total_token_limit: 100000, timeout_ms: 30000 },
      providers: anthropicProviders,
    };
    const result = await runOrchestrator(request, makeDeps({ llm, elicit }));
    expect(result.response.status).toBe("completed");
    expect(elicitCalls).toBe(0);
  });

  it("tells a soft-mode lead its iterations are unbounded, even past the entry iteration_limit", async () => {
    const llm = new MockLLM({
      script: [
        { toolCalls: [{ name: "spawn_subagent", arguments: { title: "a", task: "do a" } }] },
        { text: "a done" },
        { toolCalls: [{ name: "spawn_subagent", arguments: { title: "b", task: "do b" } }] },
        { text: "b done" },
        { text: "final" },
      ],
    });
    const elicit: Elicit = async () => ({ action: "accept" });
    const request: RunRequest = {
      messages: [{ role: "user", content: "go" }],
      servers: [],
      profiles: [
        {
          name: "lead",
          model: "anthropic/lead",
          iteration_limit: 2,
          tools: [],
          can_spawn: ["subagent"],
        },
        { name: "subagent", model: "anthropic/wrk", tools: [], iteration_limit: 3 },
      ],
      entry: "lead",
      budget: {
        on_exceed: "escalate",
        total_token_limit: 1_000_000,
        max_escalations: 5,
        timeout_ms: 30000,
      },
      providers: anthropicProviders,
    };
    const result = await runOrchestrator(request, makeDeps({ llm, elicit }));
    expect(result.response.status).toBe("completed");

    const notes = JSON.stringify(llm.calls.map((c) => c.messages));
    expect(notes).toContain("lead_iterations_remaining=unbounded");
    expect(notes).not.toContain("lead_iterations_remaining=0");
  });

  it("rejects a profile that lists a tool not in the pool", async () => {
    const llm = new MockLLM({ script: [{ text: "unused" }] });
    const mcp = mockMCPFactory({
      shared: { tools: [{ name: "read", inputSchema: {}, call: () => "x" }] },
    });
    const servers: McpServerConfig[] = [
      {
        name: "shared",
        transport: "stdio",
        command: "node",
        args: ["-e", ""],
      },
    ];
    const request: RunRequest = {
      messages: [{ role: "user", content: "go" }],
      servers,
      profiles: [
        {
          name: "lead",
          model: "anthropic/lead",
          iteration_limit: 3,
          tools: [],
          can_spawn: ["p1"],
        },
        {
          name: "p1",
          base_prompt: "bp",
          model: "anthropic/wrk",
          tools: ["nonexistent"],
          iteration_limit: 3,
        },
      ],
      entry: "lead",
      budget: { on_exceed: "stop", total_token_limit: 200000, timeout_ms: 30000 },
      providers: anthropicProviders,
    };
    const result = await runOrchestrator(request, makeDeps({ llm, mcpFactory: mcp }));
    expect(result.response.status).toBe("error");
    if (result.response.status === "error") {
      expect(result.response.error.code).toBe("invalid_profile");
      expect(result.response.error.message).toContain("shared.read");
    }
    expect(llm.calls).toHaveLength(0);
  });

  it("rejects a profile that lists a tool when the pool is empty", async () => {
    const llm = new MockLLM({ script: [{ text: "unused" }] });
    const mcp = mockMCPFactory({
      leadonly: { tools: [{ name: "peek", inputSchema: {}, call: () => "x" }] },
    });
    const servers: McpServerConfig[] = [
      {
        name: "leadonly",
        transport: "stdio",
        command: "node",
        args: ["-e", ""],
      },
    ];
    const request: RunRequest = {
      messages: [{ role: "user", content: "go" }],
      servers,
      profiles: [
        {
          name: "lead",
          model: "anthropic/lead",
          iteration_limit: 3,
          tools: ["leadonly.peek"],
          can_spawn: ["p1"],
        },
        {
          name: "p1",
          base_prompt: "bp",
          model: "anthropic/wrk",
          tools: ["whatever"],
          iteration_limit: 3,
        },
      ],
      entry: "lead",
      budget: { on_exceed: "stop", total_token_limit: 200000, timeout_ms: 30000 },
      providers: anthropicProviders,
    };
    const result = await runOrchestrator(request, makeDeps({ llm, mcpFactory: mcp }));
    expect(result.response.status).toBe("error");
    if (result.response.status === "error") {
      expect(result.response.error.code).toBe("invalid_profile");
      expect(result.response.error.message).toContain("leadonly.peek");
    }
  });
});

function relayingFactory(message: unknown): MCPClientFactory {
  return async (_tool: McpServerConfig, relay?: ElicitationRelay): Promise<MCPClientHandle> => {
    const client = {
      async listTools() {
        return {
          tools: [
            {
              name: "guard_tool",
              description: "asks",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        };
      },
      async callTool() {
        const outcome = await relay!.handle({
          message,
          requestedSchema: {
            type: "object",
            properties: { response: { type: "string" } },
            required: ["response"],
          },
        } as unknown as { message: string; requestedSchema: unknown });
        return { content: [{ type: "text", text: `verdict:${outcome.action}` }] };
      },
      async close() {},
    };
    return {
      client: client as any,
      close: async () => {},
    };
  };
}

describe("tool elicitation relay without a run signal", () => {
  async function runRelay(
    message: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: string; kinds: string[]; calls: MockLLM["calls"] }> {
    const llm = new MockLLM({
      script: [{ toolCalls: [{ name: "guard_tool", arguments: {} }] }, { text: "done" }],
    });
    const elicit: Elicit = async (): Promise<ElicitRawResult> => ({
      action: "accept",
      content: { response: "ok" },
    });
    const request: RunRequest = {
      messages: [{ role: "user", content: "go" }],
      servers: [{ name: "guard", transport: "stdio", command: "noop" }],
      profiles: [
        {
          name: "solo",
          model: "anthropic/x",
          tools: ["guard.guard_tool"],
          iteration_limit: 5,
          grants: ["ask_user"],
        },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
      providers: anthropicProviders,
    };
    const result = await runOrchestrator(
      request,
      makeDeps({
        llm,
        mcpFactory: relayingFactory(message),
        elicit,
        ...(signal ? { signal } : {}),
      }),
    );
    return { status: result.response.status, kinds: kinds(result), calls: llm.calls };
  }

  it("forwards a string-message elicitation with no run signal", async () => {
    const out = await runRelay("approve?");
    expect(out.status).toBe("completed");
    expect(out.kinds).toContain("elicitation_requested");
    expect(JSON.stringify(out.calls[1]!.messages)).toContain("verdict:accept");
  });

  it("forwards a non-string-message elicitation", async () => {
    const out = await runRelay(123);
    expect(out.status).toBe("completed");
    expect(out.kinds).toContain("elicitation_requested");
  });

  it("combines the run signal into the relayed elicitation when present", async () => {
    const out = await runRelay("approve?", new AbortController().signal);
    expect(out.status).toBe("completed");
    expect(out.kinds).toContain("elicitation_requested");
  });
});

describe("connection failures", () => {
  it("returns mcp_connection_failed when several tools fail to connect", async () => {
    const llm = new MockLLM({ script: [{ text: "unused" }] });
    const mcp = mockMCPFactory({
      a: { tools: [], connectError: new Error("a down") },
      b: { tools: [], connectError: new Error("b down") },
    });
    const servers: McpServerConfig[] = [
      { name: "a", transport: "stdio", command: "node", args: ["-e", ""] },
      { name: "b", transport: "stdio", command: "node", args: ["-e", ""] },
    ];
    const request: RunRequest = {
      messages: [{ role: "user", content: "go" }],
      servers,
      profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 3 }],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
      providers: anthropicProviders,
    };
    const result = await runOrchestrator(request, makeDeps({ llm, mcpFactory: mcp }));
    expect(result.response.status).toBe("error");
    if (result.response.status === "error") {
      expect(result.response.error.code).toBe("mcp_connection_failed");
    }
    expect(llm.calls).toHaveLength(0);
  });

  it("reports a consistent empty by_agent for a lead+subagent pre-loop connection failure", async () => {
    const llm = new MockLLM({ script: [{ text: "unused" }] });
    const mcp = mockMCPFactory({ a: { tools: [], connectError: new Error("a down") } });
    const servers: McpServerConfig[] = [
      { name: "a", transport: "stdio", command: "node", args: ["-e", ""] },
    ];
    const request: RunRequest = {
      messages: [{ role: "user", content: "go" }],
      servers,
      profiles: [
        {
          name: "lead",
          model: "anthropic/lead",
          iteration_limit: 3,
          tools: [],
          can_spawn: ["subagent"],
        },
        { name: "subagent", model: "anthropic/wrk", tools: [], iteration_limit: 3 },
      ],
      entry: "lead",
      budget: { on_exceed: "stop", total_token_limit: 200000, timeout_ms: 30000 },
      providers: anthropicProviders,
    };
    const result = await runOrchestrator(request, makeDeps({ llm, mcpFactory: mcp }));
    expect(result.response.status).toBe("error");
    expect(result.response.usage.by_agent).toEqual([]);
    expect(result.response.usage.iterations_used).toBe(0);
  });

  it("returns cancelled when the run signal is aborted during connect", async () => {
    const llm = new MockLLM({ script: [{ text: "unused" }] });
    const mcp = mockMCPFactory({ slow: { tools: [], connectDelayMs: 5000 } });
    const servers: McpServerConfig[] = [
      { name: "slow", transport: "stdio", command: "node", args: ["-e", ""] },
    ];
    const request: RunRequest = {
      messages: [{ role: "user", content: "go" }],
      servers,
      profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 3 }],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
      providers: anthropicProviders,
    };
    const result = await runOrchestrator(
      request,
      makeDeps({ llm, mcpFactory: mcp, signal: AbortSignal.abort() }),
    );
    expect(result.response.status).toBe("cancelled");
    expect(llm.calls).toHaveLength(0);
  });
});
