/**
 * `createPlansCapability`'s own gating, beyond what `planned-run-file.test.ts`
 * already exercises end to end: `requiresUserInput` per settings mode, the
 * `finalizeRun`/`onRunEnd` branches that test doesn't reach (a `failed` run, a
 * `finalizeRun` with no agent ever attached, an idempotent second
 * `onRunEnd`, and a non-`completed` end on a `discard` plan), and the
 * `ToolEffectPort` fallback a host that registers none falls back to.
 */
import { describe, expect, it } from "bun:test";
import {
  createCapabilityServices,
  createCapabilityRequestView,
  createComputeClock,
  type AgentLoopContribution,
  type AgentScope,
  type CapabilityEvent,
  type Elicit,
  type HandlerVerdict,
  type LLMToolCall,
  type RunCapability,
  type RunCapabilityContext,
  type RunRequest,
} from "@clarvis/capability";
import { createPlanStore, type PlanRef } from "../../src/index.ts";
import { createInMemoryPlanRepository } from "../../src/testing.ts";
import { createPlansCapability } from "../../src/capability/index.ts";
import {
  CREATE_PLAN_TOOL_NAME,
  LIST_PLANS_TOOL_NAME,
  READ_PLAN_TOOL_NAME,
  REVISE_PLAN_TOOL_NAME,
  TRANSITION_PLAN_TASK_TOOL_NAME,
} from "../../src/capability/runtime-tools.ts";
import {
  fakeAgentBuildContext,
  fakeExecutionRecord,
  fakeRunCapabilityContext,
} from "../helpers/context.ts";

function requestWithPlans(plans: unknown): RunRequest {
  return {
    messages: [{ role: "user", content: "task" }],
    servers: [],
    profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 3 }],
    entry: "solo",
    providers: [{ name: "anthropic", kind: "anthropic" }],
    budget: { on_exceed: "stop", total_token_limit: 100_000 },
    ...(plans === undefined ? {} : { plans }),
  } as RunRequest;
}

function requestViewWithPlans(plans: unknown) {
  return createCapabilityRequestView(requestWithPlans(plans));
}

function forRun(
  plans: unknown,
  servicesOver?: RunCapabilityContext["services"],
): Promise<{ events: CapabilityEvent[]; run: RunCapability | null }> {
  const events: CapabilityEvent[] = [];
  const capability = createPlansCapability({
    factory: {
      async storeFor() {
        return {
          key: "markdown",
          providerKind: "markdown",
          store: createPlanStore({ repository: createInMemoryPlanRepository() }),
        };
      },
    },
    defaultPendingTaskNudges: 3,
    defaultElicitWaitMs: 30_000,
  });
  return Promise.resolve(
    capability.forRun(
      fakeRunCapabilityContext({
        services: servicesOver ?? createCapabilityServices(),
        requestParam: (key) => (key === "plans" ? plans : undefined),
        emit: (event) => events.push(event),
      }),
    ),
  ).then((run) => ({ events, run }));
}

function attachEntry(run: RunCapability, opts: { elicit?: Elicit } = {}): AgentLoopContribution {
  const scope: AgentScope = {
    agent: "lead",
    entry: true,
    grants: [],
    clock: createComputeClock(60_000),
    ...(opts.elicit === undefined ? {} : { elicit: opts.elicit }),
  };
  const agentCapability = run.forAgent(scope);
  if (agentCapability === null) throw new Error("plans capability refused the entry agent");
  return agentCapability.attach(fakeAgentBuildContext());
}

async function dispatch(
  contribution: AgentLoopContribution,
  call: LLMToolCall,
): Promise<HandlerVerdict> {
  const handler = contribution.handlers?.find((h) => h.matches(call));
  if (handler === undefined) throw new Error(`no handler claimed '${call.name}'`);
  return handler.handle(call, 0);
}

describe("createPlansCapability — requiresUserInput", () => {
  const capability = createPlansCapability({
    factory: {
      async storeFor() {
        return {
          key: "markdown",
          providerKind: "markdown",
          store: createPlanStore({ repository: createInMemoryPlanRepository() }),
        };
      },
    },
    defaultPendingTaskNudges: 3,
    defaultElicitWaitMs: 30_000,
  });

  it("declares every canonical plan tool with its read or mutate effect", () => {
    expect(capability.reservedWireNames).toEqual([
      CREATE_PLAN_TOOL_NAME,
      READ_PLAN_TOOL_NAME,
      LIST_PLANS_TOOL_NAME,
      REVISE_PLAN_TOOL_NAME,
      TRANSITION_PLAN_TASK_TOOL_NAME,
    ]);
    expect(capability.toolEffects).toEqual({
      [CREATE_PLAN_TOOL_NAME]: "mutate",
      [READ_PLAN_TOOL_NAME]: "read",
      [LIST_PLANS_TOOL_NAME]: "read",
      [REVISE_PLAN_TOOL_NAME]: "mutate",
      [TRANSITION_PLAN_TASK_TOOL_NAME]: "mutate",
    });
  });

  it("is false for an unconfigured request (defaults to mode 'on')", () => {
    expect(capability.requiresUserInput!(requestViewWithPlans(undefined))).toBe(false);
  });

  it("is false for mode 'off' and mode 'on'", () => {
    expect(capability.requiresUserInput!(requestViewWithPlans("off"))).toBe(false);
    expect(capability.requiresUserInput!(requestViewWithPlans("on"))).toBe(false);
    expect(capability.requiresUserInput!(requestViewWithPlans({ mode: "on" }))).toBe(false);
  });

  it("is true for mode 'review', in both its terse and block forms", () => {
    expect(capability.requiresUserInput!(requestViewWithPlans("review"))).toBe(true);
    expect(capability.requiresUserInput!(requestViewWithPlans({ mode: "review" }))).toBe(true);
  });
});

