import { describe, expect, it } from "bun:test";
import {
  admitGoalRun,
  advanceGoalRun,
  applyGoalControl,
  type GoalRepository,
  type GoalRuntimePort,
  type GoalStewardRunInput,
  type GoalStewardResult,
  type GoalUsage,
} from "@clarvis/goal";
import type { TraceEvent } from "@clarvis/capability";
import { createGoalStewardCoordinator } from "../../src/goals/steward-coordinator.ts";

function fixture(options: { usage?: GoalUsage; honorAbort?: boolean; maxReviews?: number } = {}) {
  let planRevision = "absent";
  let trace: TraceEvent[] = [];
  let content = "";
  let state = applyGoalControl(
    undefined,
    {
      expected_revision: 0,
      operation_id: "create",
      action: {
        kind: "create",
        objective: "Deliver the answer",
        limits: { max_net_tokens: 10000 },
      },
    },
    { session_id: "session", new_goal_id: "goal", now: 1, physically_busy: false },
  ).state;
  state = admitGoalRun(state, {
    goal_id: "goal",
    execution_id: "work",
    admission_id: "work",
    automatic: false,
    expected_revision: state.revision,
    control_revision: state.current!.control_revision,
    now: 2,
  });
  state = advanceGoalRun(state, {
    goal_id: "goal",
    execution_id: "work",
    phase: "running",
    now: 3,
  });
  const repository: GoalRepository = {
    async read() {
      return structuredClone(state);
    },
    async transact(_id, mutate) {
      const result = mutate(state);
      state = result.state;
      return result.result;
    },
  };
  const binding = {
    session_id: "session",
    goal_id: "goal",
    execution_id: "work",
    agent_instance_id: "lead",
    objective_revision: 1,
  };
  const port: GoalRuntimePort = {
    binding,
    read: async () => ({ goal: structuredClone(state.current!), evidence: [] }),
    progress: async () => {},
    candidate: async () => ({
      valid: true,
      reasons: [],
      qualitative_criteria: [],
      revision: state.revision,
    }),
    checkpoint: async () => {
      throw new Error("unused");
    },
    validateCompletion: async () => ({
      valid: true,
      reasons: [],
      qualitative_criteria: [],
      revision: state.revision,
    }),
    blocked: async (reason) => {
      state.current!.status = "blocked";
      state.current!.reason = reason;
    },
  };
  const calls: GoalStewardRunInput[] = [];
  const admitted = Promise.withResolvers<void>();
  const successor = Promise.withResolvers<void>();
  const settle = Promise.withResolvers<GoalStewardResult>();
  const committed = Promise.withResolvers<void>();
  let charged = 0;
  const coordinator = createGoalStewardCoordinator({
    binding,
    repository,
    runtimePort: port,
    initialMessages: ["Deliver the answer"],
    signal: new AbortController().signal,
    runtime: () => ({
      fingerprint: "same",
      workspaceReadAvailable: true,
      promptCacheTtl: "5m",
      maxReviews: options.maxReviews ?? 8,
      maxInterventions: 3,
      budget: {
        max_net_tokens: 10000,
        timeout_ms: 120000,
        max_iterations: 8,
        call_timeout_ms: 60000,
        max_retries: 1,
      },
      async run(input) {
        calls.push(input);
        admitted.resolve();
        if (calls.length === 2) successor.resolve();
        return {
          execution_id: input.execution_id,
          result: await (options.honorAbort
            ? Promise.race([
                settle.promise,
                new Promise<never>((_resolve, reject) => {
                  input.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                    once: true,
                  });
                }),
              ])
            : settle.promise),
          usage: options.usage ?? { kind: "measured", input: 100, output: 10, cached: 50 },
          elapsed_ms: 1,
        };
      },
    }),
    readTrace: () => trace,
    readFile: async (path) => ({ path, content }),
    changed() {
      if (state.current!.steward.pending_execution_id === undefined) committed.resolve();
    },
    async settle(mutate) {
      const result = mutate(state);
      state = result.state;
      if (result.charged) charged++;
    },
  });
  coordinator.bindReviewContext({ snapshot: () => ({ revision: planRevision, contexts: [] }) });
  coordinator.observe({
    type: "lead_iteration",
    response: "I have inspected the requested result",
    iteration: 1,
  } as TraceEvent);
  return {
    coordinator,
    setRead(next: TraceEvent[], bytes: string) {
      trace = next;
      content = bytes;
    },
    setPlanRevision(value: string) {
      planRevision = value;
    },
    calls,
    admitted,
    successor,
    settle,
    committed,
    state: () => state,
    charged: () => charged,
  };
}

