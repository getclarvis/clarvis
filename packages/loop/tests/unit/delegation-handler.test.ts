import { describe, it, expect } from "../bun-test.ts";
import { buildDelegationContribution, type DelegationDeps } from "../../src/runtime/delegation.ts";
import type { FakeAgentBuildContext } from "../../src/runtime/capabilities/testing.ts";
import type { AgentResult } from "../../src/runtime/loop/loop-shared.ts";
import { resolveSubagentProfiles } from "../../src/runtime/subagents/subagent-profiles.ts";
import { createTokenLedger, createIterationCounter } from "../../src/runtime/budget/index.ts";
import { createSemaphore } from "../../src/runtime/support/concurrency.ts";
import { createAgentRegistry, type AgentsLimits } from "@clarvis/supervision";
import { createTrace } from "@clarvis/trace";
import { loadEnv } from "@clarvis/capability";
import type { LLMProvider, LLMToolCall } from "@clarvis/capability";
import type { SpawnGatePort } from "@clarvis/capability";

const env = loadEnv({});

const AGENTS_TEST_LIMITS: AgentsLimits = {
  bufferLines: 100,
  bufferBytes: 32_768,
  maxTotalBufferBytes: 524_288,
  pollMaxBytes: 4096,
  maxLiveChildren: 8,
  maxRetainedChildren: 8,
  maxNoticesPerIteration: 4,
  maxConsecutiveFailedChildren: 3,
  finishNudges: 2,
};

function makeDeps(
  over: Partial<Omit<DelegationDeps, "bc">> = {},
  bcOver: { signal?: AbortSignal; maybeCancelled?: () => AgentResult | null } = {},
): Omit<DelegationDeps, "bc"> & { bc: FakeAgentBuildContext } {
  const trace = createTrace();
  const ledger = createTokenLedger(1_000_000);
  const bc = {
    ctx: { setStableBlock: () => {}, setCanonicalState: () => {} } as unknown,
    state: { lastAssistantText: "" },
    trace,
    budget: {
      ledger,
      counter: createIterationCounter(50),
      usage: { input: 0, output: 0, cached: 0 },
    },
    maybeCancelled: bcOver.maybeCancelled ?? (() => null),
    ...(bcOver.signal !== undefined ? { signal: bcOver.signal } : {}),
  } as unknown as FakeAgentBuildContext;
  const profiles = resolveSubagentProfiles(
    [{ name: "subagent", model: "anthropic/x", base_prompt: "go", tools: [] }],
    [{ name: "anthropic", kind: "anthropic" }],
    env,
  );
  return {
    bc,
    env,
    opened: [],
    profiles,
    iterationLimitDefault: 10,
    llm: {} as unknown as LLMProvider,
    ledger,
    subagentAggByModel: new Map(),
    semaphore: createSemaphore(1),
    ...over,
  };
}

function fakeSpawnGate(over: Partial<SpawnGatePort> = {}): SpawnGatePort {
  return { beforeSpawn: async () => ({ kind: "ok" }), ...over };
}

const AGENT_STOP_CONTROL = { stop: () => {}, steer: () => false, undrained: () => 0 };

const spawnCall = (id: string, args: Record<string, unknown> = {}): LLMToolCall =>
  ({
    id,
    name: "spawn_subagent",
    arguments: { title: "w", task: "do x", ...args },
  }) as unknown as LLMToolCall;

