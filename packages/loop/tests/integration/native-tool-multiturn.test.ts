import { describe, it, expect, afterEach } from "../bun-test.ts";
import { contentToText } from "@clarvis/capability";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import type { LiveMessage, ToolCallRef } from "@clarvis/capability";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

function assertPaired(messages: LiveMessage[]): void {
  const seenCallIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && "tool_calls" in m) {
      for (const tc of m.tool_calls) seenCallIds.add(tc.id);
    }
    if (m.role === "tool") {
      expect(
        seenCallIds.has(m.tool_call_id),
        `tool result ${m.tool_call_id} has a preceding call`,
      ).toBe(true);
    }
  }
  const resultIds = messages.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : []));
  for (const id of seenCallIds) {
    expect(resultIds.filter((r) => r === id)).toHaveLength(1);
  }
}

function assistantCallIds(messages: LiveMessage[]): string[] {
  return messages.flatMap((m) =>
    m.role === "assistant" && "tool_calls" in m ? m.tool_calls.map((tc) => tc.id) : [],
  );
}
function toolResultIds(messages: LiveMessage[]): string[] {
  return messages.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : []));
}

const mcp = () =>
  mockMCPFactory({ fs: { tools: [{ name: "read", inputSchema: {}, call: () => "DATA" }] } });
const tools = [{ name: "fs", transport: "stdio" as const, command: "node", args: [] }];

describe("provider message contract", () => {
  it("a tool iteration becomes an assistant(tool_calls) + paired tool message, never user text", async () => {
    const llm = new MockLLM({
      script: [{ toolCalls: [{ id: "c1", name: "fs.read", arguments: {} }] }, { text: "done" }],
    });
    harness = await makeHarness({ llm, mcpFactory: mcp() });
    await harness.run({
      messages: [{ role: "user", content: "read it" }],
      servers: tools,
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-haiku-4-5",
          tools: ["fs.read"],
          iteration_limit: 5,
        },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
    });

    const second = llm.calls[1]!.messages;
    expect(assistantCallIds(second)).toContain("c1");
    expect(toolResultIds(second)).toContain("c1");
    const toolMsg = second.find((m) => m.role === "tool" && m.tool_call_id === "c1")!;
    expect(toolMsg).toBeDefined();
    expect((toolMsg as { content: string }).content).toContain("Tool 'fs.read' result");
    const userResultLeak = second.some(
      (m) => m.role === "user" && contentToText(m.content).includes("Tool 'fs.read' result"),
    );
    expect(userResultLeak).toBe(false);
  });

  it("N tool calls in one iteration → one assistant with N tool_calls and N paired tool messages", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            { id: "a1", name: "fs.read", arguments: {} },
            { id: "a2", name: "fs.read", arguments: {} },
          ],
        },
        { text: "done" },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: mcp() });
    await harness.run({
      messages: [{ role: "user", content: "read twice" }],
      servers: tools,
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-haiku-4-5",
          tools: ["fs.read"],
          iteration_limit: 5,
        },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
    });

    const second = llm.calls[1]!.messages;
    const assistantsWithCalls = second.filter((m) => m.role === "assistant" && "tool_calls" in m);
    expect(assistantsWithCalls).toHaveLength(1);
    expect((assistantsWithCalls[0] as { tool_calls: ToolCallRef[] }).tool_calls).toHaveLength(2);
    expect(new Set(toolResultIds(second))).toEqual(new Set(["a1", "a2"]));
  });

  it("a control-plane result (spawn_subagent) is a paired tool message, not user text", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            {
              id: "s1",
              name: "spawn_subagent",
              arguments: { title: "w", task: "do X" },
            },
          ],
        },
        { text: "X done" },
        { text: "all done" },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: mcp() });
    const res = await harness.run({
      messages: [{ role: "user", content: "do X" }],
      servers: tools,
      profiles: [
        {
          name: "lead",
          model: "anthropic/claude-opus-4-5",
          tools: [],
          can_spawn: ["subagent"],
          iteration_limit: 10,
        },
        {
          name: "subagent",
          model: "anthropic/claude-haiku-4-5",
          tools: ["fs.read"],
          iteration_limit: 5,
        },
      ],
      entry: "lead",
      budget: { on_exceed: "stop", total_token_limit: 200000, timeout_ms: 30000 },
    });
    expect(["completed", "error"]).toContain((res as { status: string }).status);

    const leadMsgs = llm.calls.filter((c) => c.model.includes("opus")).flatMap((c) => c.messages);
    const name = "spawn_subagent";
    const asTool = leadMsgs.some(
      (m) => m.role === "tool" && m.content.includes(`Tool '${name}' result`),
    );
    const asUser = leadMsgs.some(
      (m) => m.role === "user" && contentToText(m.content).includes(`Tool '${name}' result`),
    );
    expect(asTool, `${name} result present as a tool message`).toBe(true);
    expect(asUser, `${name} result NOT leaked as user text`).toBe(false);
  });
});

describe("multi-turn tool exchange stays coherent on every call", () => {
  it("three subagent iterations (2 tool calls + finish) → no orphan call/result on any request", async () => {
    const llm = new MockLLM({
      script: [
        { toolCalls: [{ id: "t0", name: "fs.read", arguments: {} }] },
        { toolCalls: [{ id: "t1", name: "fs.read", arguments: {} }] },
        { text: "all read" },
      ],
    });
    harness = await makeHarness({
      llm,
      mcpFactory: mockMCPFactory({
        fs: { tools: [{ name: "read", inputSchema: {}, call: () => "DATA" }] },
      }),
    });

    const res = await harness.run({
      messages: [{ role: "user", content: "read repeatedly" }],
      servers: [{ name: "fs", transport: "stdio", command: "node", args: [] }],
      entry: "solo",
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-haiku-4-5",
          tools: ["fs.read"],
          iteration_limit: 5,
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
    });
    expect((res as { status: string }).status).toBe("completed");

    expect(llm.calls.length).toBe(3);
    for (const c of llm.calls) assertPaired(c.messages);
    const third = llm.calls[2]!.messages;
    expect(
      third
        .filter((m) => m.role === "tool")
        .map((m) => (m as { tool_call_id: string }).tool_call_id),
    ).toEqual(["t0", "t1"]);
  });
});
