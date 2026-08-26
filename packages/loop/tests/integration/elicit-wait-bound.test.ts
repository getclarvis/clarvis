import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import type { Elicit } from "../../src/runtime/tools/ask-user-tool.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("engine-enforced elicit wait bound", () => {
  it("a non-conforming elicit (never settles, ignores signal and timeoutMs) cannot hang the run", async () => {
    const elicit: Elicit = () => new Promise(() => {});
    const llm = new MockLLM({
      script: [
        { toolCalls: [{ name: "ask_user", arguments: { question: "continue?" } }] },
        { text: "proceeded without the human" },
      ],
    });
    harness = await makeHarness({
      llm,
      mcpFactory: mockMCPFactory({}),
      elicit,
      askUser: true,
    });

    const res = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: [],
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-sonnet-4-5",
          tools: [],
          iteration_limit: 5,
          grants: ["ask_user"],
        },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 10000, timeout_ms: 30000 },
      elicit_wait_ms: 100,
    });

    expect(res.status).toBe("completed");
    const askResult = llm.calls[1]!.messages.map((m) => JSON.stringify(m.content)).join("\n");
    expect(askResult).toContain("did not respond within the wait window");
  });
});
