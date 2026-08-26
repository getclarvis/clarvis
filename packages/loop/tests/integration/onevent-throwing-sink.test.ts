import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import type { TraceEvent } from "@clarvis/capability";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const SOLO = {
  messages: [{ role: "user", content: "go" }],
  servers: [] as unknown[],
  entry: "solo",
  profiles: [{ name: "solo", model: "anthropic/claude-opus-4-5", tools: [], iteration_limit: 3 }],
  budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
};

describe("a throwing onEvent sink does not corrupt the run (finding 15)", () => {
  it("a sink that throws on run_ended still completes and persists", async () => {
    const seen: string[] = [];
    const onEvent = (e: TraceEvent): void => {
      seen.push(e.type);
      if (e.type === "run_ended") throw new Error("sink closed");
    };
    const llm = new MockLLM({
      script: [{ text: "done", usage: { input_tokens: 10, output_tokens: 5 } }],
    });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}), onEvent });

    const res = await harness.run(SOLO);
    expect(res.status).toBe("completed");
    expect(seen).toContain("run_ended");

    const detail = await harness.getRun(res.execution_id);
    expect(detail?.status).toBe("completed");
  });

  it("a sink that throws on every event still completes and persists", async () => {
    let calls = 0;
    const onEvent = (): void => {
      calls += 1;
      throw new Error("boom");
    };
    const llm = new MockLLM({
      script: [{ text: "done", usage: { input_tokens: 10, output_tokens: 5 } }],
    });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}), onEvent });

    const res = await harness.run(SOLO);
    expect(res.status).toBe("completed");
    expect(calls).toBeGreaterThan(0);

    const detail = await harness.getRun(res.execution_id);
    expect(detail?.status).toBe("completed");
  });
});
