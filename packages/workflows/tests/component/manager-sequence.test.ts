import { describe, expect, test } from "bun:test";
import type { ManagerWorkflowDefinition } from "#src/artifact.ts";
import { createRoundCoordinator } from "#src/run-round.ts";
import type { WorkflowEvidence, WorkflowSequenceState } from "#src/types.ts";
import {
  makeCtx,
  recordingBc,
  requestWithPrompt,
  testRunCtx,
  workflowRunDeps,
} from "../helpers/workflow.ts";

const definition: ManagerWorkflowDefinition = {
  control: "manager",
  name: "sufficiency",
  description: "Decide.",
  args: [],
  rounds: [],
  objective: "Answer with evidence",
  completion: { criteria: [{ id: "supported", description: "Grounded answer" }] },
  stages: [
    {
      id: "inspect",
      type: "free",
      over: { kind: "once" },
      title: "Inspect",
      brief: "Investigate",
      fanout: 1,
    },
  ],
  maxDispatches: 1,
  synthesis: "Report.",
  dir: "/test",
};

function fixture(options: { saveFails?: boolean; leaderFails?: boolean } = {}) {
  const states: WorkflowSequenceState[] = [];
  const refs: WorkflowEvidence[] = [
    { ref: "evidence-1", origin: "user", status: "provided", summary: "answer", detail: "answer" },
  ];
  let saveFails = options.saveFails ?? false;
  const runDeps = workflowRunDeps(async () => ({
    executionId: "leader-1",
    response: options.leaderFails
      ? {
          status: "error",
          error: { code: "failed", message: "optional failure" },
          usage: { iterations_used: 0, elapsed_ms: 0, by_agent: [] },
        }
      : {
          status: "completed",
          result: "finding",
          usage: { iterations_used: 1, elapsed_ms: 0, by_agent: [] },
        },
  }));
  const run = testRunCtx();
  const ctx = makeCtx({
    runDeps,
    assemble: (spec) => requestWithPrompt(spec.prompt),
    onSequenceState: (state) => states.push(state),
    flushSequenceState: () => {
      if (saveFails) throw new Error("disk failure");
    },
    evidence: {
      list: () => refs,
      get: (ref) => refs.find((item) => item.ref === ref),
      addLeader: (stageId, runId, status, result, revision) =>
        refs.push({
          ref: `evidence-${String(refs.length + 1)}`,
          origin: "leader",
          stageId,
          runId,
          status,
          summary: status,
          detail: String(result),
          revision,
        }),
    },
  });
  const coordinator = createRoundCoordinator(ctx);
  const deps = { ctx, agents: run.registry, bc: recordingBc().bc, clock: undefined };
  return {
    coordinator,
    deps,
    refs,
    states,
    run,
    runDeps,
    failSave: () => {
      saveFails = true;
    },
    restoreSave: () => {
      saveFails = false;
    },
  };
}

const assessment = {
  criteria: [
    {
      id: "supported",
      evidence_refs: ["evidence-1"],
      explanation: "The supplied answer covers it",
    },
  ],
  remaining_gaps: [],
  unresolved_failures: [],
};

