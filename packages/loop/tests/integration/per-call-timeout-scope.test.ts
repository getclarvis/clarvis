import { describe, it, expect, afterEach } from "../bun-test.ts";
import { mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import { ProviderError } from "@clarvis/capability";
import type { LLMCallParams, LLMCallResult, LLMProvider } from "@clarvis/capability";
import type { LiveMessage } from "@clarvis/capability";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const TIMEOUT_ERR = "Model call exceeded the per-call timeout of 180000ms.";
const mcp = () =>
  mockMCPFactory({ fs: { tools: [{ name: "read", inputSchema: {}, call: () => "DATA" }] } });
const tools = [{ name: "fs", transport: "stdio" as const, command: "node", args: [] }];
const lead = {
  name: "lead",
  model: "anthropic/claude-opus-4-5",
  iteration_limit: 10,
  tools: [] as string[],
  can_spawn: ["subagent"],
};
const profiles = [
  { name: "subagent", model: "anthropic/claude-haiku-4-5", tools: ["fs.read"], iteration_limit: 5 },
];

describe("per-call timeout scope is per-agent", () => {
  it("a Subagent call timeout fails only that Subagent; the Lead gets a subagent error and continues", async () => {
    const leadSaw: LiveMessage[][] = [];
    let leadCalls = 0;
    const provider: LLMProvider = {
      async call(p: LLMCallParams): Promise<LLMCallResult> {
        const usage = {
          input_tokens: 5,
          output_tokens: 5,
          cached_tokens: 0,
          cache_write_tokens: 0,
        };
        if (p.model.includes("haiku")) {
          throw new ProviderError(TIMEOUT_ERR);
        }
        leadCalls += 1;
        leadSaw.push(p.messages);
        if (leadCalls === 1) {
          return {
            toolCalls: [
              { id: "s1", name: "spawn_subagent", arguments: { title: "w", task: "do X" } },
            ],
            usage,
          };
        }
        return { text: "synthesized despite the subagent failure", usage };
      },
    };
    harness = await makeHarness({ llm: provider, mcpFactory: mcp() });

    const res = await harness.run({
      messages: [{ role: "user", content: "do X" }],
      servers: tools,
      profiles: [lead, ...profiles],
      entry: "lead",
      budget: { on_exceed: "stop", total_token_limit: 200000, timeout_ms: 30000 },
    });

    expect((res as { status: string }).status).toBe("completed");
    expect(leadCalls).toBe(2);

    const secondCall = leadSaw[1]!;
    const subagentErrorTool = secondCall.find(
      (m) => m.role === "tool" && m.tool_call_id === "s1" && m.content.includes("Sub-agent error"),
    );
    expect(subagentErrorTool).toBeDefined();

    const detail = await harness.getRun(res.execution_id);
    const events = detail!.trace.events;
    expect(events.some((e) => e.type === "delegation_created")).toBe(true);
  });

  it("the Lead/finalizer call timeout ends the run with a provider error", async () => {
    const provider: LLMProvider = {
      async call(): Promise<LLMCallResult> {
        throw new ProviderError(TIMEOUT_ERR);
      },
    };
    harness = await makeHarness({ llm: provider, mcpFactory: mcp() });

    const res = await harness.run({
      messages: [{ role: "user", content: "do X" }],
      servers: tools,
      profiles: [lead, ...profiles],
      entry: "lead",
      budget: { on_exceed: "stop", total_token_limit: 200000, timeout_ms: 30000 },
    });

    expect((res as { status: string }).status).toBe("error");
    expect((res as { error?: { code?: string } }).error?.code).toBe("provider_error");
  });
});
