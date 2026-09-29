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

function fixture(options: { saveFails?: boolean; leaderFails?: boolean; result?: unknown } = {}) {
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
          result: options.result ?? "finding",
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
        dispatch: {
          stage_id: "inspect",
          gap: "inspect the answer",
          items: [{ item_ref: "wfseq-1:1:inspect:root:0", replicas: 1 }],
        },
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
        dispatch: {
          stage_id: "inspect",
          gap: "check",
          items: [{ item_ref: "wfseq-1:1:inspect:root:0", replicas: 1 }],
        },
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
      dispatch: {
        stage_id: "inspect",
        gap: "check",
        items: [{ item_ref: "wfseq-1:1:inspect:root:0", replicas: 1 }],
      },
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
        dispatch: {
          stage_id: "inspect",
          gap: "check",
          items: [{ item_ref: "wfseq-1:1:inspect:root:0", replicas: 1 }],
        },
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

  test("selects a later declared stage out of order and reserves 2+3 replicas with explicit coverage", async () => {
    const f = fixture({
      result: {
        work_items: [
          { id: "a", title: "A", goal: "Check A", files: ["a"], dependencies: [], mutation: false },
          { id: "b", title: "B", goal: "Check B", files: ["b"], dependencies: [], mutation: false },
          { id: "c", title: "C", goal: "Check C", files: [], dependencies: [], mutation: false },
        ],
      },
    });
    const adaptive: ManagerWorkflowDefinition = {
      ...definition,
      maxDispatches: 3,
      stages: [
        {
          id: "verify",
          type: "free",
          over: { kind: "each", source: "discover.work_items" },
          title: "Verify {{item.id}}",
          brief: "Verify {{item.goal}}",
          fanout: 1,
          replicas: { min: 1, max: 3 },
        },
        { ...definition.stages[0]!, id: "discover" },
      ],
    };
    f.coordinator.startManager(f.deps, adaptive, {});
    expect(
      JSON.parse(f.coordinator.status().text).eligible.map(
        (entry: { stageId: string }) => entry.stageId,
      ),
    ).toEqual(["discover"]);
    const first = f.coordinator.decide({
      sessionId: "wfseq-1",
      revision: 1,
      decision: "dispatch",
      reason: "map",
      dispatch: {
        stage_id: "discover",
        gap: "map",
        items: [{ item_ref: "wfseq-1:1:discover:root:0", replicas: 1 }],
      },
    });
    expect(first.progress).toBe(true);
    await f.run.settle();
    const proposal = JSON.parse(f.coordinator.status().text).eligible.find(
      (entry: { stageId: string }) => entry.stageId === "verify",
    );
    expect(proposal.total).toBe(3);
    const [a, b, c] = proposal.candidates.map((entry: { ref: string }) => entry.ref);
    expect(f.coordinator.status(undefined, undefined, 0, b).text).toContain("Check B");
    const invalid = f.coordinator.decide({
      sessionId: "wfseq-1",
      revision: 3,
      decision: "dispatch",
      reason: "verify",
      dispatch: {
        stage_id: "verify",
        gap: "verify",
        source_invocation_id: "wfseq-1-inv-1",
        items: [
          { item_ref: a, replicas: 2 },
          { item_ref: a, replicas: 3 },
        ],
        skipped: [{ item_ref: c, reason: "duplicate" }],
      },
    });
    expect(invalid.text).toContain("duplicate");
    expect(f.runDeps.calls).toHaveLength(1);
    const dispatched = f.coordinator.decide({
      sessionId: "wfseq-1",
      revision: 3,
      decision: "dispatch",
      reason: "verify",
      dispatch: {
        stage_id: "verify",
        gap: "verify",
        source_invocation_id: "wfseq-1-inv-1",
        items: [
          { item_ref: a, replicas: 2 },
          { item_ref: b, replicas: 3 },
        ],
        skipped: [{ item_ref: c, reason: "already checked" }],
      },
    });
    expect(dispatched.progress).toBe(true);
    await f.run.settle();
    expect(f.runDeps.calls).toHaveLength(6);
    expect(f.states.at(-1)?.invocations?.[1]).toMatchObject({
      requested: 5,
      completed: 5,
      status: "completed",
    });
    expect(f.states.at(-1)?.invocations?.[1]?.coverage.map((entry) => entry.disposition)).toEqual([
      "selected",
      "selected",
      "skipped",
    ]);
    expect(f.coordinator.status().text).toContain('"revision":5');
  });

  test("refuses partial reservation and mutating replication without consuming the revision", async () => {
    const f = fixture({
      result: {
        work_items: [
          { id: "a", title: "A", goal: "Write", files: ["a"], dependencies: [], mutation: true },
          { id: "b", title: "B", goal: "Read", files: ["a"], dependencies: ["a"], mutation: false },
        ],
      },
    });
    const adaptive: ManagerWorkflowDefinition = {
      ...definition,
      maxDispatches: 3,
      stages: [
        { ...definition.stages[0]!, id: "discover" },
        {
          id: "verify",
          type: "free",
          over: { kind: "each", source: "discover.work_items" },
          title: "Verify",
          brief: "Check",
          fanout: 1,
          replicas: { min: 1, max: 3 },
        },
      ],
    };
    f.coordinator.startManager(f.deps, adaptive, {});
    f.coordinator.decide({
      sessionId: "wfseq-1",
      revision: 1,
      decision: "dispatch",
      reason: "map",
      dispatch: {
        stage_id: "discover",
        gap: "map",
        items: [{ item_ref: "wfseq-1:1:discover:root:0", replicas: 1 }],
      },
    });
    await f.run.settle();
    const [a, b] = JSON.parse(f.coordinator.status().text)
      .eligible.find((entry: { stageId: string }) => entry.stageId === "verify")
      .candidates.map((entry: { ref: string }) => entry.ref);
    const decide = (items: unknown[], skipped: unknown[] = []) =>
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: 3,
        decision: "dispatch",
        reason: "check",
        dispatch: {
          stage_id: "verify",
          gap: "check",
          source_invocation_id: "wfseq-1-inv-1",
          items,
          skipped,
        },
      });
    expect(
      decide([{ item_ref: a, replicas: 2 }], [{ item_ref: b, reason: "later" }]).text,
    ).toContain("mutating");
    expect(
      decide([{ item_ref: b, replicas: 1 }], [{ item_ref: a, reason: "later" }]).text,
    ).toContain("dependency");
    const count = f.runDeps.calls.length;
    const reserve = f.deps.ctx.leaderCount.reserve(f.deps.ctx.leaderCount.remaining() - 1)!;
    expect(
      decide([
        { item_ref: a, replicas: 1 },
        { item_ref: b, replicas: 1 },
      ]).text,
    ).toContain("admission refused");
    expect(f.runDeps.calls).toHaveLength(count);
    expect(f.coordinator.status().text).toContain('"revision":3');
    reserve.release();
    expect(
      decide([
        { item_ref: a, replicas: 1 },
        { item_ref: b, replicas: 1 },
      ]).progress,
    ).toBe(true);
    await f.run.settle();
    expect(f.runDeps.calls).toHaveLength(count + 2);
  });

  test("repeat is another decision with a new gap, never an automatic next stage", async () => {
    const f = fixture();
    f.coordinator.startManager(f.deps, { ...definition, maxDispatches: 2 }, {});
    const first = f.coordinator.decide({
      sessionId: "wfseq-1",
      revision: 1,
      decision: "dispatch",
      reason: "inspect",
      dispatch: {
        stage_id: "inspect",
        gap: "first question",
        items: [{ item_ref: "wfseq-1:1:inspect:root:0", replicas: 1 }],
      },
    });
    expect(first.progress).toBe(true);
    await f.run.settle();
    expect(f.runDeps.calls).toHaveLength(1);
    const again = {
      stage_id: "inspect",
      gap: "first question",
      items: [{ item_ref: "wfseq-1:3:inspect:root:0", replicas: 1 }],
    };
    expect(
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: 3,
        decision: "dispatch",
        reason: "again",
        dispatch: again,
      }).text,
    ).toContain("new gap");
    expect(
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: 3,
        decision: "dispatch",
        reason: "another concern",
        dispatch: { ...again, gap: "new question" },
      }).progress,
    ).toBe(true);
    await f.run.settle();
    expect(f.runDeps.calls).toHaveLength(2);
    expect(f.states.at(-1)?.invocations).toHaveLength(2);
  });

  test("pages candidates and admits prior coverage only for the exact source invocation", async () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      id: `i${index}`,
      title: `Item ${index}`,
      goal: `Check ${index}`,
      files: [],
      dependencies: [],
      mutation: false,
    }));
    const f = fixture({ result: { work_items: items } });
    const adaptive: ManagerWorkflowDefinition = {
      ...definition,
      maxDispatches: 3,
      stages: [
        { ...definition.stages[0]!, id: "discover" },
        {
          id: "verify",
          type: "free",
          over: { kind: "each", source: "discover.work_items" },
          title: "Verify",
          brief: "Check",
          fanout: 1,
        },
      ],
    };
    f.coordinator.startManager(f.deps, adaptive, {});
    f.coordinator.decide({
      sessionId: "wfseq-1",
      revision: 1,
      decision: "dispatch",
      reason: "map",
      dispatch: {
        stage_id: "discover",
        gap: "map",
        items: [{ item_ref: "wfseq-1:1:discover:root:0", replicas: 1 }],
      },
    });
    await f.run.settle();
    const first = JSON.parse(f.coordinator.status().text).eligible.find(
      (entry: { stageId: string }) => entry.stageId === "verify",
    );
    const second = JSON.parse(f.coordinator.status(undefined, undefined, 1).text).eligible.find(
      (entry: { stageId: string }) => entry.stageId === "verify",
    );
    expect(first.candidates).toHaveLength(16);
    expect(first.total).toBe(20);
    expect(second.candidates).toHaveLength(4);
    const refs = [...first.candidates, ...second.candidates].map(
      (entry: { ref: string }) => entry.ref,
    );
    expect(
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: 3,
        decision: "dispatch",
        reason: "partial",
        dispatch: {
          stage_id: "verify",
          gap: "first",
          source_invocation_id: "wfseq-1-inv-1",
          items: [{ item_ref: refs[0], replicas: 1 }],
          deferred: refs.slice(1).map((ref) => ({ item_ref: ref, gap: "later" })),
        },
      }).progress,
    ).toBe(true);
    await f.run.settle();
    const later = JSON.parse(f.coordinator.status().text).eligible.find(
      (entry: { stageId: string }) => entry.stageId === "verify",
    );
    const currentRefs = [
      ...later.candidates,
      ...JSON.parse(f.coordinator.status(undefined, undefined, 1).text).eligible.find(
        (entry: { stageId: string }) => entry.stageId === "verify",
      ).candidates,
    ].map((entry: { ref: string }) => entry.ref);
    const decision = {
      stage_id: "verify",
      gap: "remaining",
      source_invocation_id: "wfseq-1-inv-1",
      items: [{ item_ref: currentRefs[1], replicas: 1 }],
      covered: [{ item_ref: currentRefs[0], invocation_id: "wfseq-1-inv-2" }],
      deferred: currentRefs.slice(2).map((ref) => ({ item_ref: ref, gap: "later" })),
    };
    expect(
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: 5,
        decision: "dispatch",
        reason: "invalid coverage",
        dispatch: {
          ...decision,
          covered: [{ item_ref: currentRefs[0], invocation_id: "foreign" }],
        },
      }).text,
    ).toContain("completed prior invocation");
    expect(
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: 5,
        decision: "dispatch",
        reason: "remaining",
        dispatch: decision,
      }).progress,
    ).toBe(true);
    await f.run.settle();
    expect(f.states.at(-1)?.invocations?.[2]?.coverage[0]).toMatchObject({
      disposition: "covered",
      status: "completed",
    });
  });

  test("a selected item can depend on a completed item from the same source invocation", async () => {
    const f = fixture({
      result: {
        work_items: [
          { id: "a", title: "A", goal: "Check A", files: [], dependencies: [], mutation: false },
          {
            id: "b",
            title: "B",
            goal: "Check B after A",
            files: [],
            dependencies: ["a"],
            mutation: false,
          },
        ],
      },
    });
    const adaptive: ManagerWorkflowDefinition = {
      ...definition,
      maxDispatches: 3,
      stages: [
        { ...definition.stages[0]!, id: "discover" },
        {
          id: "verify",
          type: "free",
          over: { kind: "each", source: "discover.work_items" },
          title: "Verify",
          brief: "Check",
          fanout: 1,
        },
      ],
    };
    f.coordinator.startManager(f.deps, adaptive, {});
    expect(
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: 1,
        decision: "dispatch",
        reason: "map",
        dispatch: {
          stage_id: "discover",
          gap: "map",
          items: [{ item_ref: "wfseq-1:1:discover:root:0", replicas: 1 }],
        },
      }).progress,
    ).toBe(true);
    await f.run.settle();
    const refs = JSON.parse(f.coordinator.status().text)
      .eligible.find((entry: { stageId: string }) => entry.stageId === "verify")
      .candidates.map((entry: { ref: string }) => entry.ref) as string[];
    expect(refs).toHaveLength(2);
    expect(
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: 3,
        decision: "dispatch",
        reason: "check prerequisite",
        dispatch: {
          stage_id: "verify",
          gap: "prerequisite",
          source_invocation_id: "wfseq-1-inv-1",
          items: [{ item_ref: refs[0]!, replicas: 1 }],
          deferred: [{ item_ref: refs[1]!, gap: "depends on A" }],
        },
      }).progress,
    ).toBe(true);
    await f.run.settle();
    const current = JSON.parse(f.coordinator.status().text)
      .eligible.find((entry: { stageId: string }) => entry.stageId === "verify")
      .candidates.map((entry: { ref: string }) => entry.ref) as string[];
    expect(
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: 5,
        decision: "dispatch",
        reason: "check dependent item",
        dispatch: {
          stage_id: "verify",
          gap: "dependent",
          source_invocation_id: "wfseq-1-inv-1",
          items: [{ item_ref: current[1]!, replicas: 1 }],
          covered: [{ item_ref: current[0]!, invocation_id: "wfseq-1-inv-2" }],
        },
      }).progress,
    ).toBe(true);
    await f.run.settle();
    expect(f.states.at(-1)?.invocations?.[2]?.coverage.map((entry) => entry.disposition)).toEqual([
      "covered",
      "selected",
    ]);
    expect(f.runDeps.calls).toHaveLength(3);
  });

  test("an unmet acceptance rule does not mark the invocation or required stage complete", async () => {
    const f = fixture({ result: { verdict: "uncertain" } });
    f.coordinator.startManager(
      f.deps,
      {
        ...definition,
        completion: {
          criteria: [
            {
              id: "supported",
              description: "Grounded answer",
              requires_completed_stages: ["inspect"],
            },
          ],
        },
        stages: [
          {
            ...definition.stages[0]!,
            accept: { kind: "threshold", field: "verdict", value: "supported", count: 1 },
          },
        ],
      },
      {},
    );
    expect(
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: 1,
        decision: "dispatch",
        reason: "inspect",
        dispatch: {
          stage_id: "inspect",
          gap: "inspect",
          items: [{ item_ref: "wfseq-1:1:inspect:root:0", replicas: 1 }],
        },
      }).progress,
    ).toBe(true);
    await f.run.settle();
    expect(f.states.at(-1)?.invocations?.[0]).toMatchObject({
      status: "failed",
      requested: 1,
      completed: 1,
      coverage: [{ disposition: "selected", status: "rejected" }],
    });
    expect(
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: 3,
        decision: "complete",
        reason: "supported",
        assessment,
      }).text,
    ).toContain("requires completed stage evidence");
  });

  test("a met acceptance rule marks the invocation complete and admits its evidence", async () => {
    const f = fixture({ result: { verdict: "supported" } });
    f.coordinator.startManager(
      f.deps,
      {
        ...definition,
        completion: {
          criteria: [
            {
              id: "supported",
              description: "Grounded answer",
              requires_completed_stages: ["inspect"],
            },
          ],
        },
        stages: [
          {
            ...definition.stages[0]!,
            accept: { kind: "threshold", field: "verdict", value: "supported", count: 1 },
          },
        ],
      },
      {},
    );
    expect(
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: 1,
        decision: "dispatch",
        reason: "inspect",
        dispatch: {
          stage_id: "inspect",
          gap: "inspect",
          items: [{ item_ref: "wfseq-1:1:inspect:root:0", replicas: 1 }],
        },
      }).progress,
    ).toBe(true);
    await f.run.settle();
    expect(f.states.at(-1)?.invocations?.[0]).toMatchObject({
      status: "completed",
      coverage: [{ disposition: "selected", status: "completed" }],
    });
    expect(f.coordinator.status().text).toContain('"completedStages":["inspect"]');
    expect(
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: 3,
        decision: "complete",
        reason: "supported",
        assessment: {
          ...assessment,
          criteria: [{ ...assessment.criteria[0], evidence_refs: ["evidence-2"] }],
        },
      }).progress,
    ).toBe(true);
  });
});
