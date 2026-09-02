import { describe, expect, test } from "bun:test";
import type { LLMToolCall, RunRequest, Usage } from "@clarvis/capability";
import { createCapabilityServices } from "@clarvis/capability";
import type { ExecuteRunOutcome } from "@clarvis/loop";
import { createAgentRegistry, type AgentsLimits } from "@clarvis/supervision";
import { createWorkflowsCapability } from "../../src/capability.ts";
import { beginDispatch, type DispatchDeps, type DispatchUnit } from "../../src/dispatch.ts";
import { createElicitMux } from "../../src/elicit-mux.ts";
import { createWorkflowLedger } from "../../src/ledger.ts";
import { runLeader } from "../../src/run-leader.ts";
import { createRoundCoordinator, startRounds, type RoundCall } from "../../src/run-round.ts";
import { RUN_WORK_ITEMS_TOOL_NAME } from "../../src/work-items.ts";
import { RUN_LEADER_TOOL_NAME } from "../../src/tool.ts";
import type { WorkflowCtx } from "../../src/types.ts";
import { recordingLogger, type RecordingLogger } from "../helpers/recording-logger.ts";
import {
  makeCtx,
  recordingBc,
  requestWithPrompt,
  runContextWithAgents,
  scope,
  workflowRunDeps,
} from "../helpers/workflow.ts";

const LIMITS: AgentsLimits = {
  bufferLines: 100,
  bufferBytes: 4096,
  maxTotalBufferBytes: 65_536,
  pollMaxBytes: 4096,
  awaitTimeoutMs: 1000,
  maxLiveChildren: 8,
  maxRetainedChildren: 16,
  maxNoticesPerIteration: 8,
  maxConsecutiveFailedChildren: 3,
  finishNudges: 2,
};

function usage(output: number, elapsed = 7): Usage {
  return {
    iterations_used: 1,
    elapsed_ms: elapsed,
    by_agent: [
      {
        type: "lead",
        model: "m",
        input_tokens: 0,
        output_tokens: output,
        cached_tokens: 0,
        cache_write_tokens: 0,
        iterations: 1,
        subagents_spawned: 0,
      },
    ],
  };
}

const completed = (result: unknown = "ok"): Promise<ExecuteRunOutcome> =>
  Promise.resolve({
    executionId: "ignored",
    response: { status: "completed", result, usage: usage(3) },
  });

const failed = (): Promise<ExecuteRunOutcome> =>
  Promise.resolve({
    executionId: "ignored",
    response: {
      status: "error",
      error: { code: "boom", message: "the leader broke" },
      usage: usage(1),
    },
  });

/** Engine deps carrying a logger, which is all this package ever reads off them. */
function depsWith(log: RecordingLogger, capabilities?: string[]): WorkflowCtx["deps"] {
  return {
    logger: log.logger,
    ...(capabilities === undefined
      ? {}
      : { capabilities: capabilities.map((name) => ({ name, forRun: () => null })) }),
  } as unknown as WorkflowCtx["deps"];
}

function unit(key: string, over: Partial<DispatchUnit> = {}): DispatchUnit {
  return { key, title: `Do ${key}`, brief: `goal ${key}`, ...over };
}

/** A dispatch over a real registry, with a recording logger wired through `deps`. */
function dispatchHarness(
  units: readonly DispatchUnit[],
  over: {
    limits?: Partial<AgentsLimits>;
    execute?: () => Promise<ExecuteRunOutcome>;
    ctx?: Partial<WorkflowCtx>;
    deps?: Partial<DispatchDeps>;
    trace?: (kind: string) => void;
    totalUnits?: number;
  } = {},
) {
  const log = recordingLogger("debug");
  const controller = new AbortController();
  const registry = createAgentRegistry({ limits: { ...LIMITS, ...over.limits } });
  const ctx = makeCtx({
    deps: depsWith(log),
    signal: controller.signal,
    runDeps: workflowRunDeps(over.execute ?? completed),
    assemble: (spec) => requestWithPrompt(spec.prompt),
    ...over.ctx,
  });
  const { bc } = recordingBc();
  const traced = over.trace;
  const withTrace =
    traced === undefined
      ? bc
      : { ...bc, trace: { ...bc.trace, record: (kind: string): void => traced(kind) } };
  const deps: DispatchDeps = {
    ctx,
    bc: withTrace as typeof bc,
    clock: undefined,
    agents: registry,
    ...over.deps,
  };
  return {
    log,
    controller,
    registry,
    deps,
    dispatch: beginDispatch(deps, units, over.totalUnits ?? units.length),
  };
}

