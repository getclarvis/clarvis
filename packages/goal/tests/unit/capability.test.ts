import { describe, expect, it } from "bun:test";
import {
  createCapabilityServices,
  loadEnv,
  TOOL_EFFECT_PORT,
  type AgentBuildContext,
  type RunCapabilityContext,
  type RunRequest,
} from "@clarvis/capability";
import {
  admitGoalRun,
  advanceGoalRun,
  applyGoalControl,
  createGoalCapability,
  createGoalCreationCapability,
  goalRuntimePortOf,
  recordGoalCandidate,
  recordGoalCheckpoint,
  recordGoalProgress,
  type GoalRuntimePort,
  type GoalCreationPort,
  type GoalStewardCompletionDecision,
} from "../../src/index.ts";

function fixture(overrides: Partial<GoalRuntimePort> = {}) {
  let state = applyGoalControl(
    undefined,
    {
      expected_revision: 0,
      operation_id: "create",
      action: {
        kind: "create",
        objective: "Verify the synthetic feature",
        limits: { max_net_tokens: 1000 },
      },
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
  state = advanceGoalRun(state, { goal_id: "goal", execution_id: "run", phase: "running", now: 3 });
  const calls: string[] = [];
  const blocks: Array<{ kind: string; content: string }> = [];
  let completionValid = false;
  const port: GoalRuntimePort = {
    binding: {
      session_id: "session",
      agent_instance_id: "entry",
      goal_id: "goal",
      execution_id: "run",
      objective_revision: 1,
    },
    read: async () => ({ goal: structuredClone(state.current!), evidence: [] }),
    progress: async (input) => {
      calls.push("progress");
      state = recordGoalProgress(state, {
        goal_id: "goal",
        execution_id: "run",
        objective_revision: 1,
        now: 4,
        progress: { summary: input.summary, evidence: [] },
      });
    },
    checkpoint: async (input) => {
      calls.push("checkpoint");
      const checkpoint = {
        summary: input.summary,
        next_step: input.next_step,
        evidence: [],
        progress_accepted: false,
        reason: "No verified activity",
      };
      state = recordGoalCheckpoint(state, {
        goal_id: "goal",
        execution_id: "run",
        objective_revision: 1,
        now: 5,
        checkpoint,
      });
      return checkpoint;
    },
    candidate: async (input) => {
      calls.push("candidate");
      state = recordGoalCandidate(state, {
        goal_id: "goal",
        execution_id: "run",
        now: 6,
        candidate: {
          objective_revision: 1,
          execution_id: "run",
          summary: input.summary,
          assessments: input.assessments.map(({ evidence_ids: _, ...assessment }) => ({
            ...assessment,
            evidence: [],
          })),
        },
      });
      return {
        valid: completionValid,
        reasons: completionValid ? [] : ["Human acceptance is missing"],
        qualitative_criteria: ["objective"],
        revision: state.current!.revision,
      };
    },
    validateCompletion: async () => {
      calls.push("validate");
      return {
        valid: completionValid,
        reasons: [],
        qualitative_criteria: ["objective"],
        revision: state.current!.revision,
      };
    },
    blocked: async (reason) => {
      calls.push("blocked");
      state.current!.status = "blocked";
      state.current!.reason = reason;
    },
    ...overrides,
  };
  const runContext: RunCapabilityContext = {
    owner: "test",
    request: {
      session_id: "session",
      agent_instance_id: "entry",
      messages: [],
      servers: [],
      providers: [],
      profiles: [],
      entry: "entry",
      budget: { total_token_limit: 1000, on_exceed: "stop" },
    } as RunRequest,
    executionId: "run",
    entryGrants: [],
    env: loadEnv({}),
    workspaceRoot: "/fixture",
    resolvedPromptCacheTtl: "5m",
    executionBaseLlm: {
      call: async () => {
        throw new Error("Unused execution provider");
      },
    },
    llm: {
      call: async () => {
        throw new Error("Unexpected inference");
      },
    },
    emit: () => undefined,
    requestParam: () => undefined,
    services: (() => {
      const services = createCapabilityServices();
      services.provide(TOOL_EFFECT_PORT, {
        effect(name) {
          if (name === "read_file" || name === "grep" || name === "list_dir") return "read";
          if (name === "write_file" || name === "shell" || name === "edit_file") return "mutate";
          if (name === "run_workflow" || name === "run_leader") return "spawn_run";
          return "unknown";
        },
      });
      return services;
    })(),
  };
  const bc: AgentBuildContext = {
    agent: "lead",
    state: { lastAssistantText: "Partial work" },
    ctx: {
      appendNote: () => {
        throw new Error("Use the named stable block");
      },
      setCanonicalState: () => {
        throw new Error("Goal cannot replace the plan anchor");
      },
      setStableBlock: (kind, content) => {
        if (blocks.at(-1)?.content !== content) blocks.push({ kind, content });
      },
    },
    trace: { now: () => 0, record: () => undefined, signal: () => undefined },
    guards: {
      record: () => undefined,
      takeSoft: () => [],
      tripped: () => null,
      reset: () => undefined,
    },
    toolProgress: () => false,
    validateArgs: () => null,
    maybeCancelled: () => null,
  };
  const capability = createGoalCapability(port);
  return {
    port,
    capability,
    runContext,
    bc,
    blocks,
    calls,
    state: () => state,
    allowCompletion: () => {
      completionValid = true;
    },
    async attach() {
      const run = (await capability.forRun(runContext))!;
      return run.forAgent({ agent: "lead", entry: true, grants: [] })!.attach(bc);
    },
  };
}

function inputForCreation() {
  return {
    objective: "Create the synthetic Goal",
    criteria: [],
    constraints: [],
    exclusions: [],
    assumptions: [],
  };
}

describe("host-bound goal capability", () => {
  it("keeps create, read and update tools stable across Goal creation", async () => {
    const f = fixture();
    const port: GoalCreationPort = {
      session_id: "session",
      agent_instance_id: "entry",
      execution_id: "run",
      create: async () => f.port,
    };
    const capability = createGoalCreationCapability(port);
    const run = (await capability.forRun(f.runContext))!;
    const contribution = run.forAgent({ agent: "lead", entry: true, grants: [] })!.attach(f.bc);
    const initialTools = contribution.tools!.map((tool) => tool.wireName);
    expect(initialTools).toEqual(["create_goal", "get_goal", "update_goal"]);

    const created = await contribution.handlers![0]!.handle(
      {
        id: "create",
        name: "create_goal",
        arguments: { objective: "Verify the synthetic feature", criteria: [] },
      },
      1,
    );

    expect(created).toMatchObject({ kind: "result", progress: false });
    expect(contribution.tools!.map((tool) => tool.wireName)).toEqual(initialTools);
    expect(
      await contribution.handlers![0]!.handle({ id: "get", name: "get_goal", arguments: {} }, 2),
    ).toMatchObject({ kind: "result", progress: false });
  });

  it("covers the creation-stage controls and completion gate", async () => {
    const f = fixture();
    const port: GoalCreationPort = {
      session_id: "session",
      agent_instance_id: "entry",
      execution_id: "run",
      create: async () => f.port,
    };
    const capability = createGoalCreationCapability(port);
    const run = (await capability.forRun(f.runContext))!;
    const contribution = run.forAgent({ agent: "lead", entry: true, grants: [] })!.attach(f.bc);
    const handler = contribution.handlers![0]!;

    await contribution.hooks!.beforeIteration!();
    contribution.hooks!.afterDispatch!();
    expect(f.blocks.some((block) => block.kind === "goal_formulation")).toBe(true);
    expect(
      contribution.dispatchPolicy?.admit({ id: "write", name: "write_file", arguments: {} }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("create_goal") });
    expect(
      contribution.dispatchPolicy?.admit({ id: "read", name: "read_file", arguments: {} }),
    ).toEqual({ ok: true });
    expect(
      contribution.dispatchPolicy?.admit({ id: "shell", name: "shell", arguments: {} }),
    ).toMatchObject({ ok: false });
    expect(
      contribution.dispatchPolicy?.admit({
        id: "delegate",
        name: "delegate_task",
        arguments: {},
      }),
    ).toMatchObject({ ok: false });
    expect(
      await handler.handle({ id: "get-before", name: "get_goal", arguments: {} }, 1),
    ).toMatchObject({ kind: "result", text: expect.stringContaining("Create the Goal first") });
    expect(
      await handler.handle(
        {
          id: "update-before",
          name: "update_goal",
          arguments: { update: { action: "progress", summary: "not yet" } },
        },
        1,
      ),
    ).toMatchObject({ kind: "result", text: expect.stringContaining("Create the Goal first") });
    expect(
      await handler.handle({ id: "invalid", name: "create_goal", arguments: { objective: "" } }, 1),
    ).toMatchObject({ kind: "result", text: expect.stringContaining("Invalid Goal arguments") });
    expect(
      await contribution.gates![0]!.check({ mode: "text", text: "A premature answer" }),
    ).toMatchObject({ kind: "nudge" });
    expect(
      await contribution.gates![0]!.check({ mode: "text", text: "Still premature" }),
    ).toMatchObject({ kind: "terminal", result: { error: { code: "goal_blocked" } } });

    expect(
      await handler.handle({ id: "create", name: "create_goal", arguments: inputForCreation() }, 2),
    ).toMatchObject({ kind: "result", text: expect.stringContaining("Goal created") });
    expect(
      contribution.dispatchPolicy?.admit({ id: "write-after", name: "write_file", arguments: {} }),
    ).toEqual({ ok: true });
    expect(
      await handler.handle(
        { id: "duplicate", name: "create_goal", arguments: inputForCreation() },
        3,
      ),
    ).toMatchObject({ kind: "result", text: expect.stringContaining("already exists") });
    expect(
      await handler.handle(
        {
          id: "progress",
          name: "update_goal",
          arguments: { update: { action: "progress", summary: "Inspected the implementation" } },
        },
        4,
      ),
    ).toMatchObject({ kind: "result", text: expect.stringContaining("Progress recorded") });
    const checkpoint = await handler.handle(
      {
        id: "checkpoint",
        name: "update_goal",
        arguments: {
          update: { action: "checkpoint", summary: "Stage complete", next_step: "Continue" },
        },
      },
      5,
    );
    expect(checkpoint).toMatchObject({
      kind: "finalize",
      text: expect.stringContaining("Checkpoint"),
    });
    if (checkpoint.kind !== "finalize") throw new Error("Expected checkpoint finalization");
    expect(await contribution.gates![0]!.check(checkpoint.attempt)).toEqual({ kind: "pass" });

    expect(
      await handler.handle(
        {
          id: "candidate",
          name: "update_goal",
          arguments: {
            update: {
              action: "candidate",
              summary: "Verified",
              assessments: [
                { criterion_id: "objective", kind: "qualitative", justification: "Observed" },
              ],
            },
          },
        },
        6,
      ),
    ).toMatchObject({ kind: "result", text: expect.stringContaining("Human acceptance") });
    f.allowCompletion();
    expect(await contribution.gates![0]!.check({ mode: "text", text: "Done" })).toEqual({
      kind: "pass",
    });
    expect(f.calls).toEqual(["progress", "checkpoint", "candidate", "validate"]);
  });

  it("covers creation review feedback, invalid candidates and bounded failures", async () => {
    let decision: GoalStewardCompletionDecision = {
      kind: "needs_evidence",
      review_id: "review",
      next_step: "Run the browser-level check",
    };
    let reviewThrows = false;
    const f = fixture();
    const port: GoalCreationPort = {
      session_id: "session",
      agent_instance_id: "entry",
      execution_id: "run",
      create: async () => f.port,
      reviewCompletion: async () => {
        if (reviewThrows) throw new Error("private review detail");
        return decision;
      },
    };
    const capability = createGoalCreationCapability(port);
    const run = (await capability.forRun(f.runContext))!;
    const contribution = run.forAgent({ agent: "lead", entry: true, grants: [] })!.attach(f.bc);
    const handler = contribution.handlers![0]!;
    await handler.handle({ id: "create", name: "create_goal", arguments: inputForCreation() }, 1);

    expect(await contribution.gates![0]!.check({ mode: "text", text: "Done" })).toMatchObject({
      kind: "nudge",
    });
    expect(await contribution.gates![0]!.check({ mode: "text", text: "Done again" })).toMatchObject(
      {
        kind: "terminal",
        result: { error: { code: "goal_blocked" } },
      },
    );
    f.allowCompletion();
    expect(await contribution.gates![0]!.check({ mode: "text", text: "Done" })).toMatchObject({
      kind: "nudge",
      note: expect.stringContaining("clarification"),
    });
    decision = { kind: "needs_work", review_id: "review", next_step: "Fix the failing path" };
    expect(
      await contribution.gates![0]!.check({ mode: "submit", value: { done: true } }),
    ).toMatchObject({
      kind: "nudge",
      note: expect.stringContaining("correction"),
    });
    decision = {
      kind: "interrupted",
      review_id: "review",
      reason: "goal_steward_failed",
      cause: "transport",
    };
    expect(await contribution.gates![0]!.check({ mode: "text", text: "Done" })).toMatchObject({
      kind: "terminal",
      result: { error: { code: "goal_steward_failed" } },
    });
    decision = { kind: "achieved", review_id: "review" };
    expect(await contribution.gates![0]!.check({ mode: "text", text: "Done" })).toEqual({
      kind: "pass",
    });
    reviewThrows = true;
    expect(await contribution.gates![0]!.check({ mode: "text", text: "Done" })).toMatchObject({
      kind: "terminal",
      result: { error: { code: "goal_control_failed" } },
    });
    expect(
      await contribution.gates![0]!.check({ mode: "text", text: "x".repeat(128 * 1024) }),
    ).toMatchObject({
      kind: "terminal",
      result: { error: { code: "goal_steward_inconclusive" } },
    });
  });

  it("stops creation controls on blocked and storage failures", async () => {
    const blocked = fixture();
    const blockedPort: GoalCreationPort = {
      session_id: "session",
      agent_instance_id: "entry",
      execution_id: "run",
      create: async () => blocked.port,
    };
    const blockedCapability = createGoalCreationCapability(blockedPort);
    const blockedRun = (await blockedCapability.forRun(blocked.runContext))!;
    const blockedContribution = blockedRun
      .forAgent({ agent: "lead", entry: true, grants: [] })!
      .attach(blocked.bc);
    const blockedHandler = blockedContribution.handlers![0]!;
    await blockedHandler.handle(
      { id: "create", name: "create_goal", arguments: inputForCreation() },
      1,
    );
    expect(
      await blockedHandler.handle(
        {
          id: "blocked",
          name: "update_goal",
          arguments: { update: { action: "blocked", reason: "Missing browser evidence" } },
        },
        2,
      ),
    ).toMatchObject({ kind: "terminal", result: { error: { code: "goal_blocked" } } });

    const failed = fixture({
      progress: async () => {
        throw new Error("private store detail");
      },
    });
    const failedPort: GoalCreationPort = {
      session_id: "session",
      agent_instance_id: "entry",
      execution_id: "run",
      create: async () => failed.port,
    };
    const failedCapability = createGoalCreationCapability(failedPort);
    const failedRun = (await failedCapability.forRun(failed.runContext))!;
    const failedContribution = failedRun
      .forAgent({ agent: "lead", entry: true, grants: [] })!
      .attach(failed.bc);
    const failedHandler = failedContribution.handlers![0]!;
    await failedHandler.handle(
      { id: "create", name: "create_goal", arguments: inputForCreation() },
      1,
    );
    expect(
      await failedHandler.handle(
        {
          id: "progress",
          name: "update_goal",
          arguments: { update: { action: "progress", summary: "Record progress" } },
        },
        2,
      ),
    ).toMatchObject({ kind: "terminal", result: { error: { code: "goal_control_failed" } } });
    failed.port.read = async () => {
      throw new Error("private read detail");
    };
    expect(await failedContribution.hooks!.beforeIteration!()).toMatchObject({
      status: "error",
      error: { code: "goal_control_failed" },
    });
  });

  it("requires admission, filters children and composes without an anchor or output budget", async () => {
    const f = fixture();
    expect(f.capability.required).toBe(true);
    const run = (await f.capability.forRun(f.runContext))!;
    expect(run.preserveStateOnInterruption).toBe(true);
    expect(run.forAgent({ agent: "subagent", entry: false, grants: ["goal"] })).toBeNull();
    expect(run.forAgent({ agent: "subagent", entry: true, grants: [] })).not.toBeNull();
    const contribution = await f.attach();
    expect(contribution.anchor).toBeUndefined();
    expect(contribution.outputBudget).toBeUndefined();
    expect(run).not.toHaveProperty("systemSection");
    expect(contribution.tools!.map((tool) => tool.wireName)).toEqual(["get_goal", "update_goal"]);
    expect(contribution.gates![0]!.fastAcceptOk!()).toBe(false);
    expect(f.blocks[0]!.kind).toBe("goal");
    expect(goalRuntimePortOf(f.capability)).toBe(f.port);
    expect(goalRuntimePortOf({ ...f.capability })).toBeUndefined();
  });

  it("renders explicit criteria, human acceptance and matching host evidence", async () => {
    const f = fixture();
    const goal = f.state().current!;
    goal.criteria = [
      { id: "quality", kind: "qualitative", description: "Behavior is correct" },
      { id: "review", kind: "human", description: "The operator accepted the result" },
    ];
    goal.human_acceptances = [
      {
        criterion_id: "review",
        objective_revision: goal.objective_revision,
        operation_id: "accept-review",
        accepted_at: 4,
      },
    ];
    goal.constraints = ["Keep the public protocol compatible"];
    goal.exclusions = ["Do not publish"];
    goal.assumptions = ["The fixture represents the requested surface"];
    goal.sources = [{ path: "specs/capabilities/goals.md", digest: "a".repeat(64) }];
    f.port.read = async () => ({
      goal: structuredClone(goal),
      evidence: [
        {
          id: "tool-proof",
          goal_id: goal.goal_id,
          execution_id: "run",
          objective_revision: goal.objective_revision,
          kind: "tool_result",
          description: "Verified tool result",
        },
      ],
    });
    const contribution = await f.attach();
    const result = await contribution.handlers![0]!.handle(
      { id: "get", name: "get_goal", arguments: {} },
      1,
    );
    expect(f.blocks[0]!.content).toContain('"id":"quality"');
    expect(f.blocks[0]!.content).toContain('"constraints":["Keep the public protocol compatible"]');
    expect(result.kind).toBe("result");
    if (result.kind !== "result") throw new Error("Expected get_goal result");
    expect(result.text).toContain('"accepted_human_criteria":["review"]');
    expect(result.text).toContain('"normative_sources":[{"path":"specs/capabilities/goals.md"');
  });

  it.each(["session_id", "agent_instance_id", "executionId"] as const)(
    "rejects a foreign %s before attachment",
    async (field) => {
      const f = fixture();
      if (field === "executionId")
        await expect(
          f.capability.forRun({ ...f.runContext, executionId: "foreign" }),
        ).rejects.toThrow("admitted entry identity");
      else
        await expect(
          f.capability.forRun({
            ...f.runContext,
            request: { ...f.runContext.request, [field]: "foreign" },
          }),
        ).rejects.toThrow("admitted entry identity");
      expect(f.calls).toEqual([]);
    },
  );

  it("reads an implicit qualitative criterion without exposing the private audit or counting progress", async () => {
    const f = fixture();
    const { handlers } = await f.attach();
    const result = await handlers![0]!.handle({ id: "get", name: "get_goal", arguments: {} }, 1);
    expect(result).toMatchObject({ kind: "result", progress: false });
    if (result.kind !== "result") throw new Error("Expected result");
    expect(result.text).toContain('"id":"objective","kind":"qualitative"');
    expect(result.text).not.toContain('"runs"');
    expect(result.text).not.toContain("operation_id");
    expect(f.calls).toEqual([]);
  });

  it.each([
    "paused preparation",
    "revoked preparation",
    "foreign goal",
    "closed run",
    "foreign evidence",
  ])("fails activation on %s from the host port", async (caseName) => {
    const f = fixture();
    const goal = f.state().current!;
    switch (caseName) {
      case "paused preparation":
        goal.status = "paused";
        goal.runs[0]!.phase = "preparing";
        break;
      case "revoked preparation":
        goal.runs[0]!.phase = "preparing";
        goal.control_revision += 1;
        break;
      case "foreign goal":
        goal.goal_id = "other-goal";
        break;
      case "closed run":
        goal.runs[0]!.phase = "closed";
        break;
      case "foreign evidence":
        f.port.read = async () => ({
          goal,
          evidence: [
            {
              id: "evidence",
              goal_id: "foreign",
              execution_id: "run",
              objective_revision: 1,
              kind: "tool_result",
              description: "Foreign fixture result",
            },
          ],
        });
        break;
    }
    await expect(f.capability.forRun(f.runContext)).rejects.toThrow("bound execution");
    expect(f.calls).toEqual([]);
  });

  it.each([
    { action: "resume" },
    { action: "progress", summary: "done", session_id: "foreign" },
    { action: "progress", summary: "done", max_net_tokens: 999999 },
    { action: "progress", summary: "done", next_step: "not a progress field" },
    { action: "checkpoint", summary: "done", next_step: "" },
    {
      action: "checkpoint",
      summary: "Implementation inspected",
      next_step: "Verify in the next stage",
      evidence_ids: [],
      assessments: [{ criterion_id: "objective", kind: "qualitative", justification: "Pending" }],
      reason: "Stage boundary",
    },
    {
      action: "checkpoint",
      summary: "done",
      next_step: "continue",
      evidence_ids: [{ goal_id: "foreign", id: "fake" }],
    },
    { action: "blocked", reason: "x".repeat(4097) },
  ])("rejects invalid or privileged model controls %j", async (args) => {
    const f = fixture();
    const { handlers } = await f.attach();
    expect(
      await handlers![0]!.handle(
        { id: "update", name: "update_goal", arguments: { update: args } },
        1,
      ),
    ).toMatchObject({
      kind: "result",
      progress: false,
      text: expect.stringContaining("error"),
    });
    expect(f.calls).toEqual([]);
  });

  it("refreshes external state at iteration entry without a goal tool call", async () => {
    const f = fixture();
    const contribution = await f.attach();
    const tools = structuredClone(contribution.tools);
    f.state().current!.status = "paused";
    await contribution.hooks!.beforeIteration!();
    expect(f.calls).toEqual([]);
    expect(f.blocks).toHaveLength(2);
    expect(f.blocks[0]!.content).toContain('"status":"active"');
    expect(f.blocks[1]!.content).toContain('"status":"paused"');
    expect(contribution.tools).toEqual(tools);
  });

  it("stops on a failed iteration read without publishing stale state", async () => {
    const f = fixture();
    const contribution = await f.attach();
    f.port.read = async () => {
      throw new Error("private fixture detail");
    };
    expect(await contribution.hooks!.beforeIteration!()).toMatchObject({
      status: "error",
      error: {
        code: "goal_control_failed",
        message: "Goal control is unavailable; execution stopped",
      },
    });
    expect(f.blocks).toHaveLength(1);
  });

  it("does not publish a delayed snapshot after iteration cancellation", async () => {
    const f = fixture();
    const contribution = await f.attach();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    f.port.read = async () => {
      entered.resolve();
      await release.promise;
      return { goal: { ...f.state().current!, status: "paused" }, evidence: [] };
    };
    const pending = contribution.hooks!.beforeIteration!(controller.signal);
    await entered.promise;
    controller.abort(new Error("retired iteration"));
    release.resolve();
    await expect(Promise.resolve(pending)).rejects.toThrow("retired iteration");
    await contribution.hooks!.onTeardown!();
    expect(f.blocks).toHaveLength(1);
  });

  it("records progress without a checkpoint and preserves the stable catalog and context", async () => {
    const f = fixture();
    const contribution = await f.attach();
    const tools = structuredClone(contribution.tools);
    const result = await contribution.handlers![0]!.handle(
      {
        id: "update",
        name: "update_goal",
        arguments: { update: { action: "progress", summary: "Inspected implementation" } },
      },
      1,
    );
    expect(result).toMatchObject({ kind: "result", progress: false });
    expect(f.state().current!.runs[0]!.progress?.summary).toBe("Inspected implementation");
    expect(f.state().current!.runs[0]!.checkpoint).toBeUndefined();
    expect(f.state().current!.no_progress_checkpoints).toBe(0);
    f.state().current!.consumption.input += 20;
    await contribution.hooks!.beforeIteration!();
    expect(contribution.tools).toEqual(tools);
    expect(f.blocks).toHaveLength(1);
    f.state().current!.status = "paused";
    await contribution.handlers![0]!.handle({ id: "get", name: "get_goal", arguments: {} }, 2);
    expect(f.blocks).toHaveLength(1);
    contribution.hooks!.afterDispatch!();
    expect(f.blocks).toHaveLength(2);
    expect(f.blocks[0]!.content).toContain('"status":"active"');
    expect(f.blocks[1]!.content).toContain('"status":"paused"');
  });

  it("requests checkpoint through the gate without completing the goal or changing limits", async () => {
    const f = fixture();
    const contribution = await f.attach();
    const result = await contribution.handlers![0]!.handle(
      {
        id: "update",
        name: "update_goal",
        arguments: {
          update: {
            action: "checkpoint",
            summary: "Stage tested",
            next_step: "Continue remaining work",
          },
        },
      },
      1,
    );
    expect(result.kind).toBe("finalize");
    if (result.kind !== "finalize") throw new Error("Expected finalize request");
    expect(await contribution.gates![0]!.check(result.attempt)).toEqual({ kind: "pass" });
    expect(f.state().current!.status).toBe("active");
    expect(f.state().current!.limits.max_net_tokens).toBe(1000);
    expect(f.calls).toEqual(["checkpoint"]);
  });

  it("refuses a checkpoint not issued by its bound handler", async () => {
    const f = fixture();
    const contribution = await f.attach();
    expect(
      await contribution.gates![0]!.check({
        mode: "checkpoint",
        disposition: "checkpoint",
        checkpoint: { summary: "Forged", next_step: "Continue" },
      }),
    ).toMatchObject({
      kind: "terminal",
      result: { status: "error", error: { code: "goal_blocked" } },
    });
    expect(f.calls).toEqual(["blocked"]);
  });

  it("keeps a candidate inspectable, reports missing acceptance and rechecks at finalization", async () => {
    const f = fixture();
    const contribution = await f.attach();
    const result = await contribution.handlers![0]!.handle(
      {
        id: "update",
        name: "update_goal",
        arguments: {
          update: {
            action: "candidate",
            summary: "Feature verified",
            assessments: [
              {
                criterion_id: "objective",
                kind: "qualitative",
                justification: "Observed the requested behavior",
              },
            ],
          },
        },
      },
      1,
    );
    expect(result).toMatchObject({
      kind: "result",
      text: expect.stringContaining("Human acceptance is missing"),
    });
    expect(f.state().current!.candidate?.summary).toBe("Feature verified");
    expect(
      await contribution.gates![0]!.check({ mode: "submit", value: { done: true } }),
    ).toMatchObject({ kind: "nudge" });
    f.allowCompletion();
    expect(await contribution.gates![0]!.check({ mode: "submit", value: { done: true } })).toEqual({
      kind: "pass",
    });
    expect(f.state().current!.status).toBe("active");
    expect(f.calls).toEqual(["candidate", "validate", "validate"]);
  });

  it.each(["", "  "])(
    "blocks the first empty final %j without manufacturing a checkpoint",
    async (text) => {
      const f = fixture();
      const contribution = await f.attach();
      expect(await contribution.gates![0]!.check({ mode: "text", text })).toMatchObject({
        kind: "terminal",
        result: { status: "error", error: { code: "goal_blocked" } },
      });
      expect(f.state().current!.runs[0]!.checkpoint).toBeUndefined();
    },
  );

  it("allows only one final recovery nudge before explicit blocking", async () => {
    const f = fixture();
    const contribution = await f.attach();
    const gate = contribution.gates![0]!;
    expect(await gate.check({ mode: "text", text: "All done" })).toMatchObject({ kind: "nudge" });
    expect(await gate.check({ mode: "text", text: "Really done" })).toMatchObject({
      kind: "terminal",
      result: { error: { code: "goal_blocked" } },
    });
  });

  it("reports blocking through safe interruption and respects cancellation before host mutation", async () => {
    const f = fixture();
    const contribution = await f.attach();
    f.bc.maybeCancelled = () => ({ status: "cancelled", partialText: "" });
    expect(
      await contribution.handlers![0]!.handle(
        {
          id: "update",
          name: "update_goal",
          arguments: { update: { action: "blocked", reason: "Approval refused" } },
        },
        1,
      ),
    ).toMatchObject({ kind: "terminal", result: { status: "cancelled" } });
    expect(f.calls).toEqual([]);
    f.bc.maybeCancelled = () => null;
    expect(
      await contribution.handlers![0]!.handle(
        {
          id: "update",
          name: "update_goal",
          arguments: { update: { action: "blocked", reason: "Approval refused" } },
        },
        2,
      ),
    ).toMatchObject({ kind: "terminal", result: { error: { code: "goal_blocked" } } });
    expect(f.calls).toEqual(["blocked"]);
  });

  it("fails required setup and terminates later storage faults without echoing diagnostics", async () => {
    const error = new Error("private-store-secret");
    const bad = fixture({
      read: async () => {
        throw error;
      },
    });
    await expect(bad.capability.forRun(bad.runContext)).rejects.toThrow(error);
    const f = fixture({
      progress: async () => {
        throw error;
      },
    });
    const contribution = await f.attach();
    const result = await contribution.handlers![0]!.handle(
      {
        id: "update",
        name: "update_goal",
        arguments: { update: { action: "progress", summary: "Record progress" } },
      },
      1,
    );
    expect(result).toMatchObject({
      kind: "terminal",
      result: { error: { code: "goal_control_failed" } },
    });
    expect(JSON.stringify(result)).not.toContain("private-store-secret");
    f.state().current!.objective_revision += 1;
    expect(await contribution.gates![0]!.check({ mode: "text", text: "done" })).toMatchObject({
      kind: "terminal",
      result: { error: { code: "goal_control_failed" } },
    });
  });
});

it("routes Steward completion decisions and respects pending operator steering", async () => {
  let decision: GoalStewardCompletionDecision = {
    kind: "achieved",
    review_id: "review",
  };
  let throws = false;
  let pending = false;
  const f = fixture({
    steward: {
      bindReviewContext: () => undefined,
      closeCoordinator: async () => undefined,
      reviewCompletion: async () => {
        if (throws) throw new Error("Unavailable");
        return decision;
      },
    },
  });
  f.bc.steerProbe = () => pending;
  f.allowCompletion();
  const c = await f.attach();
  const gate = c.gates![0]!;
  expect(await gate.check({ mode: "text", text: "Done" })).toEqual({ kind: "pass" });
  decision = { kind: "needs_work", review_id: "review", next_step: "Run tests" };
  expect(await gate.check({ mode: "submit", value: { done: true } })).toMatchObject({
    kind: "nudge",
    note: "[goal steward correction] Run tests",
  });
  // The reason code names the domain failure; only the cause says why it
  // happened. The terminal message carries the cause, so a transcript explains
  // the run instead of restating the category the engine filed it under.
  const causes = [
    ["timeout", "the Steward review did not finish in time"],
    ["transport", "the Steward review failed in transit"],
    ["cancelled", "the Steward review was cancelled"],
    ["invalid_output", "the Steward review returned an unusable result"],
    ["usage_unknown", "the Steward review's token consumption could not be determined"],
  ] as const;
  for (const reason of ["goal_steward_failed", "goal_steward_inconclusive"]) {
    for (const [cause, message] of causes) {
      decision = { kind: "interrupted", review_id: "review", reason, cause };
      expect(await gate.check({ mode: "text", text: "Done" })).toMatchObject({
        kind: "terminal",
        result: { error: { code: reason, message } },
      });
    }
  }
  throws = true;
  expect(await gate.check({ mode: "text", text: "Done" })).toMatchObject({
    kind: "terminal",
    result: { error: { code: "goal_steward_failed" } },
  });
  expect(await gate.check({ mode: "text", text: "x".repeat(128 * 1024) })).toMatchObject({
    kind: "terminal",
    result: { error: { code: "goal_steward_inconclusive" } },
  });
  pending = true;
  expect(await gate.check({ mode: "text", text: "Done" })).toMatchObject({ kind: "nudge" });
});
