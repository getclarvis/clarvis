import { describe, expect, test } from "bun:test";
import type { ExecuteRunOutcome } from "@clarvis/loop";
import type { ManagerWorkflowDefinition } from "#src/artifact.ts";
import { BUILTIN_WORKFLOWS } from "#src/builtin-workflows/index.ts";
import { createRoundCoordinator } from "#src/run-round.ts";
import type { WorkflowEvidence, WorkflowSequenceState } from "#src/types.ts";
import {
  makeCtx,
  promptFrom,
  recordingBc,
  requestWithPrompt,
  testRunCtx,
  workflowRunDeps,
} from "../helpers/workflow.ts";

function definition(name: string): ManagerWorkflowDefinition {
  const workflow = BUILTIN_WORKFLOWS.find((entry) => entry.name === name);
  if (workflow?.control !== "manager") throw new Error(`missing manager workflow ${name}`);
  return workflow;
}

function fixture(
  name: string,
  execute: (prompt: string, index: number) => Promise<ExecuteRunOutcome["response"]>,
) {
  const workflow = definition(name);
  const refs: WorkflowEvidence[] = [
    {
      ref: "context-1",
      origin: "user",
      status: "provided",
      summary: "fixture evidence of deliverable and required validation",
      detail: "fixture evidence of deliverable and required validation",
    },
  ];
  const states: WorkflowSequenceState[] = [];
  let index = 0;
  const runDeps = workflowRunDeps(async (args) => ({
    executionId: `leader-${++index}`,
    response: await execute(promptFrom(args), index),
  }));
  const run = testRunCtx();
  const ctx = makeCtx({
    runDeps,
    assemble: (spec) => requestWithPrompt(spec.prompt),
    onSequenceState: (state) => states.push(state),
    evidence: {
      list: () => refs,
      get: (ref) => refs.find((entry) => entry.ref === ref),
      addLeader: (stageId, runId, status, result, revision) =>
        refs.push({
          ref: `evidence-${String(refs.length)}`,
          origin: "leader",
          stageId,
          runId,
          status,
          summary: status,
          detail: JSON.stringify(result),
          revision,
        }),
    },
  });
  const coordinator = createRoundCoordinator(ctx);
  const deps = { ctx, agents: run.registry, bc: recordingBc().bc, clock: undefined };
  const args = Object.fromEntries(workflow.args.map((arg) => [arg, "fixture task"]));
  expect(coordinator.startManager(deps, workflow, args)).toHaveProperty("text");
  const status = () =>
    JSON.parse(coordinator.status().text) as WorkflowSequenceState & {
      eligible: { stageId: string; sourceInvocationId?: string; candidates: { ref: string }[] }[];
    };
  const assess = (evidenceRefs: string[]) => ({
    criteria: workflow.completion.criteria.map(({ id }) => ({
      id,
      evidence_refs: evidenceRefs,
      explanation: "The fixture evidence addresses this criterion and its required validation",
    })),
    remaining_gaps: [],
    unresolved_failures: [],
  });
  return { coordinator, run, runDeps, states, refs, status, assess };
}

const completed = (result: unknown): ExecuteRunOutcome["response"] => ({
  status: "completed",
  result,
  usage: { iterations_used: 1, elapsed_ms: 0, by_agent: [] },
});

function dispatch(
  f: ReturnType<typeof fixture>,
  stageId: string,
  gap: string,
  selected: { item_ref: string; replicas: number }[],
  other: Record<string, unknown> = {},
) {
  const stage = f.status().eligible.find((entry) => entry.stageId === stageId);
  if (stage === undefined) throw new Error(`ineligible stage ${stageId}`);
  return f.coordinator.decide({
    sessionId: "wfseq-1",
    revision: f.status().revision,
    decision: "dispatch",
    reason: gap,
    dispatch: {
      stage_id: stageId,
      gap,
      ...(stage.sourceInvocationId === undefined
        ? {}
        : { source_invocation_id: stage.sourceInvocationId }),
      items: selected,
      ...other,
    },
  });
}