describe("Goal Steward coordinator", () => {
  it("does not wait for observation and retains independently charged usage on teardown", async () => {
    const f = fixture();
    f.coordinator.scheduleObservation();
    await f.admitted.promise;
    expect(await f.coordinator.takeReadyIntervention()).toBeUndefined();
    f.settle.resolve({
      decision: "steer",
      summary: "Missing answer",
      guidance: "Provide the answer",
    });
    await f.committed.promise;
    expect(await f.coordinator.takeReadyIntervention()).toEqual({
      kind: "steer",
      guidance: "Provide the answer",
    });
    await f.coordinator.closeCoordinator();
    expect(f.charged()).toBe(1);
    expect(f.state().current!.consumption.net_tokens).toBe(0);
    expect(f.state().current!.steward.consumption.net_tokens).toBe(60);
    expect(f.calls[0]!.budget.max_net_tokens).toBe(10000);
  });

  it("discards a late observation after accepted human steering but still accounts for it", async () => {
    const f = fixture();
    f.coordinator.scheduleObservation();
    await f.admitted.promise;
    f.coordinator.observe({
      type: "user_steering",
      agent: "lead",
      message: "Changed direction",
      iteration_ref: 1,
    } as TraceEvent);
    f.settle.resolve({ decision: "steer", summary: "Old", guidance: "Old direction" });
    await f.committed.promise;
    expect(await f.coordinator.takeReadyIntervention()).toBeUndefined();
    await f.coordinator.closeCoordinator();
    expect(f.charged()).toBe(1);
    expect(f.state().current!.runs[0]!.steward_reviews).toEqual([]);
  });

  it("requires exact semantic targets and reuses a fenced completion without another model call", async () => {
    const f = fixture();
    f.settle.resolve({
      decision: "completion",
      verdict: "achieved",
      summary: "Delivered",
      assessments: ["definition", "objective"].map((scope) => ({
        scope: scope as "definition" | "objective",
        verdict: "satisfied",
        rationale: "Answer observed",
        evidence_ids: [],
        inspected_paths: [],
      })),
    });
    const attempt = { mode: "text" as const, text: "The answer" };
    expect((await f.coordinator.reviewCompletion(attempt)).kind).toBe("achieved");
    expect((await f.coordinator.reviewCompletion(attempt)).kind).toBe("achieved");
    expect(f.calls).toHaveLength(1);
    expect(await f.coordinator.completionCurrent("The answer")).toBe(true);
    expect(await f.coordinator.completionCurrent(undefined)).toBe(false);
    expect(await f.coordinator.completionCurrent("Changed answer")).toBe(false);
    await f.coordinator.closeCoordinator();
  });
  it("invalidates a ready correction when Plan changes without altering operator authority", async () => {
    const f = fixture();
    f.coordinator.scheduleObservation();
    await f.admitted.promise;
    f.settle.resolve({ decision: "steer", summary: "Review", guidance: "Finish the current plan" });
    await f.committed.promise;
    f.setPlanRevision("edited");
    expect(await f.coordinator.takeReadyIntervention()).toBeUndefined();
    await f.coordinator.closeCoordinator();
    expect(f.charged()).toBe(1);
  });

  it("fails closed on unknown auxiliary usage and retains it outside the work allowance", async () => {
    const f = fixture({ usage: { kind: "unknown" } });
    f.settle.resolve({
      decision: "completion",
      verdict: "achieved",
      summary: "Claimed",
      assessments: ["definition", "objective"].map((scope) => ({
        scope: scope as "definition" | "objective",
        verdict: "satisfied",
        rationale: "Claimed",
        evidence_ids: [],
        inspected_paths: [],
      })),
    });
    expect((await f.coordinator.reviewCompletion({ mode: "text", text: "Answer" })).kind).toBe(
      "inconclusive",
    );
    expect(f.state().current!.steward.consumption.usage_unknown).toBe(true);
    expect(f.state().current!.consumption.net_tokens).toBe(0);
    await f.coordinator.closeCoordinator();
  });

  it("retains cancellation until evaluation settlement and leaves no pending reservation", async () => {
    const f = fixture({ honorAbort: true });
    f.coordinator.scheduleObservation();
    await f.admitted.promise;
    await f.coordinator.closeCoordinator();
    expect(f.state().current!.steward.pending_execution_id).toBeUndefined();
    expect(f.charged()).toBe(1);
    f.coordinator.scheduleObservation();
    expect(f.calls).toHaveLength(1);
  });

  it("coalesces complete responses into one successor and preserves the private predecessor", async () => {
    const f = fixture();
    f.coordinator.scheduleObservation();
    await f.admitted.promise;
    for (const response of ["Second result", "Third result"]) {
      f.coordinator.observe({ type: "lead_iteration", response, iteration: 2 } as TraceEvent);
      f.coordinator.scheduleObservation();
    }
    expect(f.calls).toHaveLength(1);
    f.settle.resolve({ decision: "aligned", summary: "Aligned" });
    await f.successor.promise;
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.continue_from).toBe(f.calls[0]!.execution_id);
    expect(f.calls[1]!.projection).toContain("Second result");
    expect(f.calls[1]!.projection).toContain("Third result");
    await f.coordinator.closeCoordinator();
  });
});

