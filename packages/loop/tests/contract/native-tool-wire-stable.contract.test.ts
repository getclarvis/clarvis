import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "../integration/_fixtures.ts";
import { makeHarness, TEST_PROVIDERS, type TestHarness } from "../integration/_helpers.ts";
import { validateBody } from "../../src/validation/index.ts";
import { loadEnv } from "@clarvis/capability";

const env = loadEnv({});

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("wire run contract is unchanged", () => {
  const continuitySeed = {
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "First, what is 2+2?" },
      { role: "assistant", content: "4." },
      { role: "user", content: "Now greet me." },
    ],
    servers: [],
    profiles: [
      { name: "solo", model: "anthropic/claude-haiku-4-5", tools: [], iteration_limit: 3 },
    ],
    entry: "solo",
    budget: { on_exceed: "stop", total_token_limit: 1000, timeout_ms: 30000 },
    providers: TEST_PROVIDERS,
  };

  it("a text-only request with a multi-turn continuity seed still validates", () => {
    expect(() => validateBody(continuitySeed, env)).not.toThrow();
  });

  it("the same request runs to completion (no tool turns required of the caller)", async () => {
    const llm = new MockLLM({ script: [{ text: "Hello!" }] });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const res = await harness.run(continuitySeed);
    expect((res as { status: string }).status).toBe("completed");
    expect((res as { result?: unknown }).result).toBe("Hello!");

    const firstCall = llm.calls[0]!.messages;
    expect(
      firstCall.every((m) => m.role === "system" || m.role === "user" || m.role === "assistant"),
    ).toBe(true);
    expect(firstCall.some((m) => m.role === "tool")).toBe(false);
  });

  it("rejects a caller-sent tool-role message (the wire role enum is still system|user|assistant)", () => {
    const withToolTurn = {
      ...continuitySeed,
      messages: [...continuitySeed.messages, { role: "tool", content: "callers cannot send this" }],
    };
    expect(() => validateBody(withToolTurn, env)).toThrow();
  });
});