describe("child-spawn handler resilience (finding 4)", () => {
  it("advertises independent spawning without a tracker and owns no gates or anchor", () => {
    const contribution = buildDelegationContribution(makeDeps());
    expect(contribution.tools?.map((tool) => tool.wireName)).toEqual(["spawn_subagent"]);
    expect(contribution.gates).toBeUndefined();
    expect(contribution.anchor).toBeUndefined();
  });

  it("a throw while preparing the spawn returns a recoverable error, not an unhandled exception", async () => {
    const deps = makeDeps({
      capabilitiesFor: () => {
        throw new Error("factory boom");
      },
    });
    const contribution = buildDelegationContribution(deps);
    const call = spawnCall("tc1");
    const handler = contribution.handlers!.find((h) => h.matches(call))!;

    const verdict = await handler.handle(call, 0);

    expect(verdict.kind).toBe("result");
    if (verdict.kind === "result") {
      expect(verdict.text).toContain("spawn_subagent error: factory boom");
      expect(verdict.progress).toBe(false);
    }
  });

  it("a clean prepare still defers to run the Subagent (no false error)", async () => {
    const deps = makeDeps();
    const contribution = buildDelegationContribution(deps);
    const call = spawnCall("tc2");
    const handler = contribution.handlers!.find((h) => h.matches(call))!;

    const verdict = await handler.handle(call, 0);
    expect(verdict.kind).toBe("deferred");
  });

  it("background: true answers with a handle immediately, even with the semaphore saturated", async () => {
    const registry = createAgentRegistry({ limits: AGENTS_TEST_LIMITS });
    const semaphore = createSemaphore(1);
    await semaphore.acquire();
    const deps = makeDeps({ agents: registry, semaphore });
    const contribution = buildDelegationContribution(deps);
    const call = spawnCall("tc3", { background: true });
    const handler = contribution.handlers!.find((h) => h.matches(call))!;

    const verdict = await handler.handle(call, 0);

    expect(verdict.kind).toBe("result");
    if (verdict.kind === "result") {
      expect(verdict.text).toMatch(/started ag_[0-9a-f]{8} in the background/);
      expect(verdict.progress).toBe(true);
    }
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]!.kind).toBe("subagent");
    expect(deps.bc.trace.entries().some((e) => e.kind === "agent_registered")).toBe(true);
  });

  it("background: true without a registry falls back to the inline path rather than failing", async () => {
    const deps = makeDeps();
    const contribution = buildDelegationContribution(deps);
    const call = spawnCall("tc4", { background: true });
    const handler = contribution.handlers!.find((h) => h.matches(call))!;

    expect((await handler.handle(call, 0)).kind).toBe("deferred");
  });

  it("refuses a background spawn past the live-children ceiling, as a plain result", async () => {
    const registry = createAgentRegistry({
      limits: { ...AGENTS_TEST_LIMITS, maxLiveChildren: 1 },
    });
    const deps = makeDeps({ agents: registry });
    const contribution = buildDelegationContribution(deps);
    const handler = contribution.handlers!.find((h) => h.matches(spawnCall("a")))!;

    await handler.handle(spawnCall("a", { background: true }), 0);
    const second = await handler.handle(spawnCall("b", { background: true }), 0);

    expect(second.kind).toBe("result");
    if (second.kind === "result") {
      expect(second.text).toContain("too many child agents");
      expect(second.progress).toBe(false);
    }
    expect(registry.list()).toHaveLength(1);
  });

  it("spawn_subagent with an unknown profile is a plain rejection, not an unhandled error", async () => {
    const deps = makeDeps();
    const contribution = buildDelegationContribution(deps);
    const call = spawnCall("bad-profile", { profile: "nope" });
    const handler = contribution.handlers!.find((h) => h.matches(call))!;

    const verdict = await handler.handle(call, 0);

    expect(verdict.kind).toBe("result");
    if (verdict.kind === "result") {
      expect(verdict.text).toContain("unknown profile 'nope'");
      expect(verdict.progress).toBe(false);
    }
  });

  it("closes child admission with a plain refusal once children keep failing consecutively", async () => {
    const registry = createAgentRegistry({
      limits: { ...AGENTS_TEST_LIMITS, maxConsecutiveFailedChildren: 1 },
    });
    const seed = registry.register({
      kind: "subagent",
      nativeId: "seed",
      title: "seed",
      control: AGENT_STOP_CONTROL,
    })!;
    seed.settled({ status: "failed", result: "boom" });

    const deps = makeDeps({ agents: registry });
    const contribution = buildDelegationContribution(deps);
    const call = spawnCall("bg-fail", { background: true });
    const handler = contribution.handlers!.find((h) => h.matches(call))!;

    const verdict = await handler.handle(call, 0);

    expect(verdict.kind).toBe("result");
    if (verdict.kind === "result") {
      expect(verdict.text).toContain("not spawned");
      expect(verdict.text).toContain("agent_poll");
      expect(verdict.progress).toBe(false);
    }
  });

  it("resets the circuit when an admitted child finishes successfully", async () => {
    const registry = createAgentRegistry({
      limits: { ...AGENTS_TEST_LIMITS, maxConsecutiveFailedChildren: 2 },
    });
    const settle = (nativeId: string, status: "failed" | "completed"): void => {
      registry
        .register({
          kind: "subagent",
          nativeId,
          title: nativeId,
          control: AGENT_STOP_CONTROL,
        })!
        .settled({ status });
    };
    settle("a", "failed");
    settle("b", "failed");
    expect(registry.failingStreakExceeded()).toBe(true);

    settle("c", "completed");
    expect(registry.failingStreakExceeded()).toBe(false);

    const deps = makeDeps({ agents: registry });
    const contribution = buildDelegationContribution(deps);
    const call = spawnCall("bg-after-success", { background: true });
    const handler = contribution.handlers!.find((h) => h.matches(call))!;
    const verdict = await handler.handle(call, 0);

    expect(verdict.kind).toBe("result");
    if (verdict.kind === "result") expect(verdict.text).toContain("started");
  });

  it("admits at most one background recovery probe while the failed circuit remains closed", async () => {
    let now = 0;
    const registry = createAgentRegistry({
      limits: { ...AGENTS_TEST_LIMITS, maxConsecutiveFailedChildren: 1 },
      now: () => now,
    });
    registry
      .register({
        kind: "subagent",
        nativeId: "failed",
        title: "failed",
        control: AGENT_STOP_CONTROL,
      })!
      .settled({ status: "failed" });
    const deps = makeDeps({ agents: registry });
    const contribution = buildDelegationContribution(deps);
    const call = spawnCall("probe", { background: true });
    const handler = contribution.handlers!.find((item) => item.matches(call))!;
    now = 30_000;
    const [one, two] = await Promise.all([
      handler.handle(call, 0),
      handler.handle(spawnCall("second", { background: true }), 0),
    ]);
    expect(one.kind).toBe("result");
    expect(two.kind).toBe("result");
    if (one.kind === "result") expect(one.text).toContain("started");
    if (two.kind === "result") expect(two.text).toContain("not spawned");
    expect(deps.bc.trace.entries().some((entry) => entry.kind === "terminate")).toBe(false);
    await registry.teardown(0);
  });

  it("leaves the streak untouched for a child that was cancelled or stopped at a limit", async () => {
    const registry = createAgentRegistry({
      limits: { ...AGENTS_TEST_LIMITS, maxConsecutiveFailedChildren: 1 },
    });
    for (const status of ["limited", "cancelled", "stopped"] as const) {
      registry
        .register({
          kind: "subagent",
          nativeId: status,
          title: status,
          control: AGENT_STOP_CONTROL,
        })!
        .settled({ status });
    }
    expect(registry.consecutiveFailures()).toBe(0);
    expect(registry.failingStreakExceeded()).toBe(false);
  });

  it("a sub-agent run that throws still closes its delegation span in the persisted trace", async () => {
    const deps = makeDeps();
    const contribution = buildDelegationContribution(deps);
    const call = spawnCall("inline-run-throws");
    const handler = contribution.handlers!.find((h) => h.matches(call))!;

    const verdict = await handler.handle(call, 0);
    if (verdict.kind !== "deferred") throw new Error("unreachable");
    await verdict.run(undefined);

    const kinds = deps.bc.trace.entries().map((e) => e.kind);
    expect(kinds).toContain("delegation_created");
    expect(kinds).toContain("delegation_failed");
    const failed = deps.bc.trace.entries().find((e) => e.kind === "delegation_failed")!;
    const created = deps.bc.trace.entries().find((e) => e.kind === "delegation_created")!;
    expect((failed.detail as { delegation_id: string }).delegation_id).toBe(
      (created.detail as { delegation_id: string }).delegation_id,
    );
    expect((failed.detail as { status: string }).status).toBe("error");
  });

  it("an inline deferred spawn whose sub-agent run throws outside its own catch surfaces as a Sub-agent error result", async () => {
    let calls = 0;
    const deps = makeDeps({
      emitCapabilityEvent: () => {
        calls += 1;
        if (calls === 2) throw new Error("emit boom 2");
      },
    });
    const contribution = buildDelegationContribution(deps);
    const call = spawnCall("inline-throw");
    const handler = contribution.handlers!.find((h) => h.matches(call))!;

    const verdict = await handler.handle(call, 0);
    expect(verdict.kind).toBe("deferred");
    if (verdict.kind !== "deferred") throw new Error("unreachable");
    const result = await verdict.run(undefined);
    expect(result.text).toBe("Tool 'spawn_subagent' result: Sub-agent error: emit boom 2");
    expect(result.progress).toBe(false);
  });

  it("an inline deferred spawn aborted before it settles reports cancellation, not the raw error", async () => {
    let calls = 0;
    const deps = makeDeps({
      emitCapabilityEvent: () => {
        calls += 1;
        if (calls === 2) throw new Error("emit boom 3");
      },
    });
    const contribution = buildDelegationContribution(deps);
    const call = spawnCall("inline-throw-abort");
    const handler = contribution.handlers!.find((h) => h.matches(call))!;

    const verdict = await handler.handle(call, 0);
    if (verdict.kind !== "deferred") throw new Error("unreachable");
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const result = await verdict.run(controller.signal);
    expect(result.text).toBe("Tool 'spawn_subagent' result: Sub-agent cancelled.");
    expect(result.progress).toBe(false);
  });
});

