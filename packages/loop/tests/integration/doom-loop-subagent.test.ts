import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const alwaysErrors = mockMCPFactory({
  filesystem: {
    tools: [
      {
        name: "read",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
        call: () => {
          throw new Error("permission denied");
        },
      },
    ],
  },
});

const failingCall = {
  toolCalls: [{ name: "filesystem.read", arguments: { path: "/x" } }],
  usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0 },
};

const tools = [{ name: "filesystem", transport: "stdio", command: "node", args: ["-e", ""] }];

describe("Subagent doom-loop guard", () => {
  it("terminates with tool_failure_loop after the identical call fails the threshold times", async () => {
    const llm = new MockLLM({ script: [failingCall, failingCall, failingCall, failingCall] });
    harness = await makeHarness({ llm, mcpFactory: alwaysErrors });

    const res = await harness.run({
      messages: [{ role: "user", content: "read /x" }],
      servers: tools,
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-haiku-4-5",
          tools: ["filesystem.read"],
          iteration_limit: 50,
        },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 400_000, timeout_ms: 30000 },
    });

    expect(res.status).toBe("error");
    expect((res as { error?: { code?: string } }).error?.code).toBe("tool_failure_loop");
    expect(llm.calls.length).toBeLessThanOrEqual(4);
  });

  it("does not trip when a success interrupts the failures (a single success rescues the run)", async () => {
    const llm = new MockLLM({
      script: [
        failingCall,
        failingCall,
        {
          text: "Could not read /x; reporting failure.",
          usage: { input_tokens: 5, output_tokens: 4 },
        },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: alwaysErrors });

    const res = await harness.run({
      messages: [{ role: "user", content: "read /x" }],
      servers: tools,
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-haiku-4-5",
          tools: ["filesystem.read"],
          iteration_limit: 50,
        },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 400_000, timeout_ms: 30000 },
    });

    expect(res.status).toBe("completed");
  });
});
