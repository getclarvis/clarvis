import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { GoalFixtureResponse } from "../helpers/goal-file-host.ts";
import { createGoalFileHostFixture } from "../helpers/goal-file-host.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

function verificationResult(
  ids: string[],
  verdict: "achieved" | "not_achieved" | "inconclusive",
  inspectedPaths: string[] = [],
): GoalFixtureResponse {
  const assessmentVerdict = verdict === "achieved" ? "satisfied" : "unsatisfied";
  return {
    name: "submit_result",
    arguments: {
      verdict,
      summary:
        verdict === "achieved"
          ? "Independent verification established the requested result"
          : "Independent verification found the requested result incomplete",
      assessments: [
        {
          scope: "definition",
          verdict: assessmentVerdict,
          rationale: "The persisted definition was checked independently",
          evidence_ids: [],
          inspected_paths: inspectedPaths,
        },
        {
          scope: "objective",
          verdict: assessmentVerdict,
          rationale: "The proposed result was checked against the objective",
          evidence_ids: [],
          inspected_paths: inspectedPaths,
        },
        ...ids.map((criterion_id) => ({
          scope: "criterion",
          criterion_id,
          verdict: assessmentVerdict,
          rationale: "The qualitative criterion was checked independently",
          evidence_ids: [],
          inspected_paths: inspectedPaths,
        })),
      ],
    },
  };
}

async function createLiteralGoal(
  fixture: Awaited<ReturnType<typeof createGoalFileHostFixture>>,
  operationId: string,
) {
  await fixture.client.goals.control({
    session_id: "conversation",
    expected_revision: 0,
    operation_id: operationId,
    action: {
      kind: "create",
      objective: "Produce and independently verify the requested result",
      limits: { max_net_tokens: 20_000 },
    },
  });
}

