/**
 * Coverage of `buildPlansOrchestration` — the plan review gate, the open-task
 * pending gate, the review blocker, the delegation port, and the
 * `beforeIteration` context wiring.
 *
 * These cases used to live in `@clarvis/loop`'s
 * `tests/unit/delegation-handler.test.ts`, driving the planning half of
 * `buildDelegationOrchestration` directly. They move here with the rest of
 * file-backed planning; the delegation-only half of that file (background
 * spawn, the `TaskTrackingPort` seam, `force_tool_on_nudge`) stayed in the
 * loop, since none of it is this package's concern — `force_tool_on_nudge` in
 * particular is the loop's own finalize-gate behaviour, not a capability's.
 *
 * `@clarvis/plan` must never import `@clarvis/loop`, so where the deleted
 * suite drove a call through `delegate_task`'s own handler, these drive the
 * seam it actually uses: `orchestration.port.beforeSpawn` / `noteSpawned`.
 * Where it drove a real `LiveContext` to observe the stable/canonical split,
 * these use a small recording `ContextPort` instead — the split itself
 * (`planSpecBlock`/`planCasHeader`) is already covered directly in
 * `plan-canonical-state.test.ts`; what is new here is that
 * `hooks.beforeIteration` actually publishes them.
 */
import { describe, expect, it } from "bun:test";
import type {
  AgentLoopContribution,
  AgentResult,
  CapabilityEvent,
  ContextPort,
  GateOutcome,
  HandlerVerdict,
  LLMToolCall,
  ToolEffect,
  ToolEffectPort,
} from "@clarvis/capability";
import { createPlanStore } from "../../src/index.ts";
import { createInMemoryPlanRepository } from "../../src/testing.ts";
import { createEditablePlanRepository } from "../helpers/store.ts";
import {
  buildPlansOrchestration,
  type PlansOrchestration,
  type PlansOrchestrationDeps,
} from "../../src/capability/orchestration.ts";
import {
  CREATE_PLAN_TOOL_NAME,
  LIST_PLANS_TOOL_NAME,
  READ_PLAN_TOOL_NAME,
  REVISE_PLAN_TOOL_NAME,
  TRANSITION_PLAN_TASK_TOOL_NAME,
} from "../../src/capability/runtime-tools.ts";
import type { PlanReviewDecision } from "../../src/capability/review-gate.ts";
import type { PlanSession } from "../../src/capability/session.ts";
import { fakeAgentBuildContext, makeTrace } from "../helpers/context.ts";

const READ_TOOLS = new Set(["read_file", "read_files", "list_dir", "glob", "grep", "diff"]);
const MUTATE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "multi_edit",
  "apply_patch",
  "shell",
  "monitor_start",
]);
const CONTROL_TOOLS = new Set([
  "ask_user",
  "load_skill",
  "submit_result",
  "delegate_task",
  "agent_list",
  "agent_poll",
  "agent_stop",
  "agent_steer",
  "await_agents",
]);

/**
 * A stand-in for the host's real `ToolEffectPort` (`@clarvis/loop`'s
 * `createToolEffectPort`, which this package may not import): enough of the
 * real classification to exercise the review blocker's allow-lists —
 * including that an unrecognised name (an MCP tool, in the engine's own
 * suite) reads as `unknown` and is refused by construction.
 */
const fakeToolEffect: ToolEffectPort = {
  effect(name: string): ToolEffect {
    if (CONTROL_TOOLS.has(name)) return "control";
    if (READ_TOOLS.has(name)) return "read";
    if (MUTATE_TOOLS.has(name)) return "mutate";
    return "unknown";
  },
};

function makeDeps(
  over: Partial<PlansOrchestrationDeps> = {},
  bcOver: Parameters<typeof fakeAgentBuildContext>[0] = {},
): PlansOrchestrationDeps {
  return {
    bc: fakeAgentBuildContext(bcOver),
    planStore: createPlanStore({ repository: createInMemoryPlanRepository() }),
    providerKey: "markdown",
    executionId: "run-1",
    pendingTaskNudges: 0,
    toolEffect: fakeToolEffect,
    ...over,
  };
}

async function dispatch(
  contribution: AgentLoopContribution,
  call: LLMToolCall,
): Promise<HandlerVerdict> {
  const handler = contribution.handlers?.find((h) => h.matches(call));
  if (handler === undefined) throw new Error(`no handler claimed '${call.name}'`);
  return handler.handle(call, 0);
}

