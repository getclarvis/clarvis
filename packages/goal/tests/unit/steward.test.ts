import { describe, expect, it } from "bun:test";
import {
  type GoalStewardRuntime,
  buildGoalStewardRequest,
  goalStewardResultSchema,
  validateGoalStewardResult,
} from "#src/index.ts";

describe("Goal Steward contract", () => {
  it("keeps profile, schema, catalog and affinity fixed while appending a new frame", () => {
    const input = {
      mode: "completion" as const,
      execution_id: "first",
      session_id: "conversation",
      projection: "initial definition",
      prompt_cache_ttl: "5m" as const,
      budget: {
        max_net_tokens: 12345,
        timeout_ms: 120000,
        max_iterations: 8,
        call_timeout_ms: 60000,
        max_retries: 1,
      },
    };
    const runtime = {
      model_ref: "fixture/model",
      providers: [],
      reasoning_effort: "medium" as const,
    };
    const first = buildGoalStewardRequest(runtime, input);
    const next = buildGoalStewardRequest(runtime, {
      ...input,
      execution_id: "second",
      continue_from: "first",
      projection: "new completion frame",
    });
    expect(first.profiles).toEqual(next.profiles);
    expect(first.output_schema).toEqual(next.output_schema);
    expect(first.output_schema).toMatchObject({ type: "object" });
    expect(first.profiles[0]).toMatchObject({
      name: "goal-steward",
      tools: [],
      grants: [],
      can_spawn: [],
      reasoning_effort: "medium",
    });
    expect(first.agent_instance_id).toBe(next.agent_instance_id);
    expect(first.session_id).toBe(next.session_id);
    expect(first.budget.total_token_limit).toBe(12345);
    expect(next.continue_from).toBe("first");
    expect(next.messages).toEqual([{ role: "user", content: "new completion frame" }]);
    expect(first.messages).toEqual([{ role: "user", content: "initial definition" }]);
    const fresh = buildGoalStewardRequest(runtime, {
      ...input,
      execution_id: "fresh",
      projection: "different goal",
    });
    expect(fresh.messages).toEqual([{ role: "user", content: "different goal" }]);
    expect(fresh.profiles).toEqual(first.profiles);
    const definition = buildGoalStewardRequest(runtime, { ...input, mode: "definition" });
    expect(JSON.stringify(definition.output_schema)).toContain(
      "accept_definition, revise_definition",
    );
    expect(JSON.stringify(first.output_schema)).toContain("achieved, needs_work, needs_evidence");
    expect(definition.profiles).toEqual(first.profiles);

    expect(fresh.output_schema).toEqual(first.output_schema);
  });

  it("accepts the verdict regardless of auxiliary fields or contradictory assessments", () => {
    for (const verdict of ["achieved", "needs_work", "needs_evidence"] as const) {
      expect(
        validateGoalStewardResult(
          {
            verdict,
            message: "Review commentary",
            decision: "definition",
            summary: 42,
            next_step: null,
            execution_id: "foreign",
            assessments: [
              { scope: "definition", criterion_id: "definition", verdict: "unsatisfied" },
              { scope: "objective", criterion_id: "objective", verdict: "inconclusive" },
            ],
          },
          "completion",
        ),
      ).toEqual({ verdict, message: "Review commentary" });
    }
  });

  it("normalizes optional commentary without rejecting a recognized verdict", () => {
    for (const verdict of [
      "achieved",
      "needs_work",
      "needs_evidence",
      "accept_definition",
      "revise_definition",
    ] as const) {
      const mode = verdict.endsWith("definition") ? "definition" : "completion";
      const fallback = validateGoalStewardResult({ verdict }, mode);
      expect(fallback.message.length).toBeGreaterThan(0);
      for (const message of [undefined, null, 42, {}, [], "", "  "])
        expect(validateGoalStewardResult({ verdict, message }, mode)).toEqual(fallback);
      expect(
        validateGoalStewardResult({ verdict, message: "  Explain the result  " }, mode).message,
      ).toBe("Explain the result");
      expect(validateGoalStewardResult({ verdict, message: "a".repeat(5000) }, mode).message).toBe(
        "a".repeat(4096),
      );
    }
  });

  it("rejects only missing, unrecognized or wrong-operation verdicts", () => {
    for (const value of [
      null,
      [],
      {},
      { verdict: "complete" },
      { verdict: 1 },
      { verdict: ["achieved"] },
    ])
      expect(() => validateGoalStewardResult(value, "completion")).toThrow();
    for (const verdict of ["accept_definition", "revise_definition"])
      expect(() => validateGoalStewardResult({ verdict }, "completion")).toThrow();
    expect(() => validateGoalStewardResult({ verdict: "achieved" }, "definition")).toThrow();
    expect(
      goalStewardResultSchema.parse({ verdict: "accept_definition", message: "Aligned" }),
    ).toEqual({ verdict: "accept_definition", message: "Aligned" });
  });
});

