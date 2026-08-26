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

const STEER = "drop the second angle, focus on auth";

function msgHasText(call: { messages: unknown }, text: string): boolean {
  return (call.messages as Array<{ content: unknown }>).some(
    (m) => typeof m.content === "string" && m.content.includes(text),
  );
}

/**
 * The regression test for the defect the whole supervision surface exists to
 * remove: a lead that spawns children used to park inside `runDispatch` until
 * the slowest one returned, so `drainSteer` never fired and the user's message
 * sat in the kernel's queue for the length of the entire fan-out.
 *
 * The assertion is deliberately about *ordering*, not elapsed time: the steer
 * must be drained into the lead's context while its children are demonstrably
 * still running. Any future change that reintroduces an awaited spawn fails
 * here, loudly, whatever the machine's speed.
 */
describe("a lead with background children stays reachable while they run", () => {
  it("drains a steer within one iteration, with both children still in flight", async () => {
    const pending: SteerMessage[] = [];
    const steer: SteerSource = { drain: () => pending.splice(0) };
    const events: TraceEvent[] = [];

    let releaseChildren!: () => void;
    const childrenHeld = new Promise<void>((resolve) => {
      releaseChildren = resolve;
    });
    let childrenStarted = 0;
    let steerSeenByLead = false;

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
                  id: "s1",
                  name: "spawn_subagent",
                  arguments: { title: "a", task: "audit auth", background: true },
                },
                {
                  id: "s2",
                  name: "spawn_subagent",
                  arguments: { title: "b", task: "audit sessions", background: true },
                },
              ],
            },
            { text: "acknowledged; waiting on the children" },
          ],
        },
        {
          name: "children",
          when: () => true,
          script: [{ text: "child one done" }, { text: "child two done" }],
        },
      ],
    });

    const originalCall = llm.call.bind(llm);
    llm.call = async (params) => {
      if (params.model === "claude-haiku-4-5") {
        childrenStarted += 1;
        await childrenHeld;
      }
      if (params.model === "claude-opus-4-5" && msgHasText(params, STEER)) {
        steerSeenByLead = true;
        expect(childrenStarted).toBe(2);
      }
      return originalCall(params);
    };

    const onEvent = (e: TraceEvent): void => {
      events.push(e);
      if (e.type === "delegation_created" && pending.length === 0) {
        pending.push({ content: STEER });
      }
    };

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

    // The lead takes its second turn — and drains the steer — while both
    // children are parked. Only then are they released.
    await waitFor(() => steerSeenByLead, 5000);
    releaseChildren();
    await runPromise;

    const steers = events.filter((e) => e.type === "user_steering");
    expect(steers).toHaveLength(1);
    const recorded = steers[0] as Extract<TraceEvent, { type: "user_steering" }>;
    expect(recorded.agent).toBe("lead");
    expect(recorded.subagent_instance_id).toBeUndefined();
    expect(recorded.message).toBe(STEER);
  });
});

/** Poll until `ready` or throw — the children are held, so a hang here means the
 * lead never got its next turn, which is precisely the defect. */
async function waitFor(ready: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error(
        "the lead never took another turn while its children ran — an awaited spawn is back",
      );
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}