describe("workflow.capability_inactive — the three topology gates", () => {
  test("a run with no supervision registry says the capability reached nobody", async () => {
    const log = recordingLogger("debug");
    const capability = createWorkflowsCapability(makeCtx({ deps: depsWith(log) }));

    expect(
      await capability.forRun({
        services: createCapabilityServices(),
        entryGrants: ["other"],
      } as never),
    ).toBeNull();

    const record = log.one("workflow.capability_inactive");
    expect(record.level).toBe("warn");
    expect(record.fields).toMatchObject({ reason: "no_registry", grants: "other" });
  });

  test("an entry agent without the grant warns; a sub-agent is only a debug note", async () => {
    const log = recordingLogger("debug");
    const capability = createWorkflowsCapability(makeCtx({ deps: depsWith(log) }));
    const run = await capability.forRun(
      runContextWithAgents(createAgentRegistry({ limits: LIMITS })),
    );

    run!.forAgent!(scope({ grants: [] }));
    run!.forAgent!(scope({ entry: false }));
    run!.forAgent!(scope());

    const [entry, child] = log.of("workflow.capability_inactive");
    expect(entry).toMatchObject({ level: "warn", fields: { reason: "no_grant", agent: "lead" } });
    expect(child).toMatchObject({ level: "debug", fields: { reason: "not_entry" } });
    expect(log.of("workflow.capability_inactive")).toHaveLength(2);
  });
});