const DEFAULT_CREATE_ARGS = {
  title: "Runtime",
  objective: "Persist directly",
  tasks: [{ title: "One" }],
  validation: [],
};

async function createPlan(
  orch: PlansOrchestration,
  args: Record<string, unknown> = DEFAULT_CREATE_ARGS,
): Promise<HandlerVerdict> {
  return dispatch(orch.contribution, {
    id: "create-plan-call",
    name: CREATE_PLAN_TOOL_NAME,
    arguments: args,
  });
}

async function readPlan(orch: PlansOrchestration): Promise<Record<string, unknown>> {
  const verdict = await dispatch(orch.contribution, {
    id: `read-plan-call-${Math.random()}`,
    name: READ_PLAN_TOOL_NAME,
    arguments: {},
  });
  if (verdict.kind !== "result") throw new Error("read_plan did not return a result");
  return JSON.parse(verdict.text.replace(/^Tool 'read_plan' result: /, "")) as Record<
    string,
    unknown
  >;
}

function cas(doc: Record<string, unknown>): Record<string, unknown> {
  return {
    expected_revision: doc.revision,
    expected_digest: doc.digest,
    expected_spec_digest: doc.spec_digest,
  };
}

/** Apply one structural revision (a fresh objective), so the spec digest
 * genuinely changes the way a model's edit would. */
async function revisePlanObjective(orch: PlansOrchestration, objective: string): Promise<void> {
  const doc = await readPlan(orch);
  await dispatch(orch.contribution, {
    id: `revise-plan-${objective}`,
    name: REVISE_PLAN_TOOL_NAME,
    arguments: { ...cas(doc), operation: { type: "set_objective", objective } },
  });
}

async function transitionTaskTo(
  orch: PlansOrchestration,
  taskId: string,
  extra: Record<string, unknown>,
): Promise<HandlerVerdict> {
  const doc = await readPlan(orch);
  return dispatch(orch.contribution, {
    id: `transition-${taskId}-${String(extra.status)}-${Math.random()}`,
    name: TRANSITION_PLAN_TASK_TOOL_NAME,
    arguments: { ...cas(doc), task_id: taskId, ...extra },
  });
}

describe("one plan per run", () => {
  it("refuses a second create_plan and names the tool to use instead", async () => {
    const orch = buildPlansOrchestration(makeDeps());
    await createPlan(orch);

    const verdict = await dispatch(orch.contribution, {
      id: "create-plan-again",
      name: CREATE_PLAN_TOOL_NAME,
      arguments: {
        title: "Second",
        objective: "A duplicate attempt",
        tasks: [{ title: "One" }],
        validation: [],
      },
    });
    if (verdict.kind !== "result") throw new Error("create_plan did not return a result");

    expect(verdict.text).toContain("An active plan already exists");
    expect(verdict.text).toContain("revise_plan");
    expect(verdict.text).toContain("transition_plan_task");
  });
});

describe("buildPlansOrchestration — contribution shape", () => {
  it("contributes the five plan tools, both finalize gates, and an anchor keyed to the live plan", async () => {
    const orch = buildPlansOrchestration(makeDeps());
    expect(orch.contribution.tools?.map((tool) => tool.wireName)).toEqual([
      CREATE_PLAN_TOOL_NAME,
      READ_PLAN_TOOL_NAME,
      LIST_PLANS_TOOL_NAME,
      REVISE_PLAN_TOOL_NAME,
      TRANSITION_PLAN_TASK_TOOL_NAME,
    ]);
    expect(orch.contribution.gates).toHaveLength(2);
    expect(orch.port.augmentDelegateTask()).toMatchObject({
      description: expect.stringContaining("task_id"),
      properties: expect.objectContaining({ task_id: expect.any(Object) }),
    });
    expect(orch.contribution.anchor).toBeDefined();
    expect(orch.contribution.anchor!()).toBeUndefined();

    await createPlan(orch);
    expect(orch.contribution.anchor!()).toEqual({
      label: "Current plan",
      body: expect.stringContaining("## Objective"),
    });
  });
});

