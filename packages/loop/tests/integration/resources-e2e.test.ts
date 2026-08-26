import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

function serialize(messages: unknown): string {
  return JSON.stringify(messages);
}

describe("MCP resources — end to end through the loop", () => {
  it("an agent reads a text resource and the content reaches the model", async () => {
    const llm = new MockLLM({
      script: [
        { toolCalls: [{ name: "docs.read_resource", arguments: { uri: "docs://readme" } }] },
        { text: "The readme greets the world." },
      ],
    });
    const mcp = mockMCPFactory({
      docs: {
        tools: [],
        resources: [
          {
            uri: "docs://readme",
            name: "readme",
            mimeType: "text/markdown",
            text: "hello from readme",
          },
        ],
      },
    });
    harness = await makeHarness({ llm, mcpFactory: mcp });

    const res = await harness.run({
      messages: [{ role: "user", content: "What does the readme say?" }],
      servers: [{ name: "docs", transport: "stdio", command: "node", args: ["-e", ""] }],
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-sonnet-4-5",
          tools: ["docs.list_resources", "docs.read_resource"],
          iteration_limit: 10,
        },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 10000, timeout_ms: 30000 },
    });

    expect(res).toMatchObject({ status: "completed", result: "The readme greets the world." });
    expect(serialize(llm.calls[1]!.messages)).toContain("hello from readme");
  });

  it("a non-image binary resource comes back as a refuse note, not base64", async () => {
    const b64 = Buffer.from("%PDF-1.7 binary bytes").toString("base64");
    const llm = new MockLLM({
      script: [
        { toolCalls: [{ name: "docs.read_resource", arguments: { uri: "docs://manual.pdf" } }] },
        { text: "It is a PDF." },
      ],
    });
    const mcp = mockMCPFactory({
      docs: {
        tools: [],
        resources: [
          { uri: "docs://manual.pdf", name: "manual", mimeType: "application/pdf", blob: b64 },
        ],
      },
    });
    harness = await makeHarness({ llm, mcpFactory: mcp });

    const res = await harness.run({
      messages: [{ role: "user", content: "Open the manual." }],
      servers: [{ name: "docs", transport: "stdio", command: "node", args: ["-e", ""] }],
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-sonnet-4-5",
          tools: ["docs.read_resource"],
          iteration_limit: 10,
        },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 10000, timeout_ms: 30000 },
    });

    expect(res).toMatchObject({ status: "completed" });
    const feedback = serialize(llm.calls[1]!.messages);
    expect(feedback).toContain("binary resource application/pdf");
    expect(feedback).not.toContain(b64);
  });

  it("a server that does not advertise resources exposes no read_resource tool (profile ref rejected)", async () => {
    const llm = new MockLLM({ script: [{ text: "unused" }] });
    const mcp = mockMCPFactory({ docs: { tools: [{ name: "search", call: () => "x" }] } });
    harness = await makeHarness({ llm, mcpFactory: mcp });

    await expect(
      harness.run({
        messages: [{ role: "user", content: "read a resource" }],
        servers: [{ name: "docs", transport: "stdio", command: "node", args: ["-e", ""] }],
        profiles: [
          {
            name: "solo",
            model: "anthropic/claude-sonnet-4-5",
            tools: ["docs.read_resource"],
            iteration_limit: 10,
          },
        ],
        entry: "solo",
        budget: { on_exceed: "stop", total_token_limit: 10000, timeout_ms: 30000 },
      }),
    ).resolves.toMatchObject({ status: "error", error: { code: "invalid_profile" } });
  });

  it("respects a per-server resources:false opt-out (no read_resource tool)", async () => {
    const llm = new MockLLM({ script: [{ text: "unused" }] });
    const mcp = mockMCPFactory({
      docs: {
        tools: [],
        resources: [{ uri: "docs://readme", name: "readme", text: "hi" }],
      },
    });
    harness = await makeHarness({ llm, mcpFactory: mcp });

    await expect(
      harness.run({
        messages: [{ role: "user", content: "read a resource" }],
        servers: [
          { name: "docs", transport: "stdio", command: "node", args: ["-e", ""], resources: false },
        ],
        profiles: [
          {
            name: "solo",
            model: "anthropic/claude-sonnet-4-5",
            tools: ["docs.read_resource"],
            iteration_limit: 10,
          },
        ],
        entry: "solo",
        budget: { on_exceed: "stop", total_token_limit: 10000, timeout_ms: 30000 },
      }),
    ).resolves.toMatchObject({ status: "error", error: { code: "invalid_profile" } });
  });
});