describe("run_leader — what an ad-hoc leader says", () => {
  const handlerFor = async (
    log: RecordingLogger,
    over: Partial<WorkflowCtx> = {},
    limits: Partial<AgentsLimits> = {},
  ) => {
    const registry = createAgentRegistry({ limits: { ...LIMITS, ...limits } });
    const tasks: Promise<unknown>[] = [];
    const agents = {
      ...registry,
      adopt(id: string, task: Promise<unknown>): void {
        tasks.push(task);
        registry.adopt(id, task);
      },
    };
    const ctx = makeCtx({
      deps: depsWith(log, ["tools", "memory"]),
      runDeps: workflowRunDeps(completed),
      assemble: (spec) => requestWithPrompt(spec.prompt),
      ...over,
    });
    const capability = await createWorkflowsCapability(ctx).forRun(runContextWithAgents(agents));
    const { bc } = recordingBc();
    const handler = capability!.forAgent(scope())!.attach(bc).handlers![0]!;
    const call: LLMToolCall = {
      id: "c",
      name: RUN_LEADER_TOOL_NAME,
      arguments: { title: "Do it", prompt: "the brief" },
    };
    return {
      call: async (): Promise<void> => {
        await handler.handle(call, 0);
        await Promise.allSettled([...tasks]);
      },
    };
  };

  test("a started leader names its budget, its brief size and its capabilities — never the brief", async () => {
    const log = recordingLogger("debug");
    await (await handlerFor(log)).call();

    const started = log.one("workflow.leader_started");
    expect(started.level).toBe("debug");
    expect(started.fields).toMatchObject({
      title: "Do it",
      brief_chars: "the brief".length,
      capabilities: "tools,memory",
      expects_schema: false,
    });
    expect(started.fields.reservation_tokens).toBeNumber();
    expect(JSON.stringify(started.fields)).not.toContain("the brief");
  });

  test("a completed leader settles at info, carrying what the trace edge omits", async () => {
    const log = recordingLogger("debug");
    await (await handlerFor(log)).call();

    const settled = log.one("workflow.leader_settled");
    expect(settled.level).toBe("info");
    expect(settled.fields).toMatchObject({ status: "completed", output_tokens: 3, elapsed_ms: 7 });
    expect(settled.fields.agent_id).toBeString();
  });

  test("a leader that ends any other way settles at warn, with its error code", async () => {
    const log = recordingLogger("debug");
    await (await handlerFor(log, { runDeps: workflowRunDeps(failed) })).call();

    const settled = log.one("workflow.leader_settled");
    expect(settled.level).toBe("warn");
    expect(settled.fields).toMatchObject({ status: "error", error_code: "boom" });
  });

  test("an exhausted tree budget says so before refusing the spawn", async () => {
    const log = recordingLogger("debug");
    const ledger = createWorkflowLedger(1);
    ledger.add(usage(5));
    await (await handlerFor(log, { ledger })).call();

    const record = log.one("workflow.budget_exhausted");
    expect(record.level).toBe("warn");
    expect(record.fields).toMatchObject({ total: 1, spent: 1, max_concurrency: 4 });
    expect(log.of("workflow.leader_started")).toHaveLength(0);
  });

  test("a leader whose executeRun rejects is reported with its stack", async () => {
    const log = recordingLogger("debug");
    const boom = new Error("executeRun exploded", { cause: new Error("socket closed") });
    const ctx = makeCtx({
      deps: depsWith(log),
      runDeps: workflowRunDeps(() => Promise.reject(boom)),
      assemble: (spec) => requestWithPrompt(spec.prompt),
    });

    const result = await runLeader({ title: "t", prompt: "p" }, ctx, "leader-9");

    expect(result.status).toBe("error");
    const record = log.one("workflow.leader_faulted");
    expect(record.level).toBe("error");
    expect(record.fields).toMatchObject({
      leader_run_id: "leader-9",
      err: "executeRun exploded",
      cause: "socket closed",
    });
    expect(record.fields.stack).toBeString();
  });

  test("a throw from the trace sink itself faults the ad-hoc leader loudly", async () => {
    const log = recordingLogger("debug");
    const registry = createAgentRegistry({ limits: LIMITS });
    const tasks: Promise<unknown>[] = [];
    const agents = {
      ...registry,
      adopt(id: string, task: Promise<unknown>): void {
        tasks.push(task);
        registry.adopt(id, task);
      },
    };
    const ctx = makeCtx({
      deps: depsWith(log),
      runDeps: workflowRunDeps(completed),
      assemble: (spec) => requestWithPrompt(spec.prompt),
    });
    const capability = await createWorkflowsCapability(ctx).forRun(runContextWithAgents(agents));
    const { bc } = recordingBc();
    const exploding = {
      ...bc,
      trace: {
        ...bc.trace,
        record: (kind: string): void => {
          if (kind.startsWith("workflow_run_")) throw new Error("sink down");
        },
      },
    };
    const handler = capability!.forAgent(scope())!.attach(exploding as typeof bc).handlers![0]!;

    await handler.handle(
      { id: "c", name: RUN_LEADER_TOOL_NAME, arguments: { title: "t", prompt: "p" } },
      0,
    );
    await Promise.allSettled([...tasks]);

    expect(log.one("workflow.leader_faulted").fields.err).toBe("sink down");
  });
});