describe("plan calls reach one captured session and emit capability events", () => {
  it("create_plan captures the run's session and emits plan_created", async () => {
    let captured: PlanSession | undefined;
    const events: CapabilityEvent[] = [];
    const orch = buildPlansOrchestration(
      makeDeps({
        onPlanSession: (session) => {
          captured = session;
        },
        emitCapabilityEvent: (event) => events.push(event),
      }),
    );

    const verdict = await createPlan(orch);

    expect(verdict.kind).toBe("result");
    expect(captured).toBe(orch.session);
    expect(captured?.cached()?.objective).toBe("Persist directly");
    expect(events).toEqual([
      expect.objectContaining({
        capability: "plans",
        kind: "plan_created",
        detail: expect.objectContaining({
          id: captured?.cached()?.id,
          revision: 1,
          spec_revision: 1,
        }),
      }),
    ]);
  });

  it("a task's recorded outcome (result/error/assignee) rides the plan_updated projection", async () => {
    const events: CapabilityEvent[] = [];
    const orch = buildPlansOrchestration(makeDeps({ emitCapabilityEvent: (e) => events.push(e) }));
    await createPlan(orch, {
      title: "Runtime",
      objective: "Persist directly",
      tasks: [{ title: "One" }, { title: "Two" }],
      validation: [],
    });
    const [one, two] = orch.session.cached()!.tasks;

    await transitionTaskTo(orch, one!.id, { status: "in_progress" });
    await transitionTaskTo(orch, one!.id, {
      status: "returned",
      result: "adapter wired; verify pending",
      assignee: "coder",
    });
    await transitionTaskTo(orch, two!.id, { status: "in_progress" });
    await transitionTaskTo(orch, two!.id, { status: "failed", error: "bun test exited 1" });

    const last = events.at(-1) as { kind: string; detail: { tasks: Record<string, unknown>[] } };
    expect(last.kind).toBe("plan_updated");
    expect(last.detail.tasks).toEqual([
      expect.objectContaining({
        id: one!.id,
        status: "returned",
        result: "adapter wired; verify pending",
        assignee: "coder",
      }),
      expect.objectContaining({ id: two!.id, status: "failed", error: "bun test exited 1" }),
    ]);
  });

  it("plan tool calls reach the trace, unlike ordinary tool dispatch that bypasses it", async () => {
    const trace = makeTrace();
    const orch = buildPlansOrchestration(makeDeps({}, { trace }));
    await createPlan(orch);
    await transitionTaskTo(orch, orch.session.cached()!.tasks[0]!.id, { status: "in_progress" });

    const names = trace
      .entries()
      .filter((e) => e.kind === "tool_call")
      .map((e) => (e.detail as { name: string }).name);

    expect(names).toContain(CREATE_PLAN_TOOL_NAME);
    expect(names).toContain(TRANSITION_PLAN_TASK_TOOL_NAME);
  });

  it("marks a missing-plan mutation as failed, removes its live projection, and tombstones context", async () => {
    const repository = createEditablePlanRepository();
    const trace = makeTrace();
    const stable: string[] = [];
    const canonical: string[] = [];
    const events: CapabilityEvent[] = [];
    const ctx: ContextPort = {
      appendNote: () => undefined,
      setStableBlock: (_kind, body) => stable.push(body),
      setCanonicalState: (body) => canonical.push(body),
    };
    const orch = buildPlansOrchestration(
      makeDeps(
        {
          planStore: createPlanStore({ repository }),
          emitCapabilityEvent: (event) => events.push(event),
        },
        { trace, ctx },
      ),
    );
    await createPlan(orch);
    const created = orch.session.cached()!;
    expect(await repository.delete(created.id)).toBeTrue();

    const verdict = await dispatch(orch.contribution, {
      id: "transition-missing-plan",
      name: TRANSITION_PLAN_TASK_TOOL_NAME,
      arguments: {
        expected_revision: created.revision,
        expected_digest: created.digest,
        expected_spec_digest: created.spec_digest,
        task_id: created.tasks[0]!.id,
        status: "in_progress",
      },
    });
    if (verdict.kind !== "result") throw new Error("expected a plan result");

    expect(verdict.text).toContain("Do not retry this mutation");
    expect(events.at(-1)).toMatchObject({
      kind: "plan_removed",
      detail: { id: created.id, title: created.title, status: "active" },
    });
    const recorded = trace
      .entries()
      .filter((entry) => entry.kind === "tool_call")
      .at(-1)?.detail as { error: string | null };
    expect(recorded.error).toContain("backing record is missing");
    expect(stable.at(-1)).toContain("NO ACTIVE PLAN");
    expect(canonical.at(-1)).toContain("There is NO active plan");
    expect(orch.contribution.anchor!()).toEqual({
      label: "Plan unavailable",
      body: expect.stringContaining("Do not reuse any earlier expected_revision"),
    });
  });
});

