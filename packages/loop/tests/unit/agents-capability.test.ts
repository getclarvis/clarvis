import { afterEach, beforeEach, describe, it, expect, vi } from "../bun-test.ts";
import {
  createAgentsRunCapability,
  AGENT_LIST_TOOL,
  AGENT_POLL_TOOL,
  AGENT_STEER_TOOL,
  AGENT_STOP_TOOL,
  AWAIT_AGENTS_TOOL,
  AGENTS_UNFINISHED_CODE,
} from "../../src/runtime/capabilities/agents.ts";
import { fakeAgentBuildContext, fakeAgentScope } from "../../src/runtime/capabilities/testing.ts";
import { createAgentRegistry, type AgentRegistry, type AgentsLimits } from "@clarvis/supervision";
import type { HandlerVerdict } from "../../src/runtime/loop/loop-contract.ts";
import type { FakeAgentBuildContext } from "../../src/runtime/capabilities/testing.ts";
import type { AgentLoopContribution } from "@clarvis/capability";
import type { AgentRegistration } from "@clarvis/capability";

const LIMITS: AgentsLimits = {
  bufferLines: 100,
  bufferBytes: 32_768,
  maxTotalBufferBytes: 524_288,
  pollMaxBytes: 4096,
  awaitTimeoutMs: 50,
  maxLiveChildren: 8,
  maxRetainedChildren: 8,
  maxNoticesPerIteration: 4,
  maxConsecutiveFailedChildren: 3,
  finishNudges: 2,
};

function registration(nativeId: string): AgentRegistration {
  return {
    kind: "subagent",
    nativeId,
    title: `task ${nativeId}`,
    control: { stop: () => {}, steer: () => true },
  };
}

interface Attached {
  registry: AgentRegistry;
  bc: FakeAgentBuildContext;
  contribution: AgentLoopContribution;
  call: (name: string, args?: Record<string, unknown>) => Promise<HandlerVerdict>;
  body: (verdict: HandlerVerdict) => string;
}

function attach(over: Partial<AgentsLimits> = {}): Attached {
  const limits = { ...LIMITS, ...over };
  const registry = createAgentRegistry({ limits });
  const bc = fakeAgentBuildContext({ agent: "lead" });
  const capability = createAgentsRunCapability(
    registry,
    limits.awaitTimeoutMs,
    limits.finishNudges,
  );
  const agentCapability = capability.forAgent(fakeAgentScope({ agent: "lead", entry: true }))!;
  const contribution = agentCapability.attach(bc);
  return {
    registry,
    bc,
    contribution,
    call: (name, args = {}) =>
      contribution.handlers![0]!.handle({ id: "c1", name, arguments: args }, 1),
    body: (verdict) => (verdict as { text: string }).text,
  };
}

describe("agents capability — activation", () => {
  it("advertises all five tools to an entry agent", () => {
    const { contribution } = attach();
    expect(contribution.advertised).toBe(true);
    expect(contribution.tools!.map((t) => t.wireName)).toEqual([
      AGENT_LIST_TOOL,
      AGENT_POLL_TOOL,
      AGENT_STOP_TOOL,
      AGENT_STEER_TOOL,
      AWAIT_AGENTS_TOOL,
    ]);
  });

  it("distinguishes a wait wake from completion or cancellation", () => {
    const { contribution } = attach();
    const wait = contribution.tools!.find((tool) => tool.wireName === AWAIT_AGENTS_TOOL)!;
    expect(wait.description).toContain("inspect woke_on and still_running");
    expect(wait.description).toContain("Timeout leaves children running");
  });

  it("does not attach to a spawned sub-agent — that is what scopes a parent to its own children", () => {
    const registry = createAgentRegistry({ limits: LIMITS });
    const capability = createAgentsRunCapability(registry, 50, 2);
    expect(capability.forAgent(fakeAgentScope({ entry: false }))).toBeNull();
  });
});