describe("dispatch — a batch's own lifecycle", () => {
  test("a batch that starts names its width, its ceiling and its queue", async () => {
    const h = dispatchHarness([unit("a"), unit("b"), unit("c")], {
      limits: { maxLiveChildren: 2 },
    });

    const begun = h.log.one("workflow.dispatch_begun");
    expect(begun.level).toBe("info");
    expect(begun.fields).toMatchObject({
      units: 3,
      registered: 2,
      queued: 1,
      max_concurrency: 4,
      budget_tokens: null,
    });
    expect(begun.fields.dispatch_id).toBeString();

    await h.dispatch!.run();
    h.dispatch!.end("done");
  });

  test("a registry that admits nothing refuses the whole dispatch, loudly", () => {
    const h = dispatchHarness([unit("a")], { limits: { maxLiveChildren: 1 } });
    const second = beginDispatch(h.deps, [unit("b")]);

    expect(second).toBeNull();
    const refused = h.log.one("workflow.dispatch_refused");
    expect(refused.level).toBe("warn");
    expect(refused.fields).toMatchObject({ units: 1, live_children: 1, sealed: false });
  });

  test("every unit's settlement is attributed to its wave and its leader run", async () => {
    const h = dispatchHarness([
      unit("a", { roundId: "verify", pass: 1, itemIndex: 2, replica: 0 }),
    ]);
    await h.dispatch!.run();
    h.dispatch!.end("done");

    const settled = h.log.one("workflow.leader_settled");
    expect(settled.fields).toMatchObject({
      unit_key: "a",
      round_id: "verify",
      pass: 1,
      item_index: 2,
      replica: 0,
      status: "completed",
      output_tokens: 3,
    });
    expect(settled.fields.dispatch_id).toBeString();
  });

  test("advancing to the next wave says whether the baton was released", async () => {
    const h = dispatchHarness([unit("a")], { totalUnits: 2 });
    await h.dispatch!.run();
    h.dispatch!.advance([unit("b", { roundId: "build", pass: 0 })]);
    await h.dispatch!.run();
    h.dispatch!.end("done");

    const advanced = h.log.one("workflow.wave_advanced");
    expect(advanced.level).toBe("debug");
    expect(advanced.fields).toMatchObject({
      round_id: "build",
      pass: 0,
      units: 1,
      registered: 1,
      baton_released: true,
    });
  });

  test("a cancelled dispatch states that no later wave is ever scheduled", async () => {
    const h = dispatchHarness([unit("a")]);
    await h.dispatch!.run();
    h.controller.abort();
    h.dispatch!.advance([unit("b"), unit("c")]);

    const halted = h.log.one("workflow.dispatch_halted");
    expect(halted.level).toBe("warn");
    expect(halted.fields).toMatchObject({ reason: "cancelled", queued_dropped: 2 });
    expect(h.log.of("workflow.wave_advanced")).toHaveLength(0);
  });

  test("an exhausted budget names the unit it stopped at", async () => {
    const ledger = createWorkflowLedger(1);
    ledger.add(usage(9));
    const h = dispatchHarness([unit("a")], { ctx: { ledger } });

    await h.dispatch!.run();
    h.dispatch!.end("done");

    const record = h.log.one("workflow.budget_exhausted");
    expect(record.level).toBe("warn");
    expect(record.fields).toMatchObject({ total: 1, spent: 1, at_unit: "a", unit_key: "a" });
  });

  test("a deadline-free capacity wait is sampled, and reported once as a stall", async () => {
    let clock = 0;
    const registry = createAgentRegistry({ limits: { ...LIMITS, maxLiveChildren: 2 } });
    const foreign = registry.register({
      kind: "subagent",
      nativeId: "foreign",
      title: "foreign",
      control: { stop: () => {}, steer: () => true, undrained: () => 0 },
    })!;
    const log = recordingLogger("debug");
    const ctx = makeCtx({
      deps: depsWith(log),
      runDeps: workflowRunDeps(completed),
      assemble: (spec) => requestWithPrompt(spec.prompt),
    });
    const { bc } = recordingBc();
    const deps: DispatchDeps = {
      ctx,
      bc,
      clock: undefined,
      agents: registry,
      now: () => {
        clock += 4000;
        return clock;
      },
    };
    const dispatch = beginDispatch(deps, [unit("a"), unit("b")])!;
    setTimeout(() => foreign.settled({ status: "completed", result: "done" }), 80);

    const outcomes = await dispatch.run();
    dispatch.end("done");

    expect(outcomes.map((o) => o.key)).toEqual(["a", "b"]);
    const waits = log.of("workflow.capacity_wait");
    expect(waits.length).toBeGreaterThan(0);
    expect(waits[0]!.fields).toMatchObject({ attempt: 0, queued: 1, foreign_live: 1 });
    expect(waits[0]!.fields.delay_ms).toBeNumber();
    const stalled = log.one("workflow.capacity_stalled");
    expect(stalled.level).toBe("info");
    expect(stalled.fields.waited_ms).toBeGreaterThanOrEqual(5000);
  });

  test("a unit whose trace sink throws reports both the fault and the lost edge", async () => {
    const h = dispatchHarness([unit("a")], {
      execute: () => Promise.reject(new Error("leader blew up")),
      trace: (kind: string): void => {
        if (kind.startsWith("workflow_run_")) throw new Error("sink down");
      },
    });

    await h.dispatch!.run();
    h.dispatch!.end("done");

    expect(h.log.one("workflow.leader_faulted").fields.err).toBe("sink down");
    const sink = h.log.one("workflow.trace_sink_failed");
    expect(sink.level).toBe("error");
    expect(sink.fields).toMatchObject({ kind: "workflow_run_failed", err: "sink down" });
  });
});

