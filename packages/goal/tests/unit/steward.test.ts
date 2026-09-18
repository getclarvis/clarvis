import { describe, expect, it } from "bun:test";
import {
  type GoalStewardRuntime,
  buildGoalStewardRequest,
  goalStewardResultSchema,
  validateGoalStewardResult,
} from "../../src/index.ts";

const assessment = (
  scope: "definition" | "objective" | "criterion",
  verdict: "satisfied" | "unsatisfied" | "inconclusive" = "satisfied",
  criterion_id?: string,
) => ({
  scope,
  verdict,
  ...(criterion_id === undefined ? {} : { criterion_id }),
  rationale: "Observed the requested output",
  evidence_ids: [],
  inspected_paths: [],
});

describe("Goal Steward contract", () => {
  it("keeps profile, schema, catalog and affinity fixed while appending a new frame", () => {
    const input = {
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
      operator_instructions: [
        { scope: "global" as const, source: "AGENTS.md", content: "Validate changes" },
      ],
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
    expect(first.profiles[0]).toMatchObject({
      name: "goal-steward",
      tools: [],
      grants: ["read_workspace"],
      can_spawn: [],
    });
    expect(first.agent_instance_id).toBe(next.agent_instance_id);
    expect(first.session_id).toBe(next.session_id);
    expect(first.budget.total_token_limit).toBe(12345);
    expect(next.continue_from).toBe("first");
    expect(next.messages).toEqual([{ role: "user", content: "new completion frame" }]);
    expect(first.messages[0]!.content).toContain("Validate changes");
    const fresh = buildGoalStewardRequest(
      {
        ...runtime,
        operator_instructions: [
          { content: "Validate changes", source: "AGENTS.md", scope: "global" },
        ],
      },
      { ...input, execution_id: "fresh", projection: "different goal" },
    );
    expect(fresh.messages[0]).toEqual(first.messages[0]);
    expect(fresh.profiles).toEqual(first.profiles);
    expect(fresh.output_schema).toEqual(first.output_schema);
  });

  it("rejects authority fields, inconsistent verdicts and invented target references", () => {
    expect(
      goalStewardResultSchema.safeParse({
        decision: "steer",
        summary: "Focus",
        guidance: "Finish",
        execution_id: "fake",
      }).success,
    ).toBe(false);
    const complete = {
      decision: "completion" as const,
      verdict: "achieved",
      summary: "Entregue",
      assessments: [
        assessment("definition"),
        assessment("objective"),
        assessment("criterion", "satisfied", "c1"),
      ],
    };
    expect(validateGoalStewardResult(complete, "completion", ["c1"], []).decision).toBe(
      "completion",
    );
    expect(() => validateGoalStewardResult(complete, "completion", ["c2"], [])).toThrow();
    expect(() => validateGoalStewardResult(complete, "observation", ["c1"], [])).toThrow();
    expect(
      goalStewardResultSchema.safeParse({
        ...complete,
        assessments: [assessment("definition"), assessment("objective", "unsatisfied")],
      }).success,
    ).toBe(false);
    expect(
      goalStewardResultSchema.safeParse({
        ...complete,
        assessments: [assessment("definition"), assessment("definition")],
      }).success,
    ).toBe(false);
    expect(() =>
      validateGoalStewardResult({ decision: "aligned", summary: "On track" }, "completion", [], []),
    ).toThrow();
  });
});

it.each([
  {
    label: "Entrega observada / observed delivery",
    verdict: "achieved",
    objective: "satisfied",
    criterion: "satisfied",
    next: undefined,
  },
  {
    label: "Promessa sem entrega / promise without delivery",
    verdict: "not_achieved",
    objective: "unsatisfied",
    criterion: "satisfied",
    next: "Entregue o resultado / deliver the result",
  },
  {
    label: "Pedido composto incompleto / partial compound request",
    verdict: "not_achieved",
    objective: "unsatisfied",
    criterion: "unsatisfied",
    next: "Conclua a segunda parte / finish the second part",
  },
  {
    label: "Restrição violada / violated constraint",
    verdict: "not_achieved",
    objective: "satisfied",
    criterion: "unsatisfied",
    next: "Respeite a restrição / satisfy the constraint",
  },
  {
    label: "Exclusão invadida / excluded work",
    verdict: "not_achieved",
    objective: "satisfied",
    criterion: "unsatisfied",
    next: "Retorne ao escopo / return to scope",
  },
  {
    label: "Plan incompleto / incomplete Plan",
    verdict: "not_achieved",
    objective: "unsatisfied",
    criterion: "satisfied",
    next: "Finalize a tarefa necessária / finish the necessary task",
  },
  {
    label: "Artifact alterado / changed artifact",
    verdict: "inconclusive",
    objective: "inconclusive",
    criterion: "satisfied",
    next: undefined,
  },
  {
    label: "Ambiguidade / ambiguity",
    verdict: "inconclusive",
    objective: "inconclusive",
    criterion: "inconclusive",
    next: undefined,
  },
])("keeps bilingual assessment consistency: $label", (scenario) => {
  const result = {
    decision: "completion" as const,
    verdict: scenario.verdict,
    summary: scenario.label,
    assessments: [
      assessment("definition"),
      assessment("objective", scenario.objective),
      assessment("criterion", scenario.criterion, "requested"),
    ],
    ...(scenario.next === undefined ? {} : { next_step: scenario.next }),
  };
  expect(validateGoalStewardResult(result, "completion", ["requested"], [])).toEqual(result);
  if (scenario.verdict !== "achieved")
    expect(goalStewardResultSchema.safeParse({ ...result, verdict: "achieved" }).success).toBe(
      false,
    );
});

describe("Steward settlement", () => {
  it("charges once, retains bounded reviews and fences stale results", async () => {
    const { applyGoalControl, admitGoalRun, settleStewardEvaluation } =
      await import("../../src/index.ts");
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
      binding,
      executionId: "review",
      usage: { kind: "measured" as const, input: 100, output: 10, cached: 60 },
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
      ["aligned", "aligned"],
      ["new_run", "new_run_recommended"],
      ["steer", "intervened"],
      ["inconclusive", "attention"],
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
        inspected_artifacts: [],
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
      usage: { kind: "measured", input: 10, output: 2 },
    }).state;
    expect(state.current!.steward.consumption.cached).toBeUndefined();
  });

  it("retains measured usage on invalid and failed isolated runs", async () => {
    const { runGoalSteward } = await import("../../src/index.ts");
    const input = {
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
                    result: status === "invalid" ? {} : { decision: "aligned", summary: "Aligned" },
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
          kind: "measured",
          input: 100,
          output: 10,
          cached: 60,
        });
      else
        await expect(runGoalSteward(runtime, input)).rejects.toMatchObject({
          execution_id: "review",
          usage: { input: 100, cached: 60 },
        });
    }
  });
});