describe("agents capability — the tools", () => {
  it("matches every supervision tool and rejects a non-supervision name", () => {
    const { contribution } = attach();
    const handler = contribution.handlers![0]!;
    expect(handler.matches({ id: "c", name: AGENT_LIST_TOOL, arguments: {} })).toBeTrue();
    expect(handler.matches({ id: "c", name: "unrelated", arguments: {} })).toBeFalse();
  });

  it("agent_list reports the caller's children", async () => {
    const { registry, call, body } = attach();
    registry.register(registration("n1"));
    const text = body(await call(AGENT_LIST_TOOL));
    expect(text).toContain("ag_");
    expect(text).toContain("task n1");
  });

  it("an unknown id is a plain result, never a terminal or a throw — and reads as an error", async () => {
    const { call } = attach();
    for (const name of [AGENT_POLL_TOOL, AGENT_STOP_TOOL, AGENT_STEER_TOOL]) {
      const verdict = await call(name, { id: "ag_deadbeef", reason: "r", message: "m" });
      expect(verdict.kind).toBe("result");
      const text = (verdict as { text: string }).text;
      expect(text).toContain("unknown agent_id");
      expect(text).toContain("result (error):");
    }
  });

  it("a missing required argument reads as an error, not a successful result", async () => {
    const { call } = attach();
    for (const [name, args] of [
      [AGENT_POLL_TOOL, {}],
      [AGENT_STOP_TOOL, {}],
      [AGENT_STEER_TOOL, {}],
      [AGENT_STEER_TOOL, { id: "ag_deadbeef" }],
    ] as const) {
      const verdict = await call(name, args);
      expect(verdict.kind).toBe("result");
      expect((verdict as { text: string }).text).toContain("result (error):");
    }
  });

  it("agent_poll refuses a malformed regex instead of failing the call — and reads as an error", async () => {
    const { registry, call, body } = attach();
    const handle = registry.register(registration("n1"))!;
    const text = body(await call(AGENT_POLL_TOOL, { id: handle.id, match: "([" }));
    expect(text).toContain("invalid 'match' regex");
    expect(text).toContain("result (error):");
  });

  it("agent_poll returns buffered output and tolerates a non-object argument payload", async () => {
    const { registry, contribution, call, body } = attach();
    const handle = registry.register(registration("n1"))!;
    expect(body(await call(AGENT_POLL_TOOL, { id: handle.id }))).toContain(handle.id);

    const malformed = await contribution.handlers![0]!.handle(
      { id: "c2", name: AGENT_POLL_TOOL, arguments: "not-an-object" },
      1,
    );
    expect(body(malformed)).toContain("'id' is required");
  });

  it("agent_stop records the kill in the trace and hands back the tail", async () => {
    const { registry, bc, call, body } = attach();
    const handle = registry.register(registration("n1"))!;
    const text = body(await call(AGENT_STOP_TOOL, { id: handle.id, reason: "off the rails" }));
    expect(text).toContain('"already_settled":false');
    const recorded = bc.trace.entries().filter((e) => e.kind === "agent_stopped");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.detail).toMatchObject({ agent_id: handle.id, reason: "off the rails" });
  });

  it("agent_steer to a settled child is refused as a result and recorded as undelivered — not an error, the id was valid", async () => {
    const { registry, bc, call, body } = attach();
    const handle = registry.register(registration("n1"))!;
    handle.settled({ status: "completed", result: "done" });
    const verdict = await call(AGENT_STEER_TOOL, { id: handle.id, message: "try again" });
    expect(verdict.kind).toBe("result");
    const text = body(verdict);
    expect(text).toContain("already settled");
    expect(text).not.toContain("(error)");
    expect(bc.trace.entries().find((e) => e.kind === "agent_steered")!.detail).toMatchObject({
      delivered: false,
    });
  });

  it("agent_steer delivers to a live child and records progress", async () => {
    const delivered: unknown[] = [];
    const { registry, bc, call, body } = attach();
    const handle = registry.register({
      ...registration("n1"),
      control: {
        stop: () => {},
        steer: (message) => {
          delivered.push(message);
          return true;
        },
      },
    })!;

    const verdict = await call(AGENT_STEER_TOOL, { id: handle.id, message: "focus" });
    expect(body(verdict)).toContain("delivered to");
    expect((verdict as { progress: boolean }).progress).toBeTrue();
    expect(delivered).toHaveLength(1);
    expect(
      bc.trace.entries().find((entry) => entry.kind === "agent_steered")?.detail,
    ).toMatchObject({ delivered: true });
  });

  it("every supervision verdict is an immediate result — never a deferred", async () => {
    const { registry, call } = attach();
    registry.register(registration("n1"));
    for (const name of [AGENT_LIST_TOOL, AWAIT_AGENTS_TOOL]) {
      expect((await call(name)).kind).toBe("result");
    }
  });
});

