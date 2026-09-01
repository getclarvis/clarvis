import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const pathSchema = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
};

function fsFactory(onCall: () => void) {
  return mockMCPFactory({
    filesystem: {
      tools: [
        {
          name: "read",
          inputSchema: pathSchema,
          call: () => {
            onCall();
            return "file-contents";
          },
        },
      ],
    },
  });
}

const fsTool = [{ name: "filesystem", transport: "stdio", command: "node", args: ["-e", ""] }];

describe("MCP tool-argument validation", () => {
  it("invalid args are NOT dispatched; a didactic error is fed back and the run continues", async () => {
    let invoked = 0;
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [{ name: "filesystem.read", arguments: {} }],
          usage: { input_tokens: 8, output_tokens: 3 },
        },
        { text: "I omitted the required path.", usage: { input_tokens: 6, output_tokens: 3 } },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: fsFactory(() => (invoked += 1)) });

    const res = await harness.run({
      messages: [{ role: "user", content: "read it" }],
      servers: fsTool,
      entry: "solo",
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-haiku-4-5",
          tools: ["filesystem.read"],
          iteration_limit: 5,
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 100_000, timeout_ms: 30000 },
    });

    expect(res.status).toBe("completed");
    expect(invoked).toBe(0);
    const secondCallMessages = JSON.stringify(llm.calls[1]!.messages);
    expect(secondCallMessages).toContain("InputValidationError");
    expect(secondCallMessages).toContain("path");
  });

  it("valid args dispatch unchanged", async () => {
    let invoked = 0;
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [{ name: "filesystem.read", arguments: { path: "/etc/hostname" } }],
          usage: { input_tokens: 8, output_tokens: 3 },
        },
        { text: "Read it: file-contents.", usage: { input_tokens: 6, output_tokens: 3 } },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: fsFactory(() => (invoked += 1)) });

    const res = await harness.run({
      messages: [{ role: "user", content: "read it" }],
      servers: fsTool,
      entry: "solo",
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-haiku-4-5",
          tools: ["filesystem.read"],
          iteration_limit: 5,
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 100_000, timeout_ms: 30000 },
    });

    expect(res.status).toBe("completed");
    expect(invoked).toBe(1);
  });

  it("a wrong-case tool name resolves and dispatches", async () => {
    let invoked = 0;
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [{ name: "Filesystem.Read", arguments: { path: "/x" } }],
          usage: { input_tokens: 8, output_tokens: 3 },
        },
        { text: "done", usage: { input_tokens: 4, output_tokens: 2 } },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: fsFactory(() => (invoked += 1)) });

    const res = await harness.run({
      messages: [{ role: "user", content: "read it" }],
      servers: fsTool,
      entry: "solo",
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-haiku-4-5",
          tools: ["filesystem.read"],
          iteration_limit: 5,
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 100_000, timeout_ms: 30000 },
    });

    expect(res.status).toBe("completed");
    expect(invoked).toBe(1);
  });

  it("the Lead validates its own MCP calls too", async () => {
    let invoked = 0;
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [{ name: "db.query", arguments: {} }],
          usage: { input_tokens: 10, output_tokens: 3 },
        },
        { text: "I must supply the required q.", usage: { input_tokens: 6, output_tokens: 3 } },
      ],
    });
    const mcp = mockMCPFactory({
      db: {
        tools: [
          {
            name: "query",
            inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
            call: () => {
              invoked += 1;
              return "rows";
            },
          },
        ],
      },
    });
    harness = await makeHarness({ llm, mcpFactory: mcp });

    const res = await harness.run({
      messages: [{ role: "user", content: "query" }],
      servers: [{ name: "db", transport: "stdio", command: "x" }],
      entry: "lead",
      profiles: [
        {
          name: "lead",
          model: "anthropic/claude-opus-4-5",
          iteration_limit: 5,
          tools: ["db.query"],
          can_spawn: ["subagent"],
        },
        { name: "subagent", model: "anthropic/claude-haiku-4-5", tools: [], iteration_limit: 5 },
      ],
      budget: { on_exceed: "stop", total_token_limit: 100_000, timeout_ms: 30000 },
    });

    expect(res.status).toBe("completed");
    expect(invoked).toBe(0);
    expect(JSON.stringify(llm.calls[1]!.messages)).toContain("InputValidationError");
  });
});
