import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import type { Elicit } from "../../src/runtime/tools/ask-user-tool.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const mcp = () => mockMCPFactory({});
const noopElicit: Elicit = async () => ({ action: "accept", content: { response: "ok" } });

const offersAskUser = (call: { tools: { wireName: string }[] }): boolean =>
  call.tools.some((t) => t.wireName === "ask_user");

describe("ask_user tool injection is gated on the ask_user grant, not on user-input capability", () => {
  it("an escalate-budget entry agent without the ask_user grant is NOT offered ask_user", async () => {
    const llm = new MockLLM({ script: [{ text: "Done." }] });
    harness = await makeHarness({
      llm,
      mcpFactory: mcp(),
      elicit: noopElicit,
      askUser: true,
    });

    const res = await harness.run({
      messages: [{ role: "user", content: "Do it" }],
      servers: [],
      profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 5 }],
      entry: "solo",
      budget: { on_exceed: "escalate", total_token_limit: 100000 },
    });

    expect((res as { status: string }).status).toBe("completed");
    expect(llm.calls.length).toBeGreaterThan(0);
    expect(offersAskUser(llm.calls[0]!)).toBe(false);
  });

  it("an entry agent WITH the ask_user grant is offered ask_user", async () => {
    const llm = new MockLLM({ script: [{ text: "Done." }] });
    harness = await makeHarness({
      llm,
      mcpFactory: mcp(),
      elicit: noopElicit,
      askUser: true,
    });

    const res = await harness.run({
      messages: [{ role: "user", content: "Do it" }],
      servers: [],
      profiles: [
        { name: "solo", model: "anthropic/x", tools: [], iteration_limit: 5, grants: ["ask_user"] },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000 },
    });

    expect((res as { status: string }).status).toBe("completed");
    expect(offersAskUser(llm.calls[0]!)).toBe(true);
  });
});

/**
 * A sub-agent never receives `ask_user`, whatever grants it is given.
 *
 * @remarks Two independent gates say so, and only one of them was covered.
 * `forRun` refuses when the *entry* agent lacks the grant — which the tests
 * above pin — and `forAgent` refuses again for any non-entry scope, which is
 * what stops a child inheriting the channel. The second gate is the load-bearing
 * one: an elicit is a question to the human at the terminal, and a sub-agent
 * that could ask one would block a run nobody is watching, from a prompt the
 * user never sees attributed to work they did not start.
 *
 * The nearest existing cover is a *static warning* about a sub-agent profile
 * declaring the grant, which is a different mechanism and would keep passing if
 * the entry check were deleted.
 */
describe("ask_user never reaches a sub-agent", () => {
  const LEAD_AND_CHILD = {
    messages: [{ role: "user", content: "Delegate it" }],
    servers: [],
    entry: "lead",
    budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
  };

  it("is offered to the granting lead and withheld from the child it spawns", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [{ name: "spawn_subagent", arguments: { title: "w", task: "look it up" } }],
          usage: { input_tokens: 50, output_tokens: 20 },
        },
        { text: "child answer", usage: { input_tokens: 40, output_tokens: 15 } },
        { text: "Done.", usage: { input_tokens: 30, output_tokens: 10 } },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: mcp(), elicit: noopElicit, askUser: true });

    const res = await harness.run({
      ...LEAD_AND_CHILD,
      profiles: [
        {
          name: "lead",
          model: "anthropic/x",
          tools: [],
          iteration_limit: 5,
          grants: ["ask_user"],
          can_spawn: ["child"],
        },
        { name: "child", model: "anthropic/x", tools: [], iteration_limit: 5 },
      ],
    });

    expect((res as { status: string }).status).toBe("completed");
    expect(offersAskUser(llm.calls[0]!)).toBe(true);
    expect(offersAskUser(llm.calls[1]!)).toBe(false);
  });

  it("withholds it from a child that declares the grant for itself", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [{ name: "spawn_subagent", arguments: { title: "w", task: "look it up" } }],
          usage: { input_tokens: 50, output_tokens: 20 },
        },
        { text: "child answer", usage: { input_tokens: 40, output_tokens: 15 } },
        { text: "Done.", usage: { input_tokens: 30, output_tokens: 10 } },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: mcp(), elicit: noopElicit, askUser: true });

    await harness.run({
      ...LEAD_AND_CHILD,
      profiles: [
        {
          name: "lead",
          model: "anthropic/x",
          tools: [],
          iteration_limit: 5,
          grants: ["ask_user"],
          can_spawn: ["child"],
        },
        {
          name: "child",
          model: "anthropic/x",
          tools: [],
          iteration_limit: 5,
          grants: ["ask_user"],
        },
      ],
    });

    expect(offersAskUser(llm.calls[1]!)).toBe(false);
  });
});
