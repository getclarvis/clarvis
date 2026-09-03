import { describe, expect, test } from "bun:test";
import {
  createSemaphore,
  type AgentBuildContext,
  type RunRequest,
  type TraceEvent,
  type Usage,
} from "@clarvis/capability";
import type { ExecuteRunOutcome } from "@clarvis/loop";
import { createWorkflowsCapability } from "../../src/capability.ts";
import { createWorkflowLedger } from "../../src/ledger.ts";
import { createWorkflowLeaderCount } from "../../src/leader-count.ts";
import { WORKFLOW_LIMITS } from "../../src/limits.ts";
import { runLeader } from "../../src/run-leader.ts";
import type { LeaderSpec } from "../../src/types.ts";
import { LEADER_TITLE_MAX } from "../../src/tool.ts";
import {
  makeCtx,
  recordingBc,
  requestWithPrompt,
  runLeaderCall,
  scope,
  testRunCtx,
  workflowRunDeps,
} from "../helpers/workflow.ts";

function usage(output: number): Usage {
  return {
    iterations_used: 1,
    elapsed_ms: 0,
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

function completed(result: unknown, output: number): ExecuteRunOutcome {
  return {
    executionId: "ignored",
    response: { status: "completed", result, usage: usage(output) },
  };
}

function cancelled(): ExecuteRunOutcome {
  return {
    executionId: "ignored",
    response: { status: "cancelled", result: "", usage: usage(0) },
  };
}

const leaderAssembler = (spec: LeaderSpec): RunRequest => {
  const request = { ...requestWithPrompt(spec.prompt), plans: "off" };
  return request;
};

/** A {@link recordingBc}-alike whose `trace.record` throws for one chosen kind,
 * to exercise the run_leader task's own catch (a fault after the leader itself
 * already resolved). */
function throwingBc(throwOnKind: string): {
  bc: AgentBuildContext;
  records: Array<{ kind: string; detail: unknown }>;
} {
  const { bc, records } = recordingBc();
  const record = bc.trace.record.bind(bc.trace);
  bc.trace.record = (kind: string, detail: unknown): void => {
    if (kind === throwOnKind) throw new Error("trace sink exploded");
    record(kind, detail);
  };
  return { bc, records };
}

describe("runLeader", () => {
  test("returns budget_exhausted without assembling or starting a run", async () => {
    const runDeps = workflowRunDeps(() => Promise.resolve(completed("impossible", 1)));
    const ledger = createWorkflowLedger(1);
    ledger.add(usage(1));
    let assembled = false;
    let exhausted = false;
    const result = await runLeader(
      { title: "leader", prompt: "hello" },
      makeCtx({
        runDeps,
        ledger,
        assemble: (spec) => {
          assembled = true;
          return leaderAssembler(spec);
        },
        onBudgetExhausted: () => {
          exhausted = true;
        },
      }),
      "leader-fixed",
    );

    expect(result).toEqual({
      runId: "leader-fixed",
      status: "budget_exhausted",
      result: undefined,
      usage: { iterations_used: 0, elapsed_ms: 0, by_agent: [] },
    });
    expect(assembled).toBe(false);
    expect(exhausted).toBe(true);
    expect(runDeps.calls).toHaveLength(0);
  });

  test("runs the assembled request under the given id and folds usage into the ledger", async () => {
    const runDeps = workflowRunDeps(() => Promise.resolve(completed("done", 42)));
    const ledger = createWorkflowLedger(1000);
    const ctx = makeCtx({ runDeps, ledger, assemble: leaderAssembler, managerRunId: "mgr" });

    const result = await runLeader({ title: "leader", prompt: "hello" }, ctx, "leader-fixed");

    expect(result.status).toBe("completed");
    expect(result.result).toBe("done");
    expect(result.runId).toBe("leader-fixed");
    expect(ledger.spent()).toBe(42);
    const first = runDeps.calls[0]!;
    const sent = first.rawBody as RunRequest;
    expect(sent.execution_id).toBe("leader-fixed");
    expect((sent as RunRequest & { plans: string }).plans).toBe("off");
    expect(first.externalSignal).toBe(ctx.signal);
    expect(first.capabilities).toHaveLength(1);
    const budgetRun = await first.capabilities![0]!.forRun({} as never);
    const contribution = budgetRun!.forAgent(scope({ grants: [] }))!.attach(recordingBc().bc);
    expect(contribution.tools).toBeUndefined();
    expect(contribution.outputBudget).toBeDefined();
  });

  test("partitions one leader reservation across its root and concurrent subagent calls", async () => {
    const ledger = createWorkflowLedger(100);
    const runDeps = workflowRunDeps(async (args) => {
      const budgetRun = await args.capabilities![0]!.forRun({} as never);
      const root = budgetRun!.forAgent(scope({ grants: [] }))!.attach(recordingBc().bc);
      const child = budgetRun!
        .forAgent(scope({ entry: false, grants: [] }))!
        .attach(recordingBc().bc);

      const rootCall = root.outputBudget!.reserveOutput(100)!;
      expect(rootCall.amount).toBe(25);
      const childCall = child.outputBudget!.reserveOutput(100)!;
      expect(childCall.amount).toBe(13);
      rootCall.settle(3);
      childCall.settle(4);
      return completed("done", 7);
    });
    const ctx = makeCtx({
      runDeps,
      ledger,
      maxConcurrency: 1,
      maxParallelSubagents: 1,
      assemble: leaderAssembler,
    });

    const result = await runLeader({ title: "leader", prompt: "hello" }, ctx, "leader-fixed");

    expect(result.status).toBe("completed");
    expect(ledger.spent()).toBe(7);
    expect(ledger.remaining()).toBe(93);
  });

  test("maps an error response to an error result and still folds usage", async () => {
    const runDeps = workflowRunDeps(() =>
      Promise.resolve({
        executionId: "x",
        response: {
          status: "error",
          error: { code: "boom", message: "kaboom" },
          usage: usage(5),
        },
      }),
    );
    const ledger = createWorkflowLedger(null);

    const result = await runLeader(
      { title: "leader", prompt: "x" },
      makeCtx({ runDeps, ledger, assemble: leaderAssembler }),
    );

    expect(result.status).toBe("error");
    expect(result.error).toEqual({ code: "boom", message: "kaboom" });
    expect(ledger.spent()).toBe(5);
  });

  test("surfaces a thrown executeRun as an error result instead of propagating", async () => {
    const runDeps = workflowRunDeps(() => Promise.reject(new Error("validation failed")));
    const result = await runLeader(
      { title: "leader", prompt: "x" },
      makeCtx({ runDeps, assemble: leaderAssembler }),
    );
    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("validation failed");
  });

  test("releases the eager reservation when leader setup fails before executeRun", async () => {
    for (const failure of ["assemble", "elicit", "steer"] as const) {
      const ledger = createWorkflowLedger(10);
      const runDeps = workflowRunDeps(() => Promise.resolve(completed("not reached", 1)));
      const setup = (): never => {
        throw new Error(`${failure} failed`);
      };
      const result = await runLeader(
        { title: "leader", prompt: "x" },
        makeCtx({
          ledger,
          maxConcurrency: 1,
          runDeps,
          assemble: failure === "assemble" ? setup : leaderAssembler,
          ...(failure === "elicit" ? { elicitForLeader: setup } : {}),
          ...(failure === "steer" ? { steerForLeader: setup } : {}),
        }),
        `leader-${failure}`,
      );

      expect(result).toMatchObject({
        runId: `leader-${failure}`,
        status: "error",
        error: { code: "leader_run_failed", message: `${failure} failed` },
      });
      expect(runDeps.calls).toHaveLength(0);
      expect(ledger.spent()).toBe(0);
      expect(ledger.remaining()).toBe(10);
    }
  });
});

describe("manager fan-out via the run_leader handler", () => {
  test("settles a registered child when its held cumulative admission is lost", async () => {
    const runDeps = workflowRunDeps(() => Promise.resolve(completed("not reached", 1)));
    const t = testRunCtx();
    const run = await createWorkflowsCapability(
      makeCtx({
        runDeps,
        leaderCount: {
          limit: 1,
          started: () => 0,
          remaining: () => 1,
          reserve: () => ({
            consume: () => false,
            release: () => undefined,
            remaining: () => 1,
          }),
        },
      }),
    ).forRun(t.runCtx);
    const handler = run!.forAgent(scope())!.attach(recordingBc().bc).handlers![0]!;

    const result = await handler.handle(runLeaderCall({ title: "leader", prompt: "A" }), 0);

    expect(result).toMatchObject({
      kind: "result",
      progress: false,
      text: expect.stringContaining("cumulative admission failed"),
    });
    expect(t.registry.list()).toMatchObject([{ status: "failed" }]);
    expect(t.registry.liveCount()).toBe(0);
    expect(runDeps.calls).toHaveLength(0);
  });

  test("releases cumulative admission when child registration throws", async () => {
    const leaderCount = createWorkflowLeaderCount(1);
    const ctx = makeCtx({
      leaderCount,
      runDeps: {
        generateExecutionId: (): never => {
          throw new Error("id source failed");
        },
        executeRun: () => Promise.resolve(completed("not reached", 1)),
      },
    });
    const run = await createWorkflowsCapability(ctx).forRun(testRunCtx().runCtx);
    const handler = run!.forAgent(scope())!.attach(recordingBc().bc).handlers![0]!;

    expect(() => handler.handle(runLeaderCall({ title: "leader", prompt: "A" }), 0)).toThrow(
      "id source failed",
    );
    expect(leaderCount.started()).toBe(0);
    expect(leaderCount.remaining()).toBe(1);
  });

  test("counts and settles an accepted child when its registration trace throws", async () => {
    const leaderCount = createWorkflowLeaderCount(1);
    const runDeps = workflowRunDeps(() => Promise.resolve(completed("not reached", 1)));
    const ctx = makeCtx({ leaderCount, runDeps });
    const t = testRunCtx();
    const run = await createWorkflowsCapability(ctx).forRun(t.runCtx);
    const handler = run!.forAgent(scope())!.attach(throwingBc("agent_registered").bc).handlers![0]!;

    expect(() => handler.handle(runLeaderCall({ title: "leader", prompt: "A" }), 0)).toThrow(
      "trace sink exploded",
    );
    expect(leaderCount.started()).toBe(1);
    expect(leaderCount.remaining()).toBe(0);
    expect(t.registry.liveCount()).toBe(0);
    expect(t.registry.list()).toMatchObject([{ status: "failed" }]);
    expect(runDeps.calls).toHaveLength(0);
  });

  test("refuses an ad-hoc spawn after the manager reaches its cumulative leader ceiling", async () => {
    const runDeps = workflowRunDeps(() => Promise.resolve(completed("ok", 1)));
    const ctx = makeCtx({
      runDeps,
      assemble: leaderAssembler,
      leaderCount: createWorkflowLeaderCount(1),
    });
    const t = testRunCtx();
    const run = await createWorkflowsCapability(ctx).forRun(t.runCtx);
    const handler = run!.forAgent(scope())!.attach(recordingBc().bc).handlers![0]!;

    const first = await handler.handle(runLeaderCall({ title: "leader", prompt: "A" }), 0);
    const second = await handler.handle(runLeaderCall({ title: "leader", prompt: "B" }), 0);
    if (first.kind !== "result" || second.kind !== "result") throw new Error("expected results");
    expect(first.progress).toBe(true);
    expect(second.progress).toBe(false);
    expect(second.text).toContain("max_total_leaders");
    await t.settle();
    expect(runDeps.calls).toHaveLength(1);
  });

  test("bounds concurrent leaders by the semaphore, sums usage, and records the tree edges", async () => {
    let active = 0;
    let maxActive = 0;
    let releaseRuns!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseRuns = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const runDeps = workflowRunDeps(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      markStarted();
      await held;
      active -= 1;
      return completed("ok", 10);
    });
    const ledger = createWorkflowLedger(100);
    const ctx = makeCtx({
      runDeps,
      semaphore: createSemaphore(1),
      ledger,
      maxConcurrency: 1,
      assemble: leaderAssembler,
    });
    const { bc, records } = recordingBc();
    const t = testRunCtx();
    const run = await createWorkflowsCapability(ctx).forRun(t.runCtx);
    const handler = run!.forAgent(scope())!.attach(bc).handlers![0]!;

    const v1 = await handler.handle(runLeaderCall({ title: "leader", prompt: "A" }), 0);
    const v2 = await handler.handle(runLeaderCall({ title: "leader", prompt: "B" }), 0);
    if (v1.kind !== "result" || v2.kind !== "result")
      throw new Error("run_leader must answer with a handle, not a deferred");
    expect(v1.text).toMatch(/started ag_[0-9a-f]{8}/);
    expect(v2.text).toMatch(/started ag_[0-9a-f]{8}/);
    await started;
    expect(maxActive).toBe(1);
    releaseRuns();
    await t.settle();

    expect(maxActive).toBe(1);
    expect(runDeps.calls).toHaveLength(2);
    expect(ledger.spent()).toBe(20);
    expect(ledger.remaining()).toBe(80);
    expect(t.registry.list().map((r) => r.status)).toEqual(["completed", "completed"]);
    const first = t.registry.list()[0]!;
    expect(t.registry.poll(first.id, {})!.result).toContain("completed");
    expect(records.filter((e) => e.kind === "workflow_run_started")).toHaveLength(2);
    expect(records.filter((e) => e.kind === "workflow_run_completed")).toHaveLength(2);
    expect(records.filter((e) => e.kind === "agent_registered")).toHaveLength(2);
  });

  test("with concurrency headroom the leaders run in parallel", async () => {
    let active = 0;
    let maxActive = 0;
    let releasePair!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      releasePair = resolve;
    });
    const runDeps = workflowRunDeps(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === 2) releasePair();
      await bothStarted;
      active -= 1;
      return completed("ok", 1);
    });
    const ctx = makeCtx({
      runDeps,
      semaphore: createSemaphore(4),
      assemble: leaderAssembler,
    });
    const t = testRunCtx();
    const run = await createWorkflowsCapability(ctx).forRun(t.runCtx);
    const handler = run!.forAgent(scope())!.attach(recordingBc().bc).handlers![0]!;

    await handler.handle(runLeaderCall({ title: "leader", prompt: "A" }), 0);
    await handler.handle(runLeaderCall({ title: "leader", prompt: "B" }), 0);
    await t.settle();

    expect(maxActive).toBe(2);
  });

  test("a leader queued behind the semaphore resolves gracefully (does not hang) once the workflow is cancelled", async () => {
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
    const runDeps = workflowRunDeps(async () => {
      await firstHeld;
      return completed("ok", 1);
    });
    const controller = new AbortController();
    const ctx = makeCtx({
      semaphore: createSemaphore(1),
      runDeps,
      assemble: leaderAssembler,
      signal: controller.signal,
    });
    const { bc, records } = recordingBc();
    const t = testRunCtx();
    const run = await createWorkflowsCapability(ctx).forRun(t.runCtx);
    const handler = run!.forAgent(scope())!.attach(bc).handlers![0]!;

    // Both calls are answered immediately with a handle; leader A holds the only
    // slot (blocked on firstHeld) and leader B is queued behind the semaphore.
    const v1 = await handler.handle(runLeaderCall({ title: "leader", prompt: "A" }), 0);
    const v2 = await handler.handle(runLeaderCall({ title: "leader", prompt: "B" }), 0);
    if (v1.kind !== "result" || v2.kind !== "result")
      throw new Error("run_leader must answer with a handle, not a deferred");

    await Promise.resolve();
    await Promise.resolve();
    expect(t.registry.liveCount()).toBe(2); // B is queued, not hung by construction

    controller.abort(new Error("workflow cancelled"));
    releaseFirst();
    await t.settle();

    // B never got a slot, so it settled without a workflow_run_started edge;
    // only A's was recorded.
    const statuses = t.registry.list().map((r) => r.status);
    expect(statuses).toContain("stopped");
    expect(records.filter((e) => e.kind === "workflow_run_started")).toHaveLength(1);
    expect(records.filter((e) => e.kind === "agent_registered")).toHaveLength(2);
  });

  test("a cancelled leader is stopped rather than presented as failed", async () => {
    const runDeps = workflowRunDeps(() => Promise.resolve(cancelled()));
    const ctx = makeCtx({ runDeps, assemble: leaderAssembler });
    const { bc, records } = recordingBc();
    const t = testRunCtx();
    const run = await createWorkflowsCapability(ctx).forRun(t.runCtx);
    const handler = run!.forAgent(scope())!.attach(bc).handlers![0]!;

    await handler.handle(runLeaderCall({ title: "leader", prompt: "A" }), 0);
    await t.settle();

    expect(t.registry.list().map((row) => row.status)).toEqual(["stopped"]);
    expect(
      records.filter((event) => event.kind === "workflow_run_failed")[0]?.detail,
    ).toMatchObject({ status: "cancelled" });
  });

  test("several admitted run_leader calls under a tight budget cannot collectively overrun it", async () => {
    let active = 0;
    let releaseFirstPair!: () => void;
    const firstPairStarted = new Promise<void>((resolve) => {
      releaseFirstPair = resolve;
    });
    const runDeps = workflowRunDeps(async () => {
      active += 1;
      if (active === 2) releaseFirstPair();
      await firstPairStarted;
      active -= 1;
      return completed("ok", 10);
    });
    const ledger = createWorkflowLedger(10);
    const ctx = makeCtx({
      semaphore: createSemaphore(2),
      runDeps,
      ledger,
      maxConcurrency: 2,
      assemble: leaderAssembler,
    });
    const t = testRunCtx();
    const run = await createWorkflowsCapability(ctx).forRun(t.runCtx);
    const handler = run!.forAgent(scope())!.attach(recordingBc().bc).handlers![0]!;

    const verdicts = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        handler.handle(runLeaderCall({ title: "leader", prompt: `p${i}` }), 0),
      ),
    );
    expect(verdicts.every((v) => v.kind === "result" && v.text.includes("in the background"))).toBe(
      true,
    );
    await t.settle();

    const statuses = t.registry.list().map((entry) => entry.status);
    expect(statuses).toContain("completed");
    expect(statuses).toContain("failed");
    expect(runDeps.calls.length).toBeGreaterThan(0);
    expect(runDeps.calls.length).toBeLessThan(10);
    expect(ledger.spent()).toBe(10);
    expect(ledger.remaining()).toBe(0);
  });

  test("forwards a matching leader's trace events to its handle and the outer onLeaderEvent", async () => {
    const emitted: TraceEvent = { type: "run_ended", occurred_at: 0, reason: "completed" };
    const runDeps = workflowRunDeps((args) => {
      args.onEvent?.(emitted);
      return Promise.resolve(completed("ok", 1));
    });
    const forwarded: Array<{ id: string; event: TraceEvent }> = [];
    const ctx = makeCtx({
      assemble: leaderAssembler,
      runDeps,
      onLeaderEvent: (id, event) => forwarded.push({ id, event }),
    });
    const t = testRunCtx();
    const run = await createWorkflowsCapability(ctx).forRun(t.runCtx);
    const handler = run!.forAgent(scope())!.attach(recordingBc().bc).handlers![0]!;

    const v = await handler.handle(runLeaderCall({ title: "leader", prompt: "A" }), 0);
    if (v.kind !== "result") throw new Error("run_leader must answer with a handle");
    const agentId = /started (ag_[0-9a-f]{8})/.exec(v.text)?.[1];
    if (agentId === undefined) throw new Error("no agent id in the verdict text");
    await t.settle();

    // The runId-tagged event reaches both the child's own handle (so agent_poll
    // sees it) and the outer, workflow-level onLeaderEvent — unrelated ids would
    // reach neither.
    expect(forwarded).toEqual([{ id: "leader-1", event: emitted }]);
    expect(t.registry.poll(agentId, {})?.output).toContain("ended completed");
  });

  test("a fault while recording/settling an already-completed leader is caught, not thrown, and the leader ends failed", async () => {
    const runDeps = workflowRunDeps(() => Promise.resolve(completed("done", 1)));
    const ctx = makeCtx({ runDeps, assemble: leaderAssembler });
    const { bc, records } = throwingBc("workflow_run_completed");
    const t = testRunCtx();
    const run = await createWorkflowsCapability(ctx).forRun(t.runCtx);
    const handler = run!.forAgent(scope())!.attach(bc).handlers![0]!;

    await handler.handle(runLeaderCall({ title: "leader", prompt: "boom" }), 0);
    await t.settle();

    expect(t.registry.list().map((r) => r.status)).toEqual(["failed"]);
    const first = t.registry.list()[0]!;
    expect(t.registry.poll(first.id, {})?.result).toContain("error: trace sink exploded");
    expect(records.filter((e) => e.kind === "workflow_run_started")).toHaveLength(1);
    expect(records.filter((e) => e.kind === "workflow_run_failed")).toHaveLength(1);
  });

  test("a fault in the first leader trace releases every execution resource", async () => {
    const runDeps = workflowRunDeps(() => Promise.resolve(completed("done", 1)));
    const ledger = createWorkflowLedger(1);
    const ctx = makeCtx({
      runDeps,
      ledger,
      maxConcurrency: 1,
      semaphore: createSemaphore(1),
      assemble: leaderAssembler,
    });
    const { bc, records } = recordingBc();
    const record = bc.trace.record.bind(bc.trace);
    let failFirstStart = true;
    bc.trace.record = (kind: string, detail: unknown): void => {
      if (kind === "workflow_run_started" && failFirstStart) {
        failFirstStart = false;
        throw new Error("first trace failed");
      }
      record(kind, detail);
    };
    const t = testRunCtx();
    const run = await createWorkflowsCapability(ctx).forRun(t.runCtx);
    const handler = run!.forAgent(scope())!.attach(bc).handlers![0]!;

    await handler.handle(runLeaderCall({ title: "first", prompt: "A" }), 0);
    await t.settle();
    await handler.handle(runLeaderCall({ title: "second", prompt: "B" }), 0);
    await t.settle();

    expect(t.registry.list().map((entry) => entry.status)).toEqual(["failed", "completed"]);
    expect(records.filter((event) => event.kind === "workflow_run_failed")).toHaveLength(1);
    expect(records.filter((event) => event.kind === "workflow_run_started")).toHaveLength(1);
    expect(ledger.spent()).toBe(1);
  });

  test("projects an object result's text field for the manager", async () => {
    const runDeps = workflowRunDeps(() =>
      Promise.resolve(completed({ text: "structured done", extra: 1 }, 1)),
    );
    const ctx = makeCtx({ runDeps, assemble: leaderAssembler });
    const t = testRunCtx();
    const run = await createWorkflowsCapability(ctx).forRun(t.runCtx);
    const handler = run!.forAgent(scope())!.attach(recordingBc().bc).handlers![0]!;

    await handler.handle(runLeaderCall({ title: "leader", prompt: "A" }), 0);
    await t.settle();

    const first = t.registry.list()[0]!;
    expect(t.registry.poll(first.id, {})?.result).toContain("structured done");
  });

  test("falls back to JSON for an object result with no text field", async () => {
    const runDeps = workflowRunDeps(() => Promise.resolve(completed({ ok: true, count: 3 }, 1)));
    const ctx = makeCtx({ runDeps, assemble: leaderAssembler });
    const t = testRunCtx();
    const run = await createWorkflowsCapability(ctx).forRun(t.runCtx);
    const handler = run!.forAgent(scope())!.attach(recordingBc().bc).handlers![0]!;

    await handler.handle(runLeaderCall({ title: "leader", prompt: "A" }), 0);
    await t.settle();

    const first = t.registry.list()[0]!;
    expect(t.registry.poll(first.id, {})?.result).toContain('{"ok":true,"count":3}');
  });

  test("falls back to a placeholder when a result cannot be JSON-serialized", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const runDeps = workflowRunDeps(() => Promise.resolve(completed(circular, 1)));
    const ctx = makeCtx({ runDeps, assemble: leaderAssembler });
    const t = testRunCtx();
    const run = await createWorkflowsCapability(ctx).forRun(t.runCtx);
    const handler = run!.forAgent(scope())!.attach(recordingBc().bc).handlers![0]!;

    await handler.handle(runLeaderCall({ title: "leader", prompt: "A" }), 0);
    await t.settle();

    const first = t.registry.list()[0]!;
    expect(t.registry.poll(first.id, {})?.result).toContain("[unserializable result]");
  });
});

