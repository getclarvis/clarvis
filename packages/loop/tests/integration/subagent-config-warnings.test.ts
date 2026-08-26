import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const LEAD_ANSWERS = new MockLLM({
  script: [{ text: "answer from the Lead", usage: { input_tokens: 10, output_tokens: 5 } }],
});

function mkHarness(llm: MockLLM): Promise<TestHarness> {
  const mcp = mockMCPFactory({
    leadonly: { tools: [{ name: "read", inputSchema: {}, call: () => "x" }] },
  });
  return makeHarness({ llm, mcpFactory: mcp, agentTools: true });
}

async function runWith(
  h: TestHarness,
  subagent: { tools: string[]; grants?: string[] },
): Promise<{ status: string; usage: { warnings?: string[] } }> {
  const res = await h.run({
    messages: [{ role: "user", content: "go" }],
    servers: [{ name: "leadonly", transport: "stdio", command: "node", args: ["-e", ""] }],
    entry: "lead",
    profiles: [
      {
        name: "lead",
        model: "anthropic/claude-opus-4-5",
        tools: ["leadonly.read"],
        can_spawn: ["subagent"],
        iteration_limit: 5,
      },
      {
        name: "subagent",
        model: "anthropic/claude-haiku-4-5",
        tools: subagent.tools,
        ...(subagent.grants ? { grants: subagent.grants } : {}),
        iteration_limit: 5,
      },
    ],
    budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
  });
  return res as unknown as { status: string; usage: { warnings?: string[] } };
}

describe("subagent_has_no_tools is builtin-aware (finding 14)", () => {
  it("a spawnable subagent with only built-in coding tools (read_workspace grant) does NOT warn", async () => {
    harness = await mkHarness(
      new MockLLM({
        script: [{ text: "answer from the Lead", usage: { input_tokens: 10, output_tokens: 5 } }],
      }),
    );
    const body = await runWith(harness, { tools: [], grants: ["read_workspace"] });
    expect(body.status).toBe("completed");
    expect(body.usage.warnings ?? []).not.toContain("subagent_has_no_tools");
  });

  it("a spawnable subagent with neither MCP tools nor grants still warns (control)", async () => {
    harness = await mkHarness(
      new MockLLM({
        script: [{ text: "answer from the Lead", usage: { input_tokens: 10, output_tokens: 5 } }],
      }),
    );
    const body = await runWith(harness, { tools: [] });
    expect(body.status).toBe("completed");
    expect(body.usage.warnings ?? []).toContain("subagent_has_no_tools");
  });

  it("CLARVIS_AGENT_TOOLS_ENABLED=false makes the read_workspace grant inert -> warns", async () => {
    const mcp = mockMCPFactory({
      leadonly: { tools: [{ name: "read", inputSchema: {}, call: () => "x" }] },
    });
    harness = await makeHarness({
      llm: new MockLLM({
        script: [{ text: "answer from the Lead", usage: { input_tokens: 10, output_tokens: 5 } }],
      }),
      mcpFactory: mcp,
      agentTools: true,
      env: { CLARVIS_AGENT_TOOLS_ENABLED: "false" },
    });
    const body = await runWith(harness, { tools: [], grants: ["read_workspace"] });
    expect(body.status).toBe("completed");
    expect(body.usage.warnings ?? []).toContain("subagent_has_no_tools");
  });
});

describe("ask_user grant on a subagent profile is inert and surfaces subagent_ask_user_ignored (finding 13)", () => {
  it("warns when a spawnable subagent declares the (entry-only) ask_user grant", async () => {
    harness = await mkHarness(
      new MockLLM({
        script: [{ text: "answer from the Lead", usage: { input_tokens: 10, output_tokens: 5 } }],
      }),
    );
    const body = await runWith(harness, { tools: ["leadonly.read"], grants: ["ask_user"] });
    expect(body.status).toBe("completed");
    expect(body.usage.warnings ?? []).toContain("subagent_ask_user_ignored");
  });

  it("does not warn when no subagent declares ask_user (control)", async () => {
    harness = await mkHarness(LEAD_ANSWERS);
    const body = await runWith(harness, { tools: ["leadonly.read"] });
    expect(body.status).toBe("completed");
    expect(body.usage.warnings ?? []).not.toContain("subagent_ask_user_ignored");
  });
});
