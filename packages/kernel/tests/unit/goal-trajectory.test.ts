import { describe, expect, it } from "bun:test";
import type { RunDetail, Session } from "@clarvis/protocol";
import type { GoalCandidate, GoalRecord } from "@clarvis/goal";
import { projectGoalTrajectory } from "../../src/goals/trajectory.ts";
import { projectGoalVerificationInput } from "../../src/goals/verification-input.ts";

const session = (turns: Session["turns"]): Session => ({
  id: "session",
  title: "Trajectory",
  project_id: "project",
  workspace: "workspace",
  created_at: 1,
  updated_at: 10,
  revision: 4,
  turns,
  totals: { input: 0, output: 0 },
});

const run = (
  execution_id: string,
  created_at: number,
  fields: Partial<RunDetail> = {},
): RunDetail =>
  ({
    execution_id,
    created_at,
    ended_at: created_at + 10,
    status: "completed",
    messages: [],
    events: [],
    ...fields,
  }) as RunDetail;

describe("Goal trajectory projection", () => {
  it("reconstructs continuation chronology and keeps only semantic user-owned evidence", async () => {
    const runs = new Map<string, RunDetail>([
      [
        "root",
        run("root", 10, {
          messages: [
            { role: "user", content: "Primeiro pedido token=super-secret-value" },
            { role: "assistant", content: "provider metadata must not be projected" },
          ],
          events: [
            {
              type: "iteration_completed",
              at: 11,
              agent: "lead",
              iteration: 1,
              response: "rascunho interno",
              response_phase: "commentary",
              input_tokens: 1,
              output_tokens: 1,
            },
            {
              type: "iteration_completed",
              at: 12,
              agent: "lead",
              iteration: 2,
              response: "resultado final",
              response_phase: "final_answer",
              input_tokens: 1,
              output_tokens: 1,
            },
            { type: "steering_applied", at: 13, agent: "lead", message: "Corrija: sem publicar" },
            {
              type: "elicitation_resolved",
              at: 14,
              question: "Qual branch?",
              outcome: "accept",
              answer: "develop",
            },
            {
              type: "tool_call",
              at: 15,
              agent: "lead",
              server: "tools",
              tool: "read_file",
              arguments: { path: "secret" },
              ok: true,
              result: "secret payload",
            },
            { type: "run_ended", at: 16, status: "completed" },
          ] as RunDetail["events"],
        }),
      ],
      [
        "child",
        run("child", 20, {
          continue_from: "root",
          messages: [{ role: "user", content: "Agora implemente" }],
          events: [{ type: "run_ended", at: 21, status: "cancelled", reason: "operator" }],
        }),
      ],
    ]);
    const projected = await projectGoalTrajectory(
      session([
        {
          kind: "conversation",
          status: "done",
          execution_id: "child",
          user_preview: "continue",
          started_at: 20,
          ended_at: 21,
        } as Session["turns"][number],
        {
          kind: "conversation",
          status: "pending",
          execution_id: "pending",
          user_preview: "pending",
          started_at: 30,
        } as Session["turns"][number],
      ]),
      async (id) => runs.get(id) ?? null,
      { workspace_read_available: true },
    );
    const text = projected.projection;
    expect(projected.source_execution_ids).toEqual(["root", "child"]);
    expect(projected).toMatchObject({
      partial: false,
      truncated: false,
      eligible_user_messages: 2,
    });
    expect(text).toContain("Primeiro pedido");
    expect(text).toContain("token: [redacted]");
    expect(text).not.toContain("super-secret-value");
    expect(text).toContain("resultado final");
    expect(text).toContain("Corrija: sem publicar");
    expect(text).toContain("Qual branch?");
    expect(text).toContain("cancelled: operator");
    expect(text).not.toContain("rascunho interno");
    expect(text).not.toContain("provider metadata");
    expect(text).not.toContain("secret payload");
    expect(text).not.toContain("pending");
  });

  it("marks partial recovery, prioritizes corrections under bounds, and hashes canonical input", async () => {
    const detail = run("child", 20, {
      continue_from: "missing",
      messages: [
        { role: "user", content: "seed sent separately" },
        { role: "user", content: "latest request" },
      ],
      events: [
        { type: "steering_applied", at: 21, agent: "lead", message: "latest correction" },
        { type: "run_ended", at: 22, status: "completed" },
      ] as RunDetail["events"],
    });
    const args = [
      session([
        {
          kind: "conversation",
          status: "done",
          execution_id: "child",
          user_preview: "continue",
          started_at: 20,
          ended_at: 22,
        } as Session["turns"][number],
      ]),
      async (id: string) => (id === "child" ? detail : null),
      {
        workspace_read_available: false,
        exclude_user_text: "seed sent separately",
        max_entries: 1,
      },
    ] as const;
    const first = await projectGoalTrajectory(...args);
    const second = await projectGoalTrajectory(...args);
    expect(first).toMatchObject({
      partial: true,
      truncated: true,
      eligible_user_messages: 1,
      workspace_read_available: false,
    });
    expect(first.projection).toContain("latest correction");
    expect(first.projection).not.toContain("seed sent separately");
    expect(first.digest).toBe(second.digest);
  });

  it("bounds recovered execution provenance without following an unbounded chain", async () => {
    const runs = new Map<string, RunDetail>();
    for (let index = 0; index < 5; index++)
      runs.set(
        `run-${String(index)}`,
        run(`run-${String(index)}`, index, {
          ...(index === 0 ? {} : { continue_from: `run-${String(index - 1)}` }),
          messages: [{ role: "user", content: `request ${String(index)}` }],
        }),
      );
    const projected = await projectGoalTrajectory(
      session([
        {
          kind: "conversation",
          status: "done",
          execution_id: "run-4",
          user_preview: "bounded",
          started_at: 4,
          ended_at: 5,
        } as Session["turns"][number],
      ]),
      async (id) => runs.get(id) ?? null,
      { workspace_read_available: true, max_runs: 2 },
    );
    expect(projected.source_execution_ids).toEqual(["run-3", "run-4"]);
    expect(projected).toMatchObject({ partial: true, truncated: true });
  });

  it("reconstructs an exact formulation source set without admitting a later live Goal stage", async () => {
    const runs = new Map<string, RunDetail>([
      [
        "source",
        run("source", 10, {
          messages: [{ role: "user", content: "Original Goal request" }],
          events: [{ type: "run_ended", at: 11, status: "completed" }],
        }),
      ],
      [
        "goal-stage",
        run("goal-stage", 20, {
          continue_from: "source",
          messages: [{ role: "user", content: "Synthetic continuation" }],
        }),
      ],
    ]);
    const current = session([
      {
        kind: "conversation",
        status: "done",
        execution_id: "source",
        user_preview: "request",
        started_at: 10,
        ended_at: 11,
      } as Session["turns"][number],
      {
        kind: "conversation",
        status: "running",
        execution_id: "goal-stage",
        user_preview: "continuation",
        started_at: 20,
      } as Session["turns"][number],
    ]);
    const projected = await projectGoalTrajectory(current, async (id) => runs.get(id) ?? null, {
      workspace_read_available: true,
      source_execution_ids: ["source"],
    });

    expect(projected).toMatchObject({
      source_execution_ids: ["source"],
      partial: false,
      truncated: false,
      eligible_user_messages: 1,
    });
    expect(projected.projection).toContain("Original Goal request");
    expect(projected.projection).not.toContain("Synthetic continuation");
  });

  it("keeps guided verification on the exact formulation digest while the Goal stage is live", async () => {
    const source = run("source", 10, {
      messages: [
        { role: "user", content: "Implement the referenced design" },
        { role: "user", content: "guided seed" },
      ],
      events: [{ type: "run_ended", at: 15, status: "completed" }],
    });
    const live = run("work", 30, {
      status: "running",
      ended_at: undefined,
      messages: [{ role: "user", content: "synthetic Goal continuation" }],
      events: [
        {
          type: "iteration_completed",
          at: 31,
          agent: "lead",
          iteration: 1,
          response: "live output must not move the verifier fence",
          response_phase: "final_answer",
          input_tokens: 1,
          output_tokens: 1,
        },
      ],
    });
    const runs = new Map([
      [source.execution_id, source],
      [live.execution_id, live],
    ]);
    const baseSession = session([
      {
        kind: "conversation",
        status: "done",
        execution_id: "source",
        user_preview: "source",
        started_at: 10,
        ended_at: 15,
      } as Session["turns"][number],
    ]);
    const formulated = await projectGoalTrajectory(
      baseSession,
      async (id) => runs.get(id) ?? null,
      {
        workspace_read_available: true,
        exclude_user_text: "guided seed",
      },
    );
    const goal = {
      goal_id: "goal",
      session_id: "session",
      revision: 1,
      control_revision: 1,
      objective_revision: 1,
      objective: "Implement the referenced design",
      criteria: [{ id: "quality", kind: "qualitative", description: "Design is implemented" }],
      constraints: [],
      exclusions: [],
      assumptions: [],
      sources: [],
      origin: {
        kind: "guided",
        seed: "guided seed",
        formulation_execution_id: "formulation",
        source_session_revision: baseSession.revision,
        source_execution_ids: formulated.source_execution_ids,
        trajectory_digest: formulated.digest,
        trajectory_truncated: formulated.truncated,
      },
      status: "active",
      created_at: 1,
      updated_at: 2,
      limits: {
        max_net_tokens: 10_000,
        max_auto_continuations: 8,
        max_no_progress_checkpoints: 3,
      },
      consumption: {
        input: 0,
        output: 0,
        cached: 0,
        net_tokens: 0,
        usage_unknown: false,
        cache_estimated: false,
        overrun_tokens: 0,
      },
      auto_continuations: 0,
      no_progress_checkpoints: 0,
      runs: [
        {
          execution_id: "work",
          admission_id: "admission",
          control_revision: 1,
          objective_revision: 1,
          automatic: false,
          phase: "running",
          admitted_at: 2,
          verifications: [],
        },
      ],
      human_acceptances: [],
    } as GoalRecord;
    const candidate = {
      objective_revision: 1,
      execution_id: "work",
      summary: "Implemented",
      assessments: [
        {
          criterion_id: "quality",
          kind: "qualitative",
          justification: "Observed",
          evidence: [],
        },
      ],
    } as GoalCandidate;
    const currentSession = session([
      ...baseSession.turns,
      {
        kind: "conversation",
        status: "pending",
        execution_id: "work",
        user_preview: "Goal continuation",
        started_at: 30,
      } as Session["turns"][number],
    ]);
    const verification = await projectGoalVerificationInput({
      session: currentSession,
      goal,
      candidate,
      attempt: { mode: "text", text: "Implemented result" },
      evidence: [],
      validation: { valid: true, reasons: [], qualitative_criteria: ["quality"], revision: 1 },
      workspaceRoot: "/workspace",
      workspaceReadAvailable: true,
      readRun: async (id) => runs.get(id) ?? null,
    });
    const payload = JSON.parse(verification.projection) as {
      trajectory: { projection: string; digest_matches_origin: boolean; partial: boolean };
    };
    expect(payload.trajectory).toMatchObject({ digest_matches_origin: true, partial: false });
    expect(payload.trajectory.projection).not.toContain("synthetic Goal continuation");
    expect(payload.trajectory.projection).not.toContain("live output must not move");
  });

  it("drops oldest projected entries until the simultaneous byte bound is satisfied", async () => {
    const detail = run("large", 10, {
      messages: [
        {
          role: "user",
          content: `large request ${Array.from({ length: 400 }, (_, index) => `segment-${String(index)}`).join(" ")}`,
        },
      ],
    });
    const projected = await projectGoalTrajectory(
      session([
        {
          kind: "conversation",
          status: "done",
          execution_id: "large",
          user_preview: "large",
          started_at: 10,
          ended_at: 11,
        } as Session["turns"][number],
      ]),
      async () => detail,
      { workspace_read_available: true, max_bytes: 1024 },
    );
    expect(projected).toMatchObject({ truncated: true, eligible_user_messages: 1 });
    expect(JSON.parse(projected.projection)).toMatchObject({ omitted_entries: 1, entries: [] });
  });
});
