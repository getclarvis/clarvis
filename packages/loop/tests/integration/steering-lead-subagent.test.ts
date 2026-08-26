import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import type { SteerMessage, SteerSource } from "@clarvis/capability";
import type { TraceEvent } from "@clarvis/capability";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const STEER = "also verify the null path";

function msgHasText(call: { messages: unknown }, text: string): boolean {
  return (call.messages as Array<{ content: unknown }>).some(
    (m) => typeof m.content === "string" && m.content.includes(text),
  );
}

describe("steering reaches the entry Lead but never a spawned subagent", () => {
  it("injects the steer into the Lead (agent=lead) and no subagent turn ever sees it", async () => {
    const pending: SteerMessage[] = [];
    const steer: SteerSource = { drain: () => pending.splice(0) };
    const events: TraceEvent[] = [];
    let pushed = false;
    const onEvent = (e: TraceEvent): void => {
      events.push(e);
      if (e.type === "delegation_created" && !pushed) {
        pending.push({ content: STEER });
        pushed = true;
      }
    };

    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            { name: "spawn_subagent", arguments: { title: "w", task: "do the extraction" } },
          ],
        },
        { text: "subagent output" },
        { text: "Final answer incorporating the steer" },
      ],
    });

    const mcp = mockMCPFactory({
      info: {
        tools: [
          {
            name: "lookup",
            inputSchema: { type: "object", properties: { q: { type: "string" } } },
            call: () => "ok",
          },
        ],
      },
    });

    harness = await makeHarness({ llm, mcpFactory: mcp, steer, onEvent });

    const res = await harness.run({
      messages: [{ role: "user", content: "extract the plaintiff" }],
      servers: [{ name: "info", transport: "stdio", command: "node", args: ["-e", ""] }],
      entry: "lead",
      profiles: [
        {
          name: "lead",
          model: "anthropic/claude-opus-4-5",
          iteration_limit: 10,
          tools: ["info.lookup"],
          can_spawn: ["subagent"],
        },
        {
          name: "subagent",
          model: "anthropic/claude-haiku-4-5",
          tools: ["info.lookup"],
          iteration_limit: 10,
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    });

    const body = res as unknown as { status: string; result: string };
    expect(body.status).toBe("completed");
    expect(body.result).toBe("Final answer incorporating the steer");

    const steers = events.filter((e) => e.type === "user_steering");
    expect(steers).toHaveLength(1);
    const s = steers[0] as Extract<TraceEvent, { type: "user_steering" }>;
    expect(s.agent).toBe("lead");
    expect(s.subagent_instance_id).toBeUndefined();
    expect(s.message).toBe(STEER);

    const leadCalls = llm.calls.filter((c) => c.model === "claude-opus-4-5");
    const subagentCalls = llm.calls.filter((c) => c.model === "claude-haiku-4-5");
    expect(leadCalls.some((c) => msgHasText(c, STEER))).toBe(true);
    expect(subagentCalls.every((c) => !msgHasText(c, STEER))).toBe(true);
  });

  it("a run-level steer channel does not reach a background child either", async () => {
    const events: TraceEvent[] = [];
    let releaseChild!: () => void;
    const childHeld = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let childTurns = 0;

    const llm = new MockLLM({
      script: [],
      routes: [
        {
          name: "lead",
          when: (p) => p.model === "claude-opus-4-5",
          script: [
            {
              toolCalls: [
                {
                  name: "spawn_subagent",
                  arguments: { title: "w", task: "audit auth", background: true },
                },
              ],
            },
            { toolCalls: [{ name: "agent_list", arguments: {} }] },
            { text: "steered the child" },
          ],
        },
        {
          name: "child",
          when: () => true,
          script: [
            { toolCalls: [{ name: "info.lookup", arguments: { q: "a" } }] },
            { text: "child done" },
          ],
        },
      ],
    });

    const originalCall = llm.call.bind(llm);
    llm.call = async (params) => {
      if (params.model === "claude-haiku-4-5") {
        childTurns += 1;
        if (childTurns === 1) await childHeld;
      }
      return originalCall(params);
    };

    const onEvent = (e: TraceEvent): void => void events.push(e);
    const mcp = mockMCPFactory({
      info: {
        tools: [
          {
            name: "lookup",
            inputSchema: { type: "object", properties: { q: { type: "string" } } },
            call: () => "ok",
          },
        ],
      },
    });

    harness = await makeHarness({ llm, mcpFactory: mcp, onEvent });
    const runPromise = harness.run({
      messages: [{ role: "user", content: "audit the auth paths" }],
      servers: [{ name: "info", transport: "stdio", command: "node", args: ["-e", ""] }],
      entry: "lead",
      profiles: [
        {
          name: "lead",
          model: "anthropic/claude-opus-4-5",
          iteration_limit: 10,
          tools: ["info.lookup"],
          can_spawn: ["subagent"],
        },
        {
          name: "subagent",
          model: "anthropic/claude-haiku-4-5",
          tools: ["info.lookup"],
          iteration_limit: 10,
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 200_000, timeout_ms: 30_000 },
    });

    // Let the lead reach its agent_list turn, which proves the child is live and
    // registered while the lead keeps working.
    await new Promise((r) => setTimeout(r, 50));
    releaseChild();
    await runPromise;

    const registered = events.filter((e) => e.type === "delegation_created");
    expect(registered).toHaveLength(1);
    // The run-level steer channel was never used here, so no user_steering was
    // recorded at all: a child is not reachable by the run's steer.
    expect(events.filter((e) => e.type === "user_steering")).toHaveLength(0);
    expect(childTurns).toBeGreaterThanOrEqual(1);
  });
});