describe("run_round — planning, skipping and folding", () => {
  const roundsHarness = (
    over: {
      execute?: () => Promise<ExecuteRunOutcome>;
      limits?: Partial<AgentsLimits>;
    } = {},
  ) => {
    const log = recordingLogger("debug");
    const registry = createAgentRegistry({ limits: { ...LIMITS, ...over.limits } });
    const tasks: Promise<unknown>[] = [];
    const agents = {
      ...registry,
      adopt(id: string, task: Promise<unknown>): void {
        tasks.push(task);
        registry.adopt(id, task);
      },
    };
    const states: Parameters<NonNullable<WorkflowCtx["onSequenceState"]>>[0][] = [];
    const ctx = makeCtx({
      deps: depsWith(log),
      runDeps: workflowRunDeps(over.execute ?? (() => completed({ findings: ["x"] }))),
      assemble: (spec): RunRequest => requestWithPrompt(spec.prompt),
      onSequenceState: (state) => states.push(state),
    });
    const { bc } = recordingBc();
    const deps = { ctx, bc, clock: undefined, agents } as DispatchDeps;
    const coordinator = createRoundCoordinator(ctx);
    return {
      log,
      deps,
      start: (call: RoundCall) => startRounds(deps, call, coordinator),
      settle: async (): Promise<void> => {
        for (;;) {
          await Promise.allSettled([...tasks]);
          const state = states.at(-1);
          if (state?.status !== "awaiting_manager") return;
          coordinator.decide({
            sessionId: state.sessionId,
            revision: state.revision,
            decision: "continue",
            reason: "observability test authorizes the next asserted round",
          });
        }
      },
    };
  };

  const DISCOVER = {
    id: "discover",
    title: "Map work",
    type: "discovery" as const,
    over: { kind: "once" } as const,
    brief: "Map the work.",
    fanout: 1,
  };

  test("a round states its whole fan-out before it costs anything", async () => {
    const h = roundsHarness();
    const started = h.start({ rounds: [DISCOVER], args: {} });
    expect(started).toHaveProperty("text");
    await h.settle();

    const planned = h.log.of("workflow.round_planned")[0]!;
    expect(planned.level).toBe("info");
    expect(planned.fields).toMatchObject({
      round_id: "discover",
      pass: 0,
      selector: "once",
      items: 1,
      fanout: 1,
      units: 1,
      waves: 1,
      prereq_units: 0,
    });
  });

  test("a folded round names its shape, so a prose reply is not silently an array", async () => {
    const h = roundsHarness({ execute: () => completed("just prose") });
    h.start({ rounds: [DISCOVER], args: {} });
    await h.settle();

    const folded = h.log.one("workflow.round_folded");
    expect(folded.level).toBe("debug");
    expect(folded.fields).toMatchObject({
      round_id: "discover",
      leaders: 1,
      result_shape: "scalar",
      non_object_replicas: 1,
    });
  });

  test("a round guarded on an empty field is reported as skipped, not just summarized", async () => {
    const h = roundsHarness();
    h.start({
      rounds: [
        DISCOVER,
        {
          id: "verify",
          title: "Verify",
          type: "verdict" as const,
          over: { kind: "once" } as const,
          brief: "Check it.",
          fanout: 1,
          when: "discover.nothing",
        },
      ],
      args: {},
    });
    await h.settle();

    const skipped = h.log.of("workflow.round_skipped");
    expect(skipped[0]!.level).toBe("warn");
    expect(skipped[0]!.fields).toMatchObject({
      round_id: "verify",
      pass: 0,
      reason: "'discover.nothing' is empty",
    });
  });

  test("a first round whose guard is empty reports the skip on the refusal path too", () => {
    const h = roundsHarness();
    const started = h.start({
      rounds: [{ ...DISCOVER, when: "nothing.here" }],
      args: {},
    });

    expect(started).toHaveProperty("error");
    expect(h.log.one("workflow.round_skipped").fields).toMatchObject({ round_id: "discover" });
  });

  test("a driver that throws is attributable to its rounds before adopt swallows it", async () => {
    let ids = 0;
    const log = recordingLogger("debug");
    const registry = createAgentRegistry({ limits: LIMITS });
    const tasks: Promise<unknown>[] = [];
    const agents = {
      ...registry,
      adopt(id: string, task: Promise<unknown>): void {
        tasks.push(task);
        registry.adopt(id, task);
      },
    };
    const states: Parameters<NonNullable<WorkflowCtx["onSequenceState"]>>[0][] = [];
    const ctx = makeCtx({
      deps: depsWith(log),
      assemble: (spec): RunRequest => requestWithPrompt(spec.prompt),
      onSequenceState: (state) => states.push(state),
      runDeps: {
        generateExecutionId: (): string => {
          ids += 1;
          if (ids > 1) throw new Error("the id source failed");
          return "leader-1";
        },
        executeRun: () => completed(),
      },
    });
    const { bc } = recordingBc();
    const deps = { ctx, bc, clock: undefined, agents } as DispatchDeps;
    const coordinator = createRoundCoordinator(ctx);

    startRounds(
      deps,
      {
        rounds: [
          DISCOVER,
          {
            id: "verify",
            title: "Verify",
            type: "verdict" as const,
            over: { kind: "once" } as const,
            brief: "Check it.",
            fanout: 1,
          },
        ],
        args: {},
      },
      coordinator,
    );
    await Promise.allSettled([...tasks]);
    const checkpoint = states.at(-1)!;
    expect(checkpoint.status).toBe("awaiting_manager");
    coordinator.decide({
      sessionId: checkpoint.sessionId,
      revision: checkpoint.revision,
      decision: "continue",
      reason: "exercise the next-round registration fault",
    });

    const faulted = log.one("workflow.driver_faulted");
    expect(faulted.level).toBe("error");
    expect(faulted.fields).toMatchObject({
      err: "the id source failed",
      rounds_done: 1,
      reports: "discover:1",
    });
    expect(faulted.fields.stack).toBeString();
  });
});

