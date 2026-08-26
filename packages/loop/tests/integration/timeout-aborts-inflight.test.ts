import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("timeout aborts in-flight work", () => {
  it("stalls out on a hung model call and the Subagent stops calling the model after the run returns", async () => {
    const llm = new MockLLM({ script: [{ text: "…working…", delayMs: 5_000 }] });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const res = await harness.run({
      messages: [{ role: "user", content: "loop" }],
      servers: [],
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-sonnet-4-5",
          tools: [],
          iteration_limit: 100,
        },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 400_000, timeout_ms: 120 },
    });

    expect(res.status).toBe("error");
    expect((res as { error?: { code?: string } }).error?.code).toBe("timeout");

    const callsAtReturn = llm.calls.length;
    await delay(700);
    expect(llm.calls.length).toBeLessThanOrEqual(callsAtReturn + 1);
  });
});