/** The optional spawn gate can refuse a child before preparation. */
describe("spawn gate for independent children", () => {
  it("with no spawn gate configured, only spawn_subagent is advertised", async () => {
    const deps = makeDeps();
    const contribution = buildDelegationContribution(deps);
    expect(contribution.tools?.map((tool) => tool.wireName)).toEqual(["spawn_subagent"]);

    const call = spawnCall("no-gate");
    const handler = contribution.handlers!.find((h) => h.matches(call))!;
    expect((await handler.handle(call, 0)).kind).toBe("deferred");
  });

  it("a refuse verdict from beforeSpawn answers the call with its text and spawns nothing", async () => {
    const spawnGate = fakeSpawnGate({
      beforeSpawn: async () => ({ kind: "refuse", text: "not now" }),
    });
    const deps = makeDeps({ spawnGate });
    const contribution = buildDelegationContribution(deps);
    const call = spawnCall("refused");
    const handler = contribution.handlers!.find((h) => h.matches(call))!;

    const verdict = await handler.handle(call, 0);

    expect(verdict.kind).toBe("result");
    if (verdict.kind === "result") {
      expect(verdict.text).toBe("Tool 'spawn_subagent' result: not now");
      expect(verdict.progress).toBe(false);
    }
    expect(deps.bc.trace.entries().some((e) => e.kind === "delegation_created")).toBe(false);
  });

  it("a terminal verdict from beforeSpawn ends the agent with the gate's own result", async () => {
    const terminalResult: AgentResult = {
      status: "error",
      partialText: "",
      error: { code: "no_progress", message: "gate says stop" },
    };
    const spawnGate = fakeSpawnGate({
      beforeSpawn: async () => ({ kind: "terminal", result: terminalResult }),
    });
    const deps = makeDeps({ spawnGate });
    const contribution = buildDelegationContribution(deps);
    const call = spawnCall("terminal");
    const handler = contribution.handlers!.find((h) => h.matches(call))!;

    const verdict = await handler.handle(call, 0);

    expect(verdict.kind).toBe("terminal");
    if (verdict.kind === "terminal") expect(verdict.result).toBe(terminalResult);
  });
});
