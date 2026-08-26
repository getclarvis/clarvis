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
import type { TaskTrackingPort } from "@clarvis/capability";

const env = loadEnv({});

const AGENTS_TEST_LIMITS: AgentsLimits = {
  bufferLines: 100,
  bufferBytes: 32_768,
  maxTotalBufferBytes: 524_288,
  pollMaxBytes: 4096,
  awaitTimeoutMs: 1000,
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

/**
 * A hand-rolled fake `TaskTrackingPort`, standing in for whatever capability
 * tracks a run's work items. `delegate_task`'s handler consumes only the
 * port's shape, and every case below would read the same against a tracker
 * over, say, a list of GitHub issues.
 */
function fakeTracker(over: Partial<TaskTrackingPort> = {}): TaskTrackingPort {
  return {
    openTasks: () => [],
    getTask: () => undefined,
    markSpawned: () => true,
    markFailed: () => true,
    beforeSpawn: async () => ({ kind: "ok" }),
    noteSpawned: () => {},
    augmentDelegateTask: () => ({
      description: "tracked spawn",
      properties: { task_id: { type: "string" } },
    }),
    ...over,
  };
}

const AGENT_STOP_CONTROL = { stop: () => {}, steer: () => false, undrained: () => 0 };

const delegateCall = (id: string, args: Record<string, unknown> = {}): LLMToolCall =>
  ({
    id,
    name: "delegate_task",
    arguments: { title: "w", task: "do x", ...args },
  }) as unknown as LLMToolCall;

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

  it("terminates the run once background children keep failing consecutively", async () => {
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

    expect(verdict.kind).toBe("terminal");
    if (verdict.kind === "terminal") {
      expect(verdict.result.status).toBe("error");
      expect(verdict.result.error?.code).toBe("background_children_failing");
    }
    expect(
      deps.bc.trace
        .entries()
        .some(
          (e) =>
            e.kind === "terminate" &&
            (e.detail as { reason?: string }).reason === "background_children_failing",
        ),
    ).toBe(true);
  });

  it("a background spawn queued behind a saturated semaphore settles as stopped when its combined signal was already aborted", async () => {
    const registry = createAgentRegistry({ limits: AGENTS_TEST_LIMITS });
    const semaphore = createSemaphore(1);
    await semaphore.acquire();
    const controller = new AbortController();
    controller.abort(new Error("bc stop"));
    const deps = makeDeps({ agents: registry, semaphore }, { signal: controller.signal });
    const contribution = buildDelegationContribution(deps);
    const call = spawnCall("bg-abort", { background: true });
    const handler = contribution.handlers!.find((h) => h.matches(call))!;
    const wait = registry.waitAny();

    const verdict = await handler.handle(call, 0);
    expect(verdict.kind).toBe("result");

    const info = await wait.promise;
    expect(info.status).toBe("stopped");
    expect(info.result).toBe("cancelled before it finished");
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

  it("a background spawn whose sub-agent run throws outside its own catch settles as failed, not silently lost", async () => {
    const registry = createAgentRegistry({ limits: AGENTS_TEST_LIMITS });
    let calls = 0;
    const deps = makeDeps({
      agents: registry,
      emitCapabilityEvent: () => {
        calls += 1;
        if (calls === 2) throw new Error("emit boom");
      },
    });
    const contribution = buildDelegationContribution(deps);
    const call = spawnCall("bg-throw", { background: true });
    const handler = contribution.handlers!.find((h) => h.matches(call))!;
    const wait = registry.waitAny();

    const verdict = await handler.handle(call, 0);
    expect(verdict.kind).toBe("result");

    const info = await wait.promise;
    expect(info.status).toBe("failed");
    expect(info.result).toBe("emit boom");
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

/**
 * The pre-spawn ruling, the batch bookkeeping and the schema augmentation all
 * arrive through the optional {@link TaskTrackingPort} — `delegation.ts`'s own
 * TSDoc calls `tasks` "the only coupling to a tracker". These pin that seam
 * directly, with a tracker that has nothing to do with any particular feature.
 */
describe("delegate_task handler — the TaskTrackingPort seam", () => {
  it("with no tracker configured, only spawn_subagent is advertised", async () => {
    const deps = makeDeps();
    const contribution = buildDelegationContribution(deps);
    expect(contribution.tools?.map((tool) => tool.wireName)).toEqual(["spawn_subagent"]);

    const call = spawnCall("no-tracker");
    const handler = contribution.handlers!.find((h) => h.matches(call))!;
    expect((await handler.handle(call, 0)).kind).toBe("deferred");
    expect(contribution.handlers!.some((h) => h.matches(delegateCall("unavailable")))).toBe(false);
  });

  it("a refuse verdict from beforeSpawn answers the call with its text and spawns nothing", async () => {
    const tasks = fakeTracker({ beforeSpawn: async () => ({ kind: "refuse", text: "not now" }) });
    const deps = makeDeps({ tasks });
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

  it("a terminal verdict from beforeSpawn ends the agent with the tracker's own result", async () => {
    const terminalResult: AgentResult = {
      status: "error",
      partialText: "",
      error: { code: "no_progress", message: "tracker says stop" },
    };
    const tasks = fakeTracker({
      beforeSpawn: async () => ({ kind: "terminal", result: terminalResult }),
    });
    const deps = makeDeps({ tasks });
    const contribution = buildDelegationContribution(deps);
    const call = spawnCall("terminal");
    const handler = contribution.handlers!.find((h) => h.matches(call))!;

    const verdict = await handler.handle(call, 0);

    expect(verdict.kind).toBe("terminal");
    if (verdict.kind === "terminal") expect(verdict.result).toBe(terminalResult);
  });

  it("an ok verdict lets the spawn proceed, and noteSpawned fires with the resolved task_id", async () => {
    const noted: string[] = [];
    const tasks = fakeTracker({
      openTasks: () => [{ id: "t1", status: "pending" }],
      getTask: (id) => (id === "t1" ? { id: "t1", title: "T", status: "pending" } : undefined),
      noteSpawned: (id) => noted.push(id),
    });
    const deps = makeDeps({ tasks });
    const contribution = buildDelegationContribution(deps);
    const call = delegateCall("ok-verdict", { task_id: "t1" });
    const handler = contribution.handlers!.find((h) => h.matches(call))!;

    const verdict = await handler.handle(call, 0);

    expect(verdict.kind).toBe("deferred");
    expect(noted).toEqual(["t1"]);
  });

  it("delegate_task rejects a missing task_id and points independent work to spawn_subagent", async () => {
    const noted: string[] = [];
    const tasks = fakeTracker({ noteSpawned: (id) => noted.push(id) });
    const deps = makeDeps({ tasks });
    const contribution = buildDelegationContribution(deps);
    const call = delegateCall("no-task-id");
    const handler = contribution.handlers!.find((h) => h.matches(call))!;

    const verdict = await handler.handle(call, 0);
    expect(verdict.kind).toBe("result");
    if (verdict.kind === "result") {
      expect(verdict.text).toContain("task_id is required");
      expect(verdict.text).toContain("Use spawn_subagent for independent work");
    }
    expect(noted).toEqual([]);
  });

  it("spawn_subagent ignores a surplus task_id and never associates it with the tracker", async () => {
    const seenBeforeSpawn: Array<string | undefined> = [];
    const noted: string[] = [];
    const tasks = fakeTracker({
      beforeSpawn: async (taskId) => {
        seenBeforeSpawn.push(taskId);
        return { kind: "ok" };
      },
      noteSpawned: (id) => noted.push(id),
    });
    const contribution = buildDelegationContribution(makeDeps({ tasks }));
    const call = spawnCall("surplus-task-id", { task_id: "independent" });
    const handler = contribution.handlers!.find((h) => h.matches(call))!;

    expect((await handler.handle(call, 0)).kind).toBe("deferred");
    expect(seenBeforeSpawn).toEqual([undefined]);
    expect(noted).toEqual([]);
  });

  it("advertises tolerant, separate schemas when a tracker is present", () => {
    const tasks = fakeTracker({
      augmentDelegateTask: () => ({
        description: "Spawn a Sub-agent against a tracked task.",
        properties: { task_id: { type: "string" } },
      }),
    });
    const deps = makeDeps({ tasks });
    const contribution = buildDelegationContribution(deps);
    expect(contribution.tools?.map((tool) => tool.wireName)).toEqual([
      "spawn_subagent",
      "delegate_task",
    ]);
    const spawn = contribution.tools!.find((tool) => tool.wireName === "spawn_subagent")!;
    const delegated = contribution.tools!.find((tool) => tool.wireName === "delegate_task")!;

    expect(delegated.description).toBe("Spawn a Sub-agent against a tracked task.");
    expect(
      (spawn.inputSchema as { properties: Record<string, unknown> }).properties.task_id,
    ).toBeUndefined();
    expect(
      (delegated.inputSchema as { properties: Record<string, unknown> }).properties.task_id,
    ).toBeDefined();
    expect((delegated.inputSchema as { required: string[] }).required).toContain("task_id");
    expect(spawn.inputSchema).not.toHaveProperty("additionalProperties", false);
    expect(delegated.inputSchema).not.toHaveProperty("additionalProperties", false);
  });
});
