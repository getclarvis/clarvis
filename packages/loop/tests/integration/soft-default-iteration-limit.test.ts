import { describe, it, expect } from "../bun-test.ts";
import { loadEnv } from "@clarvis/capability";
import { runOrchestrator, type OrchestratorDeps } from "../../src/runtime/orchestrator.ts";
import { MockLLM, mockConnections, mockMCPFactory } from "./_fixtures.ts";
import { createAskUserCapability } from "../../src/runtime/capabilities/ask-user.ts";
import type { RunRequest, McpServerConfig } from "@clarvis/capability";
import type { Elicit } from "../../src/runtime/tools/ask-user-tool.ts";

const env = loadEnv({
  ANTHROPIC_API_KEY: "k",
  CLARVIS_MCP_CONNECT_TIMEOUT_MS: "2000",
  CLARVIS_DEFAULT_ITERATION_LIMIT: "2",
});

const anthropicProviders = [{ name: "anthropic", kind: "anthropic" as const }];

function makeDeps(over: Partial<OrchestratorDeps> & { llm: MockLLM }): OrchestratorDeps {
  return {
    env,
    connections: mockConnections(
      mockMCPFactory({
        noop: { tools: [{ name: "run", inputSchema: {}, call: () => "x" }] },
      }),
      env,
    ),
    workspaceRoot: process.cwd(),
    owner: "test",
    capabilities: [createAskUserCapability()],
    ...over,
  };
}

describe("soft mode without a profile iteration_limit", () => {
  it("asks at the default iteration limit instead of running unbounded", async () => {
    const step = {
      toolCalls: [{ name: "noop.run", arguments: {} }],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const llm = new MockLLM({ script: [step, step, step, step] });
    const asked: string[] = [];
    const elicit: Elicit = async (params) => {
      asked.push(params.message);
      return { action: "accept", content: { continue: "stop" } };
    };
    const servers: McpServerConfig[] = [
      { name: "noop", transport: "stdio", command: "node", args: ["-e", ""] },
    ];
    const request: RunRequest = {
      messages: [{ role: "user", content: "go" }],
      servers,
      profiles: [{ name: "solo", model: "anthropic/x", tools: ["noop.run"] }],
      entry: "solo",
      budget: {
        on_exceed: "escalate",
        total_token_limit: 1_000_000,
        max_escalations: 5,
        timeout_ms: 30000,
      },
      providers: anthropicProviders,
    };

    const result = await runOrchestrator(request, makeDeps({ llm, elicit }));

    expect(result.response.status).toBe("soft_limit_declined");
    expect(llm.calls).toHaveLength(2);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("iterations");
    expect(asked[0]).toContain("(2)");
    const softChecks = result.trace.entries.filter((e) => e.kind === "soft_limit_check");
    expect(softChecks.length).toBeGreaterThanOrEqual(1);
    expect(softChecks[0]!.detail).toMatchObject({ dimension: "iterations", limit: 2 });
  });

  it("continues past the default limit when the user accepts the ask", async () => {
    const step = {
      toolCalls: [{ name: "noop.run", arguments: {} }],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const llm = new MockLLM({
      script: [step, step, { text: "done", usage: { input_tokens: 1, output_tokens: 1 } }],
    });
    const elicit: Elicit = async () => ({ action: "accept", content: { continue: "continue" } });
    const servers: McpServerConfig[] = [
      { name: "noop", transport: "stdio", command: "node", args: ["-e", ""] },
    ];
    const request: RunRequest = {
      messages: [{ role: "user", content: "go" }],
      servers,
      profiles: [{ name: "solo", model: "anthropic/x", tools: ["noop.run"] }],
      entry: "solo",
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
    expect(llm.calls).toHaveLength(3);
  });
});