describe("independent Goal verification through the real file host", () => {
  it("nudges once after a negative verdict, then completes only after a new achieved proof", async () => {
    const f = await createGoalFileHostFixture();
    cleanups.push(f.close);
    let primaryCalls = 0;
    let verificationCalls = 0;
    f.setResponder(async () => {
      primaryCalls++;
      if (primaryCalls === 1 || primaryCalls === 3)
        return {
          name: "update_goal",
          arguments: {
            update: {
              action: "candidate",
              summary: primaryCalls === 1 ? "Initial candidate" : "Corrected candidate",
              assessments: [
                {
                  criterion_id: "objective",
                  kind: "qualitative",
                  justification: "The controlled result is ready for independent review",
                },
              ],
            },
          },
        };
      return { text: primaryCalls === 2 ? "Initial result" : "Corrected result" };
    });
    f.setVerificationResponder(async (_request, ids) => {
      verificationCalls++;
      return verificationResult(ids, verificationCalls === 1 ? "not_achieved" : "achieved");
    });

    await createLiteralGoal(f, "verify-correction");
    await f.until(
      async () => (await f.client.goals.get("conversation")).state.current?.status === "complete",
    );
    await f.until(() => f.host.stats().runs === 0);

    const goal = (await f.client.goals.get("conversation")).state.current!;
    expect(primaryCalls).toBe(4);
    expect(verificationCalls).toBe(2);
    expect(goal.runs[0]!.verifications.map((item) => item.verdict)).toEqual([
      "not_achieved",
      "achieved",
    ]);
    expect(goal.runs[0]!.verifications[0]!.verification_execution_id).not.toBe(
      goal.runs[0]!.execution_id,
    );
    const measured = f.usages.reduce(
      (total, usage) => ({
        input: total.input + usage.input,
        output: total.output + usage.output,
        cached: total.cached + usage.cached,
      }),
      { input: 0, output: 0, cached: 0 },
    );
    expect(goal.consumption).toMatchObject({ ...measured, usage_unknown: false });
    expect((await f.client.sessions.get("conversation"))!.totals).toEqual(measured);
  });

  it("reuses an unchanged negative proof instead of spending a second verifier attempt", async () => {
    const f = await createGoalFileHostFixture();
    cleanups.push(f.close);
    let primaryCalls = 0;
    let verificationCalls = 0;
    f.setResponder(async () => {
      primaryCalls++;
      if (primaryCalls === 1)
        return {
          name: "update_goal",
          arguments: {
            update: {
              action: "candidate",
              summary: "Unchanged candidate",
              assessments: [
                {
                  criterion_id: "objective",
                  kind: "qualitative",
                  justification: "The same candidate remains proposed",
                },
              ],
            },
          },
        };
      return { text: "Unchanged result" };
    });
    f.setVerificationResponder(async (_request, ids) => {
      verificationCalls++;
      return verificationResult(ids, "not_achieved");
    });

    await createLiteralGoal(f, "verify-reuse");
    await f.until(
      async () => (await f.client.goals.get("conversation")).state.current?.status === "blocked",
    );
    await f.until(() => f.host.stats().runs === 0);

    const goal = (await f.client.goals.get("conversation")).state.current!;
    expect(primaryCalls).toBe(3);
    expect(verificationCalls).toBe(1);
    expect(goal.runs[0]!.verifications).toHaveLength(1);
    expect(goal.runs[0]!.verifications[0]!.verdict).toBe("not_achieved");
  });

  it("fails closed when the independent verifier returns an invalid structured result", async () => {
    const f = await createGoalFileHostFixture();
    cleanups.push(f.close);
    let primaryCalls = 0;
    let verificationCalls = 0;
    f.setResponder(async () => {
      primaryCalls++;
      if (primaryCalls === 1)
        return {
          name: "update_goal",
          arguments: {
            update: {
              action: "candidate",
              summary: "Candidate awaiting independent proof",
              assessments: [
                {
                  criterion_id: "objective",
                  kind: "qualitative",
                  justification: "The controlled result is ready for verification",
                },
              ],
            },
          },
        };
      return { text: "Proposed result without valid independent proof" };
    });
    f.setVerificationResponder(async () => {
      verificationCalls++;
      return {
        name: "submit_result",
        arguments: { verdict: "achieved", summary: "Missing required assessments" },
      };
    });

    await createLiteralGoal(f, "verify-invalid-result");
    await f.until(
      async () => (await f.client.goals.get("conversation")).state.current?.status === "blocked",
    );
    await f.until(() => f.host.stats().runs === 0);

    const goal = (await f.client.goals.get("conversation")).state.current!;
    expect(verificationCalls).toBeGreaterThan(0);
    expect(goal.status).toBe("blocked");
    expect(goal.runs[0]!.verifications).toEqual([]);
  });

  it("binds every claimed inspected path to a successful verifier trace read and digest", async () => {
    const f = await createGoalFileHostFixture();
    cleanups.push(f.close);
    await writeFile(join(f.workspaceRoot, "result.txt"), "verified bytes\n");
    let primaryCalls = 0;
    let verificationCalls = 0;
    f.setResponder(async () => {
      primaryCalls++;
      if (primaryCalls === 1)
        return {
          name: "update_goal",
          arguments: {
            update: {
              action: "candidate",
              summary: "Workspace artifact is ready",
              assessments: [
                {
                  criterion_id: "objective",
                  kind: "qualitative",
                  justification: "The artifact is ready for a separate reader",
                },
              ],
            },
          },
        };
      return { text: "result.txt contains the requested result" };
    });
    f.setVerificationResponder(async (_request, ids) => {
      verificationCalls++;
      return verificationCalls === 1
        ? { name: "read_file", arguments: { path: "result.txt" } }
        : verificationResult(ids, "achieved", ["result.txt"]);
    });

    await createLiteralGoal(f, "verify-artifact");
    await f.until(
      async () => (await f.client.goals.get("conversation")).state.current?.status === "complete",
    );
    await f.until(() => f.host.stats().runs === 0);

    const proof = (await f.client.goals.get("conversation")).state.current!.runs[0]!
      .verifications[0]!;
    expect(verificationCalls).toBe(2);
    expect(proof.inspected_artifacts).toEqual([
      { path: "result.txt", digest: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ]);
    const trace = await f.host.kernel.runs.get(proof.verification_execution_id);
    expect(
      trace.events.some(
        (event) =>
          event.type === "tool_call" &&
          (event.tool === "read_file" || event.server === "read_file"),
      ),
    ).toBe(true);
  });

  it("refuses a verifier verdict that did not inspect every normative source", async () => {
    const f = await createGoalFileHostFixture();
    cleanups.push(f.close);
    await writeFile(join(f.workspaceRoot, "normative.md"), "Stable normative requirement\n");
    let formulationCalls = 0;
    let primaryCalls = 0;
    let verificationCalls = 0;
    f.setResponder(async (request) => {
      if (request.tools?.some((tool) => tool.function.name === "submit_result")) {
        formulationCalls++;
        if (formulationCalls === 1)
          return { name: "read_file", arguments: { path: "normative.md" } };
        return {
          name: "submit_result",
          arguments: {
            status: "ready",
            objective: "Honor the stable normative requirement",
            criteria: [{ description: "The requirement is honored", kind: "qualitative" }],
            constraints: [],
            exclusions: [],
            assumptions: [],
            normative_source_paths: ["normative.md"],
          },
        };
      }
      primaryCalls++;
      if (primaryCalls === 1)
        return {
          name: "update_goal",
          arguments: {
            update: {
              action: "candidate",
              summary: "Candidate claims the normative result",
              assessments: [
                {
                  criterion_id: "criterion-01",
                  kind: "qualitative",
                  justification: "The requirement appears implemented",
                },
              ],
            },
          },
        };
      return { text: "Proposed normative result" };
    });
    f.setVerificationResponder(async (_request, ids) => {
      verificationCalls++;
      return verificationResult(ids, "achieved");
    });

    const receipt = await f.client.goals.formulate({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "verify-normative-inspection",
      mode: "guided",
      seed: "Implement normative.md",
    });
    expect(receipt.formulation.outcome).toBe("created");
    await f.until(
      async () => (await f.client.goals.get("conversation")).state.current?.status === "blocked",
    );
    await f.until(() => f.host.stats().runs === 0);

    const goal = (await f.client.goals.get("conversation")).state.current!;
    expect(verificationCalls).toBeGreaterThan(0);
    expect(goal.runs[0]!.verifications).toEqual([]);
  });

  it("blocks normative source drift before spending a verifier call", async () => {
    const f = await createGoalFileHostFixture();
    cleanups.push(f.close);
    await writeFile(join(f.workspaceRoot, "drift-spec.md"), "Original requirement\n");
    const primaryArrived = Promise.withResolvers<void>();
    const releasePrimary = Promise.withResolvers<void>();
    cleanups.push(async () => releasePrimary.resolve());
    let formulationCalls = 0;
    let primaryCalls = 0;
    let verificationCalls = 0;
    f.setResponder(async (request) => {
      const hasSubmitResult = request.tools?.some((tool) => tool.function.name === "submit_result");
      if (hasSubmitResult) {
        formulationCalls++;
        if (formulationCalls === 1)
          return { name: "read_file", arguments: { path: "drift-spec.md" } };
        return {
          name: "submit_result",
          arguments: {
            status: "ready",
            objective: "Implement the normative drift specification",
            criteria: [
              { description: "The normative requirement is implemented", kind: "qualitative" },
            ],
            constraints: [],
            exclusions: [],
            assumptions: [],
            normative_source_paths: ["drift-spec.md"],
          },
        };
      }
      primaryCalls++;
      if (primaryCalls === 1) {
        primaryArrived.resolve();
        await releasePrimary.promise;
        return {
          name: "update_goal",
          arguments: {
            update: {
              action: "candidate",
              summary: "Candidate based on the original source",
              assessments: [
                {
                  criterion_id: "criterion-1",
                  kind: "qualitative",
                  justification: "The original normative requirement appears implemented",
                },
              ],
            },
          },
        };
      }
      return { text: "Implementation based on the original source" };
    });
    f.setVerificationResponder(async (_request, ids) => {
      verificationCalls++;
      return verificationResult(ids, "achieved");
    });

    const formulation = await f.client.goals.formulate({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "formulate-drift",
      mode: "guided",
      seed: "Implement drift-spec.md",
    });
    expect(formulation.formulation.outcome).toBe("created");
    await primaryArrived.promise;
    await writeFile(join(f.workspaceRoot, "drift-spec.md"), "Changed requirement\n");
    releasePrimary.resolve();
    await f.until(
      async () => (await f.client.goals.get("conversation")).state.current?.status === "blocked",
    );
    await f.until(() => f.host.stats().runs === 0);

    const goal = (await f.client.goals.get("conversation")).state.current!;
    expect(formulationCalls).toBe(2);
    expect(primaryCalls).toBe(3);
    expect(verificationCalls).toBe(0);
    expect(goal.sources).toHaveLength(1);
    expect(goal.runs[0]!.verifications).toEqual([]);
  });
});
