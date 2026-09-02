import { describe, expect, test } from "bun:test";
import { createSemaphore, type Usage } from "@clarvis/capability";
import type { ExecuteRunOutcome } from "@clarvis/loop";
import { createAgentRegistry, type AgentsLimits } from "@clarvis/supervision";
import {
  beginDispatch,
  describeQueued,
  type DispatchDeps,
  type DispatchUnit,
} from "../../src/dispatch.ts";
import { createWorkflowLedger } from "../../src/ledger.ts";
import { createWorkflowLeaderCount } from "../../src/leader-count.ts";
import { makeCtx, recordingBc, requestWithPrompt, workflowRunDeps } from "../helpers/workflow.ts";

const LIMITS: AgentsLimits = {
  bufferLines: 100,
  bufferBytes: 4096,
  maxTotalBufferBytes: 65_536,
  pollMaxBytes: 4096,
  awaitTimeoutMs: 1000,
  maxLiveChildren: 4,
  maxRetainedChildren: 8,
  maxNoticesPerIteration: 8,
  maxConsecutiveFailedChildren: 3,
  finishNudges: 2,
};

function usage(): Usage {
  return {
    iterations_used: 1,
    elapsed_ms: 0,
    by_agent: [
      {
        type: "lead",
        model: "m",
        input_tokens: 0,
        output_tokens: 1,
        cached_tokens: 0,
        cache_write_tokens: 0,
        iterations: 1,
        subagents_spawned: 0,
      },
    ],
  };
}

const completed = (): Promise<ExecuteRunOutcome> =>
  Promise.resolve({
    executionId: "ignored",
    response: { status: "completed", result: "ok", usage: usage() },
  });

function unit(key: string): DispatchUnit {
  return { key, title: `Do ${key}`, brief: `goal ${key}` };
}

/**
 * Occupy `count` registry slots with children this dispatch does not own — the
 * shape a manager holding background `delegate_task` sub-agents produces.
 */
function occupy(registry: ReturnType<typeof createAgentRegistry>, count: number) {
  return Array.from({ length: count }, (_, i) => {
    const handle = registry.register({
      kind: "subagent",
      nativeId: `foreign-${String(i)}`,
      title: `foreign ${String(i)}`,
      control: { stop: () => {}, steer: () => true, undrained: () => 0 },
    });
    if (handle === null) throw new Error("the registry refused a foreign child");
    return handle;
  });
}

/**
 * A dispatch over a real registry, with an abort signal the test controls.
 *
 * @param before - run against the registry *before* the first batch registers,
 *   so a test can claim slots the dispatch will then have to wait for.
 */
function session(
  units: readonly DispatchUnit[],
  limits: Partial<AgentsLimits> = {},
  before?: (registry: ReturnType<typeof createAgentRegistry>) => void,
) {
  const controller = new AbortController();
  const registry = createAgentRegistry({ limits: { ...LIMITS, ...limits } });
  before?.(registry);
  const ctx = makeCtx({
    signal: controller.signal,
    runDeps: workflowRunDeps(completed),
    assemble: (spec) => requestWithPrompt(spec.prompt),
  });
  const { bc } = recordingBc();
  const deps: DispatchDeps = { ctx, bc, clock: undefined, agents: registry };
  return { controller, registry, dispatch: beginDispatch(deps, units) };
}