describe("the delegation port — beforeSpawn / noteSpawned / getTask", () => {
  it("refuses a task_id already spawned this iteration, and names it in the refusal", async () => {
    const orch = buildPlansOrchestration(makeDeps());
    await createPlan(orch);
    const taskId = orch.session.cached()!.tasks[0]!.id;

    const first = await orch.port.beforeSpawn(taskId);
    expect(first.kind).toBe("ok");
    orch.port.noteSpawned(taskId);

    const second = await orch.port.beforeSpawn(taskId);
    expect(second.kind).toBe("refuse");
    if (second.kind === "refuse") expect(second.text).toContain(`duplicate task_id '${taskId}'`);
  });

  it("an independent spawn (no task_id) never trips the duplicate check", async () => {
    const orch = buildPlansOrchestration(makeDeps());
    await createPlan(orch);

    expect((await orch.port.beforeSpawn(undefined)).kind).toBe("ok");
    expect((await orch.port.beforeSpawn(undefined)).kind).toBe("ok");
  });

  it("markSpawned/markFailed emit plan_updated tagged 'task', and a recovery spawn tags 'recovery'", async () => {
    const events: CapabilityEvent[] = [];
    const orch = buildPlansOrchestration(makeDeps({ emitCapabilityEvent: (e) => events.push(e) }));
    await createPlan(orch);
    const taskId = orch.session.cached()!.tasks[0]!.id;

    expect(await orch.port.markSpawned(taskId)).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "plan_updated", detail: { change: "task" } });

    expect(await orch.port.markFailed(taskId, "boom")).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "plan_updated", detail: { change: "task" } });

    expect(await orch.port.markSpawned(taskId)).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "plan_updated", detail: { change: "recovery" } });
  });

  it("propagates a planReviewAsk throw when the run is not cancelled", async () => {
    const orch = buildPlansOrchestration(
      makeDeps({
        planReviewAsk: () => {
          throw new Error("ask boom");
        },
      }),
    );
    await createPlan(orch);

    await expect(orch.port.beforeSpawn(undefined)).rejects.toThrow("ask boom");
  });

  it("stops for a planReviewAsk throw when the run is already cancelled, instead of propagating it", async () => {
    const cancelled: AgentResult = { status: "cancelled", partialText: "" };
    const orch = buildPlansOrchestration(
      makeDeps(
        {
          planReviewAsk: () => {
            throw new Error("ask boom 2");
          },
        },
        { maybeCancelled: () => cancelled },
      ),
    );
    await createPlan(orch);

    const gate = await orch.port.beforeSpawn(undefined);
    expect(gate.kind).toBe("terminal");
    if (gate.kind === "terminal") expect(gate.result).toBe(cancelled);
  });

  it("blocks a spawn while the plan review gate is unresolved, without re-eliciting mid-iteration", async () => {
    let asks = 0;
    const orch = buildPlansOrchestration(
      makeDeps({
        planReviewAsk: async (): Promise<PlanReviewDecision> => {
          asks += 1;
          return { kind: "request_changes", feedback: "check Y" };
        },
      }),
    );
    await createPlan(orch);

    const first = await orch.port.beforeSpawn(undefined);
    expect(first.kind).toBe("refuse");
    if (first.kind === "refuse") {
      expect(first.text).toContain("spawn sub-agents again");
      expect(first.text).toContain("check Y");
    }

    const second = await orch.port.beforeSpawn(undefined);
    expect(second.kind).toBe("refuse");
    if (second.kind === "refuse") expect(second.text).toContain("spawn sub-agents again");

    expect(asks).toBe(1);
  });

  it("a request_changes decision with no feedback still reads back as a rejection, without notes", async () => {
    const orch = buildPlansOrchestration(
      makeDeps({
        planReviewAsk: async (): Promise<PlanReviewDecision> => ({ kind: "request_changes" }),
      }),
    );
    await createPlan(orch);

    const gate = await orch.port.beforeSpawn(undefined);
    expect(gate.kind).toBe("refuse");
    if (gate.kind === "refuse") {
      expect(gate.text).toContain("no specific notes");
      expect(gate.text).toContain("spawn sub-agents again");
    }
  });
});

