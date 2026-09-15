import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import { contentToText } from "@clarvis/capability";
import type { LiveMessage } from "@clarvis/capability";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

function texts(messages: LiveMessage[]): string[] {
  return messages.map((m) => `${m.role}:${contentToText(m.content)}`);
}

/**
 * A lead agent carries a volatile tail — the tokens_remaining runtime note is
 * spliced out and re-pushed every iteration — so a breakpoint on the last
 * message would be written and never read. These tests pin the property that
 * actually matters: the prefix one request marks is still a prefix of the next.
 */
describe("prompt-cache breakpoints across iterations", () => {
  async function runLead(): Promise<MockLLM> {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            { name: "filesystem.read", arguments: { path: "/a" } },
            { name: "filesystem.read", arguments: { path: "/b" } },
          ],
          usage: { input_tokens: 30, output_tokens: 10, cached_tokens: 0 },
        },
        {
          toolCalls: [{ name: "filesystem.read", arguments: { path: "/c" } }],
          usage: { input_tokens: 40, output_tokens: 10, cached_tokens: 20 },
        },
        {
          text: "done reading",
          usage: { input_tokens: 50, output_tokens: 5, cached_tokens: 40 },
        },
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
          can_spawn: ["worker"],
          iteration_limit: 10,
        },
        {
          name: "worker",
          model: "anthropic/claude-sonnet-4-5",
          tools: ["filesystem.read"],
          iteration_limit: 5,
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
    });
    return llm;
  }

  it("can include runtime notes because all previous notes stay in place", async () => {
    const llm = await runLead();
    expect(llm.calls.length).toBeGreaterThanOrEqual(2);

    for (const call of llm.calls) {
      for (const index of call.cacheBreakpoints ?? []) {
        expect(index).toBeLessThan(call.messages.length);
      }
    }
  });

  // AC1.5 — the criterion that encodes the defect. Before the fix the marked
  // message was the runtime note itself, which the next request had already
  // moved, so no cached prefix could ever be read back.
  it("marks in each request a prefix the next request still carries verbatim", async () => {
    const llm = await runLead();

    for (let i = 0; i + 1 < llm.calls.length; i += 1) {
      const marked = llm.calls[i]!.cacheBreakpoints;
      expect(marked, `request ${i} carried no breakpoint`).toBeDefined();

      const cached = texts(llm.calls[i]!.messages.slice(0, marked!.at(-1)! + 1));
      const next = texts(llm.calls[i + 1]!.messages);
      expect(
        next.slice(0, cached.length),
        `request ${i}'s cached prefix is not a prefix of request ${i + 1}`,
      ).toEqual(cached);
    }
  });

  it("emits at most two message breakpoints, leaving the system block a slot", async () => {
    const llm = await runLead();
    for (const call of llm.calls) {
      expect((call.cacheBreakpoints ?? []).length).toBeLessThanOrEqual(2);
    }
  });

  it("anchors the newest breakpoint at the end of the retained transcript", async () => {
    const llm = await runLead();
    const second = llm.calls[1]!;
    const newest = second.cacheBreakpoints!.at(-1)!;
    expect(newest).toBe(second.messages.length - 1);
  });
});

/**
 * The longer cache lifetime costs roughly twice as much to write, so it is only
 * worth it for a run that can actually pause on a person long enough for a
 * five-minute entry to expire.
 */
describe("prompt-cache TTL reaching the provider", () => {
  async function runSolo(grants: string[]): Promise<MockLLM> {
    const llm = new MockLLM({
      script: [{ text: "done", usage: { input_tokens: 10, output_tokens: 2, cached_tokens: 0 } }],
    });
    harness = await makeHarness({
      llm,
      mcpFactory: mockMCPFactory({}),
      elicit: async () => ({ action: "decline" }),
    });

    await harness.run({
      messages: [{ role: "user", content: "hello" }],
      servers: [],
      entry: "solo",
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-sonnet-4-5",
          tools: [],
          iteration_limit: 5,
          ...(grants.length > 0 ? { grants } : {}),
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 10000, timeout_ms: 30000 },
    });
    return llm;
  }

  it("uses the cheap 5m lifetime for a run that cannot park on a human", async () => {
    const llm = await runSolo([]);
    expect(llm.calls[0]!.promptCacheTtl).toBe("5m");
  });

  it("uses 1h once an ask_user grant lets the run block mid-conversation", async () => {
    const llm = await runSolo(["ask_user"]);
    expect(llm.calls[0]!.promptCacheTtl).toBe("1h");
  });
});
