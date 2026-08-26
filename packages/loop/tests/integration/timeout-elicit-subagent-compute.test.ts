import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import type { Elicit } from "../../src/runtime/tools/ask-user-tool.ts";

let h: TestHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("stall watchdog is not a compute cap: a spawned Subagent at work never trips it", () => {
  it("[spawn_subagent(slow), ask_user] completes even though the Subagent's tool time dwarfs timeout_ms", async () => {
    let elicitCalls = 0;
    const elicit: Elicit = (_params, opts) =>
      new Promise((resolve) => {
        elicitCalls += 1;
        const sig = opts.signal;
        if (sig?.aborted) {
          resolve({ action: "decline" });
          return;
        }
        const t = setTimeout(() => resolve({ action: "accept", content: { response: "go" } }), 20);
        sig?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            resolve({ action: "decline" });
          },
          { once: true },
        );
      });

    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            {
              name: "spawn_subagent",
              arguments: { title: "w", profile: "subagent", task: "slow work" },
            },
            { name: "ask_user", arguments: { question: "proceed?" } },
          ],
          usage: { input_tokens: 5, output_tokens: 3, cached_tokens: 0 },
        },
        { toolCalls: [{ name: "slow.op", arguments: {} }] },
        { text: "subagent done" },
        { toolCalls: [{ name: "submit_result", arguments: { status: "shipped" } }] },
      ],
    });
    const mcp = mockMCPFactory({
      slow: {
        tools: [
          {
            name: "op",
            inputSchema: {},
            call: async () => {
              await delay(600);
              return "ok";
            },
          },
        ],
      },
    });
    h = await makeHarness({ llm, mcpFactory: mcp, elicit, askUser: true });

    const res = await h.run({
      messages: [{ role: "user", content: "go" }],
      servers: [{ name: "slow", transport: "stdio", command: "node", args: ["-e", ""] }],
      profiles: [
        {
          name: "lead",
          model: "anthropic/x",
          tools: [],
          iteration_limit: 10,
          can_spawn: ["subagent"],
          grants: ["ask_user"],
        },
        { name: "subagent", model: "anthropic/x", tools: ["slow.op"], iteration_limit: 10 },
      ],
      entry: "lead",
      budget: { on_exceed: "stop", total_token_limit: 400_000, timeout_ms: 200 },
      output_schema: {
        type: "object",
        additionalProperties: false,
        properties: { status: { type: "string" } },
        required: ["status"],
      },
    });

    expect(res.status).toBe("completed");
    expect(elicitCalls).toBe(1);

    await delay(50);
  });
});