describe("scheduling — the decision nobody could audit", () => {
  const workItemsHarness = () => {
    const log = recordingLogger("debug");
    const registry = createAgentRegistry({ limits: LIMITS });
    const tasks: Promise<unknown>[] = [];
    const agents = {
      ...registry,
      adopt(id: string, task: Promise<unknown>): void {
        tasks.push(task);
        registry.adopt(id, task);
      },
    };
    const ctx = makeCtx({
      deps: depsWith(log),
      runDeps: workflowRunDeps(completed),
      assemble: (spec): RunRequest => requestWithPrompt(spec.prompt),
    });
    return {
      log,
      ctx,
      agents,
      settle: async (): Promise<void> => {
        await Promise.allSettled([...tasks]);
      },
    };
  };

  const item = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    title: `Item ${id}`,
    goal: `do ${id}`,
    files: [],
    dependencies: [],
    mutation: false,
    ...over,
  });

  test("a derived schedule records its waves and its unscoped writers", async () => {
    const h = workItemsHarness();
    const capability = await createWorkflowsCapability(h.ctx).forRun(
      runContextWithAgents(h.agents),
    );
    const { bc } = recordingBc();
    const handler = capability!.forAgent(scope())!.attach(bc).handlers![1]!;

    await handler.handle(
      {
        id: "c",
        name: RUN_WORK_ITEMS_TOOL_NAME,
        arguments: { items: [item("a", { mutation: true }), item("b")] },
      },
      0,
    );
    await h.settle();

    const derived = h.log.one("workflow.schedule_derived");
    expect(derived.level).toBe("debug");
    expect(derived.fields).toMatchObject({
      items: 2,
      waves: 2,
      wave_sizes: "1,1",
      unscoped_writers: 1,
    });
  });

  test("a batch the scheduler refuses names the code and the ids", async () => {
    const h = workItemsHarness();
    const capability = await createWorkflowsCapability(h.ctx).forRun(
      runContextWithAgents(h.agents),
    );
    const { bc } = recordingBc();
    const handler = capability!.forAgent(scope())!.attach(bc).handlers![1]!;

    await handler.handle(
      {
        id: "c",
        name: RUN_WORK_ITEMS_TOOL_NAME,
        arguments: { items: [item("a"), item("a")] },
      },
      0,
    );

    const refused = h.log.one("workflow.schedule_refused");
    expect(refused.level).toBe("warn");
    expect(refused.fields).toMatchObject({ code: "duplicate_id", ids: "a" });
    expect(h.log.of("workflow.schedule_derived")).toHaveLength(0);
  });
});

