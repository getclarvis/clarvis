import { describe, expect, it } from "bun:test";
import {
  ElicitTimeoutError,
  type AgentScope,
  type HandlerVerdict,
  type RunCapability,
  type ToolHandler,
} from "@clarvis/capability";
import {
  ACTIVE_TASK_MARKER,
  TASK_GRANTS,
  TASK_TOOL_NAMES,
  TASK_TOOL_WIRE_NAMES,
  createTasksCapability,
  taskCapabilityStateV2Schema,
  type TaskCapabilityStateV2,
  type TaskRunStateV2,
} from "../../src/capability.ts";
import {
  TASK_LIMITS,
  TaskProviderError,
  type TaskMutationContext,
  type TaskProviderResolution,
} from "../../src/index.ts";
import { ACTIVE_TASK_BLOCK_KIND } from "../../src/active-task.ts";
import { TASKS_CAPABILITY_NAME } from "../../src/settings.ts";
import { TASK_PERSISTED_TRACE_PROJECTORS } from "../../src/trace.ts";
import { fullCapabilities, makeProvider, PROVIDER_KEY } from "../helpers/provider.ts";
import { buildContext, runContext, runRequest } from "../helpers/context.ts";

const ALL_GRANTS = Object.values(TASK_GRANTS);

function resolution(
  over: Partial<TaskProviderResolution> = {},
): TaskProviderResolution & { provider: ReturnType<typeof makeProvider> } {
  const provider = makeProvider();
  return {
    provider,
    capabilities: fullCapabilities,
    writes: "enabled",
    defaultContainer: "CLAR",
    server: "jira:tasks",
    ...over,
  } as TaskProviderResolution & { provider: ReturnType<typeof makeProvider> };
}

async function activation(
  options: {
    grants?: string[];
    task?: unknown;
    resolution?: TaskProviderResolution;
    priorState?: Record<string, unknown>;
    continueFrom?: string;
    executionId?: string;
    enabled?: boolean;
    resolveError?: Error;
  } = {},
): Promise<{
  run: RunCapability;
  resolution: TaskProviderResolution & { provider: ReturnType<typeof makeProvider> };
  resolveCalls: { owner: string; expected?: string }[];
}> {
  const selected = (options.resolution ?? resolution()) as TaskProviderResolution & {
    provider: ReturnType<typeof makeProvider>;
  };
  const resolveCalls: { owner: string; expected?: string }[] = [];
  const capability = createTasksCapability({
    enabled: options.enabled,
    resolver: {
      async resolve(owner, expectedProviderKey) {
        resolveCalls.push({
          owner,
          ...(expectedProviderKey === undefined ? {} : { expected: expectedProviderKey }),
        });
        if (options.resolveError) throw options.resolveError;
        if (expectedProviderKey && expectedProviderKey !== selected.provider.key) {
          throw new TaskProviderError("task_provider_mismatch", "provider changed");
        }
        return selected;
      },
    },
  });
  const grants = options.grants ?? ALL_GRANTS;
  const request = runRequest(grants);
  if (options.continueFrom) request.continue_from = options.continueFrom;
  const run = await capability.forRun(
    runContext({
      request,
      task: Object.hasOwn(options, "task")
        ? options.task
        : { id: "CLAR-42", provider_key: PROVIDER_KEY, mode: "work" },
      ...(options.priorState === undefined ? {} : { priorState: options.priorState }),
      executionId: options.executionId ?? "exec-1",
    }),
  );
  if (!run) throw new Error("expected Tasks capability activation");
  return { run, resolution: selected, resolveCalls };
}

function scope(grants: string[] = ALL_GRANTS, over: Partial<AgentScope> = {}): AgentScope {
  return { agent: "lead", entry: true, grants, ...over };
}

async function attached(options: Parameters<typeof activation>[0] = {}) {
  const active = await activation(options);
  const agent = active.run.forAgent(scope(options.grants ?? ALL_GRANTS));
  if (!agent) throw new Error("expected agent capability");
  const build = buildContext();
  const contribution = agent.attach(build);
  const handler = contribution.handlers?.[0];
  if (!handler) throw new Error("expected Tasks handler");
  return { ...active, build, contribution, handler };
}

async function call(
  handler: ToolHandler,
  name: string,
  args: Record<string, unknown> = {},
  id = `call-${name}`,
): Promise<HandlerVerdict> {
  return handler.handle({ id, name, arguments: args }, 1);
}

function textOf(verdict: HandlerVerdict): string {
  if (verdict.kind !== "result") throw new Error(`unexpected ${verdict.kind} verdict`);
  return verdict.text;
}