describe("reviewGate", () => {
  it("a retry within the same iteration after request_changes hits the already-rejected note, without re-eliciting", async () => {
    let asks = 0;
    const orch = buildPlansOrchestration(
      makeDeps({
        planReviewAsk: async (): Promise<PlanReviewDecision> => {
          asks += 1;
          return { kind: "request_changes", feedback: "fix X" };
        },
      }),
    );
    await createPlan(orch);
    const reviewGate = orch.contribution.gates![0]!;

    const first = await reviewGate.check({ mode: "text" });
    expect(first.kind).toBe("nudge");
    if (first.kind === "nudge") expect(first.note).toContain("the human requested changes: fix X");

    const secondSubmit = await reviewGate.check({ mode: "submit" });
    expect(secondSubmit.kind).toBe("nudge");
    if (secondSubmit.kind === "nudge") {
      expect(secondSubmit.note).toContain("Plan not approved");
      expect(secondSubmit.note).toContain("fix X");
    }

    const thirdText = await reviewGate.check({ mode: "text" });
    expect(thirdText.kind).toBe("nudge");
    if (thirdText.kind === "nudge")
      expect(thirdText.note).toContain("the human requested changes: fix X");

    expect(asks).toBe(1);
  });

  it("an approval on a submit attempt passes straight through", async () => {
    const orch = buildPlansOrchestration(
      makeDeps({ planReviewAsk: async (): Promise<PlanReviewDecision> => ({ kind: "approve" }) }),
    );
    await createPlan(orch);
    const reviewGate = orch.contribution.gates![0]!;

    expect((await reviewGate.check({ mode: "submit" })).kind).toBe("pass");
  });

  it("an approval on a text-only finalize nudges to execute rather than passing", async () => {
    const orch = buildPlansOrchestration(
      makeDeps({ planReviewAsk: async (): Promise<PlanReviewDecision> => ({ kind: "approve" }) }),
    );
    await createPlan(orch);
    const reviewGate = orch.contribution.gates![0]!;

    const outcome = await reviewGate.check({ mode: "text" });
    expect(outcome.kind).toBe("nudge");
    if (outcome.kind === "nudge") expect(outcome.note).toContain("APPROVED");
  });

  it("a bypass (no plan yet under a review-on run) nudges once, then terminates", async () => {
    const orch = buildPlansOrchestration(
      makeDeps({ planReviewAsk: async (): Promise<PlanReviewDecision> => ({ kind: "no_human" }) }),
    );
    const reviewGate = orch.contribution.gates![0]!;

    const first = await reviewGate.check({ mode: "text" });
    expect(first.kind).toBe("nudge");

    const second = await reviewGate.check({ mode: "submit" });
    expect(second.kind).toBe("terminal");
    if (second.kind === "terminal")
      expect(second.result.error?.code).toBe("plan_review_unreviewed");
  });

  it("terminates after MAX_PLAN_REVIEW_REVISIONS (10) consecutive change-request rounds", async () => {
    const events: CapabilityEvent[] = [];
    const orch = buildPlansOrchestration(
      makeDeps({
        emitCapabilityEvent: (event) => events.push(event),
        planReviewAsk: async (): Promise<PlanReviewDecision> => ({
          kind: "request_changes",
          feedback: "again",
        }),
      }),
    );
    await createPlan(orch);
    const reviewGate = orch.contribution.gates![0]!;

    let outcome: GateOutcome | undefined;
    for (let round = 0; round < 12; round += 1) {
      orch.contribution.hooks!.beforeIteration!();
      outcome = await reviewGate.check({ mode: "text" });
      if (outcome.kind === "terminal") break;
      await revisePlanObjective(orch, `round ${round}`);
    }

    expect(outcome?.kind).toBe("terminal");
    if (outcome?.kind === "terminal")
      expect(outcome.result.error?.code).toBe("plan_review_revision_limit");
    expect(
      events.filter(
        (e) =>
          e.kind === "plan_review_resolved" &&
          (e.detail as { outcome?: string }).outcome === "changes_requested",
      ).length,
    ).toBe(11);
  });

  it("re-presents the gate only when the plan's substance actually changed", async () => {
    let asks = 0;
    const orch = buildPlansOrchestration(
      makeDeps({
        planReviewAsk: async (): Promise<PlanReviewDecision> => {
          asks += 1;
          return { kind: "request_changes", feedback: "fix X" };
        },
      }),
    );
    await createPlan(orch);
    const reviewGate = orch.contribution.gates![0]!;

    orch.contribution.hooks!.beforeIteration!();
    expect((await reviewGate.check({ mode: "text" })).kind).toBe("nudge");
    expect(asks).toBe(1);

    for (let round = 0; round < 3; round += 1) {
      orch.contribution.hooks!.beforeIteration!();
      const outcome = await reviewGate.check({ mode: "submit" });
      expect(outcome.kind).toBe("nudge");
      if (outcome.kind === "nudge") expect(outcome.note).toContain("fix X");
    }
    expect(asks).toBe(1);

    await revisePlanObjective(orch, "addressed the feedback");
    orch.contribution.hooks!.beforeIteration!();
    expect((await reviewGate.check({ mode: "text" })).kind).toBe("nudge");
    expect(asks).toBe(2);
  });

  it("a retry against an unchanged rejected plan does not count as progress", async () => {
    const orch = buildPlansOrchestration(
      makeDeps({
        planReviewAsk: async (): Promise<PlanReviewDecision> => ({
          kind: "request_changes",
          feedback: "fix X",
        }),
      }),
    );
    await createPlan(orch);
    const reviewGate = orch.contribution.gates![0]!;
    const contributes = orch.contribution.hooks!.contributesProgress!;

    orch.contribution.hooks!.beforeIteration!();
    await reviewGate.check({ mode: "text" });
    expect(contributes()).toBe(true);

    orch.contribution.hooks!.beforeIteration!();
    await reviewGate.check({ mode: "text" });
    expect(contributes()).toBe(false);
  });
});