describe("agents capability — await_agents", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns immediately with woke_on 'none' when there is nothing to wait for", async () => {
    const { call, body } = attach();
    expect(body(await call(AWAIT_AGENTS_TOOL))).toContain('"woke_on":"none"');
  });

  it("returns an unknown-id error immediately instead of waiting for the timeout", async () => {
    const { call, body } = attach({ awaitTimeoutMs: 2000 });
    const verdict = await call(AWAIT_AGENTS_TOOL, { ids: ["agent_missing"] });
    expect(body(verdict)).toContain("unknown agent_id");
  });

  it("filters non-string ids before validating the requested wait scope", async () => {
    const { registry, call, body } = attach({ awaitTimeoutMs: 20 });
    const handle = registry.register(registration("n1"))!;
    const pending = call(AWAIT_AGENTS_TOOL, { ids: [false, handle.id], timeout_ms: 20 });
    handle.settled({ status: "completed", result: "done" });
    expect(body(await pending)).toContain('"woke_on":"agent_done"');
  });

  it("wakes on the first child to settle and counts that as progress", async () => {
    const { registry, call, body } = attach({ awaitTimeoutMs: 2000 });
    const handle = registry.register(registration("n1"))!;
    const pending = call(AWAIT_AGENTS_TOOL);
    handle.settled({ status: "completed", result: "landed" });
    const verdict = await pending;
    expect(body(verdict)).toContain('"woke_on":"agent_done"');
    expect(body(verdict)).toContain("landed");
    expect((verdict as { progress: boolean }).progress).toBe(true);
  });

  it("wakes on the timeout without claiming progress", async () => {
    const { registry, call, body } = attach({ awaitTimeoutMs: 20 });
    registry.register(registration("n1"));
    const pending = call(AWAIT_AGENTS_TOOL);
    await vi.advanceTimersByTimeAsync(20);
    const verdict = await pending;
    expect(body(verdict)).toContain('"woke_on":"timeout"');
    expect((verdict as { progress: boolean }).progress).toBe(false);
  });

  it("wakes on a queued user steer, without consuming it", async () => {
    const limits = { ...LIMITS, awaitTimeoutMs: 3000 };
    const registry = createAgentRegistry({ limits });
    let probed = 0;
    const bc = fakeAgentBuildContext({
      agent: "lead",
      steerProbe: () => {
        probed += 1;
        return probed > 1;
      },
    });
    const contribution = createAgentsRunCapability(registry, limits.awaitTimeoutMs, 2)
      .forAgent(fakeAgentScope({ agent: "lead", entry: true }))!
      .attach(bc);
    registry.register(registration("n1"));
    const pending = contribution.handlers![0]!.handle(
      { id: "c1", name: AWAIT_AGENTS_TOOL, arguments: {} },
      1,
    );
    await vi.advanceTimersByTimeAsync(500);
    const verdict = await pending;
    expect((verdict as { text: string }).text).toContain('"woke_on":"steer"');
    expect((verdict as { progress: boolean }).progress).toBe(false);
  });

  it("wakes on cancellation and resumes the run clock", async () => {
    const limits = { ...LIMITS, awaitTimeoutMs: 3000 };
    const registry = createAgentRegistry({ limits });
    const controller = new AbortController();
    let paused = 0;
    let resumed = 0;
    const bc = fakeAgentBuildContext({
      agent: "lead",
      signal: controller.signal,
      clock: {
        race: async (promise) => promise,
        pause: () => {
          paused += 1;
        },
        resume: () => {
          resumed += 1;
        },
        enter: () => {},
        leave: () => {},
        pauseCompute: () => () => {},
        enterBackground: () => ({ pause: () => () => {}, leave: () => {} }),
        poke: () => {},
      },
    });
    const contribution = createAgentsRunCapability(registry, limits.awaitTimeoutMs, 2)
      .forAgent(fakeAgentScope({ agent: "lead", entry: true }))!
      .attach(bc);
    registry.register(registration("n1"));

    const pending = contribution.handlers![0]!.handle(
      { id: "c1", name: AWAIT_AGENTS_TOOL, arguments: {} },
      1,
    );
    controller.abort();
    const verdict = await pending;

    expect((verdict as { text: string }).text).toContain('"woke_on":"cancelled"');
    expect((verdict as { progress: boolean }).progress).toBe(false);
    expect(paused).toBe(1);
    expect(resumed).toBe(1);
  });

  it("maps an unexpected registry wait rejection to a timeout result", async () => {
    let disposed = false;
    const registry = {
      has: () => true,
      liveIds: () => ["ag_test"],
      waitAny: () => ({
        promise: Promise.reject(new Error("wait failed")),
        dispose: () => {
          disposed = true;
        },
      }),
    } as unknown as AgentRegistry;
    const bc = fakeAgentBuildContext({ agent: "lead" });
    const contribution = createAgentsRunCapability(registry, 1000, 2)
      .forAgent(fakeAgentScope({ agent: "lead", entry: true }))!
      .attach(bc);

    const verdict = await contribution.handlers![0]!.handle(
      { id: "c1", name: AWAIT_AGENTS_TOOL, arguments: { ids: ["ag_test"] } },
      1,
    );

    expect((verdict as { text: string }).text).toContain('"woke_on":"timeout"');
    expect(disposed).toBeTrue();
  });
});