describe("Tasks capability lifecycle and gates", () => {
  it("owns static grants, names, effects, marker and projectors without loop knowledge", () => {
    const capability = createTasksCapability();
    expect(capability.name).toBe(TASKS_CAPABILITY_NAME);
    expect(capability.seedMarker).toBe(ACTIVE_TASK_MARKER);
    expect(capability.grants?.map((grant) => grant.name)).toEqual(ALL_GRANTS);
    expect(capability.grants?.every((grant) => grant.entryCanSpawn === undefined)).toBeTrue();
    expect(capability.reservedWireNames).toEqual(TASK_TOOL_WIRE_NAMES);
    expect(capability.persistedTraceProjectors).toHaveLength(7);
    expect(capability.toolEffects?.[TASK_TOOL_NAMES.create]).toBe("mutate");
    expect(capability.toolEffects?.[TASK_TOOL_NAMES.read]).toBe("read");
  });

  it("stays inactive without a binding/grant and fails requested bindings closed", async () => {
    const resolverError = new TaskProviderError("task_provider_unavailable", "down");
    const inactive = createTasksCapability({
      resolver: { resolve: async () => Promise.reject(resolverError) },
    });
    expect(
      await inactive.forRun(runContext({ request: runRequest([]), task: undefined })),
    ).toBeNull();
    expect(
      await inactive.forRun(
        runContext({ request: runRequest([TASK_GRANTS.read]), task: undefined }),
      ),
    ).toBeNull();
    await expect(
      inactive.forRun(runContext({ request: runRequest([]), task: { id: "CLAR-42" } })),
    ).rejects.toBe(resolverError);
    await expect(
      createTasksCapability({ enabled: false }).forRun(
        runContext({ request: runRequest([]), task: { id: "CLAR-42" } }),
      ),
    ).rejects.toMatchObject({ code: "task_not_configured" });
    expect(
      await createTasksCapability({ enabled: false }).forRun(
        runContext({ request: runRequest([TASK_GRANTS.read]), task: undefined }),
      ),
    ).toBeNull();
  });

  it("binds, seeds sanitized context and persists only minimal run state", async () => {
    const { run, resolveCalls } = await activation();
    expect(resolveCalls).toEqual([{ owner: "owner-a", expected: PROVIDER_KEY }]);
    expect(await run.seedBlock?.()).toContain("<active_task>");
    expect(await run.seedBlock?.()).not.toContain("payload");
    expect(run.systemSection?.({ agent: "lead", entry: true, grants: [] })).toContain("untrusted");
    expect(run.forAgent(scope([]))).toBeNull();
    const state = run.finalizeRun?.({ status: "completed" }) as TaskRunStateV2;
    expect(state).toEqual({
      version: 2,
      providerKey: PROVIDER_KEY,
      taskId: "CLAR-42",
      mode: "work",
      lastRevision: "1",
      lastStage: "ready",
    });
    expect(Object.keys(state)).not.toContain("title");
    expect(typeof run.onRunEnd).toBe("undefined");
  });

  it("makes inspect mode and writes-disabled providers read-only", async () => {
    for (const options of [
      { task: { id: "CLAR-42", provider_key: PROVIDER_KEY, mode: "inspect" } },
      { resolution: resolution({ writes: "disabled" }) },
    ]) {
      const { contribution } = await attached(options);
      expect(contribution.tools?.map((tool) => tool.wireName).sort()).toEqual(
        [TASK_TOOL_NAMES.list, TASK_TOOL_NAMES.read].sort(),
      );
    }
  });

  it("exposes tools only for the intersection of grant and provider capability", async () => {
    const readOnlyCapabilities = {
      ...fullCapabilities,
      read: { ...fullCapabilities.read, actors: false },
      write: {
        create: false,
        assign: false,
        comment: false,
        attachArtifact: false,
        intents: [],
      },
      concurrency: "none" as const,
    };
    const provider = makeProvider({ capabilities: readOnlyCapabilities });
    const { contribution } = await attached({
      grants: [TASK_GRANTS.read, TASK_GRANTS.create],
      resolution: {
        provider,
        capabilities: readOnlyCapabilities,
        writes: "enabled",
        server: "readonly",
      },
    });
    expect(contribution.tools?.map((tool) => tool.wireName).sort()).toEqual(
      [TASK_TOOL_NAMES.list, TASK_TOOL_NAMES.read].sort(),
    );
  });

  it("allows discovery and non-lifecycle writes without binding a task", async () => {
    const { contribution, handler } = await attached({ task: undefined });
    expect(contribution.tools?.map((tool) => tool.wireName).sort()).toEqual(
      [
        TASK_TOOL_NAMES.list,
        TASK_TOOL_NAMES.read,
        TASK_TOOL_NAMES.create,
        TASK_TOOL_NAMES.assign,
        TASK_TOOL_NAMES.comment,
      ].sort(),
    );
    expect(contribution.tools?.some((tool) => tool.wireName === TASK_TOOL_NAMES.start)).toBeFalse();
    expect(
      textOf(
        await call(handler, TASK_TOOL_NAMES.comment, { id: "CLAR-42", body: "from unbound run" }),
      ),
    ).toContain("CLAR-42");
    expect(
      textOf(await call(handler, TASK_TOOL_NAMES.comment, { body: "missing id" }, "missing")),
    ).toContain("task_invalid_input");
  });

  it("rejects late binding and any continuation task/provider/mode change", async () => {
    const prior: TaskRunStateV2 = {
      version: 2,
      providerKey: PROVIDER_KEY,
      taskId: "CLAR-42",
      mode: "work",
      lastStage: "active",
      lastRevision: "3",
      claim: { executionId: "root-exec", claimantId: "agent" },
    };
    const priorState = { [TASKS_CAPABILITY_NAME]: prior };
    const continued = await activation({
      priorState,
      continueFrom: "exec-old",
      task: undefined,
      executionId: "exec-new",
    });
    expect(continued.resolveCalls[0]).toMatchObject({ expected: PROVIDER_KEY });
    expect(continued.run.finalizeRun?.({ status: "completed" })).toMatchObject({
      taskId: "CLAR-42",
      mode: "work",
    });

    await expect(
      activation({ continueFrom: "old", task: { id: "CLAR-42" }, priorState: {} }),
    ).rejects.toMatchObject({ code: "task_invalid_input" });
    await expect(
      activation({
        continueFrom: "old",
        task: undefined,
        priorState: {
          [TASKS_CAPABILITY_NAME]: {
            version: 1,
            providerKey: PROVIDER_KEY,
            taskId: "CLAR-42",
            mode: "work",
            lastStage: "active",
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "task_invalid_input",
      message: expect.stringContaining("Tasks v1"),
    });
    for (const task of [
      { id: "OTHER", provider_key: PROVIDER_KEY, mode: "work" },
      { id: "CLAR-42", provider_key: "other", mode: "work" },
      { id: "CLAR-42", provider_key: PROVIDER_KEY, mode: "inspect" },
    ]) {
      await expect(activation({ priorState, continueFrom: "old", task })).rejects.toMatchObject({
        code: "task_provider_mismatch",
      });
    }
    await expect(
      activation({
        priorState,
        continueFrom: "old",
        task: undefined,
        resolveError: new TaskProviderError("task_provider_mismatch", "changed"),
      }),
    ).rejects.toMatchObject({ code: "task_provider_mismatch" });
  });

  it("rejects a resolver that returns a different provider than the pinned request or run", async () => {
    const selected = resolution();
    const capability = createTasksCapability({
      resolver: { resolve: async () => selected },
    });
    const staleProviderKey = "stale-provider";
    const continuationRequest = runRequest(ALL_GRANTS);
    continuationRequest.continue_from = "exec-old";
    const prior: TaskRunStateV2 = {
      version: 2,
      providerKey: staleProviderKey,
      taskId: "CLAR-42",
      mode: "work",
      lastStage: "active",
    };

    await expect(
      capability.forRun(
        runContext({
          request: continuationRequest,
          task: undefined,
          priorState: { [TASKS_CAPABILITY_NAME]: prior },
        }),
      ),
    ).rejects.toMatchObject({ code: "task_provider_mismatch" });
    await expect(
      capability.forRun(
        runContext({
          request: runRequest(ALL_GRANTS),
          task: { id: "CLAR-42", provider_key: staleProviderKey, mode: "work" },
        }),
      ),
    ).rejects.toMatchObject({ code: "task_provider_mismatch" });
  });
});

describe("Tasks agent tools", () => {
  it("lists, reads, creates, assigns and comments without leaking content into trace", async () => {
    const { handler, resolution: selected, build } = await attached();
    const listed = textOf(await call(handler, TASK_TOOL_NAMES.list, { query: "Tasks", limit: 10 }));
    expect(listed).toContain("CLAR-42");
    expect(listed).toContain("Implement Tasks");
    expect(textOf(await call(handler, TASK_TOOL_NAMES.read, { id: "CLAR-42" }))).toContain(
      "acceptance_criteria",
    );
    expect(textOf(await call(handler, TASK_TOOL_NAMES.create, { title: "Created" }))).toContain(
      "CLAR-99",
    );
    expect(
      textOf(
        await call(handler, TASK_TOOL_NAMES.assign, {
          id: "CLAR-42",
          assignee_id: "ana",
        }),
      ),
    ).toContain("assignee");
    expect(
      textOf(
        await call(handler, TASK_TOOL_NAMES.comment, {
          id: "CLAR-42",
          body: "secret comment body",
        }),
      ),
    ).toContain("CLAR-42");
    expect(selected.provider.calls.map((entry) => entry.operation)).toEqual(
      expect.arrayContaining(["search", "get", "create", "assign", "comment"]),
    );
    expect(JSON.stringify(build.trace.entries)).not.toContain("secret comment body");
    expect(JSON.stringify(build.trace.entries)).toContain("body_chars");
  });

  it("requires a create container when no default exists", async () => {
    const { handler } = await attached({ resolution: resolution({ defaultContainer: undefined }) });
    const verdict = await call(handler, TASK_TOOL_NAMES.create, { title: "No container" });
    expect(textOf(verdict)).toContain("task_invalid_input");
  });

  it("fails closed for unbound lifecycle calls and unexpected provider failures", async () => {
    const unbound = await attached({ task: undefined });
    expect(
      unbound.handler.matches({ id: "start", name: TASK_TOOL_NAMES.start, arguments: {} }),
    ).toBeFalse();
    expect(textOf(await call(unbound.handler, TASK_TOOL_NAMES.start))).toContain(
      "task_invalid_input",
    );

    const createFailure = await attached();
    createFailure.resolution.provider.create = async () => {
      throw new Error("create exploded");
    };
    expect(
      textOf(await call(createFailure.handler, TASK_TOOL_NAMES.create, { title: "Failure" })),
    ).toContain("task_provider_unavailable");
    expect(
      createFailure.build.trace.entries.some(
        (entry) =>
          entry.kind === "task_operation_failed" &&
          (entry.detail as { operation?: string }).operation === "create",
      ),
    ).toBeTrue();

    const mutationFailure = await attached();
    mutationFailure.resolution.provider.comment = async () => {
      throw new Error("comment exploded");
    };
    expect(
      textOf(await call(mutationFailure.handler, TASK_TOOL_NAMES.comment, { body: "once" })),
    ).toContain("task_provider_unavailable");

    const readFailure = await attached();
    readFailure.resolution.provider.search = async () => {
      throw "search exploded";
    };
    expect(textOf(await call(readFailure.handler, TASK_TOOL_NAMES.list))).toContain(
      "task_provider_unavailable",
    );
  });

  it("fails closed when a provider withdraws advertised writes and bounds review publication", async () => {
    const missingCreate = await attached();
    delete missingCreate.resolution.provider.create;
    expect(
      textOf(await call(missingCreate.handler, TASK_TOOL_NAMES.create, { title: "Missing" })),
    ).toContain("task_unsupported");

    const missingAssign = await attached();
    delete missingAssign.resolution.provider.assign;
    expect(
      textOf(await call(missingAssign.handler, TASK_TOOL_NAMES.assign, { assignee_id: "user-1" })),
    ).toContain("task_unsupported");

    const missingComment = await attached();
    delete missingComment.resolution.provider.comment;
    expect(
      textOf(await call(missingComment.handler, TASK_TOOL_NAMES.comment, { body: "Missing" })),
    ).toContain("task_unsupported");

    const missingTransition = await attached();
    delete missingTransition.resolution.provider.transition;
    expect(textOf(await call(missingTransition.handler, TASK_TOOL_NAMES.start))).toContain(
      "task_unsupported",
    );

    const oversized = await attached();
    expect(
      textOf(
        await call(oversized.handler, TASK_TOOL_NAMES.review, {
          summary: "x".repeat(TASK_LIMITS.comment * 17),
        }),
      ),
    ).toContain("maximum number of comment parts");
  });

  it("requires clock-bounded human approval when review evidence cannot be published", async () => {
    const selected = resolution();
    delete selected.provider.comment;
    const clockCalls: string[] = [];
    const clock = {
      race: async <T>(pending: Promise<T>) => pending,
      pause: () => clockCalls.push("pause"),
      resume: () => clockCalls.push("resume"),
      enter: () => undefined,
      leave: () => undefined,
      pauseCompute: () => () => undefined,
      enterBackground: () => ({ pause: () => () => undefined, leave: () => undefined }),
      poke: () => undefined,
    } as NonNullable<AgentScope["clock"]>;
    const active = await activation({ resolution: selected });
    const agent = active.run.forAgent(
      scope(ALL_GRANTS, {
        clock,
        elicit: async () => ({ action: "accept", content: { decision: "deny" } }),
      }),
    )!;
    const handler = agent.attach(buildContext()).handlers![0]!;
    const verdict = await call(handler, TASK_TOOL_NAMES.review, {
      summary: "Done",
      no_evidence_reason: "provider cannot receive evidence",
      allow_without_artifacts: true,
    });
    expect(textOf(verdict)).toContain("task_forbidden");
    expect(clockCalls).toEqual(["pause", "resume"]);

    const timedOut = await activation({ resolution: selected });
    const timedOutAgent = timedOut.run.forAgent(
      scope(ALL_GRANTS, {
        clock,
        elicit: async () => {
          throw new ElicitTimeoutError();
        },
      }),
    )!;
    const timedOutHandler = timedOutAgent.attach(buildContext()).handlers![0]!;
    expect(
      textOf(
        await call(timedOutHandler, TASK_TOOL_NAMES.review, {
          summary: "Done",
          no_evidence_reason: "provider cannot receive evidence",
          allow_without_artifacts: true,
        }),
      ),
    ).toContain("task_forbidden");
  });

  it("rejects an unadvertised task tool even when invoked directly", async () => {
    const { handler } = await attached();
    expect(
      handler.matches({ id: "unknown", name: "unknown_task_tool", arguments: {} }),
    ).toBeFalse();
    expect(textOf(await call(handler, "unknown_task_tool"))).toContain("task_unsupported");
  });

  it("updates the active block and stable claim lineage across lifecycle tools", async () => {
    const { handler, build, run, resolution: selected } = await attached();
    expect(textOf(await call(handler, TASK_TOOL_NAMES.start))).toContain('"stage":"active"');
    expect(build.blocks.get(ACTIVE_TASK_BLOCK_KIND)).toContain("stage: active");
    expect(textOf(await call(handler, TASK_TOOL_NAMES.block, { reason: "waiting" }))).toContain(
      '"stage":"blocked"',
    );
    expect(textOf(await call(handler, TASK_TOOL_NAMES.complete))).toContain('"stage":"done"');
    expect(textOf(await call(handler, TASK_TOOL_NAMES.reopen))).toContain('"stage":"ready"');
    const transitions = selected.provider.calls.filter((entry) => entry.operation === "transition");
    expect(transitions).toHaveLength(4);
    expect(transitions[0]?.input).toMatchObject({
      intent: "start",
      mutation: { executionId: "exec-1", claimExecutionId: "exec-1" },
    });
    expect(run.finalizeRun?.({ status: "completed" })).toMatchObject({
      lastStage: "ready",
    });
    expect(typeof run.onRunEnd).toBe("undefined");
  });

  it("refuses illegal active-task transitions and invalid call envelopes", async () => {
    const provider = makeProvider({
      document: makeProvider().current(),
    });
    const original = provider.current();
    const limited = makeProvider({
      document: { ...original, availableIntents: ["start"] },
    });
    const { handler } = await attached({
      resolution: {
        provider: limited,
        capabilities: fullCapabilities,
        writes: "enabled",
        server: "jira",
      },
    });
    expect(textOf(await call(handler, TASK_TOOL_NAMES.block, { reason: "no" }))).toContain(
      "task_invalid_transition",
    );

    const invalidBuild = buildContext({ validateArgs: () => "missing required property" });
    const active = await activation();
    const contribution = active.run.forAgent(scope())!.attach(invalidBuild);
    const invalid = await call(contribution.handlers![0]!, TASK_TOOL_NAMES.read, {});
    expect(textOf(invalid)).toContain("missing required property");
  });

  it("re-reads after conflict and unknown outcomes without replaying the write", async () => {
    for (const code of ["task_conflict", "task_outcome_unknown"] as const) {
      const selected = resolution();
      selected.provider.failNext("comment", new TaskProviderError(code, code));
      const { handler, build } = await attached({ resolution: selected });
      const verdict = await call(handler, TASK_TOOL_NAMES.comment, { body: "once" });
      expect(textOf(verdict)).toContain(code);
      expect(selected.provider.calls.filter((entry) => entry.operation === "comment")).toHaveLength(
        1,
      );
      expect(selected.provider.calls.filter((entry) => entry.operation === "get").length).toBe(2);
      expect(
        build.trace.entries.some((entry) => entry.kind === code.replace("task_", "task_")),
      ).toBeTrue();
    }
  });

  it("carries the provider's stated reason into the persisted failure trace", async () => {
    const selected = resolution();
    selected.provider.failNext(
      "comment",
      new TaskProviderError("task_conflict", "The sprint board is locked by ana; token: shhhhh"),
    );
    const { handler, build } = await attached({ resolution: selected });
    await call(handler, TASK_TOOL_NAMES.comment, { body: "once" });
    const entry = build.trace.entries.find((candidate) => candidate.kind === "task_conflict")!;
    const projector = TASK_PERSISTED_TRACE_PROJECTORS.find(
      (candidate) => candidate.kind === "task_conflict",
    )!;
    const projected = projector.project(entry, {
      absoluteTime: (at: number) => at,
    } as never) as Record<string, unknown>;
    expect(projected).toMatchObject({
      code: "task_conflict",
      message: "The sprint board is locked by ana; token: [redacted]",
    });
  });

  it("reuses exact prepared inputs for explicit ordinary retries with new call IDs", async () => {
    const cases = [
      {
        tool: TASK_TOOL_NAMES.create,
        operation: "create",
        args: { title: "Created after uncertainty" },
      },
      {
        tool: TASK_TOOL_NAMES.assign,
        operation: "assign",
        args: { assignee_id: "ana" },
      },
      {
        tool: TASK_TOOL_NAMES.comment,
        operation: "comment",
        args: { body: "Only once" },
      },
      { tool: TASK_TOOL_NAMES.start, operation: "transition", args: {} },
      {
        tool: TASK_TOOL_NAMES.block,
        operation: "transition",
        args: { reason: "Waiting" },
      },
      { tool: TASK_TOOL_NAMES.complete, operation: "transition", args: {} },
      { tool: TASK_TOOL_NAMES.reopen, operation: "transition", args: {} },
    ] as const;

    for (const testCase of cases) {
      const selected = resolution();
      selected.provider.failNext(
        testCase.operation,
        new TaskProviderError("task_outcome_unknown", "response lost"),
      );
      const { handler, run } = await attached({ resolution: selected });

      expect(textOf(await call(handler, testCase.tool, testCase.args, "ordinary-1"))).toContain(
        "task_outcome_unknown",
      );
      expect(run.finalizeRun?.({ status: "error" })).toMatchObject({
        pendingMutations: [{ operation: testCase.tool.replace("_task", "") }],
      });
      expect(textOf(await call(handler, testCase.tool, testCase.args, "ordinary-2"))).toContain(
        '"ref"',
      );

      const writes = selected.provider.calls.filter(
        (entry) => entry.operation === testCase.operation,
      );
      expect(writes).toHaveLength(2);
      expect(writes[1]?.input).toEqual(writes[0]?.input);
    }
  });

  it("persists content-free ordinary retry metadata across a continuation", async () => {
    const selected = resolution();
    selected.provider.failNext(
      "comment",
      new TaskProviderError("task_outcome_unknown", "response lost"),
    );
    const initial = await attached({ resolution: selected });
    const args = { body: "Do not persist this comment body" };

    expect(
      textOf(await call(initial.handler, TASK_TOOL_NAMES.comment, args, "comment-1")),
    ).toContain("task_outcome_unknown");
    const prior = initial.run.finalizeRun?.({ status: "error" }) as TaskRunStateV2;
    expect(JSON.stringify(prior)).not.toContain(args.body);
    expect(prior.pendingMutations).toHaveLength(1);

    const continued = await attached({
      resolution: selected,
      priorState: { [TASKS_CAPABILITY_NAME]: prior },
      continueFrom: "exec-1",
      executionId: "exec-2",
      task: undefined,
    });
    expect(
      textOf(await call(continued.handler, TASK_TOOL_NAMES.comment, args, "comment-2")),
    ).toContain('"ref"');
    const writes = selected.provider.calls.filter((entry) => entry.operation === "comment");
    expect(writes).toHaveLength(2);
    expect(writes[1]?.input).toEqual(writes[0]?.input);
  });

  it("rejects operation drift in persisted ordinary retry metadata", async () => {
    const selected = resolution();
    selected.provider.failNext(
      "comment",
      new TaskProviderError("task_outcome_unknown", "response lost"),
    );
    const initial = await attached({ resolution: selected });
    const args = { body: "Keep this operation pinned" };

    expect(
      textOf(await call(initial.handler, TASK_TOOL_NAMES.comment, args, "comment-1")),
    ).toContain("task_outcome_unknown");
    const prior = initial.run.finalizeRun?.({ status: "error" }) as TaskRunStateV2;
    const drifted = structuredClone(prior);
    drifted.pendingMutations![0]!.operation = "assign";
    const continued = await attached({
      resolution: selected,
      priorState: { [TASKS_CAPABILITY_NAME]: drifted },
      continueFrom: "exec-1",
      executionId: "exec-2",
      task: undefined,
    });

    expect(
      textOf(await call(continued.handler, TASK_TOOL_NAMES.comment, args, "comment-2")),
    ).toContain("task_invalid_input");
    expect(selected.provider.calls.filter((entry) => entry.operation === "comment")).toHaveLength(
      1,
    );
  });

  it("bounds unresolved ordinary mutations before dispatching another write", async () => {
    const selected = resolution();
    selected.provider.comment = async (input) => {
      selected.provider.calls.push({ operation: "comment", input: structuredClone(input) });
      throw new TaskProviderError("task_outcome_unknown", "response lost");
    };
    const { handler, run } = await attached({ resolution: selected });

    for (let index = 0; index < 16; index += 1) {
      expect(
        textOf(
          await call(
            handler,
            TASK_TOOL_NAMES.comment,
            { body: `uncertain-${index}` },
            `comment-${index}`,
          ),
        ),
      ).toContain("task_outcome_unknown");
    }
    expect(
      textOf(
        await call(handler, TASK_TOOL_NAMES.comment, { body: "one-too-many" }, "comment-overflow"),
      ),
    ).toContain("task_conflict");
    expect(selected.provider.calls.filter((entry) => entry.operation === "comment")).toHaveLength(
      16,
    );
    expect(
      (run.finalizeRun?.({ status: "error" }) as TaskRunStateV2).pendingMutations,
    ).toHaveLength(16);
  });

  it("preserves an ordinary replay through a transient retry failure", async () => {
    const selected = resolution();
    selected.provider.failNext(
      "comment",
      new TaskProviderError("task_outcome_unknown", "response lost"),
    );
    const { handler, run } = await attached({ resolution: selected });
    const args = { body: "Keep the original mutation" };

    expect(textOf(await call(handler, TASK_TOOL_NAMES.comment, args, "unknown"))).toContain(
      "task_outcome_unknown",
    );
    selected.provider.failNext(
      "comment",
      new TaskProviderError("task_provider_unavailable", "not dispatched"),
    );
    expect(textOf(await call(handler, TASK_TOOL_NAMES.comment, args, "unavailable"))).toContain(
      "task_provider_unavailable",
    );
    expect(run.finalizeRun?.({ status: "error" })).toMatchObject({
      pendingMutations: [{ operation: "comment" }],
    });
    expect(textOf(await call(handler, TASK_TOOL_NAMES.comment, args, "retry"))).toContain('"ref"');

    const writes = selected.provider.calls.filter((entry) => entry.operation === "comment");
    expect(writes).toHaveLength(3);
    expect(writes[1]?.input).toEqual(writes[0]?.input);
    expect(writes[2]?.input).toEqual(writes[0]?.input);
  });

  it("persists uncertain writes without manufacturing an active task binding", async () => {
    const selected = resolution();
    selected.provider.failNext(
      "create",
      new TaskProviderError("task_outcome_unknown", "response lost"),
    );
    const args = { title: "Do not create this twice" };
    const initial = await attached({
      resolution: selected,
      grants: [TASK_GRANTS.create],
      task: undefined,
    });

    expect(textOf(await call(initial.handler, TASK_TOOL_NAMES.create, args, "create-1"))).toContain(
      "task_outcome_unknown",
    );
    const prior = initial.run.finalizeRun?.({ status: "error" }) as TaskCapabilityStateV2;
    expect(prior).toMatchObject({
      version: 2,
      providerKey: PROVIDER_KEY,
      pendingMutations: [{ operation: "create", containerId: "CLAR" }],
    });
    expect(prior).not.toHaveProperty("taskId");
    expect(JSON.stringify(prior)).not.toContain(args.title);
    expect(
      taskCapabilityStateV2Schema.safeParse({
        ...prior,
        pendingMutations: prior.pendingMutations!.map((mutation) => ({
          ...mutation,
          operation: "start",
          targetId: "CLAR-42",
          containerId: undefined,
        })),
      }).success,
    ).toBeFalse();

    const dormant = await activation({
      resolution: selected,
      grants: [],
      priorState: { [TASKS_CAPABILITY_NAME]: prior },
      continueFrom: "exec-1",
      executionId: "exec-2",
      task: undefined,
    });
    expect(dormant.resolveCalls).toEqual([{ owner: "owner-a", expected: PROVIDER_KEY }]);
    expect(dormant.run.forAgent(scope([]))).toBeNull();
    expect(dormant.run.finalizeRun?.({ status: "completed" })).toEqual(prior);

    const continued = await attached({
      resolution: selected,
      grants: [TASK_GRANTS.create],
      priorState: { [TASKS_CAPABILITY_NAME]: prior },
      continueFrom: "exec-1",
      executionId: "exec-2",
      task: undefined,
    });
    expect(continued.resolveCalls).toEqual([{ owner: "owner-a", expected: PROVIDER_KEY }]);
    expect(
      textOf(await call(continued.handler, TASK_TOOL_NAMES.create, args, "create-2")),
    ).toContain('"ref"');
    const writes = selected.provider.calls.filter((entry) => entry.operation === "create");
    expect(writes).toHaveLength(2);
    expect(writes[1]?.input).toEqual(writes[0]?.input);
    expect(continued.run.finalizeRun?.({ status: "completed" })).toBeUndefined();
  });

  it("advances an ordinary key only after a definitive non-applied failure", async () => {
    const selected = resolution();
    selected.provider.failNext(
      "comment",
      new TaskProviderError("task_forbidden", "comment rejected"),
    );
    const { handler, run } = await attached({ resolution: selected });
    const args = { body: "Try again explicitly" };

    expect(textOf(await call(handler, TASK_TOOL_NAMES.comment, args, "denied-1"))).toContain(
      "task_forbidden",
    );
    expect(run.finalizeRun?.({ status: "error" })).not.toHaveProperty("pendingMutations");
    expect(textOf(await call(handler, TASK_TOOL_NAMES.comment, args, "denied-2"))).toContain(
      '"ref"',
    );
    const writes = selected.provider.calls.filter((entry) => entry.operation === "comment");
    const keys = writes.map(
      (entry) => (entry.input as { mutation: TaskMutationContext }).mutation.idempotencyKey,
    );
    expect(new Set(keys).size).toBe(2);
  });

  it("publishes artifacts and evidence before the review transition with child keys", async () => {
    const { handler, resolution: selected } = await attached();
    const verdict = await call(handler, TASK_TOOL_NAMES.review, {
      summary: "Implemented",
      evidence: ["tests pass"],
      artifacts: [
        { kind: "pull_request", label: "PR", url: "https://example.test/pr/1" },
        { kind: "run", label: "CI", executionId: "ci-1" },
      ],
    });
    expect(textOf(verdict)).toContain('"stage":"review"');
    const writes = selected.provider.calls.filter((entry) =>
      ["attachArtifact", "comment", "transition"].includes(entry.operation),
    );
    expect(writes.map((entry) => entry.operation)).toEqual([
      "attachArtifact",
      "attachArtifact",
      "comment",
      "transition",
    ]);
    const keys = writes.map(
      (entry) => (entry.input as { mutation: { idempotencyKey: string } }).mutation.idempotencyKey,
    );
    expect(new Set(keys).size).toBe(4);
    expect(keys[0]).toEndWith(":artifact:0");
    expect(keys[1]).toEndWith(":artifact:1");
    expect(keys[2]).toEndWith(":comment");
    expect(keys[3]).toEndWith(":transition");
  });

  it("falls back to sanitized links when artifact attachment is unavailable", async () => {
    const capabilities = {
      ...fullCapabilities,
      write: { ...fullCapabilities.write, attachArtifact: false },
    };
    const provider = makeProvider({ capabilities });
    const { handler } = await attached({
      resolution: { provider, capabilities, writes: "enabled", server: "jira" },
    });
    await call(handler, TASK_TOOL_NAMES.review, {
      summary: "Done",
      artifacts: [{ kind: "url", label: "Build", url: "https://example.test/build" }],
    });
    expect(provider.calls.map((entry) => entry.operation)).not.toContain("attachArtifact");
    const comment = provider.calls.find((entry) => entry.operation === "comment")?.input as {
      body: string;
    };
    expect(comment.body).toContain("Artifacts:");
    expect(comment.body).toContain("https://example.test/build");
  });

  it("blocks review on publication failure unless a repeated explicit bypass is approved", async () => {
    const selected = resolution();
    selected.provider.attachArtifact = async () => {
      selected.provider.calls.push({ operation: "attachArtifact", input: {} });
      throw new TaskProviderError("task_provider_unavailable", "artifact down");
    };
    const active = await activation({ resolution: selected });
    const agent = active.run.forAgent(
      scope(ALL_GRANTS, {
        elicit: async () => ({ action: "accept", content: { decision: "approve" } }),
      }),
    )!;
    const handler = agent.attach(buildContext()).handlers![0]!;
    const args = {
      summary: "Done",
      artifacts: [{ kind: "url", label: "Build", url: "https://example.test/build" }],
    };
    expect(textOf(await call(handler, TASK_TOOL_NAMES.review, args, "first"))).toContain(
      "task_provider_unavailable",
    );
    expect(
      selected.provider.calls.filter((entry) => entry.operation === "transition"),
    ).toHaveLength(0);
    expect(
      textOf(
        await call(
          handler,
          TASK_TOOL_NAMES.review,
          { ...args, allow_without_artifacts: true },
          "second",
        ),
      ),
    ).toContain('"stage":"review"');
    expect(
      selected.provider.calls.filter((entry) => entry.operation === "transition"),
    ).toHaveLength(1);
  });

  it("never turns a publication conflict into an evidence bypass", async () => {
    const selected = resolution();
    selected.provider.attachArtifact = async (input) => {
      selected.provider.calls.push({ operation: "attachArtifact", input: structuredClone(input) });
      throw new TaskProviderError("task_conflict", "task changed");
    };
    let approvalCalls = 0;
    const active = await activation({ resolution: selected });
    const agent = active.run.forAgent(
      scope(ALL_GRANTS, {
        elicit: async () => {
          approvalCalls += 1;
          return { action: "accept", content: { decision: "approve" } };
        },
      }),
    )!;
    const handler = agent.attach(buildContext()).handlers![0]!;
    const verdict = await call(handler, TASK_TOOL_NAMES.review, {
      summary: "Done",
      artifacts: [{ kind: "url", label: "Build", url: "https://example.test/build" }],
      allow_without_artifacts: true,
    });

    expect(textOf(verdict)).toContain("task_conflict");
    expect(approvalCalls).toBe(0);
    expect(
      selected.provider.calls.filter((entry) => entry.operation === "transition"),
    ).toHaveLength(0);
  });

  it("advances a failed child key without republishing completed evidence", async () => {
    const selected = resolution();
    const attach = selected.provider.attachArtifact!.bind(selected.provider);
    let rejectedKey: string | undefined;
    selected.provider.attachArtifact = async (input, signal) => {
      if (input.artifact.label === "second") {
        const key = input.mutation.idempotencyKey;
        if (rejectedKey === undefined) rejectedKey = key;
        if (key === rejectedKey) {
          selected.provider.calls.push({
            operation: "attachArtifact",
            input: structuredClone(input),
          });
          throw new TaskProviderError("task_forbidden", "second artifact rejected");
        }
      }
      return attach(input, signal);
    };
    const { handler } = await attached({ resolution: selected });
    const args = {
      summary: "Done",
      evidence: ["tests pass"],
      artifacts: [
        { kind: "url" as const, label: "first", url: "https://example.test/first" },
        { kind: "url" as const, label: "second", url: "https://example.test/second" },
      ],
    };

    expect(textOf(await call(handler, TASK_TOOL_NAMES.review, args, "review-1"))).toContain(
      "task_forbidden",
    );
    expect(textOf(await call(handler, TASK_TOOL_NAMES.review, args, "review-2"))).toContain(
      '"stage":"review"',
    );

    const attachments = selected.provider.calls.filter(
      (entry) => entry.operation === "attachArtifact",
    );
    expect(attachments).toHaveLength(3);
    expect(
      attachments.map((entry) => (entry.input as { artifact: { label: string } }).artifact.label),
    ).toEqual(["first", "second", "second"]);
    const secondKeys = attachments
      .slice(1)
      .map(
        (entry) =>
          (entry.input as { mutation: { idempotencyKey: string } }).mutation.idempotencyKey,
      );
    expect(new Set(secondKeys).size).toBe(2);
  });

  it("reuses the exact child mutation after an unknown review outcome", async () => {
    for (const operation of ["attachArtifact", "comment", "transition"] as const) {
      const selected = resolution();
      let first = true;
      if (operation === "attachArtifact") {
        const original = selected.provider.attachArtifact!.bind(selected.provider);
        selected.provider.attachArtifact = async (input, signal) => {
          const result = await original(input, signal);
          if (first) {
            first = false;
            throw new TaskProviderError("task_outcome_unknown", "attachment response lost");
          }
          return result;
        };
      } else if (operation === "comment") {
        const original = selected.provider.comment!.bind(selected.provider);
        selected.provider.comment = async (input, signal) => {
          const result = await original(input, signal);
          if (first) {
            first = false;
            throw new TaskProviderError("task_outcome_unknown", "comment response lost");
          }
          return result;
        };
      } else {
        const original = selected.provider.transition!.bind(selected.provider);
        const get = selected.provider.get.bind(selected.provider);
        selected.provider.get = async (ref, signal) => {
          const current = await get(ref, signal);
          return current.stage === "review"
            ? {
                ...current,
                availableIntents: current.availableIntents.filter(
                  (intent) => intent !== "submit_review",
                ),
              }
            : current;
        };
        selected.provider.transition = async (input, signal) => {
          const result = await original(input, signal);
          if (first) {
            first = false;
            throw new TaskProviderError("task_outcome_unknown", "transition response lost");
          }
          return result;
        };
      }

      const { handler, run } = await attached({ resolution: selected });
      const args = {
        summary: "Done",
        evidence: ["tests pass"],
        artifacts: [{ kind: "url" as const, label: "build", url: "https://example.test/build" }],
      };
      expect(textOf(await call(handler, TASK_TOOL_NAMES.review, args, "review-1"))).toContain(
        "task_outcome_unknown",
      );
      if (operation === "transition") {
        expect(run.finalizeRun?.({ status: "error" })).toMatchObject({
          pendingReviews: [{ unknownSteps: ["transition"] }],
        });
      }
      expect(textOf(await call(handler, TASK_TOOL_NAMES.review, args, "review-2"))).toContain(
        '"stage":"review"',
      );

      const retried = selected.provider.calls.filter((entry) => entry.operation === operation);
      expect(retried).toHaveLength(2);
      const contexts = retried.map(
        (entry) => (entry.input as { mutation: TaskMutationContext }).mutation,
      );
      expect(contexts[1]).toEqual(contexts[0]);
    }
  });

  it("preserves an uncertain review child through a transient retry failure", async () => {
    const selected = resolution();
    selected.provider.failNext(
      "comment",
      new TaskProviderError("task_outcome_unknown", "comment response lost"),
    );
    const { handler, run } = await attached({ resolution: selected });
    const args = {
      summary: "Done",
      evidence: ["tests pass"],
      artifacts: [],
      allow_without_artifacts: true,
    };

    expect(textOf(await call(handler, TASK_TOOL_NAMES.review, args, "review-1"))).toContain(
      "task_outcome_unknown",
    );
    selected.provider.failNext(
      "comment",
      new TaskProviderError("task_provider_unavailable", "not dispatched"),
    );
    expect(textOf(await call(handler, TASK_TOOL_NAMES.review, args, "review-2"))).toContain(
      "task_provider_unavailable",
    );
    expect(run.finalizeRun?.({ status: "error" })).toMatchObject({
      pendingReviews: [{ unknownSteps: ["comment"], attempts: [] }],
    });
    expect(textOf(await call(handler, TASK_TOOL_NAMES.review, args, "review-3"))).toContain(
      '"stage":"review"',
    );

    const comments = selected.provider.calls.filter((entry) => entry.operation === "comment");
    expect(comments).toHaveLength(3);
    expect(comments[1]?.input).toEqual(comments[0]?.input);
    expect(comments[2]?.input).toEqual(comments[0]?.input);
  });

  it("rejects a persisted review plan whose artifact digest vector drifted", async () => {
    const selected = resolution();
    selected.provider.failNext(
      "comment",
      new TaskProviderError("task_outcome_unknown", "comment response lost"),
    );
    const initial = await attached({ resolution: selected });
    const args = { summary: "Done", evidence: ["tests pass"] };
    expect(textOf(await call(initial.handler, TASK_TOOL_NAMES.review, args, "review-1"))).toContain(
      "task_outcome_unknown",
    );
    const prior = initial.run.finalizeRun?.({ status: "error" }) as TaskRunStateV2;
    prior.pendingReviews![0]!.plan.artifactDigests = ["0".repeat(64)];

    const continued = await attached({
      resolution: selected,
      priorState: { [TASKS_CAPABILITY_NAME]: prior },
      continueFrom: "exec-1",
      executionId: "exec-2",
      task: undefined,
    });
    expect(
      textOf(await call(continued.handler, TASK_TOOL_NAMES.review, args, "review-2")),
    ).toContain("persisted review plan no longer matches");
  });

  it("keeps an inline review plan stable when artifact support appears on continuation", async () => {
    const provider = makeProvider();
    const attachArtifact = provider.attachArtifact!.bind(provider);
    delete provider.attachArtifact;
    const withoutArtifacts = {
      ...fullCapabilities,
      write: { ...fullCapabilities.write, attachArtifact: false },
    };
    const comment = provider.comment!.bind(provider);
    let first = true;
    provider.comment = async (input, signal) => {
      const result = await comment(input, signal);
      if (first) {
        first = false;
        throw new TaskProviderError("task_outcome_unknown", "comment response lost");
      }
      return result;
    };
    const initial = await attached({
      resolution: {
        provider,
        capabilities: withoutArtifacts,
        writes: "enabled",
        server: "jira",
      },
    });
    const args = {
      summary: "Done",
      evidence: ["tests pass"],
      artifacts: [{ kind: "url" as const, label: "build", url: "https://example.test/build" }],
    };

    expect(textOf(await call(initial.handler, TASK_TOOL_NAMES.review, args, "review-1"))).toContain(
      "task_outcome_unknown",
    );
    const prior = initial.run.finalizeRun?.({ status: "error" }) as TaskRunStateV2;
    expect(prior.pendingReviews?.[0]?.plan.artifactStrategies).toEqual(["inline"]);

    provider.attachArtifact = attachArtifact;
    const continued = await attached({
      resolution: {
        provider,
        capabilities: fullCapabilities,
        writes: "enabled",
        server: "jira",
      },
      priorState: { [TASKS_CAPABILITY_NAME]: prior },
      continueFrom: "exec-1",
      executionId: "exec-2",
      task: undefined,
    });
    expect(
      textOf(await call(continued.handler, TASK_TOOL_NAMES.review, args, "review-2")),
    ).toContain('"stage":"review"');

    expect(provider.calls.filter((entry) => entry.operation === "attachArtifact")).toHaveLength(0);
    const comments = provider.calls.filter((entry) => entry.operation === "comment");
    expect(comments).toHaveLength(2);
    expect(comments[1]?.input).toEqual(comments[0]?.input);
  });

  it("does not replace an uncertain attachment with inline publication after capability drift", async () => {
    const provider = makeProvider();
    const attachArtifact = provider.attachArtifact!.bind(provider);
    let first = true;
    provider.attachArtifact = async (input, signal) => {
      const result = await attachArtifact(input, signal);
      if (first) {
        first = false;
        throw new TaskProviderError("task_outcome_unknown", "attachment response lost");
      }
      return result;
    };
    const initial = await attached({
      resolution: { provider, capabilities: fullCapabilities, writes: "enabled", server: "jira" },
    });
    const args = {
      summary: "Done",
      artifacts: [{ kind: "url" as const, label: "build", url: "https://example.test/build" }],
    };

    expect(textOf(await call(initial.handler, TASK_TOOL_NAMES.review, args, "review-1"))).toContain(
      "task_outcome_unknown",
    );
    const prior = initial.run.finalizeRun?.({ status: "error" }) as TaskRunStateV2;
    expect(prior.pendingReviews?.[0]?.plan.artifactStrategies).toEqual(["attach"]);

    delete provider.attachArtifact;
    const capabilities = {
      ...fullCapabilities,
      write: { ...fullCapabilities.write, attachArtifact: false },
    };
    const continued = await attached({
      resolution: { provider, capabilities, writes: "enabled", server: "jira" },
      priorState: { [TASKS_CAPABILITY_NAME]: prior },
      continueFrom: "exec-1",
      executionId: "exec-2",
      task: undefined,
    });
    expect(
      textOf(await call(continued.handler, TASK_TOOL_NAMES.review, args, "review-2")),
    ).toContain("task_unsupported");
    expect(provider.calls.filter((entry) => entry.operation === "attachArtifact")).toHaveLength(1);
    expect(provider.calls.filter((entry) => entry.operation === "comment")).toHaveLength(0);
  });

  it("bounds durable review retry metadata across repeated conflicts", async () => {
    const selected = resolution();
    selected.provider.transition = async (input) => {
      selected.provider.calls.push({ operation: "transition", input: structuredClone(input) });
      throw new TaskProviderError("task_conflict", "changed");
    };
    const { handler, run } = await attached({ resolution: selected });
    const args = { summary: "Done", evidence: ["tests pass"] };

    for (let attempt = 0; attempt < 70; attempt += 1) {
      expect(
        textOf(await call(handler, TASK_TOOL_NAMES.review, args, `review-${attempt}`)),
      ).toContain("task_conflict");
    }

    const state = run.finalizeRun?.({ status: "error" }) as TaskRunStateV2;
    expect(state.pendingReviews).toHaveLength(1);
    expect(state.pendingReviews?.[0]).toMatchObject({
      contexts: [],
      unknownSteps: [],
      attempts: [{ step: "transition", attempt: 70 }],
    });
  });

  it("bounds distinct unresolved review submissions before publishing another one", async () => {
    const selected = resolution();
    selected.provider.transition = async (input) => {
      selected.provider.calls.push({ operation: "transition", input: structuredClone(input) });
      throw new TaskProviderError("task_conflict", "changed");
    };
    const { handler, run } = await attached({ resolution: selected });

    for (let index = 0; index < 4; index += 1) {
      expect(
        textOf(
          await call(
            handler,
            TASK_TOOL_NAMES.review,
            { summary: `Done ${index}`, evidence: [`evidence ${index}`] },
            `review-${index}`,
          ),
        ),
      ).toContain("task_conflict");
    }
    expect(
      textOf(
        await call(
          handler,
          TASK_TOOL_NAMES.review,
          { summary: "One too many", evidence: ["new evidence"] },
          "review-overflow",
        ),
      ),
    ).toContain("task_conflict");
    expect(
      selected.provider.calls.filter((entry) => entry.operation === "transition"),
    ).toHaveLength(4);
    expect((run.finalizeRun?.({ status: "error" }) as TaskRunStateV2).pendingReviews).toHaveLength(
      4,
    );
  });

  it("splits generated review comments at the provider comment limit", async () => {
    const capabilities = {
      ...fullCapabilities,
      write: { ...fullCapabilities.write, attachArtifact: false },
    };
    const provider = makeProvider({ capabilities });
    const { handler } = await attached({
      resolution: { provider, capabilities, writes: "enabled", server: "jira" },
    });
    const finalEvidence = `final-evidence-${"e".repeat(2_000)}`;
    const finalUrl = `https://example.test/${"a".repeat(1_900)}`;
    const verdict = await call(handler, TASK_TOOL_NAMES.review, {
      summary: "s".repeat(TASK_LIMITS.summary),
      evidence: [
        ...Array.from(
          { length: TASK_LIMITS.evidence - 1 },
          (_, index) => `${index}-${"e".repeat(2_000)}`,
        ),
        finalEvidence,
      ],
      artifacts: [
        ...Array.from({ length: TASK_LIMITS.artifacts - 1 }, (_, index) => ({
          kind: "url" as const,
          label: `artifact-${index}`,
          url: `https://example.test/${index}/${"a".repeat(1_900)}`,
        })),
        { kind: "url" as const, label: "final-artifact", url: finalUrl },
      ],
    });

    expect(textOf(verdict)).toContain('"stage":"review"');
    const comments = provider.calls
      .filter((entry) => entry.operation === "comment")
      .map((entry) => (entry.input as { body: string }).body);
    expect(comments.length).toBeGreaterThan(1);
    expect(comments.every((body) => body.length <= TASK_LIMITS.comment)).toBeTrue();
    expect(comments.join("\n")).toContain(finalEvidence);
    expect(comments.join("\n")).toContain(finalUrl);
  });

  it("does not republish review evidence when only the final transition conflicts", async () => {
    const selected = resolution();
    const transition = selected.provider.transition!.bind(selected.provider);
    let conflict = true;
    selected.provider.transition = async (input, signal) => {
      if (input.intent === "submit_review" && conflict) {
        conflict = false;
        selected.provider.calls.push({ operation: "transition", input: structuredClone(input) });
        throw new TaskProviderError("task_conflict", "changed");
      }
      return transition(input, signal);
    };
    const { handler } = await attached({ resolution: selected });
    const args = {
      summary: "Done",
      artifacts: [{ kind: "url" as const, label: "build", url: "https://example.test/build" }],
    };

    expect(textOf(await call(handler, TASK_TOOL_NAMES.review, args, "review-1"))).toContain(
      "task_conflict",
    );
    expect(textOf(await call(handler, TASK_TOOL_NAMES.review, args, "review-2"))).toContain(
      '"stage":"review"',
    );
    expect(
      selected.provider.calls.filter((entry) => entry.operation === "attachArtifact"),
    ).toHaveLength(1);
    expect(selected.provider.calls.filter((entry) => entry.operation === "comment")).toHaveLength(
      1,
    );
    const transitions = selected.provider.calls.filter((entry) => entry.operation === "transition");
    expect(transitions).toHaveLength(2);
    const transitionKeys = transitions.map(
      (entry) => (entry.input as { mutation: { idempotencyKey: string } }).mutation.idempotencyKey,
    );
    expect(new Set(transitionKeys).size).toBe(2);
  });

  it("serializes writes from agents sharing one run runtime", async () => {
    const selected = resolution();
    const original = selected.provider.comment!.bind(selected.provider);
    let concurrent = 0;
    let peak = 0;
    selected.provider.comment = async (input, signal) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await original(input, signal);
      } finally {
        concurrent -= 1;
      }
    };
    const { handler } = await attached({ resolution: selected });
    await Promise.all([
      call(handler, TASK_TOOL_NAMES.comment, { body: "one" }, "one"),
      call(handler, TASK_TOOL_NAMES.comment, { body: "two" }, "two"),
    ]);
    expect(peak).toBe(1);
  });
});