describe("createPlansCapability — provider resolution", () => {
  it("does not resolve any provider when mode is off", async () => {
    let resolutions = 0;
    const capability = createPlansCapability({
      factory: {
        async storeFor() {
          resolutions += 1;
          throw new Error("must not resolve");
        },
      },
      defaultPendingTaskNudges: 3,
      defaultElicitWaitMs: 30_000,
    });
    expect(
      await capability.forRun(
        fakeRunCapabilityContext({ requestParam: (key) => (key === "plans" ? "off" : undefined) }),
      ),
    ).toBeNull();
    expect(resolutions).toBe(0);
  });

  it("refuses an unfinished continuation owned by another provider", async () => {
    const capability = createPlansCapability({
      factory: {
        async storeFor() {
          return {
            key: "plugin:new",
            providerKind: "fixture",
            store: createPlanStore({ repository: createInMemoryPlanRepository() }),
          };
        },
      },
      defaultPendingTaskNudges: 3,
      defaultElicitWaitMs: 30_000,
    });
    await expect(
      capability.forRun(
        fakeRunCapabilityContext({
          priorState: {
            plans: {
              id: "p1",
              provider_key: "plugin:old",
              final_revision: 1,
              final_spec_revision: 1,
              status: "failed",
              retention: "keep",
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "plan_provider_mismatch" });
  });

  it("drops a completed continuation from another provider", async () => {
    const capability = createPlansCapability({
      factory: {
        async storeFor() {
          return {
            key: "plugin:new",
            providerKind: "fixture",
            store: createPlanStore({ repository: createInMemoryPlanRepository() }),
          };
        },
      },
      defaultPendingTaskNudges: 3,
      defaultElicitWaitMs: 30_000,
    });
    const run = await capability.forRun(
      fakeRunCapabilityContext({
        priorState: {
          plans: {
            id: "old-id",
            provider_key: "markdown",
            final_revision: 1,
            final_spec_revision: 1,
            status: "completed",
            retention: "keep",
          },
        },
      }),
    );
    expect(run).not.toBeNull();
  });

  it("emits a recovery projection before a continued run starts so clients restore its tasks", async () => {
    const repository = createInMemoryPlanRepository();
    const store = createPlanStore({ repository });
    const created = await store.create({
      title: "Continued plan",
      objective: "Keep the sidebar current",
      tasks: [{ title: "Recovered task" }],
      createdByRun: "run-1",
    });
    const interrupted = await store.update(created.id, created, (plan) => {
      plan.tasks[0]!.status = "in_progress";
      plan.status = "failed";
    });
    const ref: PlanRef = {
      id: interrupted.id,
      provider_key: "markdown",
      ...(interrupted.path === undefined ? {} : { path: interrupted.path }),
      final_revision: interrupted.revision,
      final_spec_revision: interrupted.spec_revision,
      status: interrupted.status,
      retention: interrupted.retention,
    };
    const events: CapabilityEvent[] = [];
    const capability = createPlansCapability({
      factory: {
        async storeFor() {
          return { key: "markdown", providerKind: "markdown", store };
        },
      },
      defaultPendingTaskNudges: 3,
      defaultElicitWaitMs: 30_000,
    });
    const run = await capability.forRun(
      fakeRunCapabilityContext({
        executionId: "run-2",
        priorState: { plans: ref },
        emit: (event) => events.push(event),
      }),
    );

    await run!.lifecycle![0]!.onRunStart!({ mode: "lead-subagent", entry: "solo" });

    expect(events).toEqual([
      expect.objectContaining({
        kind: "plan_updated",
        detail: expect.objectContaining({
          change: "recovery",
          id: interrupted.id,
          revision: interrupted.revision + 1,
          tasks: [expect.objectContaining({ title: "Recovered task", status: "pending" })],
        }),
      }),
    ]);
  });
});

describe("createPlansCapability — finalizeRun edge cases", () => {
  it.each([
    { status: "completed", disposition: "checkpoint" },
    { status: "cancelled", preserveState: true },
    { status: "error", preserveState: true },
  ] as const)(
    "preserves the plan and discard retention on a non-final stage %j",
    async (outcome) => {
      const { run, events } = await forRun({ mode: "on", retention: "discard" });
      const contribution = attachEntry(run!);
      await dispatch(contribution, {
        id: "create",
        name: CREATE_PLAN_TOOL_NAME,
        arguments: { title: "T", objective: "o", tasks: [{ title: "Open task" }], validation: [] },
      });
      const before = (await run!.finalizeRun!({
        status: "completed",
        disposition: "checkpoint",
      })) as PlanRef;
      const after = (await run!.finalizeRun!(outcome)) as PlanRef;
      expect(after).toEqual(before);
      expect(after.status).not.toBe("completed");
      const record = fakeExecutionRecord(outcome.status, { plans: after });
      if (record.response.status === "completed") {
        record.response = {
          ...record.response,
          disposition: "checkpoint",
          checkpoint: { summary: "stage", next_step: "continue" },
        };
      }
      await run!.onRunEnd!(record);
      expect(events.filter((event) => event.kind === "plan_removed")).toHaveLength(0);
      const read = await dispatch(contribution, {
        id: "read",
        name: READ_PLAN_TOOL_NAME,
        arguments: {},
      });
      expect(read.kind).toBe("result");
      if (read.kind === "result") expect(read.text).toContain("Open task");
    },
  );
  it("maps a non-completed, non-cancelled status to the plan status 'failed'", async () => {
    const { run } = await forRun("on");
    const contribution = attachEntry(run!);
    await dispatch(contribution, {
      id: "c1",
      name: CREATE_PLAN_TOOL_NAME,
      arguments: {
        title: "T",
        objective: "o",
        tasks: [{ title: "One" }],
        validation: [],
      },
    });

    const ref = await run!.finalizeRun!({ status: "error" });
    expect((ref as PlanRef | undefined)?.status).toBe("failed");
    expect((ref as PlanRef | undefined)?.provider_key).toBe("markdown");
  });

  it("returns undefined when no agent was ever attached, since there is no session to finalize", async () => {
    const { run } = await forRun("on");
    const ref = await run!.finalizeRun!({ status: "completed" });
    expect(ref).toBeUndefined();
  });
});

describe("createPlansCapability — onRunEnd edge cases", () => {
  async function discardedRun(): Promise<{
    run: RunCapability;
    ref: PlanRef;
    events: CapabilityEvent[];
  }> {
    const { run, events } = await forRun({ mode: "on", retention: "discard" });
    const contribution = attachEntry(run!);
    await dispatch(contribution, {
      id: "c1",
      name: CREATE_PLAN_TOOL_NAME,
      arguments: { title: "T", objective: "o", tasks: [{ title: "One" }], validation: [] },
    });
    const ref = (await run!.finalizeRun!({ status: "completed" })) as PlanRef;
    return { run: run!, ref, events };
  }

  it("leaves a discard-retention plan alone when the run did not complete, so a later completed end still finds it", async () => {
    const { run, ref, events } = await discardedRun();

    await run.onRunEnd?.(fakeExecutionRecord("error", { plans: ref }));
    expect(events.filter((e) => e.kind === "plan_removed")).toHaveLength(0);

    // Proves the earlier non-completed call did not delete it: a genuinely
    // completed end still finds the plan there to remove.
    await run.onRunEnd?.(fakeExecutionRecord("completed", { plans: ref }));
    expect(events.filter((e) => e.kind === "plan_removed")).toHaveLength(1);
  });

  it("is idempotent: a second onRunEnd after the plan is already gone emits nothing further", async () => {
    const { run, ref, events } = await discardedRun();
    await run.onRunEnd?.(fakeExecutionRecord("completed", { plans: ref }));
    expect(events.filter((e) => e.kind === "plan_removed")).toHaveLength(1);

    await run.onRunEnd?.(fakeExecutionRecord("completed", { plans: ref }));
    expect(events.filter((e) => e.kind === "plan_removed")).toHaveLength(1);
  });

  it("does nothing when the run carries no plan ref at all", async () => {
    const { run, events } = await forRun("on");
    await run!.onRunEnd?.(fakeExecutionRecord("completed"));
    expect(events).toEqual([]);
  });
});

describe("createPlansCapability — the ToolEffectPort fallback", () => {
  it("with no ToolEffectPort registered, an unrecognised tool reads as unknown and is refused during review", async () => {
    const { run } = await forRun("review", createCapabilityServices());
    const contribution = attachEntry(run!, {
      elicit: async () => ({ action: "accept", content: { decision: "approve" } }),
    });

    const call: LLMToolCall = { id: "x1", name: "some_unclassified_tool", arguments: {} };
    const handler = contribution.handlers!.find((h) => h.matches(call));
    expect(handler).toBeDefined();

    const verdict = await handler!.handle(call, 0);
    expect(verdict.kind).toBe("result");
    if (verdict.kind === "result") expect(verdict.text).toContain("no plan exists yet");
  });
});
