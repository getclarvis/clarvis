import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

interface Ev {
  type: string;
  status?: string;
  result?: string;
}
interface Envelope {
  status: string;
  execution_id: string;
  error?: { code: string };
}

const tools = [
  {
    name: "docs",
    transport: "stdio" as const,
    command: "node",
    args: ["-e", ""],
  },
];
const lead = {
  name: "lead",
  model: "anthropic/x",
  iteration_limit: 30,
  tools: [] as string[],
  can_spawn: ["poller"],
};
const SPAWN = {
  name: "spawn_subagent",
  arguments: { title: "poll", profile: "poller", task: "poll the source repeatedly" },
};
const SEARCH = { name: "docs.search", arguments: { q: "same" } };

const mcp = (counter: { n: number }) =>
  mockMCPFactory({
    docs: {
      tools: [
        {
          name: "search",
          inputSchema: { type: "object", properties: { q: { type: "string" } } },
          call: () => {
            counter.n += 1;
            return "identical result";
          },
        },
      ],
    },
  });

const body = (poller: Record<string, unknown>) => ({
  messages: [{ role: "user", content: "poll it" }],
  servers: tools,
  profiles: [lead, poller],
  entry: "lead",
  budget: { on_exceed: "stop", total_token_limit: 200000, timeout_ms: 30000 },
});

const events = (env: Envelope): Ev[] =>
  (h!.traceStore.getById("test", env.execution_id)!.trace.events as unknown as Ev[]) ?? [];
const subagentCompleted = (ev: Ev[]): Ev | undefined =>
  ev.find((e) => e.type === "delegation_completed" || e.type === "delegation_failed");

describe("spawned subagent honors its per-profile stagnation_threshold (finding 9)", () => {
  it("stagnation_threshold: 0 on the spawned profile disables the guard (identical results are allowed)", async () => {
    const counter = { n: 0 };
    const llm = new MockLLM({
      script: [
        { toolCalls: [SPAWN] },
        { toolCalls: [SEARCH] },
        { toolCalls: [SEARCH] },
        { toolCalls: [SEARCH] },
        { toolCalls: [SEARCH] },
        { text: "polled — all identical, nothing changed" },
        { text: "subagent finished; wrapping up" },
      ],
    });
    h = await makeHarness({ llm, mcpFactory: mcp(counter) });

    const env = (await h.run(
      body({
        name: "poller",
        model: "anthropic/x",
        tools: ["docs.search"],
        iteration_limit: 10,
        stagnation_threshold: 0,
      }),
    )) as unknown as Envelope;

    expect(env.status).toBe("completed");
    expect(counter.n).toBe(4);
    const wc = subagentCompleted(events(env));
    expect(wc?.status).toBe("completed");
    expect(wc?.result ?? "").not.toContain("stagnation_detected");
  });

  it("stagnation_threshold: 2 on the spawned profile trips earlier than the built-in default of 3", async () => {
    const counter = { n: 0 };
    const llm = new MockLLM({
      script: [
        { toolCalls: [SPAWN] },
        { toolCalls: [SEARCH] },
        { toolCalls: [SEARCH] },
        { toolCalls: [SEARCH] },
        { text: "subagent error observed; wrapping up" },
      ],
    });
    h = await makeHarness({ llm, mcpFactory: mcp(counter) });

    const env = (await h.run(
      body({
        name: "poller",
        model: "anthropic/x",
        tools: ["docs.search"],
        iteration_limit: 10,
        stagnation_threshold: 2,
      }),
    )) as unknown as Envelope;

    expect(env.status).toBe("completed");
    expect(counter.n).toBe(2);
    const wc = subagentCompleted(events(env));
    expect(wc?.status).toBe("error");
    expect(wc?.result ?? "").toContain("stagnation_detected");
  });

  it("CLARVIS_DEFAULT_STAGNATION_THRESHOLD=0 disables the guard for spawned subagents too", async () => {
    const counter = { n: 0 };
    const llm = new MockLLM({
      script: [
        { toolCalls: [SPAWN] },
        { toolCalls: [SEARCH] },
        { toolCalls: [SEARCH] },
        { toolCalls: [SEARCH] },
        { toolCalls: [SEARCH] },
        { text: "polled — all identical" },
        { text: "subagent finished; wrapping up" },
      ],
    });
    h = await makeHarness({
      llm,
      mcpFactory: mcp(counter),
      env: { CLARVIS_DEFAULT_STAGNATION_THRESHOLD: "0" },
    });

    const env = (await h.run(
      body({
        name: "poller",
        model: "anthropic/x",
        tools: ["docs.search"],
        iteration_limit: 10,
      }),
    )) as unknown as Envelope;

    expect(env.status).toBe("completed");
    expect(counter.n).toBe(4);
    const wc = subagentCompleted(events(env));
    expect(wc?.status).toBe("completed");
    expect(wc?.result ?? "").not.toContain("stagnation_detected");
  });
});