describe("agents capability — notices and progress", () => {
  it("a settled child's result reaches the model at the next iteration, without a poll", async () => {
    const { registry, bc, contribution } = attach();
    const handle = registry.register(registration("n1"))!;
    await handle.settled({ status: "completed", result: "the auth paths are clean" });

    await contribution.hooks!.beforeIteration!();
    const notes = bc.ctx.messages
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(notes).toContain("[agents]");
    expect(notes).toContain("the auth paths are clean");
    expect(contribution.hooks!.contributesProgress!()).toBe(true);
  });

  it("a failed child's notice does not count as progress", async () => {
    const { registry, contribution } = attach();
    const handle = registry.register(registration("n1"))!;
    await handle.settled({ status: "failed", result: "boom" });
    await contribution.hooks!.beforeIteration!();
    expect(contribution.hooks!.contributesProgress!()).toBe(false);
  });

  it("an iteration with no notices claims no progress", async () => {
    const { contribution } = attach();
    await contribution.hooks!.beforeIteration!();
    expect(contribution.hooks!.contributesProgress!()).toBe(false);
  });
});

describe("agents capability — the finish gate (D10)", () => {
  it("fastAcceptOk is true with no live children, and false with one", () => {
    const { registry, contribution } = attach();
    const gate = contribution.gates![0]!;
    expect(gate.fastAcceptOk!()).toBe(true);
    registry.register(registration("n1"));
    expect(gate.fastAcceptOk!()).toBe(false);
  });

  it("nudges rather than accepting a finish on top of a live child", async () => {
    const { registry, bc, contribution } = attach();
    registry.register(registration("n1"));
    const outcome = await contribution.gates![0]!.check({ mode: "text", text: "done" });
    expect(outcome.kind).toBe("nudge");
    expect((outcome as { note: string }).note).toContain("await_agents");
    expect(bc.trace.entries().find((e) => e.kind === "agent_finish_nudge")!.detail).toMatchObject({
      outcome: "nudged",
      nudge_index: 1,
    });
  });

  it("terminates with its own reason once the nudge budget is spent, cancelling survivors", async () => {
    const { registry, bc, contribution } = attach({ finishNudges: 1 });
    const stops: string[] = [];
    registry.register({
      ...registration("n1"),
      control: { stop: (r) => stops.push(r), steer: () => true },
    });
    const gate = contribution.gates![0]!;

    expect((await gate.check({ mode: "text" })).kind).toBe("nudge");
    const terminal = await gate.check({ mode: "text" });
    expect(terminal.kind).toBe("terminal");
    expect((terminal as { result: { error?: { code: string } } }).result.error!.code).toBe(
      AGENTS_UNFINISHED_CODE,
    );
    expect(stops).toHaveLength(1);
    expect(registry.sealed()).toBe(true);
    expect(bc.trace.entries().some((e) => e.kind === "terminate")).toBe(true);
  });

  it("a child settling between nudges resets the streak rather than counting toward the cap", async () => {
    const { registry, contribution } = attach({ finishNudges: 1 });
    const a = registry.register(registration("n1"))!;
    registry.register(registration("n2"));
    const gate = contribution.gates![0]!;

    expect((await gate.check({ mode: "text" })).kind).toBe("nudge");
    a.settled({ status: "completed", result: "done" });
    expect((await gate.check({ mode: "text" })).kind).toBe("nudge");
  });

  it("terminates on the first check when the nudge budget is zero, rather than skipping the gate", async () => {
    const { registry, bc, contribution } = attach({ finishNudges: 0 });
    const stops: string[] = [];
    registry.register({
      ...registration("n1"),
      control: { stop: (r) => stops.push(r), steer: () => true },
    });
    const gate = contribution.gates![0]!;

    const terminal = await gate.check({ mode: "text" });
    expect(terminal.kind).toBe("terminal");
    expect((terminal as { result: { error?: { code: string } } }).result.error!.code).toBe(
      AGENTS_UNFINISHED_CODE,
    );
    expect(stops).toHaveLength(1);
    expect(registry.sealed()).toBe(true);
    expect(bc.trace.entries().some((e) => e.kind === "terminate")).toBe(true);
  });
});