describe("Steward settlement", () => {
  it("charges once, retains bounded reviews and fences stale results", async () => {
    const { applyGoalControl, admitGoalRun, settleStewardEvaluation } =
      await import("#src/index.ts");
    let state = applyGoalControl(
      undefined,
      {
        expected_revision: 0,
        operation_id: "create",
        action: { kind: "create", objective: "Verify output", limits: { max_net_tokens: 10000 } },
      },
      { session_id: "session", new_goal_id: "goal", now: 1, physically_busy: false },
    ).state;
    state = admitGoalRun(state, {
      goal_id: "goal",
      execution_id: "run",
      admission_id: "admit",
      automatic: false,
      expected_revision: state.revision,
      control_revision: state.current!.control_revision,
      now: 2,
    });
    const binding = {
      session_id: "session",
      agent_instance_id: "lead",
      goal_id: "goal",
      execution_id: "run",
      objective_revision: 1,
    };
    const input = {
      mode: "completion" as const,
      binding,
      executionId: "review",
      usage: { kind: "complete" as const, input: 100, output: 10, cached: 60 },
      sequence: 3,
      fingerprint: "fingerprint",
      now: 4,
      continued: true,
      controlRevision: state.current!.control_revision,
    };
    expect(settleStewardEvaluation(state, input).charged).toBe(false);
    state.current!.steward.pending_execution_id = "review";
    const settled = settleStewardEvaluation(state, input);
    expect(settled.charged).toBe(true);
    expect(settled.state.current!.steward.consumption).toMatchObject({
      input: 100,
      output: 10,
      cached: 60,
      net_tokens: 50,
    });
    expect(settleStewardEvaluation(settled.state, input).charged).toBe(false);
    state = settled.state;
    for (const [decision, status] of [
      ["achieved", "verified"],
      ["needs_evidence", "evidence_requested"],
      ["needs_work", "attention"],
      ["interrupted", "attention"],
    ] as const) {
      state.current!.steward.pending_execution_id = "review";
      const review = {
        steward_execution_id: "review",
        mode: "completion" as const,
        goal_id: "goal",
        work_execution_id: "run",
        control_revision: state.current!.control_revision,
        objective_revision: 1,
        definition_digest: "a".repeat(64),
        trajectory_digest: "b".repeat(64),
        plan_context_revision: "absent",
        operator_steering_epoch: 0,
        evidence_digest: "c".repeat(64),
        decision,
        summary: "Reviewed",
        speakers: [],
        usage: input.usage,
        reviewed_at: 4,
      };
      state = settleStewardEvaluation(state, { ...input, review }).state;
      expect(state.current!.steward.status).toBe(status);
    }
    state.current!.steward.pending_execution_id = "review";
    state.current!.status = "paused";
    state = settleStewardEvaluation(state, { ...input, usage: { kind: "unknown" } }).state;
    expect(state.current!.steward.consumption.usage_unknown).toBe(true);
    expect(state.current!.steward.last_steward_execution_id).toBeUndefined();
    state.current!.steward.pending_execution_id = "review";
    state = settleStewardEvaluation(state, {
      ...input,
      usage: { kind: "complete", input: 10, output: 2 },
    }).state;
    expect(state.current!.steward.consumption.cached).toBeUndefined();
  });

  it("retains measured usage on invalid and failed isolated runs", async () => {
    const { runGoalSteward } = await import("#src/index.ts");
    const input = {
      mode: "completion" as const,
      execution_id: "review",
      session_id: "session",
      projection: "frame",
      prompt_cache_ttl: "5m" as const,
      budget: {
        max_net_tokens: 10000,
        timeout_ms: 1000,
        max_iterations: 4,
        call_timeout_ms: 1000,
        max_retries: 0,
      },
    };
    for (const status of ["completed", "invalid", "error", "cancelled"] as const) {
      const runtime: GoalStewardRuntime = {
        owner: "owner",
        model_ref: "fixture/model",
        providers: [],
        deps: {
          executionVisibility: "public",
        } as GoalStewardRuntime["deps"],
        execute_run: async () => ({
          executionId: "review",
          response: {
            ...(status === "error"
              ? { status: "error" as const, error: { code: "fixture", message: "Failure" } }
              : status === "cancelled"
                ? { status: "cancelled" as const, result: null }
                : {
                    status: "completed" as const,
                    result:
                      status === "invalid"
                        ? {}
                        : {
                            verdict: "achieved",
                            message: "Aligned",
                          },
                  }),
            usage: {
              iterations_used: 1,
              elapsed_ms: 1,
              by_agent: [
                {
                  type: "lead" as const,
                  model: "fixture/model",
                  input_tokens: 100,
                  output_tokens: 10,
                  cached_tokens: 60,
                  cache_write_tokens: 0,
                  iterations: 1,
                  subagents_spawned: 0,
                },
              ],
            },
          },
        }),
      };
      if (status === "completed")
        expect((await runGoalSteward(runtime, input)).usage).toEqual({
          kind: "complete",
          input: 100,
          output: 10,
          cached: 60,
        });
      else
        await expect(runGoalSteward(runtime, input)).rejects.toMatchObject({
          execution_id: "review",
          ...(status === "invalid" ? { code: "invalid_output" } : {}),
          usage: { input: 100, cached: 60 },
        });
    }
  });
});
