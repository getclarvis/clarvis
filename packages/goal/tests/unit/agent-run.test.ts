import { describe, expect, it } from "bun:test";
import type { ExecuteRunArgs, ExecuteRunOutcome } from "@clarvis/loop";
import {
  buildGoalAgentRequest,
  applyGoalControl,
  applyGoalFormulation,
  boundedGoalState,
  formulationCriteria,
  goalFormulateInputSchema,
  goalFormulateRequestSchema,
  goalFormulationFingerprint,
  goalFormulationResultSchema,
  recordGoalFormulationReceipt,
  runGoalAgent,
  type GoalAgentRunInput,
  type GoalAgentRuntime,
} from "../../src/index.ts";
import { goalFormulationCorpus } from "../fixtures/formulation-corpus.ts";

const input: GoalAgentRunInput = {
  mode: "guided",
  seed: "  Implemente a spec sem publicar  ",
  execution_id: "formulation-1",
  agent_instance_id: "agent-1",
  session_id: "session-1",
  trajectory: {
    projection: '{"entries":[]}',
    digest: "a".repeat(64),
    truncated: false,
    source_execution_ids: [],
    workspace_read_available: true,
  },
};

const ready = {
  status: "ready" as const,
  objective: "Implementar a especificação",
  criteria: [
    { description: "  Os testes passam  ", kind: "qualitative" as const },
    { description: "Publicação aprovada", kind: "human" as const },
  ],
  constraints: ["Preservar compatibilidade"],
  exclusions: ["Não publicar"],
  assumptions: ["A spec é normativa"],
  normative_source_paths: ["specs/capabilities/goals.md"],
};