describe("manager workflow sufficiency", () => {
  test("opens without a child, completes with context evidence, and refuses duplicate revision", () => {
    const f = fixture();
    expect(f.coordinator.startManager(f.deps, definition, {})).toHaveProperty("text");
    expect(f.run.registry.liveCount()).toBe(0);
    expect(f.runDeps.calls).toHaveLength(0);
    expect(f.coordinator.status().text).toContain("evidence-1");
    expect(f.coordinator.status(undefined, "evidence-1").text).toContain('"origin":"user"');
    expect(f.coordinator.status(undefined, "foreign-ref").progress).toBe(false);
    expect(
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: 1,
        decision: "complete",
        reason: "sufficient",
        assessment,
      }).text,
    ).toContain("completed");
    expect(f.states.at(-1)?.assessment?.outcome).toBe("sufficient");
    expect(
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: 1,
        decision: "complete",
        reason: "again",
        assessment,
      }).progress,
    ).toBe(false);
  });

  test("invalid refs and required stage reject completion without consuming revision", async () => {
    const f = fixture();
    const required: ManagerWorkflowDefinition = {
      ...definition,
      completion: {
        criteria: [
          { id: "supported", description: "Grounded", requires_completed_stages: ["inspect"] },
        ],
      },
    };
    f.coordinator.startManager(f.deps, required, {});
    const decide = (value: unknown) =>
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: 1,
        decision: "complete",
        reason: "done",
        assessment: value,
      });
    expect(decide(assessment).text).toContain("requires completed stage");
    expect(
      decide({
        ...assessment,
        criteria: [{ ...assessment.criteria[0], evidence_refs: ["fabricated"] }],
      }).text,
    ).toContain("unknown or active");
    expect(f.coordinator.status().text).toContain('"revision":1');
    expect(
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: 1,
        decision: "dispatch",
        reason: "gap",
        dispatch: { stage_id: "inspect", gap: "inspect the answer" },
      }).progress,
    ).toBe(true);
    expect(f.run.registry.liveCount()).toBeGreaterThan(0);
    await f.run.settle();
    expect(f.coordinator.status().text).toContain('"revision":3');
    expect(
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: 3,
        decision: "complete",
        reason: "done",
        assessment: {
          ...assessment,
          criteria: [{ ...assessment.criteria[0], evidence_refs: ["evidence-2"] }],
        },
      }).progress,
    ).toBe(true);
  });

  test("failed flush refuses completion, and stop records insufficiency", () => {
    const f = fixture();
    f.coordinator.startManager(f.deps, definition, {});
    f.failSave();
    expect(
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: 1,
        decision: "complete",
        reason: "done",
        assessment,
      }).progress,
    ).toBe(false);
    expect(f.coordinator.status().text).toContain('"revision":1');
    f.restoreSave();
    expect(
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: 1,
        decision: "stop",
        reason: "not enough",
        remaining_gaps: ["verification"],
      }).progress,
    ).toBe(true);
    expect(f.states.at(-1)?.assessment?.outcome).toBe("insufficient");
  });

  test("failed optional leader remains visible alongside sufficient objective", async () => {
    const f = fixture({ leaderFails: true });
    f.coordinator.startManager(f.deps, definition, {});
    expect(
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: 1,
        decision: "dispatch",
        reason: "gap",
        dispatch: { stage_id: "inspect", gap: "check" },
      }).progress,
    ).toBe(true);
    expect(
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: 2,
        decision: "complete",
        reason: "too early",
        assessment,
      }).progress,
    ).toBe(false);
    await f.run.settle();
    expect(f.refs.at(-1)).toMatchObject({ origin: "leader", runId: "leader-1", status: "failed" });
    expect(
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: 3,
        decision: "complete",
        reason: "supported",
        assessment,
      }).text,
    ).toContain("disposition");
    const withDisposition = {
      ...assessment,
      remaining_gaps: ["Optional check remains unverified"],
      unresolved_failures: [
        {
          run_id: "leader-1",
          disposition: "non_blocking",
          explanation: "The supplied answer already covers the objective",
          evidence_refs: [],
        },
      ],
    };
    expect(
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: 3,
        decision: "complete",
        reason: "unsupported resolution",
        assessment: {
          ...withDisposition,
          unresolved_failures: [
            { ...withDisposition.unresolved_failures[0], evidence_refs: ["unknown-ref"] },
          ],
        },
      }).text,
    ).toContain("valid disposition");
    expect(
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: 3,
        decision: "complete",
        reason: "unsupported resolution",
        assessment: {
          ...withDisposition,
          unresolved_failures: [
            {
              ...withDisposition.unresolved_failures[0],
              disposition: "resolved",
              evidence_refs: ["evidence-1"],
            },
          ],
        },
      }).text,
    ).toContain("needs completed evidence");
    expect(
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: 3,
        decision: "complete",
        reason: "supported",
        assessment: withDisposition,
      }).progress,
    ).toBe(true);
    expect(f.states.at(-1)?.assessment?.outcome).toBe("sufficient");
    expect(f.refs.at(-1)?.status).toBe("failed");
  });

  test("dispatch cap refuses a second leader without replacing checkpoint", async () => {
    const f = fixture();
    f.coordinator.startManager(f.deps, definition, {});
    f.coordinator.decide({
      sessionId: "wfseq-1",
      revision: 1,
      decision: "dispatch",
      reason: "gap",
      dispatch: { stage_id: "inspect", gap: "check" },
    });
    await f.run.settle();
    expect(
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: 3,
        decision: "dispatch",
        reason: "another",
        dispatch: { stage_id: "inspect", gap: "again" },
      }).text,
    ).toContain("max_dispatches");
    expect(f.runDeps.calls).toHaveLength(1);
  });

  test("active or unknown physical children prevent terminal decisions", () => {
    const f = fixture();
    f.coordinator.startManager(f.deps, definition, {});
    const original = () => f.run.registry.liveCount();
    f.deps.agents.liveCount = () => 1;
    expect(
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: 1,
        decision: "complete",
        reason: "done",
        assessment,
      }).text,
    ).toContain("active or unknown");
    expect(
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: 1,
        decision: "stop",
        reason: "stop",
        remaining_gaps: [],
      }).text,
    ).toContain("active or unknown");
    expect(
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: 1,
        decision: "dispatch",
        reason: "more",
        dispatch: { stage_id: "inspect", gap: "check" },
      }).text,
    ).toContain("would overlap");
    f.deps.agents.liveCount = original;
  });

  test("textual finalization nudges once, then stops without assessment", async () => {
    const f = fixture();
    f.coordinator.startManager(f.deps, definition, {});
    const gate = f.coordinator.finalizeGate();
    expect(await gate.check({ mode: "text", text: "done" })).toMatchObject({ kind: "nudge" });
    expect(f.coordinator.status().text).toContain('"revision":1');
    expect(await gate.check({ mode: "text", text: "done" })).toMatchObject({ kind: "pass" });
    expect(f.states.at(-1)).toMatchObject({ status: "stopped" });
    expect(f.states.at(-1)?.assessment).toBeUndefined();
    expect(f.runDeps.calls).toHaveLength(0);
  });
});
