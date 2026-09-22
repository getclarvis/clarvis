import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import type { TraceEvent } from "@clarvis/capability";
import { isBuiltinTraceEvent } from "@clarvis/capability";

/**
 * The 512-iteration decision, at the real boundary rather than a scaled stand-in.
 *
 * @remarks Both counters get a case at the shipped value: a spawned child's own
 *   attempt counter and the entry agent's. What is being proved is not the number
 *   but its *reach* — a child that reaches its own cap hands a partial back and the
 *   lead keeps its run, while the entry agent's cap ends that attempt and no 513th
 *   iteration is ever started. Fixtures with smaller caps cover the wider matrix in
 *   `subagent-iteration-hard-cap-escalate.test.ts`; keeping one honest case at 512
 *   is what proves the shipped default is actually reachable and hard.
 */
const CHILD_MODEL = "anthropic/claude-haiku-4-5";
const LEAD_MODEL = "anthropic/claude-opus-4-5";
const LIMIT = 512;

/** One search call per iteration, each with its own arguments so nothing repeats. */
function searching(index: number): {
  toolCalls: Array<{ name: string; arguments: unknown }>;
  usage: { input_tokens: number; output_tokens: number };
} {
  return {
    toolCalls: [{ name: "docs.search", arguments: { probe: index } }],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

const DOCS = {
  docs: { tools: [{ name: "search", inputSchema: {}, call: () => "nothing conclusive" }] },
};

const SERVERS = [{ name: "docs", transport: "stdio", command: "node", args: ["-e", ""] }];

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("a spawned Subagent's own 512-iteration cap", () => {
  it("returns a partial the Lead survives, and never starts a 513th iteration", async () => {
    const started: number[] = [];
    const llm = new MockLLM({
      script: [],
      routes: [
        {
          name: "lead",
          when: (params) => params.model === "claude-opus-4-5",
          script: [
            {
              toolCalls: [
                { name: "spawn_subagent", arguments: { title: "w", task: "deep search" } },
              ],
              usage: { input_tokens: 20, output_tokens: 10 },
            },
            { text: "Best effort from the Lead.", usage: { input_tokens: 10, output_tokens: 4 } },
          ],
        },
        {
          name: "child",
          when: (params) => params.model === "claude-haiku-4-5",
          script: Array.from({ length: LIMIT + 1 }, (_, index) => searching(index)),
        },
      ],
    });
    harness = await makeHarness({
      llm,
      mcpFactory: mockMCPFactory(DOCS),
      onEvent: (event: TraceEvent) => {
        if (isBuiltinTraceEvent(event) && event.type === "subagent_iteration_started")
          started.push(event.iteration);
      },
    });

    const res = await harness.run({
      messages: [{ role: "user", content: "extract name" }],
      servers: SERVERS,
      entry: "lead",
      profiles: [
        {
          name: "lead",
          model: LEAD_MODEL,
          tools: [],
          can_spawn: ["subagent"],
          iteration_limit: 10,
        },
        { name: "subagent", model: CHILD_MODEL, tools: ["docs.search"], iteration_limit: LIMIT },
      ],
      budget: { on_exceed: "stop", total_token_limit: 500_000, timeout_ms: 60_000 },
    });

    expect(res.status).toBe("completed");
    expect(started).toHaveLength(LIMIT);
    expect(Math.max(...started)).toBe(LIMIT);

    const childCalls = llm.calls.filter((call) => call.model === "claude-haiku-4-5");
    expect(childCalls).toHaveLength(LIMIT);
    const leadSaw = JSON.stringify(
      llm.calls.filter((call) => call.model === "claude-opus-4-5").at(-1)!.messages,
    );
    expect(leadSaw).toContain("stopped at its own iteration limit");
    expect(leadSaw).toContain(`${LIMIT} iterations`);
  });
});

describe("the entry agent's 512-iteration cap under on_exceed='stop'", () => {
  it("stops at 512 and never starts a 513th iteration", async () => {
    const started: number[] = [];
    const llm = new MockLLM({
      script: Array.from({ length: LIMIT + 1 }, (_, index) => searching(index)),
    });
    harness = await makeHarness({
      llm,
      mcpFactory: mockMCPFactory(DOCS),
      onEvent: (event: TraceEvent) => {
        if (isBuiltinTraceEvent(event) && event.type === "lead_iteration_started")
          started.push(event.iteration);
      },
    });

    const res = await harness.run({
      messages: [{ role: "user", content: "extract name" }],
      servers: SERVERS,
      entry: "lead",
      profiles: [
        {
          name: "lead",
          model: LEAD_MODEL,
          tools: ["docs.search"],
          can_spawn: ["subagent"],
          iteration_limit: LIMIT,
        },
        { name: "subagent", model: CHILD_MODEL, tools: [], iteration_limit: LIMIT },
      ],
      budget: { on_exceed: "stop", total_token_limit: 500_000, timeout_ms: 60_000 },
    });

    expect(llm.calls).toHaveLength(LIMIT);
    expect(res.status).toBe("budget_exhausted");
    expect(started).toHaveLength(LIMIT);
    expect(Math.max(...started)).toBe(LIMIT);
  });
});