describe("Goal semantic agent", () => {
  it("uses the selected main profile while host-enforcing formulation-only authority", () => {
    const request = buildGoalAgentRequest(
      {
        model_ref: "fallback/model",
        providers: [],
        profile: {
          name: "marshall",
          model: "selected/model",
          base_prompt: "Workspace instructions from the selected main agent",
          tools: ["external.tool"],
          grants: ["edit_workspace", "run_commands", "delegate"],
          can_spawn: ["worker"],
          iteration_limit: 20,
        },
      },
      input,
    );
    expect(request.entry).toBe("marshall");
    expect(request.profiles[0]).toMatchObject({
      name: "marshall",
      model: "selected/model",
      tools: [],
      grants: ["read_workspace"],
      can_spawn: [],
    });
    expect(request.profiles[0]!.base_prompt).toContain(
      "Workspace instructions from the selected main agent",
    );
  });

  it("builds one finite isolated request with no MCP or delegation authority", () => {
    const request = buildGoalAgentRequest(
      { model_ref: "fixture/model", providers: [] },
      {
        ...input,
        budget: {
          max_net_tokens: 99_999,
          timeout_ms: 999_999,
          max_iterations: 99,
          call_timeout_ms: 99_999,
          max_retries: 9,
        },
      },
    );
    expect(request).toMatchObject({
      execution_id: "formulation-1",
      session_id: "session-1",
      agent_instance_id: "agent-1",
      entry: "goal-agent",
      servers: [],
      shared_prompt: "",
      budget: { on_exceed: "stop", total_token_limit: 99_999, timeout_ms: 120_000 },
      profiles: [
        {
          name: "goal-agent",
          tools: [],
          grants: ["read_workspace"],
          can_spawn: [],
          iteration_limit: 8,
          call_timeout_ms: 60_000,
          retry: { max_retries: 1 },
        },
      ],
    });
    expect(request.output_schema).toMatchObject({ type: "object", oneOf: expect.any(Array) });
    expect(JSON.parse(request.messages[0]!.content as string)).toMatchObject({
      mode: "guided",
      seed: "Implemente a spec sem publicar",
    });
  });

  it("keeps one byte-identical semantic prefix while mode and trajectory remain volatile", () => {
    const guided = buildGoalAgentRequest({ model_ref: "fixture/model", providers: [] }, input);
    const automatic = buildGoalAgentRequest(
      { model_ref: "fixture/model", providers: [] },
      {
        ...input,
        mode: "auto",
        seed: undefined,
        trajectory: { ...input.trajectory, projection: '{"entries":["different"]}' },
      },
    );
    expect(guided.profiles[0]!.base_prompt).toBe(automatic.profiles[0]!.base_prompt);
    expect(guided.profiles[0]!.base_prompt).not.toContain(input.seed!);
    expect(guided.profiles[0]!.base_prompt).not.toContain(input.trajectory.projection);
    expect(guided.profiles[0]!.base_prompt).toContain("First read the exact named path");
    expect(guided.profiles[0]!.base_prompt).toContain("Formulation is not implementation research");
    expect(guided.messages).not.toEqual(automatic.messages);
    expect(guided.shared_prompt).toBe("");
    expect(automatic.shared_prompt).toBe("");
  });

  it("requires the exact mode shape and bounds guided seeds", () => {
    expect(goalFormulateInputSchema.safeParse({ mode: "auto", seed: "x" }).success).toBe(false);
    expect(goalFormulateInputSchema.safeParse({ mode: "guided" }).success).toBe(false);
    expect(goalFormulateInputSchema.parse({ mode: "guided", seed: "  x  " }).seed).toBe("x");
    expect(
      goalFormulateInputSchema.safeParse({ mode: "guided", seed: "x".repeat(16_385) }).success,
    ).toBe(false);
  });

  it("parses strict transport requests and fingerprints their exact semantic input", () => {
    const auto = goalFormulateRequestSchema.parse({
      session_id: "session-1",
      expected_revision: 0,
      operation_id: "operation-1",
      mode: "auto",
    });
    const guided = goalFormulateRequestSchema.parse({
      session_id: "session-1",
      expected_revision: 0,
      operation_id: "operation-2",
      mode: "guided",
      seed: "  exact seed  ",
    });
    expect(auto).toEqual({
      session_id: "session-1",
      expected_revision: 0,
      operation_id: "operation-1",
      mode: "auto",
    });
    expect(guided.seed).toBe("exact seed");
    expect(goalFormulationFingerprint(auto)).not.toBe(goalFormulationFingerprint(guided));
    expect(
      goalFormulateRequestSchema.safeParse({ ...auto, seed: "forbidden" }).success,
    ).toBeFalse();
    expect(
      goalFormulateRequestSchema.safeParse({ ...guided, seed: undefined }).success,
    ).toBeFalse();
  });

  it("records and replays terminal formulation receipts without creating a Goal", () => {
    const first = recordGoalFormulationReceipt(undefined, {
      expected_revision: 0,
      operation_id: "formulate-receipt",
      fingerprint: "a".repeat(64),
      formulation_execution_id: "analysis-1",
      mode: "guided",
      outcome: "insufficient_context",
      question: "Which target?",
      message: "Two targets remain plausible",
    });
    expect(first).toMatchObject({
      replayed: false,
      start: false,
      state: { revision: 1 },
      receipt: {
        formulation: {
          formulation_execution_id: "analysis-1",
          mode: "guided",
          outcome: "insufficient_context",
          question: "Which target?",
          message: "Two targets remain plausible",
        },
      },
    });
    expect(first.state.current).toBeUndefined();
    expect(
      recordGoalFormulationReceipt(first.state, {
        expected_revision: 0,
        operation_id: "formulate-receipt",
        fingerprint: "a".repeat(64),
        mode: "guided",
        outcome: "insufficient_context",
      }),
    ).toMatchObject({ replayed: true, receipt: first.receipt });
    expect(() =>
      recordGoalFormulationReceipt(first.state, {
        expected_revision: 1,
        operation_id: "formulate-receipt",
        fingerprint: "b".repeat(64),
        mode: "guided",
        outcome: "failed",
      }),
    ).toThrow("different goal control");
    expect(() =>
      recordGoalFormulationReceipt(first.state, {
        expected_revision: 0,
        operation_id: "another-operation",
        fingerprint: "c".repeat(64),
        mode: "auto",
        outcome: "stale_context",
      }),
    ).toThrow("revision changed");
  });

  it("accepts ready and insufficient output and rejects untrusted or duplicated fields", () => {
    expect(goalFormulationResultSchema.parse(ready)).toEqual({
      ...ready,
      criteria: [{ ...ready.criteria[0]!, description: "Os testes passam" }, ready.criteria[1]!],
    });
    expect(
      goalFormulationResultSchema.parse({
        status: "insufficient_context",
        question: "Qual repositório?",
        reason: "Duas leituras continuam plausíveis",
      }),
    ).toMatchObject({ status: "insufficient_context" });
    for (const invalid of [
      { ...ready, revision: 1 },
      { ...ready, criteria: [{ description: "x", kind: "host" }] },
      { ...ready, constraints: ["same"], assumptions: [" SAME "] },
      { ...ready, objective: " " },
      { ...ready, normative_source_paths: Array.from({ length: 17 }, (_, index) => `s${index}`) },
    ])
      expect(goalFormulationResultSchema.safeParse(invalid).success).toBe(false);
  });

  it("keeps the material request represented across the bilingual formulation corpus", () => {
    for (const fixture of goalFormulationCorpus) {
      const result = goalFormulationResultSchema.parse(fixture.result);
      const representation = JSON.stringify(result);
      for (const fragment of fixture.required_fragments)
        expect(representation.toLocaleLowerCase()).toContain(fragment.toLocaleLowerCase());
      if (fixture.mode === "guided")
        expect(goalFormulateInputSchema.parse({ mode: fixture.mode, seed: fixture.seed! })).toEqual(
          {
            mode: "guided",
            seed: fixture.seed!,
          },
        );
    }
  });

  it("assigns deterministic host criterion ids and preserves only allowed kinds", () => {
    expect(formulationCriteria(ready)).toEqual([
      { id: "criterion-01", description: "Os testes passam", kind: "qualitative" },
      { id: "criterion-02", description: "Publicação aprovada", kind: "human" },
    ]);
  });

  it("executes with callPurpose goal and returns measured usage", async () => {
    let captured: ExecuteRunArgs | undefined;
    const events: string[] = [];
    const runtime = {
      owner: "owner",
      model_ref: "fixture/model",
      providers: [],
      deps: {
        executionVisibility: "public",
      } as GoalAgentRuntime["deps"],
      async execute_run(args: ExecuteRunArgs): Promise<ExecuteRunOutcome> {
        captured = args;
        args.onEvent?.({
          type: "subagent_iteration_started",
          subagent_instance_id: "agent-1",
          iteration: 1,
          started_at: 1,
          model: "fixture/model",
        });
        return {
          executionId: "formulation-1",
          response: {
            status: "completed",
            result: ready,
            usage: {
              iterations_used: 1,
              elapsed_ms: 2,
              by_agent: [
                {
                  type: "lead",
                  model: "fixture/model",
                  input_tokens: 100,
                  output_tokens: 20,
                  cached_tokens: 60,
                  cache_write_tokens: 0,
                  iterations: 1,
                  subagents_spawned: 0,
                },
              ],
            },
          },
        };
      },
    } satisfies GoalAgentRuntime;
    const result = await runGoalAgent(runtime, {
      ...input,
      on_event: (event) => events.push(event.type),
    });
    expect(captured).toMatchObject({ owner: "owner", callPurpose: "goal" });
    expect(events).toEqual(["subagent_iteration_started"]);
    expect(result).toMatchObject({
      execution_id: "formulation-1",
      result: { status: "ready" },
      usage: { kind: "complete", input: 100, output: 20, cached: 60 },
    });
  });

  it("retains measured usage when a completed run submits invalid output", async () => {
    const runtime = {
      owner: "owner",
      model_ref: "fixture/model",
      providers: [],
      deps: {
        executionVisibility: "public",
      } as GoalAgentRuntime["deps"],
      async execute_run(): Promise<ExecuteRunOutcome> {
        return {
          executionId: "formulation-1",
          response: {
            status: "completed",
            result: { status: "ready", objective: "missing fields" },
            usage: {
              iterations_used: 1,
              elapsed_ms: 2,
              by_agent: [
                {
                  type: "lead",
                  model: "fixture/model",
                  input_tokens: 70,
                  output_tokens: 5,
                  cached_tokens: 20,
                  cache_write_tokens: 0,
                  iterations: 1,
                  subagents_spawned: 0,
                },
              ],
            },
          },
        };
      },
    } satisfies GoalAgentRuntime;
    await expect(runGoalAgent(runtime, input)).rejects.toMatchObject({
      name: "GoalAgentRunFailure",
      usage: { kind: "complete", input: 70, output: 5, cached: 20 },
    });
  });

  it("defaults old records and turns semantic edits into a new literal declaration", () => {
    const created = applyGoalFormulation(
      undefined,
      {
        objective: ready.objective,
        criteria: formulationCriteria(ready),
        constraints: ready.constraints,
        exclusions: ready.exclusions,
        assumptions: ready.assumptions,
      },
      {
        session_id: "session-1",
        new_goal_id: "goal-1",
        new_execution_id: "work-1",
        now: 1,
        physically_busy: false,
        default_limits: { max_net_tokens: 10_000 },
        operation_id: "formulate-1",
        expected_revision: 0,
        fingerprint: "b".repeat(64),
        sources: [{ path: "specs/capabilities/goals.md", digest: "c".repeat(64) }],
        origin: {
          kind: "guided",
          seed: "Implemente a spec",
          formulation_execution_id: "formulation-1",
          source_session_revision: 2,
          source_execution_ids: ["prior-1"],
          trajectory_digest: "d".repeat(64),
          trajectory_truncated: false,
        },
      },
    );
    expect(created.receipt.formulation).toEqual({
      formulation_execution_id: "formulation-1",
      mode: "guided",
      outcome: "created",
    });
    created.state.current!.candidate = {
      objective_revision: 1,
      execution_id: "work-1",
      summary: "candidate",
      assessments: [
        {
          criterion_id: "criterion-01",
          kind: "qualitative",
          justification: "evidence",
          evidence: [],
        },
      ],
    };
    created.state.current!.human_acceptances = [
      {
        criterion_id: "criterion-02",
        objective_revision: 1,
        operation_id: "accept-1",
        accepted_at: 2,
      },
    ];
    const edited = applyGoalControl(
      created.state,
      {
        expected_revision: created.state.revision,
        operation_id: "edit-1",
        action: { kind: "edit", assumptions: ["Explicit user correction"] },
      },
      { session_id: "session-1", now: 3, physically_busy: false },
    );
    expect(edited.state.current).toMatchObject({
      objective_revision: 2,
      assumptions: ["Explicit user correction"],
      sources: [],
      origin: { kind: "literal" },
      human_acceptances: [],
    });
    expect(edited.state.current!.candidate).toBeUndefined();

    const old = structuredClone(edited.state) as unknown as Record<string, unknown>;
    const current = old.current as Record<string, unknown>;
    delete current.constraints;
    delete current.exclusions;
    delete current.assumptions;
    delete current.sources;
    delete current.origin;
    expect(boundedGoalState(old).current).toMatchObject({
      constraints: [],
      exclusions: [],
      assumptions: [],
      sources: [],
      origin: { kind: "literal" },
    });
  });
});
