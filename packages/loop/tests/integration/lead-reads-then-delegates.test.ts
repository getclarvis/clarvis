import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("Lead reads an informational MCP then spawns a context-informed Subagent", () => {
  it("calls the informational MCP first, then spawn_subagent, then synthesizes", async () => {
    let infoCalledAt = -1;
    let order = 0;

    const llm = new MockLLM({
      script: [
        {
          toolCalls: [{ name: "info.lookup", arguments: { q: "process CASE-0001234" } }],
          usage: { input_tokens: 100, output_tokens: 20 },
        },
        {
          toolCalls: [
            {
              name: "spawn_subagent",
              arguments: { title: "w", task: "Extract the plaintiff name using context: court=SP" },
            },
          ],
          usage: { input_tokens: 80, output_tokens: 30 },
        },
        { text: "Plaintiff: Jane Doe", usage: { input_tokens: 60, output_tokens: 40 } },
        {
          text: "Final: Plaintiff is Jane Doe.",
          usage: { input_tokens: 50, output_tokens: 25 },
        },
      ],
    });

    const mcp = mockMCPFactory({
      info: {
        tools: [
          {
            name: "lookup",
            inputSchema: { type: "object", properties: { q: { type: "string" } } },
            call: () => {
              infoCalledAt = order++;
              return "court=SP";
            },
          },
        ],
      },
    });

    harness = await makeHarness({ llm, mcpFactory: mcp });

    const res = await harness.run({
      messages: [{ role: "user", content: "Extract the plaintiff from process CASE-0001234" }],
      servers: [
        {
          name: "info",
          transport: "stdio",
          command: "node",
          args: ["-e", ""],
        },
      ],
      entry: "lead",
      profiles: [
        {
          name: "lead",
          model: "anthropic/claude-opus-4-5",
          iteration_limit: 10,
          tools: ["info.lookup"],
          can_spawn: ["subagent"],
        },
        {
          name: "subagent",
          model: "anthropic/claude-haiku-4-5",
          tools: ["info.lookup"],
          iteration_limit: 10,
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    });

    const body = res as unknown as {
      status: string;
      result: string;
      usage: { by_agent: Array<{ type: string; instances?: number; subagents_spawned?: number }> };
    };
    expect(body.status).toBe("completed");
    expect(body.result).toBe("Final: Plaintiff is Jane Doe.");

    expect(infoCalledAt).toBe(0);

    expect(body.usage.by_agent.map((a) => a.type)).toEqual(["lead", "subagent"]);
    const subagentEntry = body.usage.by_agent.find((a) => a.type === "subagent")!;
    expect(subagentEntry.instances).toBe(1);

    const leadCalls = llm.calls.filter((c) => c.model === "claude-opus-4-5");
    const subagentCalls = llm.calls.filter((c) => c.model === "claude-haiku-4-5");
    expect(leadCalls[0]!.tools.some((t) => t.fullName === "spawn_subagent")).toBe(true);
    expect(subagentCalls.every((c) => c.tools.every((t) => t.fullName !== "spawn_subagent"))).toBe(
      true,
    );
  });
});