describe("shipped manager workflow adoption", () => {
  test("canonical evidence can finish each objective without spawning optional leaders", () => {
    for (const name of ["audit", "research", "implement"]) {
      const f = fixture(name, async () => {
        throw new Error("no leader expected");
      });
      expect(f.status().leadersStarted).toBe(0);
      expect(
        f.coordinator.decide({
          sessionId: "wfseq-1",
          revision: 1,
          decision: "complete",
          reason: "fixture evidence already addresses the task and validation",
          assessment: f.assess(["context-1"]),
        }).progress,
      ).toBe(true);
      expect(f.status()).toMatchObject({
        status: "completed",
        dispatches: 0,
        leadersStarted: 0,
        assessment: { outcome: "sufficient" },
      });
      expect(f.runDeps.calls).toHaveLength(0);
    }
  });

  test("one investigation can finish research without an imposed verify pass", async () => {
    const f = fixture("research", async () => completed({ work_items: [], unknowns: [] }));
    const candidate = f.status().eligible.find((entry) => entry.stageId === "frame")!.candidates[0]!
      .ref;
    expect(
      dispatch(f, "frame", "need to frame the question", [{ item_ref: candidate, replicas: 1 }])
        .progress,
    ).toBe(true);
    await f.run.settle();
    expect(f.status().invocations?.[0]).toMatchObject({ stageId: "frame", status: "completed" });
    expect(
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: f.status().revision,
        decision: "complete",
        reason: "the framing and prior evidence suffice",
        assessment: f.assess(["context-1", "evidence-1"]),
      }).progress,
    ).toBe(true);
    expect(f.status().dispatches).toBe(1);
    expect(f.runDeps.calls).toHaveLength(1);
  });

  test("an audit chooses one of several reviews and can verify any finding, regardless of its flag", async () => {
    const items = ["a", "b", "c"].map((id) => ({
      id,
      title: id,
      goal: `Inspect ${id}`,
      files: [id],
      dependencies: [],
      mutation: false,
    }));
    const finding = {
      id: "finding-a",
      title: "Claim A",
      claim: "A is wrong",
      evidence: ["a:1"],
      impact: "important",
      needs_verification: false,
    };
    const f = fixture("audit", async (prompt) =>
      completed(
        prompt.includes("Map the unresolved scope")
          ? { work_items: items }
          : { findings: [finding] },
      ),
    );
    const discover = f.status().eligible.find((entry) => entry.stageId === "discover")!
      .candidates[0]!.ref;
    expect(dispatch(f, "discover", "scope", [{ item_ref: discover, replicas: 1 }]).progress).toBe(
      true,
    );
    await f.run.settle();
    const review = f.status().eligible.find((entry) => entry.stageId === "review")!;
    expect(review.candidates).toHaveLength(3);
    expect(
      dispatch(
        f,
        "review",
        "one consequential area",
        [{ item_ref: review.candidates[0]!.ref, replicas: 1 }],
        {
          skipped: [{ item_ref: review.candidates[1]!.ref, reason: "out of requested scope" }],
          deferred: [{ item_ref: review.candidates[2]!.ref, gap: "needs another source" }],
        },
      ).progress,
    ).toBe(true);
    await f.run.settle();
    expect(f.status().invocations?.[1]?.coverage.map((entry) => entry.disposition)).toEqual([
      "selected",
      "skipped",
      "deferred",
    ]);
    const verify = f.status().eligible.find((entry) => entry.stageId === "verify")!;
    expect(verify.candidates).toHaveLength(1);
    expect(f.coordinator.status(undefined, undefined, 0, verify.candidates[0]!.ref).text).toContain(
      '"needs_verification":false',
    );
  });

  test("a failed replica preserves denominator and uncertainty rather than confirming a finding", async () => {
    const work = {
      id: "a",
      title: "A",
      goal: "Review A",
      files: [],
      dependencies: [],
      mutation: false,
    };
    const finding = {
      id: "claim-a",
      title: "Claim A",
      claim: "A is wrong",
      evidence: ["a:1"],
      impact: "important",
    };
    const f = fixture("audit", async (_prompt, index) =>
      index === 4
        ? {
            status: "error",
            error: { code: "failed", message: "fixture failure" },
            usage: { iterations_used: 0, elapsed_ms: 0, by_agent: [] },
          }
        : completed(
            index === 1
              ? { work_items: [work] }
              : index === 2
                ? { findings: [finding] }
                : { verdict: "refuted", finding_id: "claim-a" },
          ),
    );
    const discover = f.status().eligible.find((entry) => entry.stageId === "discover")!
      .candidates[0]!.ref;
    expect(dispatch(f, "discover", "map", [{ item_ref: discover, replicas: 1 }]).progress).toBe(
      true,
    );
    await f.run.settle();
    const review = f.status().eligible.find((entry) => entry.stageId === "review")!;
    expect(
      dispatch(f, "review", "inspect claim", [{ item_ref: review.candidates[0]!.ref, replicas: 1 }])
        .progress,
    ).toBe(true);
    await f.run.settle();
    const verify = f.status().eligible.find((entry) => entry.stageId === "verify")!;
    expect(
      dispatch(f, "verify", "test contradictory evidence", [
        { item_ref: verify.candidates[0]!.ref, replicas: 2 },
      ]).progress,
    ).toBe(true);
    await f.run.settle();
    expect(f.status().invocations?.[2]).toMatchObject({
      stageId: "verify",
      requested: 2,
      started: 2,
      completed: 1,
      status: "failed",
      coverage: [{ disposition: "selected", replicas: 2, status: "failed" }],
    });
    expect(
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: f.status().revision,
        decision: "complete",
        reason: "not justified",
        assessment: f.assess(["context-1"]),
      }).text,
    ).toContain("failure requires a disposition");
    expect(
      f.coordinator.decide({
        sessionId: "wfseq-1",
        revision: f.status().revision,
        decision: "stop",
        reason: "one verifier failed and the claim remains uncertain",
        remaining_gaps: ["verification remains unknown"],
      }).progress,
    ).toBe(true);
    expect(f.status().assessment?.outcome).toBe("insufficient");
  });

  test("an implementation build stays mutating even when the planner marks items read-only", async () => {
    const items = ["a", "b"].map((id) => ({
      id,
      title: id,
      goal: `Change ${id}`,
      files: [],
      dependencies: [],
      mutation: false,
    }));
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const f = fixture("implement", async (prompt, index) => {
      if (index === 2) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      return completed(
        prompt.includes("Plan this change") ? { work_items: items } : { findings: [] },
      );
    });
    const plan = f.status().eligible.find((entry) => entry.stageId === "plan")!.candidates[0]!.ref;
    expect(dispatch(f, "plan", "need work plan", [{ item_ref: plan, replicas: 1 }]).progress).toBe(
      true,
    );
    await f.run.settle();
    expect(f.status().eligible.some((entry) => entry.stageId === "review")).toBe(false);
    const build = f.status().eligible.find((entry) => entry.stageId === "build")!;
    expect(
      dispatch(
        f,
        "build",
        "implement",
        build.candidates.map((entry) => ({ item_ref: entry.ref, replicas: 1 })),
      ).progress,
    ).toBe(true);
    await firstStarted.promise;
    const callsBeforeFirstSettled = f.runDeps.calls.length;
    releaseFirst.resolve();
    await f.run.settle();
    expect(callsBeforeFirstSettled).toBe(2);
    expect(f.runDeps.calls).toHaveLength(3);
    expect(promptFrom(f.runDeps.calls[1]!)).toContain(
      "may modify the workspace within its task scope",
    );
    expect(f.status().invocations?.[1]).toMatchObject({ requested: 2, completed: 2 });
    expect(f.status().eligible.some((entry) => entry.stageId === "review")).toBe(true);
  });
});
