import { describe, expect, it } from "bun:test";
import type { ExecuteRunArgs, ExecuteRunOutcome } from "@clarvis/loop";
import {
  admitGoalRun,
  advanceGoalRun,
  applyGoalControl,
  buildGoalVerificationRequest,
  currentGoalVerification,
  goalCandidateDigest,
  goalDefinitionDigest,
  goalFinalAttemptDigest,
  goalStateSchema,
  limitGoalForVerificationBudget,
  recordGoalCandidate,
  recordGoalVerification,
  runGoalVerification,
  validateGoalCandidate,
  validateGoalVerificationResult,
  verificationAssessmentSummary,
  type GoalAgentRuntime,
  type GoalState,
  type GoalVerification,
} from "../../src/index.ts";
import { goalVerificationCorpus } from "../fixtures/verification-corpus.ts";

function running(): GoalState {
  let state = applyGoalControl(
    undefined,
    {
      expected_revision: 0,
      operation_id: "create",
      action: {
        kind: "create",
        objective: "Implement the requested behavior",
        criteria: [{ id: "quality", description: "Behavior is complete", kind: "qualitative" }],
        limits: { max_net_tokens: 100_000 },
      },
    },
    { session_id: "session", new_goal_id: "goal", now: 1, physically_busy: false },
  ).state;
  state = admitGoalRun(state, {
    goal_id: "goal",
    expected_revision: state.revision,
    control_revision: state.current!.control_revision,
    execution_id: "primary",
    admission_id: "admission",
    automatic: false,
    now: 2,
  });
  state = advanceGoalRun(state, {
    goal_id: "goal",
    execution_id: "primary",
    phase: "running",
    now: 3,
  });
  return recordGoalCandidate(state, {
    goal_id: "goal",
    execution_id: "primary",
    now: 4,
    candidate: {
      objective_revision: 1,
      execution_id: "primary",
      summary: "Implementation finished",
      assessments: [
        {
          criterion_id: "quality",
          kind: "qualitative",
          justification: "The requested behavior is present",
          evidence: [],
        },
      ],
    },
  });
}

const assessments = [
  {
    scope: "definition" as const,
    verdict: "satisfied" as const,
    rationale: "The durable definition retains the request",
    evidence_ids: [] as string[],
    inspected_paths: [] as string[],
  },
  {
    scope: "objective" as const,
    verdict: "satisfied" as const,
    rationale: "The observable result exists",
    evidence_ids: [] as string[],
    inspected_paths: [] as string[],
  },
  {
    scope: "criterion" as const,
    criterion_id: "quality",
    verdict: "satisfied" as const,
    rationale: "The qualitative condition is satisfied",
    evidence_ids: [] as string[],
    inspected_paths: [] as string[],
  },
];