describe("reviewBlocker before any plan exists", () => {
  function unplannedOrch(): PlansOrchestration {
    return buildPlansOrchestration(
      makeDeps({ planReviewAsk: async (): Promise<PlanReviewDecision> => ({ kind: "no_human" }) }),
    );
  }

  /**
   * Whether the review blocker itself claims `name`. Read as `handlers[0]`
   * rather than by `find`, since the plan tools have handlers of their own
   * further down the list — a `find` would report those and hide whether the
   * blocker fired. Being first is also what makes it win over a run's coding
   * toolset in the folded chain (`@clarvis/loop` orders capabilities so this
   * one goes first).
   */
  const blocked = (orch: PlansOrchestration, name: string): boolean => {
    const call: LLMToolCall = { id: `c-${name}`, name, arguments: {} };
    return orch.contribution.handlers![0]!.matches(call);
  };

  it.each(["write_file", "edit_file", "multi_edit", "apply_patch", "shell", "monitor_start"])(
    "refuses %s before a plan exists, naming create_plan as the way forward",
    async (name) => {
      const orch = unplannedOrch();
      expect(blocked(orch, name)).toBe(true);

      const verdict = await orch.contribution.handlers![0]!.handle(
        { id: `c-${name}`, name, arguments: {} },
        0,
      );
      if (verdict.kind !== "result") throw new Error("expected a result");
      expect(verdict.text).toContain("no plan exists yet");
      expect(verdict.text).toContain("create_plan");
      expect(verdict.progress).toBe(false);
    },
  );

  it.each(["read_file", "read_files", "list_dir", "glob", "grep", "diff"])(
    "still allows %s, so the plan it must author can be grounded in evidence",
    (name) => {
      expect(blocked(unplannedOrch(), name)).toBe(false);
    },
  );

  it.each(["ask_user", "load_skill", "submit_result"])("still allows control tool %s", (name) => {
    expect(blocked(unplannedOrch(), name)).toBe(false);
  });

  it("allows a contributed memory read and refuses a contributed memory mutation by effect", () => {
    const toolEffect: ToolEffectPort = {
      effect(name): ToolEffect {
        if (name === "list_memories") return "read";
        if (name === "edit_memory") return "mutate";
        return "unknown";
      },
    };
    const orch = buildPlansOrchestration(
      makeDeps({
        toolEffect,
        planReviewAsk: async (): Promise<PlanReviewDecision> => ({ kind: "no_human" }),
      }),
    );

    expect(blocked(orch, "list_memories")).toBe(false);
    expect(blocked(orch, "edit_memory")).toBe(true);
  });

  /**
   * The hole this closes: `run_leader` and friends were `control`, so the gate
   * waved them through in both phases. A manager under human plan review fanned
   * out ten leaders before any plan existed, and only met the gate at its
   * finalize attempt — with the job already done.
   */
  it("refuses a run-spawning tool in both phases, unlike an in-run delegation", async () => {
    const toolEffect: ToolEffectPort = {
      effect(name): ToolEffect {
        if (name === "run_leader" || name === "run_work_items") return "spawn_run";
        if (name === "spawn_subagent" || name === "delegate_task") return "control";
        return "unknown";
      },
    };
    const orch = buildPlansOrchestration(
      makeDeps({
        toolEffect,
        planReviewAsk: async (): Promise<PlanReviewDecision> => ({ kind: "no_human" }),
      }),
    );

    expect(blocked(orch, "run_leader")).toBe(true);
    expect(blocked(orch, "run_work_items")).toBe(true);
    /* A Sub-agent runs inside this run's own toolset, so its control tools stay
       available; spawn_subagent is the pre-plan exploration route. */
    expect(blocked(orch, "spawn_subagent")).toBe(false);
    expect(blocked(orch, "delegate_task")).toBe(false);

    await createPlan(orch);
    expect(blocked(orch, "run_leader")).toBe(true);
  });

  it("tells a refused spawn why, rather than claiming it would change the workspace", async () => {
    const toolEffect: ToolEffectPort = {
      effect: (name): ToolEffect => (name === "run_leader" ? "spawn_run" : "mutate"),
    };
    const orch = buildPlansOrchestration(
      makeDeps({
        toolEffect,
        planReviewAsk: async (): Promise<PlanReviewDecision> => ({ kind: "no_human" }),
      }),
    );
    const handler = orch.contribution.handlers!.find((h) =>
      h.matches({ id: "c", name: "run_leader", arguments: {} }),
    )!;
    const verdict = await handler.handle({ id: "c", name: "run_leader", arguments: {} }, 1);
    const text = (verdict as { text: string }).text;
    expect(text).toContain("starts an independent run");
    expect(text).toContain("spawn_subagent");
    expect(text).not.toContain("nothing may change in the workspace");
  });

  it("stops refusing a spawn once the human approves the plan", async () => {
    const toolEffect: ToolEffectPort = {
      effect: (name): ToolEffect => (name === "run_leader" ? "spawn_run" : "mutate"),
    };
    const orch = buildPlansOrchestration(
      makeDeps({
        toolEffect,
        planReviewAsk: async (): Promise<PlanReviewDecision> => ({ kind: "approve" }),
      }),
    );
    await createPlan(orch);
    expect(blocked(orch, "run_leader")).toBe(true);
    const gate = orch.contribution.gates![0]!;
    expect((await gate.check({ mode: "submit", value: {} })).kind).toBe("pass");
    expect(blocked(orch, "run_leader")).toBe(false);
  });

  it.each([CREATE_PLAN_TOOL_NAME, READ_PLAN_TOOL_NAME])("still allows plan tool %s", (name) => {
    expect(blocked(unplannedOrch(), name)).toBe(false);
  });

  it("refuses an MCP tool by construction, since its effects are unknowable here", () => {
    expect(blocked(unplannedOrch(), "docs.search_docs")).toBe(true);
  });

  it("does not engage at all when the run is not under review", () => {
    const orch = buildPlansOrchestration(makeDeps());
    expect(blocked(orch, "write_file")).toBe(false);
    expect(blocked(orch, "shell")).toBe(false);
  });

  it("stops refusing once the human approves the plan", async () => {
    const orch = buildPlansOrchestration(
      makeDeps({ planReviewAsk: async (): Promise<PlanReviewDecision> => ({ kind: "approve" }) }),
    );
    expect(blocked(orch, "write_file")).toBe(true);

    await createPlan(orch);
    expect(blocked(orch, "write_file")).toBe(true);
    expect(blocked(orch, "read_file")).toBe(true);

    const gate = orch.contribution.gates![0]!;
    expect((await gate.check({ mode: "submit", value: {} })).kind).toBe("pass");
    expect(blocked(orch, "write_file")).toBe(false);
    expect(blocked(orch, "shell")).toBe(false);
  });

  it("re-locks the run when a revision revokes an approval", async () => {
    let asks = 0;
    const orch = buildPlansOrchestration(
      makeDeps({
        planReviewAsk: async (): Promise<PlanReviewDecision> => {
          asks += 1;
          return { kind: "approve" };
        },
      }),
    );
    await createPlan(orch);

    expect((await orch.contribution.gates![0]!.check({ mode: "submit" })).kind).toBe("pass");
    expect(blocked(orch, "shell")).toBe(false);
    expect((await readPlan(orch)).status).toBe("active");

    await revisePlanObjective(orch, "a discovery changed the objective");

    const doc = await readPlan(orch);
    expect(doc.status).toBe("awaiting_approval");
    expect(doc.approved_spec_revision).toBeUndefined();
    expect(blocked(orch, "shell")).toBe(true);

    orch.contribution.hooks!.beforeIteration!();
    expect((await orch.contribution.gates![0]!.check({ mode: "submit" })).kind).toBe("pass");
    expect(asks).toBe(2);
    expect(blocked(orch, "shell")).toBe(false);
  });
});

