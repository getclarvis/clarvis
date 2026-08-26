import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import { contentToText } from "@clarvis/capability";
import type { LLMCallParams } from "@clarvis/capability";
import { renderForPrefix } from "../prefix-stability.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const REASONING = "internal deliberation the provider returned but the transcript must never hold";

/**
 * Drive a lead through several iterations, one of which returns reasoning, and
 * hand back every request the provider saw.
 */
async function runLead(): Promise<LLMCallParams[]> {
  const llm = new MockLLM({
    script: [
      {
        reasoning: REASONING,
        reasoningParts: [{ text: REASONING }],
        toolCalls: [{ name: "filesystem.read", arguments: { path: "/a" } }],
      },
      { toolCalls: [{ name: "filesystem.read", arguments: { path: "/b" } }] },
      {
        reasoning: REASONING,
        reasoningParts: [{ text: REASONING }],
        toolCalls: [{ name: "filesystem.read", arguments: { path: "/c" } }],
      },
      { text: "done reading" },
    ],
  });
  const mcp = mockMCPFactory({
    filesystem: {
      tools: [{ name: "read", inputSchema: { type: "object" }, call: () => "contents" }],
    },
  });
  harness = await makeHarness({ llm, mcpFactory: mcp });

  await harness.run({
    messages: [{ role: "user", content: "read a, b and c" }],
    servers: [{ name: "filesystem", transport: "stdio", command: "node", args: ["-e", ""] }],
    entry: "lead",
    profiles: [
      {
        name: "lead",
        model: "anthropic/claude-sonnet-4-5",
        tools: ["filesystem.read"],
        iteration_limit: 10,
      },
    ],
    budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
  });
  return llm.calls;
}

/**
 * Pins the negative result that let the prompt-cache audit attribute its
 * remaining misses instead of guessing: whatever sits ahead of the conversation
 * is bound once and never rebuilt. A single byte moving here invalidates 100% of
 * a provider's prefix cache, so a regression is both invisible and total.
 */
describe("the request head is immutable for the life of a run", () => {
  it("sends byte-identical tool definitions on every iteration", async () => {
    const calls = await runLead();
    expect(calls.length).toBeGreaterThanOrEqual(3);

    const first = JSON.stringify(calls[0]!.tools);
    for (const [i, call] of calls.entries())
      expect(JSON.stringify(call.tools), `request ${i} changed the tool definitions`).toBe(first);
  });

  it("advertises tools in a stable order, not a set/map iteration order", async () => {
    const calls = await runLead();
    const names = calls[0]!.tools.map((t) => t.wireName);
    for (const [i, call] of calls.entries())
      expect(
        call.tools.map((t) => t.wireName),
        `request ${i} reordered the tools`,
      ).toEqual(names);
  });

  it("sends a byte-identical system head on every iteration", async () => {
    const calls = await runLead();

    const head = calls[0]!.messages[0]!;
    expect(head.role).toBe("system");
    for (const [i, call] of calls.entries()) {
      expect(call.messages[0]!.role, `request ${i} lost its system head`).toBe("system");
      expect(contentToText(call.messages[0]!.content), `request ${i} rebuilt the system head`).toBe(
        contentToText(head.content),
      );
    }
  });

  it("interpolates no per-run identity into a tool description", async () => {
    const calls = await runLead();
    const serialized = JSON.stringify(calls[0]!.tools);
    expect(serialized).not.toMatch(/\bexec_[0-9a-f-]{8}/);
    expect(serialized).not.toMatch(/\d{13}/);
  });
});

/**
 * Drive a lead that delegates, so the sub-agent runs several iterations of its
 * own. Lead and sub-agent are told apart by the model they call with.
 */
async function runWithSubagent(): Promise<LLMCallParams[]> {
  const llm = new MockLLM({
    script: [
      { toolCalls: [{ name: "spawn_subagent", arguments: { title: "w", task: "read a and b" } }] },
      { toolCalls: [{ name: "filesystem.read", arguments: { path: "/a" } }] },
      { toolCalls: [{ name: "filesystem.read", arguments: { path: "/b" } }] },
      { text: "both read" },
      { text: "done" },
    ],
  });
  const mcp = mockMCPFactory({
    filesystem: {
      tools: [{ name: "read", inputSchema: { type: "object" }, call: () => "contents" }],
    },
  });
  harness = await makeHarness({ llm, mcpFactory: mcp });

  await harness.run({
    messages: [{ role: "user", content: "read a and b" }],
    servers: [{ name: "filesystem", transport: "stdio", command: "node", args: ["-e", ""] }],
    entry: "lead",
    profiles: [
      {
        name: "lead",
        model: "anthropic/claude-opus-4-5",
        tools: [],
        can_spawn: ["worker"],
        iteration_limit: 10,
      },
      {
        name: "worker",
        model: "anthropic/claude-haiku-4-5",
        tools: ["filesystem.read"],
        iteration_limit: 5,
      },
    ],
    budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
  });
  return llm.calls;
}

/**
 * The other negative result the audit turned up: a sub-agent's conversation is
 * structurally append-only. It gets no stable block and no canonical state —
 * a capability's canonical-state contribution activates only for the run's
 * *entry* agent — so unlike the lead it carries no volatile tail and every
 * request extends the last one verbatim. Worth pinning because the cheapest
 * way to "share context with the lead" would be to hand a spawned agent the
 * same contributions, which would silently import the lead's rewrite cadence.
 */
describe("a sub-agent's conversation grows only at the tail", () => {
  it("extends the previous request verbatim on every iteration", async () => {
    const calls = await runWithSubagent();
    const sub = calls.filter((c) => c.model.includes("haiku"));
    expect(sub.length).toBeGreaterThanOrEqual(3);

    for (let i = 0; i + 1 < sub.length; i += 1) {
      const previous = renderForPrefix(sub[i]!.messages);
      expect(
        renderForPrefix(sub[i + 1]!.messages).startsWith(previous),
        `sub-agent request ${i + 1} did not extend request ${i}`,
      ).toBe(true);
    }
  });

  it("carries no canonical block and no runtime note", async () => {
    const calls = await runWithSubagent();
    for (const call of calls.filter((c) => c.model.includes("haiku")))
      for (const message of call.messages)
        expect(contentToText(message.content)).not.toContain("[runtime:");
  });
});

/**
 * Reasoning continuation state is retained on the assistant turn, but remains
 * separate from its visible content. The provider adapter needs the state to
 * produce a valid continuation while transcript consumers must not render it as
 * ordinary assistant prose.
 */
describe("reasoning continuation state", () => {
  it("replays reasoning structurally without exposing it as message content", async () => {
    const calls = await runLead();
    expect(calls.length).toBeGreaterThanOrEqual(3);

    for (const [i, call] of calls.entries()) {
      for (const message of call.messages)
        expect(
          contentToText(message.content),
          `request ${i} exposed reasoning as prose`,
        ).not.toContain(REASONING);
    }
    const replayed = calls
      .slice(1)
      .flatMap((call) => call.messages)
      .filter((message) => message.role === "assistant" && "reasoning" in message);
    expect(replayed.length).toBeGreaterThan(0);
    expect(
      replayed.some(
        (message) => "reasoning" in message && message.reasoning?.[0]?.text === REASONING,
      ),
    ).toBe(true);
  });
});