describe("independent Goal verification", () => {
  it("accepts the deterministic bilingual semantic-verification corpus", () => {
    expect(new Set(goalVerificationCorpus.map((fixture) => fixture.locale))).toEqual(
      new Set(["en", "pt-BR"]),
    );
    expect(goalVerificationCorpus).toHaveLength(15);
    for (const fixture of goalVerificationCorpus)
      expect(validateGoalVerificationResult(fixture.expected, ["quality"], []).verdict).toBe(
        fixture.expected.verdict,
      );
  });

  it("requires exact definition, objective and qualitative criterion coverage", () => {
    expect(
      validateGoalVerificationResult(
        { verdict: "achieved", summary: "Verified", assessments },
        ["quality"],
        [],
      ).verdict,
    ).toBe("achieved");
    for (const invalid of [
      assessments.slice(1),
      [...assessments, assessments[2]],
      assessments.map((item) =>
        item.scope === "criterion" ? { ...item, criterion_id: "invented" } : item,
      ),
    ])
      expect(() =>
        validateGoalVerificationResult(
          { verdict: "achieved", summary: "Invalid", assessments: invalid },
          ["quality"],
          [],
        ),
      ).toThrow();
  });

  it("enforces global verdict consistency and host-owned evidence IDs", () => {
    expect(() =>
      validateGoalVerificationResult(
        {
          verdict: "achieved",
          summary: "Contradictory",
          assessments: assessments.map((item, index) =>
            index === 1 ? { ...item, verdict: "unsatisfied" } : item,
          ),
        },
        ["quality"],
        [],
      ),
    ).toThrow();
    expect(() =>
      validateGoalVerificationResult(
        {
          verdict: "not_achieved",
          summary: "Contradictory",
          assessments: assessments.map((item, index) =>
            index === 1 ? { ...item, verdict: "inconclusive" } : item,
          ),
        },
        ["quality"],
        [],
      ),
    ).toThrow();
    expect(() =>
      validateGoalVerificationResult(
        { verdict: "not_achieved", summary: "Contradictory", assessments },
        ["quality"],
        [],
      ),
    ).toThrow();
    expect(() =>
      validateGoalVerificationResult(
        {
          verdict: "achieved",
          summary: "Invented evidence",
          assessments: assessments.map((item, index) =>
            index === 1 ? { ...item, evidence_ids: ["missing"] } : item,
          ),
        },
        ["quality"],
        ["known"],
      ),
    ).toThrow();
  });

  it("executes the isolated verifier and retains accounting on terminal failures", async () => {
    const outcome = (status: ExecuteRunOutcome["response"]["status"], result: unknown) => ({
      executionId: "verification",
      response: {
        status,
        result,
        usage: {
          iterations_used: 1,
          elapsed_ms: 2,
          by_agent: [
            {
              type: "lead" as const,
              model: "fixture/model",
              input_tokens: 12,
              output_tokens: 3,
              cached_tokens: 4,
              cache_write_tokens: 0,
              iterations: 1,
              subagents_spawned: 0,
            },
          ],
        },
      },
    });
    let next = outcome("completed", {
      verdict: "achieved",
      summary: "Verified",
      assessments,
    }) as ExecuteRunOutcome;
    let captured: ExecuteRunArgs | undefined;
    const runtime = {
      owner: "owner",
      model_ref: "fixture/model",
      providers: [],
      deps: {} as GoalAgentRuntime["deps"],
      async execute_run(args: ExecuteRunArgs): Promise<ExecuteRunOutcome> {
        captured = args;
        return next;
      },
    } satisfies GoalAgentRuntime;
    const input = {
      execution_id: "verification",
      agent_instance_id: "agent",
      session_id: "session",
      projection: "{}",
      budget: {
        max_net_tokens: 16_000,
        timeout_ms: 90_000,
        max_iterations: 6,
        call_timeout_ms: 60_000,
        max_retries: 1,
      },
    };

    await expect(runGoalVerification(runtime, input)).resolves.toMatchObject({
      execution_id: "verification",
      result: { verdict: "achieved" },
      usage: { kind: "measured", input: 12, output: 3, cached: 4 },
    });
    expect(captured).toMatchObject({ owner: "owner", callPurpose: "goal" });
    expect(
      (
        captured!.rawBody as {
          output_schema: { properties: { assessments: { items: { oneOf: unknown[] } } } };
        }
      ).output_schema.properties.assessments.items.oneOf,
    ).toEqual([
      expect.objectContaining({
        required: expect.not.arrayContaining(["criterion_id"]),
        properties: expect.objectContaining({ scope: { const: "definition" } }),
      }),
      expect.objectContaining({
        required: expect.not.arrayContaining(["criterion_id"]),
        properties: expect.objectContaining({ scope: { const: "objective" } }),
      }),
      expect.objectContaining({
        required: expect.arrayContaining(["criterion_id"]),
        properties: expect.objectContaining({ scope: { const: "criterion" } }),
      }),
    ]);

    next = outcome("error", undefined) as ExecuteRunOutcome;
    await expect(runGoalVerification(runtime, input)).rejects.toMatchObject({
      execution_id: "verification",
      usage: { kind: "measured", input: 12, output: 3, cached: 4 },
    });
    next = outcome("completed", { verdict: "achieved" }) as ExecuteRunOutcome;
    await expect(runGoalVerification(runtime, input)).rejects.toMatchObject({
      execution_id: "verification",
      usage: { kind: "measured", input: 12, output: 3, cached: 4 },
    });
  });

  it("summarizes only semantic failures and rejects checkpoint result digests", () => {
    expect(
      verificationAssessmentSummary([
        assessments[0]!,
        { ...assessments[1]!, verdict: "inconclusive" },
        { ...assessments[2]!, verdict: "unsatisfied" },
      ]),
    ).toEqual(["objective: inconclusive", "quality: unsatisfied"]);
    expect(() => goalFinalAttemptDigest({ mode: "checkpoint", summary: "later" })).toThrow(
      "checkpoint",
    );
  });

  it("builds a finite read-only verify request without mutation authority", () => {
    const request = buildGoalVerificationRequest(
      { model_ref: "fixture/model", providers: [] },
      {
        execution_id: "verification",
        agent_instance_id: "agent",
        session_id: "session",
        projection: "{}",
        budget: {
          max_net_tokens: 16_000,
          timeout_ms: 90_000,
          max_iterations: 6,
          call_timeout_ms: 60_000,
          max_retries: 1,
        },
      },
    );
    expect(request).toMatchObject({
      entry: "goal-agent",
      servers: [],
      shared_prompt: "",
      budget: { total_token_limit: 16_000, on_exceed: "stop", timeout_ms: 90_000 },
      profiles: [
        {
          name: "goal-agent",
          grants: ["read_workspace"],
          tools: [],
          can_spawn: [],
          iteration_limit: 6,
          call_timeout_ms: 60_000,
        },
      ],
    });
  });

  it("keeps all semantic and terminal digests stable and change-sensitive", () => {
    const state = running();
    const goal = state.current!;
    const definition = goalDefinitionDigest(goal);
    const candidate = goalCandidateDigest(goal.candidate!);
    const attempt = goalFinalAttemptDigest({ mode: "text", text: "Done" });
    expect(goalDefinitionDigest(structuredClone(goal))).toBe(definition);
    expect(goalCandidateDigest(structuredClone(goal.candidate!))).toBe(candidate);
    expect(goalFinalAttemptDigest("Done")).toBe(attempt);
    expect(goalDefinitionDigest({ ...goal, constraints: ["New limit"] })).not.toBe(definition);
    expect(goalCandidateDigest({ ...goal.candidate!, summary: "Changed" })).not.toBe(candidate);
    expect(goalFinalAttemptDigest("Different")).not.toBe(attempt);
  });

  it("persists at most four fenced audits and defaults old runs to none", () => {
    let state = running();
    const parsedOld = structuredClone(state) as unknown as {
      current: { runs: Array<Record<string, unknown>> };
    };
    delete parsedOld.current.runs[0]!.verifications;
    expect(goalStateSchema.parse(parsedOld).current!.runs[0]!.verifications).toEqual([]);
    for (let index = 0; index < 5; index++) {
      const goal = state.current!;
      const fence = {
        goal_id: goal.goal_id,
        execution_id: "primary",
        control_revision: goal.control_revision,
        objective_revision: goal.objective_revision,
        definition_digest: goalDefinitionDigest(goal),
        candidate_digest: goalCandidateDigest(goal.candidate!),
        final_attempt_digest: goalFinalAttemptDigest(`Attempt ${index}`),
        evidence_digest: "a".repeat(64),
      };
      const verification: GoalVerification = {
        verification_execution_id: `verify-${index}`,
        control_revision: fence.control_revision,
        objective_revision: fence.objective_revision,
        definition_digest: fence.definition_digest,
        candidate_digest: fence.candidate_digest,
        final_attempt_digest: fence.final_attempt_digest,
        evidence_digest: fence.evidence_digest,
        verdict: "achieved",
        summary: `Verification ${index}`,
        assessments,
        inspected_artifacts: [],
        usage: { kind: "measured", input: 1, output: 1, cached: 0 },
        verified_at: 10 + index,
      };
      state = recordGoalVerification(state, { ...fence, verification, now: 10 + index });
      expect(currentGoalVerification(state.current!, fence)).toEqual(verification);
    }
    expect(state.current!.runs[0]!.verifications).toHaveLength(4);
    expect(state.current!.runs[0]!.verifications[0]!.verification_execution_id).toBe("verify-1");
  });

  it("blocks invalid host and human criteria before semantic verification", async () => {
    const goal = running().current!;
    goal.criteria = [
      {
        id: "host-check",
        description: "Host check passes",
        kind: "host",
        verification: { kind: "tool_success", tool_name: "shell" },
      },
      { id: "human", description: "Owner approves", kind: "human" },
    ];
    goal.candidate = {
      objective_revision: 1,
      execution_id: "primary",
      summary: "Claimed complete",
      assessments: [
        { criterion_id: "host-check", kind: "host", justification: "Claimed", evidence: [] },
        { criterion_id: "human", kind: "human", justification: "Claimed", evidence: [] },
      ],
    };
    const result = await validateGoalCandidate(goal, goal.candidate, {
      verify: async () => ({ valid: false }),
    });
    expect(result.valid).toBeFalse();
    expect(result.reasons.join(" ")).toContain("host-verifiable evidence");
    expect(result.reasons.join(" ")).toContain("recorded user decision");
  });

  it("marks an unpartitionable stage budget before physical admission", () => {
    const active = applyGoalControl(
      undefined,
      {
        expected_revision: 0,
        operation_id: "create-small",
        action: {
          kind: "create",
          objective: "Remain conservatively bounded",
          limits: { max_net_tokens: 1 },
        },
      },
      { session_id: "session", new_goal_id: "small", now: 1, physically_busy: false },
    ).state;
    const limited = limitGoalForVerificationBudget(active, {
      goal_id: "small",
      control_revision: active.current!.control_revision,
      reason: "Cannot reserve both partitions",
      now: 2,
    });
    expect(limited.current).toMatchObject({
      status: "budget_limited",
      reason: "Cannot reserve both partitions",
      runs: [],
    });
    expect(limited.revision).toBe(active.revision + 1);
  });
});