/**
 * A leader used to be registered under its **entire** prompt, so a fan-out
 * listed several children each labelled with a full task brief — unreadable in
 * the agent list and in the transcript, and inconsistent with `delegate_task`,
 * which has taken a short model-authored `title` all along.
 */
describe("a leader's display title", () => {
  test("registers the model's short title, not the whole prompt", async () => {
    const ctx = makeCtx({ assemble: leaderAssembler });
    const t = testRunCtx();
    const run = await createWorkflowsCapability(ctx).forRun(t.runCtx);
    const { bc, records } = recordingBc();
    const handler = run!.forAgent(scope())!.attach(bc).handlers![0]!;

    await handler.handle(
      runLeaderCall({
        title: "migrate the storage schema",
        prompt: "A very long brief that goes on for a while ".repeat(10),
      }),
      0,
    );
    await t.settle();

    expect(t.registry.list()[0]!.title).toBe("migrate the storage schema");
    expect(records.find((event) => event.kind === "workflow_run_started")?.detail).toMatchObject({
      title: "migrate the storage schema",
      task: "A very long brief that goes on for a while ".repeat(10),
    });
  });

  test("refuses a missing title instead of deriving one from the prompt", async () => {
    const ctx = makeCtx({ assemble: leaderAssembler });
    const t = testRunCtx();
    const run = await createWorkflowsCapability(ctx).forRun(t.runCtx);
    const handler = run!.forAgent(scope())!.attach(recordingBc().bc).handlers![0]!;

    const verdict = await handler.handle(
      runLeaderCall({ prompt: `${"x".repeat(200)}\nsecond line` }),
      0,
    );
    await t.settle();

    expect(verdict.kind).toBe("result");
    if (verdict.kind === "result") expect(verdict.text).toContain("title");
    expect(t.registry.list()).toEqual([]);
  });

  test("refuses an over-long declared title rather than clipping it", async () => {
    const ctx = makeCtx({ assemble: leaderAssembler });
    const t = testRunCtx();
    const run = await createWorkflowsCapability(ctx).forRun(t.runCtx);
    const handler = run!.forAgent(scope())!.attach(recordingBc().bc).handlers![0]!;

    const verdict = await handler.handle(
      runLeaderCall({ title: "t".repeat(LEADER_TITLE_MAX + 1), prompt: "go" }),
      0,
    );
    await t.settle();

    expect(verdict.kind).toBe("result");
    if (verdict.kind === "result") expect(verdict.text).toContain("title");
    expect(t.registry.list()).toEqual([]);
  });

  test.each([
    ["an oversized prompt", { title: "leader", prompt: "x".repeat(WORKFLOW_LIMITS.textChars + 1) }],
    [
      "an oversized profile",
      {
        title: "leader",
        prompt: "go",
        profile: "x".repeat(WORKFLOW_LIMITS.identifierChars + 1),
      },
    ],
  ])("refuses %s before registering a leader", async (_label, args) => {
    const ctx = makeCtx({ assemble: leaderAssembler });
    const t = testRunCtx();
    const run = await createWorkflowsCapability(ctx).forRun(t.runCtx);
    const handler = run!.forAgent(scope())!.attach(recordingBc().bc).handlers![0]!;

    const verdict = await handler.handle(runLeaderCall(args), 0);
    await t.settle();

    expect(verdict.kind).toBe("result");
    expect(t.registry.list()).toEqual([]);
  });
});
