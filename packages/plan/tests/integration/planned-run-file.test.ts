/**
 * End-to-end coverage of the `plans` capability's own contribution — the plan
 * Markdown file it writes, seals into the run record, and deletes under
 * `retention: "discard"`.
 *
 * This used to drive a whole `@clarvis/loop` run
 * (`packages/loop/tests/integration/planned-run-file.test.ts`); it moved here
 * with the rest of file-backed planning, and `@clarvis/plan` must never
 * import `@clarvis/loop` — that edge would close a dependency cycle a test in
 * the loop enforces. So instead of driving a real run, this drives
 * `createPlansCapability`'s `forRun` -> `forAgent` -> `attach` directly
 * against contract-shaped fakes (see `../helpers/context.ts`), exactly as a host would,
 * and dispatches plan tool calls through the returned contribution's own
 * handlers and finalize gates.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  createCapabilityServices,
  createComputeClock,
  type AgentLoopContribution,
  type AgentScope,
  type CapabilityEvent,
  type Elicit,
  type FinalizeAttempt,
  type GateOutcome,
  type HandlerVerdict,
  type LLMToolCall,
  type RunCapability,
} from "@clarvis/capability";
import { createFilePlanRepository, createPlanStore, type PlanRef } from "@clarvis/plan";
import { createPlansCapability } from "@clarvis/plan/capability";
import {
  fakeAgentBuildContext,
  fakeExecutionRecord,
  fakeRunCapabilityContext,
} from "../helpers/context.ts";
import { createTempWorkspace, type TempWorkspace } from "../helpers/temp.ts";

const CREATE_PLAN_TOOL_NAME = "create_plan";
const TRANSITION_PLAN_TASK_TOOL_NAME = "transition_plan_task";

const workspaces: TempWorkspace[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.cleanup()));
});

async function planFiles(workspaceRoot: string): Promise<string[]> {
  try {
    return (await readdir(join(workspaceRoot, ".clarvis", "plans"))).filter((n) =>
      n.endsWith(".md"),
    );
  } catch {
    return [];
  }
}

/** Builds the plans capability over a fresh temp workspace and drives
 * `forRun` with the given `plans` request param, as a host would. */
async function forRun(
  plans: unknown,
): Promise<{ workspaceRoot: string; events: CapabilityEvent[]; run: RunCapability | null }> {
  const workspace = await createTempWorkspace("clarvis-plan-capability-");
  workspaces.push(workspace);
  const workspaceRoot = workspace.dir;
  const events: CapabilityEvent[] = [];
  const capability = createPlansCapability({
    factory: {
      async storeFor() {
        return {
          key: "markdown",
          providerKind: "markdown",
          store: createPlanStore({ repository: createFilePlanRepository({ workspaceRoot }) }),
        };
      },
    },
    defaultPendingTaskNudges: 3,
    defaultElicitWaitMs: 30_000,
  });
  const run = await capability.forRun(
    fakeRunCapabilityContext({
      workspaceRoot,
      services: createCapabilityServices(),
      requestParam: (key) => (key === "plans" ? plans : undefined),
      emit: (event) => events.push(event),
    }),
  );
  return { workspaceRoot, events, run };
}

/** Attaches the `plans` capability to a solo entry agent — the shape a run
 * with no delegation gets. */
function attachEntry(run: RunCapability, opts: { elicit?: Elicit } = {}): AgentLoopContribution {
  const scope: AgentScope = {
    agent: "lead",
    entry: true,
    grants: [],
    clock: createComputeClock(60_000),
    ...(opts.elicit === undefined ? {} : { elicit: opts.elicit }),
  };
  const agentCapability = run.forAgent(scope);
  if (agentCapability === null) throw new Error("plans capability refused the entry agent");
  return agentCapability.attach(fakeAgentBuildContext());
}

/** Dispatches one call through the contribution's handlers, first-match, as
 * the engine's own dispatcher does. */
