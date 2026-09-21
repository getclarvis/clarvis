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
    progress: async () => ({ kind: "ok", value: undefined }),
    candidate: async () => ({
      kind: "ok",
      value: {
        valid: true,
        reasons: [],
        qualitative_criteria: [],
        revision: state.revision,
      },
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
      state.current!.runs.at(-1)!.impediment = { reason, declared_at: 10 };
    },
  };
  const calls: GoalStewardRunInput[] = [];
  const admitted = Promise.withResolvers<void>();
  const settle = Promise.withResolvers<GoalStewardResult>();
  let charged = 0;
  const coordinator = createGoalStewardCoordinator({
    binding,
    repository,
    runtimePort: port,
    initialMessages: ["Deliver the answer"],
    signal: new AbortController().signal,
    runtime: () => ({
      fingerprint: "same",
      promptCacheTtl: "5m",
      maxReviews: options.maxReviews ?? 8,
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
    changed() {},
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
    setPlanRevision(value: string) {
      planRevision = value;
    },
    calls,
    admitted,
    settle,
    state: () => state,
    charged: () => charged,
  };
}

describe("Goal Steward coordinator", () => {
  it("reviews only completion and retains independently charged usage", async () => {
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
      })),
    });
    expect((await f.coordinator.reviewCompletion({ mode: "text", text: "The answer" })).kind).toBe(
      "achieved",
    );
    await f.coordinator.closeCoordinator();
    expect(f.charged()).toBe(1);
    expect(f.state().current!.consumption.net_tokens).toBe(0);
    expect(f.state().current!.steward.consumption.net_tokens).toBe(60);
    expect(f.calls[0]!.budget.max_net_tokens).toBe(10000);
  });

  it("discards a completion review after accepted human steering but still accounts for it", async () => {
    const f = fixture();
    const pending = f.coordinator.reviewCompletion({ mode: "text", text: "The answer" });
    await f.admitted.promise;
    f.coordinator.observe({
      type: "user_steering",
      agent: "lead",
      message: "Changed direction",
      iteration_ref: 1,
    } as TraceEvent);
    f.settle.resolve({
      decision: "completion",
      verdict: "achieved",
      summary: "Old",
      assessments: ["definition", "objective"].map((scope) => ({
        scope: scope as "definition" | "objective",
        verdict: "satisfied",
        rationale: "Old direction",
        evidence_ids: [],
      })),
    });
    expect((await pending).kind).toBe("interrupted");
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
  it("does not discard a completion decision when only Plan context changes", async () => {
    const f = fixture();
    const pending = f.coordinator.reviewCompletion({ mode: "text", text: "The answer" });
    await f.admitted.promise;
    f.setPlanRevision("edited");
    f.settle.resolve({
      decision: "completion",
      verdict: "needs_work",
      summary: "Review",
      next_step: "Finish the current plan",
      assessments: ["definition", "objective"].map((scope) => ({
        scope: scope as "definition" | "objective",
        verdict: "unsatisfied",
        rationale: "Plan changed",
        evidence_ids: [],
      })),
    });
    expect((await pending).kind).toBe("needs_work");
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
      })),
    });
    expect((await f.coordinator.reviewCompletion({ mode: "text", text: "Answer" })).kind).toBe(
      "interrupted",
    );
    expect(f.state().current!.steward.consumption.usage_unknown).toBe(true);
    expect(f.state().current!.consumption.net_tokens).toBe(0);
    expect(f.state().current!.steward.status).toBe("attention");
    expect(f.state().current!.runs[0]!.steward_reviews.at(-1)).toMatchObject({
      decision: "interrupted",
      interruption_cause: "usage_unknown",
    });
    expect(f.state().current!.steward.last_steward_execution_id).toBeUndefined();
    await f.coordinator.closeCoordinator();
  });

  it("retains cancellation until completion-review settlement and leaves no pending reservation", async () => {
    const f = fixture({ honorAbort: true });
    const pending = f.coordinator.reviewCompletion({ mode: "text", text: "Answer" });
    await f.admitted.promise;
    await f.coordinator.closeCoordinator();
    expect((await pending).kind).toBe("interrupted");
    expect(f.state().current!.steward.pending_execution_id).toBeUndefined();
    expect(f.charged()).toBe(1);
    expect(f.calls).toHaveLength(1);
  });
});

describe("Goal Steward recovery", () => {
  it("retires an orphaned reservation once and never replays a write", async () => {
    const f = fixture();
    f.state().current!.steward.pending_execution_id = "crashed-steward";
    f.settle.resolve({
      decision: "completion",
      verdict: "achieved",
      summary: "Recovered completion review",
      assessments: ["definition", "objective"].map((scope) => ({
        scope: scope as "definition" | "objective",
        verdict: "satisfied",
        rationale: "Answer observed",
        evidence_ids: [],
      })),
    });
    expect((await f.coordinator.reviewCompletion({ mode: "text", text: "Answer" })).kind).toBe(
      "achieved",
    );
    await f.coordinator.closeCoordinator();
    expect(f.charged()).toBe(2);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.continue_from).toBeUndefined();
    expect(f.state().current!.steward.pending_execution_id).toBeUndefined();
    expect(f.state().current!.steward.consumption.usage_unknown).toBe(true);
  });
});

for (const maxReviews of [1, 2]) {
  it(`admits the last bounded completion review (${maxReviews})`, async () => {
    const f = fixture({ maxReviews });
    f.state().current!.runs[0]!.steward_review_count = maxReviews - 1;
    f.settle.resolve({
      decision: "completion",
      verdict: "achieved",
      summary: "Delivered",
      assessments: ["definition", "objective"].map((scope) => ({
        scope: scope as "definition" | "objective",
        verdict: "satisfied",
        rationale: "Observed",
        evidence_ids: [],
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
it("returns a semantic evidence request without classifying it as a runtime failure", async () => {
  const f = fixture();
  f.settle.resolve({
    decision: "completion",
    verdict: "needs_evidence",
    next_step: "Provide the missing evidence",
    summary: "Evidence unavailable",
    assessments: ["definition", "objective"].map((scope) => ({
      scope: scope as "definition" | "objective",
      verdict: "inconclusive",
      rationale: "Missing evidence",
      evidence_ids: [],
    })),
  });
  expect(await f.coordinator.reviewCompletion({ mode: "text", text: "Answer" })).toMatchObject({
    kind: "needs_evidence",
    next_step: "Provide the missing evidence",
  });
  await f.coordinator.closeCoordinator();
});