describe("beginDispatch", () => {
  test("abandons a registered child when its atomic reservation cannot be consumed", () => {
    const registry = createAgentRegistry({ limits: LIMITS });
    const ctx = makeCtx({
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
    });

    expect(
      beginDispatch({ ctx, bc: recordingBc().bc, clock: undefined, agents: registry }, [unit("a")]),
    ).toBeNull();
    expect(registry.list()).toMatchObject([{ status: "failed" }]);
    expect(registry.liveCount()).toBe(0);
  });

  test("settles an already-registered prefix when a later registration throws", () => {
    let ids = 0;
    const registry = createAgentRegistry({ limits: LIMITS });
    const leaderCount = createWorkflowLeaderCount(2);
    const ctx = makeCtx({
      leaderCount,
      runDeps: {
        generateExecutionId: (): string => {
          ids += 1;
          if (ids === 2) throw new Error("id source failed");
          return `leader-${String(ids)}`;
        },
        executeRun: completed,
      },
    });

    expect(() =>
      beginDispatch(
        { ctx, bc: recordingBc().bc, clock: undefined, agents: registry },
        [unit("a"), unit("b")],
        2,
      ),
    ).toThrow("id source failed");
    expect(registry.liveCount()).toBe(0);
    expect(registry.list()).toMatchObject([{ status: "failed" }]);
    expect(leaderCount.started()).toBe(1);
    expect(leaderCount.remaining()).toBe(1);
  });

  test("counts and settles every accepted registration when the trace sink throws mid-batch", () => {
    const registry = createAgentRegistry({ limits: LIMITS });
    const leaderCount = createWorkflowLeaderCount(2);
    const ctx = makeCtx({ leaderCount });
    const { bc } = recordingBc();
    const record = bc.trace.record.bind(bc.trace);
    let registrations = 0;
    bc.trace.record = (kind: string, detail: unknown): void => {
      if (kind === "agent_registered") {
        registrations += 1;
        if (registrations === 2) throw new Error("registration trace failed");
      }
      record(kind, detail);
    };

    expect(() =>
      beginDispatch({ ctx, bc, clock: undefined, agents: registry }, [unit("a"), unit("b")], 2),
    ).toThrow("registration trace failed");
    expect(registry.liveCount()).toBe(0);
    expect(registry.list()).toMatchObject([{ status: "failed" }, { status: "failed" }]);
    expect(leaderCount.started()).toBe(2);
    expect(leaderCount.remaining()).toBe(0);
  });

  test("refuses outright when the run was already aborted", () => {
    const s = session([unit("a")]);
    s.controller.abort();
    expect(
      beginDispatch(
        {
          ctx: makeCtx({ signal: s.controller.signal }),
          bc: recordingBc().bc,
          clock: undefined,
          agents: s.registry,
        },
        [unit("a")],
      ),
    ).toBeNull();
  });

  test("an abort between batches registers nothing further", async () => {
    const s = session([unit("a")]);
    expect(s.dispatch).not.toBeNull();
    const dispatch = s.dispatch!;

    expect(await dispatch.run()).toMatchObject([{ key: "a", status: "completed" }]);
    // The abort lands after the batch settled but before the next one is asked
    // for: `advance` is the only place that can still refuse to spend on it.
    s.controller.abort();
    dispatch.advance([unit("b")]);

    expect(dispatch.pendingHandles().size).toBe(0);
    expect(dispatch.queuedCount()).toBe(0);
    expect(await dispatch.run()).toEqual([]);
    dispatch.end("done");
  });

  test("waits for a child outside the batch to free a slot, rather than dropping the queue", async () => {
    let foreign: ReturnType<typeof occupy> = [];
    const s = session([unit("a"), unit("b"), unit("c")], { maxLiveChildren: 3 }, (registry) => {
      foreign = occupy(registry, 2);
    });

    const dispatch = s.dispatch!;
    // One unit got the last slot; the other two are queued behind children this
    // dispatch cannot settle itself.
    expect(dispatch.queuedCount()).toBe(2);
    setTimeout(() => {
      for (const handle of foreign) handle.settled({ status: "completed", result: "done" });
    }, 60);

    const outcomes = await dispatch.run();
    expect(outcomes.map((o) => o.key)).toEqual(["a", "b", "c"]);
    expect(outcomes.every((o) => o.status === "completed")).toBe(true);
    dispatch.end("done");
  });

  test("gives up on a queue no slot can ever free, instead of waiting forever", async () => {
    // The ceiling is one and the baton holds it, so nothing outside this
    // dispatch is live to settle. Reporting the tail beats hanging the driver.
    const s = session([unit("a"), unit("b")], { maxLiveChildren: 1 });
    const dispatch = s.dispatch!;

    const outcomes = await dispatch.run();
    expect(outcomes.map((o) => o.key)).toEqual(["a", "b"]);
    expect(outcomes[0]).toMatchObject({ key: "a", status: "completed" });
    expect(outcomes[1]).toMatchObject({ key: "b", status: "unregistered" });
    dispatch.end("done");
  });

  test("the batch's outcome count equals its unit count however narrow the registry", async () => {
    const keys = ["a", "b", "c", "d", "e", "f", "g"];
    const s = session(keys.map(unit), { maxLiveChildren: 2 });
    const dispatch = s.dispatch!;

    expect(dispatch.queuedCount()).toBeGreaterThan(0);
    const outcomes = await dispatch.run();
    expect(outcomes.map((o) => o.key)).toEqual(keys);
    expect(outcomes.every((o) => o.status === "completed")).toBe(true);
    dispatch.end("done");
  });

  test("serial concurrency admits the queued tail against headroom released by each predecessor", async () => {
    const controller = new AbortController();
    const runDeps = workflowRunDeps(completed);
    const ledger = createWorkflowLedger(100);
    const registry = createAgentRegistry({ limits: LIMITS });
    const ctx = makeCtx({
      signal: controller.signal,
      runDeps,
      assemble: (spec) => requestWithPrompt(spec.prompt),
      semaphore: createSemaphore(1),
      ledger,
      maxConcurrency: 1,
    });
    const dispatch = beginDispatch(
      { ctx, bc: recordingBc().bc, clock: undefined, agents: registry },
      [unit("a"), unit("b")],
    )!;

    const outcomes = await dispatch.run();
    expect(outcomes).toMatchObject([
      { key: "a", status: "completed" },
      { key: "b", status: "completed" },
    ]);
    expect(runDeps.calls).toHaveLength(2);
    expect(ledger.spent()).toBe(2);
    expect(ledger.remaining()).toBe(98);
    dispatch.end("done");
  });
});

describe("describeQueued", () => {
  test("says nothing when the whole batch started", () => {
    expect(describeQueued(0)).toBe("");
    expect(describeQueued(-1)).toBe("");
  });

  test("names the count and tells the caller it needs no action", () => {
    expect(describeQueued(12)).toContain("12 more are queued");
  });
});