async function dispatch(
  contribution: AgentLoopContribution,
  call: LLMToolCall,
): Promise<HandlerVerdict> {
  const handler = contribution.handlers?.find((h) => h.matches(call));
  if (handler === undefined) throw new Error(`no handler claimed '${call.name}'`);
  return handler.handle(call, 1);
}

/** Runs every finalize gate in order, stopping at the first non-`pass`
 * outcome — the same sweep a real finalize attempt gets. */
async function checkGates(
  contribution: AgentLoopContribution,
  attempt: FinalizeAttempt,
): Promise<GateOutcome> {
  for (const gate of contribution.gates ?? []) {
    const outcome = await gate.check(attempt);
    if (outcome.kind !== "pass") return outcome;
  }
  return { kind: "pass" };
}

function extractCas(text: string): { revision: number; digest: string; spec_digest: string } {
  return JSON.parse(text.slice(text.indexOf("{"))) as {
    revision: number;
    digest: string;
    spec_digest: string;
  };
}

const CREATE_PLAN_CALL: LLMToolCall = {
  id: "p1",
  name: CREATE_PLAN_TOOL_NAME,
  arguments: {
    title: "Audit the auth flow",
    objective: "Understand how sessions are issued",
    context: "express app with custom middleware",
    tasks: [{ title: "Read the middleware", detail: "trace the session cookie" }],
    validation: ["the report cites the middleware"],
  },
};

/** Closes task `t1` against the given compare-and-swap triple, as a Lead does
 * by reading the triple straight out of `create_plan`'s own tool result. */
function closeTaskOneCall(cas: {
  revision: number;
  digest: string;
  spec_digest: string;
}): LLMToolCall {
  return {
    id: "d1",
    name: TRANSITION_PLAN_TASK_TOOL_NAME,
    arguments: {
      expected_revision: cas.revision,
      expected_digest: cas.digest,
      expected_spec_digest: cas.spec_digest,
      task_id: "t1",
      status: "done",
      result: "sessions are issued by session.ts",
    },
  };
}