describe("pendingGate", () => {
  it("fastAcceptOk reflects whether an open task is actually blocking", async () => {
    const orch = buildPlansOrchestration(makeDeps({ pendingTaskNudges: 1 }));
    await createPlan(orch);
    const pendingGate = orch.contribution.gates![1]!;

    expect(pendingGate.fastAcceptOk!()).toBe(false);
  });

  it("fastAcceptOk passes trivially when the nudge cap is 0", async () => {
    const orch = buildPlansOrchestration(makeDeps({ pendingTaskNudges: 0 }));
    await createPlan(orch);
    const pendingGate = orch.contribution.gates![1]!;

    expect(pendingGate.fastAcceptOk!()).toBe(true);
  });

  it("fastAcceptOk passes once every task is closed", async () => {
    const orch = buildPlansOrchestration(makeDeps({ pendingTaskNudges: 1 }));
    await createPlan(orch);
    await transitionTaskTo(orch, orch.session.cached()!.tasks[0]!.id, {
      status: "done",
      result: "shipped",
    });
    const pendingGate = orch.contribution.gates![1]!;

    expect(pendingGate.fastAcceptOk!()).toBe(true);
  });

  it("nudges on open tasks with no progress, then terminates once the nudge cap is spent", async () => {
    const orch = buildPlansOrchestration(makeDeps({ pendingTaskNudges: 1 }));
    await createPlan(orch);
    const pendingGate = orch.contribution.gates![1]!;

    const first = await pendingGate.check({ mode: "text" });
    expect(first.kind).toBe("nudge");
    if (first.kind === "nudge") expect(first.note).toContain("plan task(s) are still open");

    const second = await pendingGate.check({ mode: "text" });
    expect(second.kind).toBe("terminal");
    if (second.kind === "terminal") {
      expect(second.result.error?.code).toBe("pending_tasks_unfinished");
      expect(second.result.error?.message).toContain("1 consecutive nudge(s)");
    }
  });

  it("resets the stall counter once a spawn against every open task makes progress", async () => {
    const orch = buildPlansOrchestration(makeDeps({ pendingTaskNudges: 2 }));
    await createPlan(orch);
    const taskId = orch.session.cached()!.tasks[0]!.id;
    const pendingGate = orch.contribution.gates![1]!;

    expect((await pendingGate.check({ mode: "text" })).kind).toBe("nudge");

    await orch.port.beforeSpawn(taskId);
    orch.port.noteSpawned(taskId);
    const afterProgress = await pendingGate.check({ mode: "text" });
    expect(afterProgress.kind).toBe("nudge");

    // Progress reset the stall counter, so the cap of 2 has one more nudge in
    // it rather than terminating immediately.
    const stillNudging = await pendingGate.check({ mode: "text" });
    expect(stillNudging.kind).toBe("nudge");
  });
});

