import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import { withTransportRetry } from "@clarvis/llm";
import { ProviderError } from "@clarvis/capability";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("a transient model failure refills the stall watchdog (loop onRetry → clock.poke)", () => {
  it("retries through the transport layer and threads onRetry into every model call", async () => {
    const llm = new MockLLM({
      script: [
        { throw: new ProviderError("overloaded", { kind: "transient", status: 503 }) },
        { text: "done", usage: { input_tokens: 10, output_tokens: 5 } },
      ],
    });
    const retryLlm = withTransportRetry(llm, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 });
    harness = await makeHarness({ llm: retryLlm, mcpFactory: mockMCPFactory({}) });

    const res = await harness.run({
      messages: [{ role: "user", content: "hi" }],
      servers: [],
      entry: "lead",
      profiles: [
        { name: "lead", model: "anthropic/claude-opus-4-5", iteration_limit: 5, tools: [] },
      ],
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    });

    expect((res as unknown as { status: string }).status).toBe("completed");
    expect(llm.calls).toHaveLength(2);
    expect(typeof llm.calls[0]!.onRetry).toBe("function");
    expect(typeof llm.calls[1]!.onRetry).toBe("function");
  });
});