describe("the elicit mux — a prompt nobody will ever answer", () => {
  test("a queued prompt is recorded with the queue it joined", async () => {
    const log = recordingLogger("debug");
    const mux = createElicitMux(() => Promise.resolve({ action: "accept" }), {
      logger: log.logger,
    });

    await mux.forLeader("leader-abcdef01")({ message: "?" } as never, {} as never);

    const queued = log.one("workflow.elicit_queued");
    expect(queued.level).toBe("debug");
    expect(queued.fields).toMatchObject({ kind: "leader", leader_run_id: "leader-abcdef01" });
    expect(queued.fields.queue_depth).toBe(1);
  });

  test("a prompt whose agent was already stopped is reported, not dropped in silence", async () => {
    const log = recordingLogger("debug");
    const mux = createElicitMux(() => Promise.resolve({ action: "accept" }), {
      logger: log.logger,
    });
    const controller = new AbortController();
    controller.abort();

    const result = await mux.manager(
      { message: "?" } as never,
      {
        signal: controller.signal,
      } as never,
    );

    expect(result).toEqual({ action: "cancel" });
    const skipped = log.one("workflow.elicit_skipped");
    expect(skipped.level).toBe("warn");
    expect(skipped.fields).toMatchObject({ kind: "manager", waited_ms: 0 });
  });

  test("a prompt aborted while queued is reported when its turn comes", async () => {
    const log = recordingLogger("debug");
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mux = createElicitMux(() => gate.then(() => ({ action: "accept" }) as never), {
      logger: log.logger,
    });
    const controller = new AbortController();

    const first = mux.manager({ message: "one" } as never, {} as never);
    const second = mux.forLeader("leader-2")(
      { message: "two" } as never,
      {
        signal: controller.signal,
      } as never,
    );
    controller.abort();
    release();

    await Promise.all([first, second]);
    const skipped = log.of("workflow.elicit_skipped");
    expect(skipped.at(-1)!.fields).toMatchObject({ kind: "leader", leader_run_id: "leader-2" });
    expect(skipped.at(-1)!.fields.waited_ms).toBeNumber();
  });
});

describe("a host that wired no logger", () => {
  test("changes nothing: the engine deps a leader runs against keep their identity", async () => {
    const deps = {} as WorkflowCtx["deps"];
    const runDeps = workflowRunDeps(completed);
    const ctx = makeCtx({ deps, runDeps, assemble: (spec) => requestWithPrompt(spec.prompt) });

    await runLeader({ title: "t", prompt: "p" }, ctx, "leader-1");

    expect(runDeps.calls[0]!.deps).toBe(deps);
  });

  test("and a dispatch through it still runs, silently", async () => {
    const registry = createAgentRegistry({ limits: LIMITS });
    const ctx = makeCtx({
      runDeps: workflowRunDeps(completed),
      assemble: (spec) => requestWithPrompt(spec.prompt),
    });
    const { bc } = recordingBc();
    const dispatch = beginDispatch({ ctx, bc, clock: undefined, agents: registry }, [unit("a")])!;

    expect((await dispatch.run()).map((o) => o.status)).toEqual(["completed"]);
    dispatch.end("done");
  });
});