describe("a planned run writes one Markdown plan into the workspace", () => {
  it("creates the file mid-run, records the outcome in it, and keeps it on a clean finish", async () => {
    const { workspaceRoot, run } = await forRun("on");
    expect(run).not.toBeNull();
    const contribution = attachEntry(run!);

    const created = await dispatch(contribution, CREATE_PLAN_CALL);
    if (created.kind !== "result") throw new Error("create_plan did not return a result");

    // The plan file is on disk mid-run, before the agent has finished, and
    // the mutating tool's own result already carries the NEXT
    // compare-and-swap triple.
    const midRun = await planFiles(workspaceRoot);
    expect(midRun).toHaveLength(1);
    expect(midRun[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-audit-the-auth-flow\.md$/);
    const midRunMarkdown = await readFile(
      join(workspaceRoot, ".clarvis", "plans", midRun[0]!),
      "utf8",
    );
    expect(midRunMarkdown).toContain("## Objective");
    expect(midRunMarkdown).toContain("- [ ] (t1) Read the middleware");

    const cas = extractCas(created.text);
    const transitioned = await dispatch(contribution, closeTaskOneCall(cas));
    expect(transitioned.kind).toBe("result");

    const gate = await checkGates(contribution, { mode: "text" });
    expect(gate.kind).toBe("pass");

    const ref = (await run!.finalizeRun!({ status: "completed" })) as PlanRef;
    expect(ref).toMatchObject({
      path: `.clarvis/plans/${midRun[0]!}`,
      retention: "keep",
      status: "completed",
    });

    await run!.onRunEnd?.(fakeExecutionRecord("completed", { plans: ref }));

    const remaining = await planFiles(workspaceRoot);
    expect(remaining).toEqual([midRun[0]!]);
    const markdown = await readFile(
      join(workspaceRoot, ".clarvis", "plans", remaining[0]!),
      "utf8",
    );
    expect(markdown).toContain("retention: keep");
    expect(markdown).toContain("status: completed");
    expect(markdown).toContain("- [x] (t1) Read the middleware");
    expect(markdown).toContain("Result: sessions are issued by session.ts");
  });

  it("deletes the file on a clean finish only when the run asks for retention 'discard'", async () => {
    const { workspaceRoot, run } = await forRun({ mode: "on", retention: "discard" });
    expect(run).not.toBeNull();
    const contribution = attachEntry(run!);

    const created = await dispatch(contribution, CREATE_PLAN_CALL);
    if (created.kind !== "result") throw new Error("create_plan did not return a result");
    const cas = extractCas(created.text);
    const transitioned = await dispatch(contribution, closeTaskOneCall(cas));
    if (transitioned.kind !== "result")
      throw new Error("transition_plan_task did not return a result");

    const ref = (await run!.finalizeRun!({ status: "completed" })) as PlanRef;
    expect(ref).toMatchObject({ retention: "discard", status: "completed" });

    await run!.onRunEnd?.(fakeExecutionRecord("completed", { plans: ref }));

    expect(await planFiles(workspaceRoot)).toEqual([]);
  });

  it("review mode gates the plan on a human approval before the lead may work", async () => {
    const asked: { kind?: string; message: string }[] = [];
    const elicit: Elicit = async (params) => {
      asked.push({ kind: params.kind, message: params.message });
      return { action: "accept", content: { decision: "approve" } };
    };
    const { workspaceRoot, run } = await forRun("review");
    expect(run).not.toBeNull();
    const contribution = attachEntry(run!, { elicit });

    const created = await dispatch(contribution, CREATE_PLAN_CALL);
    if (created.kind !== "result") throw new Error("create_plan did not return a result");
    const cas = extractCas(created.text);

    // The plan tools are never gated by the review blocker, even while the
    // plan awaits approval — only the coding toolset is refused until then.
    const transitioned = await dispatch(contribution, closeTaskOneCall(cas));
    if (transitioned.kind !== "result")
      throw new Error("transition_plan_task did not return a result");

    // The first finalize attempt is not approved yet: the gate presents the
    // review inline, records the approval, and nudges the model to continue
    // rather than passing outright.
    const firstAttempt = await checkGates(contribution, { mode: "text" });
    expect(firstAttempt.kind).toBe("nudge");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.kind).toBe("plan_review");
    expect(asked[0]!.message).not.toContain("[plan-review]");

    // The second attempt sees the approval already recorded and passes
    // without asking the human again.
    const secondAttempt = await checkGates(contribution, { mode: "text" });
    expect(secondAttempt.kind).toBe("pass");
    expect(asked).toHaveLength(1);

    const ref = (await run!.finalizeRun!({ status: "completed" })) as PlanRef;
    expect(ref?.status).toBe("completed");

    const remaining = await planFiles(workspaceRoot);
    expect(remaining).toHaveLength(1);
    const markdown = await readFile(
      join(workspaceRoot, ".clarvis", "plans", remaining[0]!),
      "utf8",
    );
    expect(markdown).toContain("status: completed");
    expect(markdown).toContain("approved_spec_revision: 1");
  });

  it("review mode cancels the run when the human declines the plan", async () => {
    const elicit: Elicit = async () => ({ action: "accept", content: { decision: "cancel" } });
    const { workspaceRoot, run } = await forRun("review");
    expect(run).not.toBeNull();
    const contribution = attachEntry(run!, { elicit });

    const created = await dispatch(contribution, CREATE_PLAN_CALL);
    if (created.kind !== "result") throw new Error("create_plan did not return a result");
    const cas = extractCas(created.text);
    await dispatch(contribution, closeTaskOneCall(cas));

    const outcome = await checkGates(contribution, { mode: "text" });
    if (outcome.kind !== "terminal") throw new Error("expected the review decline to end the run");
    expect(outcome.result.status).toBe("cancelled");

    const ref = (await run!.finalizeRun!({ status: "cancelled" })) as PlanRef;
    expect(ref?.status).toBe("cancelled");
    await run!.onRunEnd?.(fakeExecutionRecord("cancelled", { plans: ref }));

    expect(await planFiles(workspaceRoot)).toHaveLength(1);
  });
});