describe("Goal Steward recovery", () => {
  it("retires an orphaned reservation once and never replays a write", async () => {
    const f = fixture();
    f.state().current!.steward.pending_execution_id = "crashed-steward";
    f.coordinator.scheduleObservation();
    await f.admitted.promise;
    f.settle.resolve({ decision: "aligned", summary: "Recovered read-only analysis" });
    await f.committed.promise;
    await f.coordinator.closeCoordinator();
    expect(f.charged()).toBe(2);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.continue_from).toBeUndefined();
    expect(f.state().current!.steward.pending_execution_id).toBeUndefined();
    expect(f.state().current!.steward.consumption.usage_unknown).toBe(true);
  });
});

it("discards a ready observation if its inspected artifact changes", async () => {
  const f = fixture();
  const trace = [
    {
      type: "tool_call",
      mcp_name: "read_file",
      arguments: { path: "answer.txt" },
      result: "     1\told",
      error: null,
    },
  ] as TraceEvent[];
  f.setRead(trace, "old");
  f.coordinator.scheduleObservation();
  await f.admitted.promise;
  f.settle.resolve({ decision: "steer", summary: "Old file", guidance: "Correct the old file" });
  await f.committed.promise;
  f.setRead(trace, "changed");
  expect(await f.coordinator.takeReadyIntervention()).toBeUndefined();
  await f.coordinator.closeCoordinator();
  expect(f.charged()).toBe(1);
});

for (const maxReviews of [1, 2]) {
  it(`reserves the final evaluation when observations reach their allowance (${maxReviews})`, async () => {
    const f = fixture({ maxReviews });
    f.state().current!.runs[0]!.steward_review_count = maxReviews - 1;
    f.coordinator.scheduleObservation();
    f.settle.resolve({
      decision: "completion",
      verdict: "achieved",
      summary: "Delivered",
      assessments: ["definition", "objective"].map((scope) => ({
        scope: scope as "definition" | "objective",
        verdict: "satisfied",
        rationale: "Observed",
        evidence_ids: [],
        inspected_paths: [],
      })),
    });
    expect((await f.coordinator.reviewCompletion({ mode: "text", text: "Answer" })).kind).toBe(
      "achieved",
    );
    expect(f.calls).toHaveLength(1);
    expect(f.state().current!.runs[0]!.steward_review_count).toBe(maxReviews);
    expect(f.state().current!.status).toBe("active");
    await f.coordinator.closeCoordinator();
  });
}
it("does not classify a later inconclusive verdict as an earlier observation failure", async () => {
  const f = fixture();
  f.coordinator.scheduleObservation();
  await f.admitted.promise;
  f.settle.resolve({
    decision: "completion",
    verdict: "inconclusive",
    summary: "Evidence unavailable",
    assessments: ["definition", "objective"].map((scope) => ({
      scope: scope as "definition" | "objective",
      verdict: "inconclusive",
      rationale: "Missing evidence",
      evidence_ids: [],
      inspected_paths: [],
    })),
  });
  await f.committed.promise;
  expect(await f.coordinator.reviewCompletion({ mode: "text", text: "Answer" })).toMatchObject({
    kind: "inconclusive",
    reason: "goal_steward_inconclusive",
  });
  await f.coordinator.closeCoordinator();
});
