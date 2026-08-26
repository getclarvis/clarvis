import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import type { Elicit } from "../../src/runtime/tools/ask-user-tool.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("stall watchdog: a slow tool and a human wait never trip the deadline", () => {
  it("an ask_user queued behind a slow tool IS reached and the run completes, though both overrun timeout_ms", async () => {
    let elicitCalls = 0;
    const elicit: Elicit = (_params, opts) => {
      elicitCalls += 1;
      return new Promise((resolve) => {
        const sig = opts.signal;
        if (sig?.aborted) {
          resolve({ action: "decline" });
          return;
        }
        const t = setTimeout(() => resolve({ action: "accept", content: { response: "yes" } }), 20);
        sig?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            resolve({ action: "decline" });
          },
          { once: true },
        );
      });
    };

    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            { name: "slow.op", arguments: {} },
            { name: "ask_user", arguments: { question: "continue?" } },
          ],
          usage: { input_tokens: 5, output_tokens: 3, cached_tokens: 0 },
        },
        { text: "done" },
      ],
    });
    const mcp = mockMCPFactory({
      slow: {
        tools: [
          {
            name: "op",
            inputSchema: {},
            call: async () => {
              await delay(300);
              return "ok";
            },
          },
        ],
      },
    });
    harness = await makeHarness({ llm, mcpFactory: mcp, elicit, askUser: true });

    const res = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: [{ name: "slow", transport: "stdio", command: "node", args: ["-e", ""] }],
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-sonnet-4-5",
          tools: ["slow.op"],
          iteration_limit: 10,
          grants: ["ask_user"],
        },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 400_000, timeout_ms: 80 },
    });

    expect(res.status).toBe("completed");
    expect(elicitCalls).toBe(1);

    await delay(50);
  });
});

describe("stall watchdog: a human who declines behind a slow tool", () => {
  it("the elicit's decline branch fires, the decline is delivered to the model, and the run completes", async () => {
    let elicitCalls = 0;
    const elicit: Elicit = (_params, opts) => {
      elicitCalls += 1;
      return new Promise((resolve) => {
        const sig = opts.signal;
        if (sig?.aborted) {
          resolve({ action: "decline" });
          return;
        }
        const t = setTimeout(() => resolve({ action: "decline" }), 20);
        sig?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            resolve({ action: "decline" });
          },
          { once: true },
        );
      });
    };

    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            { name: "slow.op", arguments: {} },
            { name: "ask_user", arguments: { question: "continue?" } },
          ],
          usage: { input_tokens: 5, output_tokens: 3, cached_tokens: 0 },
        },
        { text: "acknowledged; wrapping up" },
      ],
    });
    const mcp = mockMCPFactory({
      slow: {
        tools: [
          {
            name: "op",
            inputSchema: {},
            call: async () => {
              await delay(300);
              return "ok";
            },
          },
        ],
      },
    });
    harness = await makeHarness({ llm, mcpFactory: mcp, elicit, askUser: true });

    const res = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: [{ name: "slow", transport: "stdio", command: "node", args: ["-e", ""] }],
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-sonnet-4-5",
          tools: ["slow.op"],
          iteration_limit: 10,
          grants: ["ask_user"],
        },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 400_000, timeout_ms: 80 },
    });

    expect(res.status).toBe("completed");
    expect(elicitCalls).toBe(1);

    const seen = JSON.stringify(llm.calls.at(-1)!.messages);
    expect(seen.toLowerCase()).toContain("declined");

    await delay(50);
  });
});