describe("hooks.beforeIteration — publishing the plan as canonical context", () => {
  function recordingCtx(): { ctx: ContextPort; stable: string[]; canonical: string[] } {
    const stable: string[] = [];
    const canonical: string[] = [];
    const ctx: ContextPort = {
      appendNote: () => undefined,
      setStableBlock: (_label, body) => {
        stable.push(body);
      },
      setCanonicalState: (body) => {
        canonical.push(body);
      },
    };
    return { ctx, stable, canonical };
  }

  it("does nothing while no plan exists yet", () => {
    const { ctx, stable, canonical } = recordingCtx();
    const orch = buildPlansOrchestration(makeDeps({}, { ctx }));

    orch.contribution.hooks!.beforeIteration!();

    expect(stable).toEqual([]);
    expect(canonical).toEqual([]);
  });

  it("publishes the spec block as stable and the CAS header as canonical once a plan exists", async () => {
    const { ctx, stable, canonical } = recordingCtx();
    const orch = buildPlansOrchestration(makeDeps({}, { ctx }));
    await createPlan(orch);

    orch.contribution.hooks!.beforeIteration!();

    expect(stable).toHaveLength(1);
    expect(stable[0]).toContain("## Objective");
    expect(canonical).toHaveLength(1);
    expect(canonical[0]).toContain("expected_spec_digest");
  });
});