describe("agents capability — teardown warnings", () => {
  function attachWithWarnings(): {
    registry: AgentRegistry;
    contribution: AgentLoopContribution;
    warnings: string[];
  } {
    const warnings: string[] = [];
    const registry = createAgentRegistry({ limits: LIMITS });
    const bc = fakeAgentBuildContext({ agent: "lead", warnings });
    const contribution = createAgentsRunCapability(
      registry,
      LIMITS.awaitTimeoutMs,
      LIMITS.finishNudges,
    )
      .forAgent(fakeAgentScope({ agent: "lead", entry: true }))!
      .attach(bc);
    return { registry, contribution, warnings };
  }

  it("reports abandoned children as a warning instead of discarding the teardown report", async () => {
    const { registry, contribution, warnings } = attachWithWarnings();
    registry.register(registration("n1"));
    await contribution.hooks!.onTeardown!();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("1 child agent(s) abandoned");
  });

  it("reports undrained steers as a warning, independent of whether the child is still live", async () => {
    const { registry, contribution, warnings } = attachWithWarnings();
    const handle = registry.register({
      ...registration("n1"),
      control: { stop: () => {}, steer: () => true, undrained: () => 2 },
    })!;
    handle.settled({ status: "completed", result: "done" });
    await contribution.hooks!.onTeardown!();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("2 steer message(s)");
  });

  it("pushes no warnings when teardown has nothing to report", async () => {
    const { contribution, warnings } = attachWithWarnings();
    await contribution.hooks!.onTeardown!();
    expect(warnings).toHaveLength(0);
  });
});
