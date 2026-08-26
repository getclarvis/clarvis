import { describe, expect, it } from "../bun-test.ts";
import {
  DELEGATE_TASK_MAX_CHARS,
  loadEnv,
  type LifecycleHook,
  type PreDelegateTaskContext,
  type TaskTrackingPort,
} from "@clarvis/capability";
import { createTrace } from "@clarvis/trace";
import { createTokenLedger } from "../../src/runtime/budget/index.ts";
import { DISABLED_COMPACTION } from "../../src/runtime/context/index.ts";
import {
  prepareSpawn,
  runPreparedSubagent,
  type DelegateTaskContext,
} from "../../src/runtime/subagents/delegate-task.ts";
import type { ResolvedSubagentProfile } from "../../src/runtime/subagents/subagent-profiles.ts";
import { MockLLM } from "../helpers/fixtures.ts";

const env = loadEnv({});
const SPAWN_ARGS = { title: "worker", task: "do the thing", profile: "coder" };

function profile(): ResolvedSubagentProfile {
  return {
    name: "coder",
    model: "model",
    modelRef: "anthropic:model",
    provider: "anthropic",
    tools: [],
    contextWindowTokens: 200_000,
    stagnationThreshold: 3,
    callTimeoutMs: 60_000,
    reasoningSummary: "off",
    maxRetries: 0,
    maxRetryAfterMs: 0,
    compaction: DISABLED_COMPACTION,
    stream: true,
  };
}

function context(
  llm: MockLLM,
  hooks: LifecycleHook[],
): DelegateTaskContext & { trace: ReturnType<typeof createTrace> } {
  return {
    env,
    opened: [],
    profiles: new Map([["coder", profile()]]),
    iterationLimitDefault: 5,
    llm,
    ledger: createTokenLedger(1_000_000),
    trace: createTrace(),
    subagentAggByModel: new Map(),
    hooks,
  };
}

describe("pre_delegate_task hook wiring", () => {
  it("passes validated spawn arguments to the fake hook and maps its denial", async () => {
    const seen: PreDelegateTaskContext[] = [];
    const ctx = context(new MockLLM({ script: [] }), [
      {
        async preDelegateTask(input) {
          seen.push(input);
          return { kind: "deny", message: "coder subagents are disabled" };
        },
      },
    ]);

    const prepared = await prepareSpawn(SPAWN_ARGS, ctx);

    expect(prepared).toEqual({
      ok: false,
      text: "delegate_task DENIED by a workspace hook: coder subagents are disabled",
    });
    expect(seen).toEqual([SPAWN_ARGS]);
    expect(ctx.trace.entries().some((entry) => entry.kind === "delegation_created")).toBe(false);
  });

  it("a passing fake hook preserves the real subagent lifecycle wiring", async () => {
    const ctx = context(new MockLLM({ script: [{ text: "done" }] }), [
      { preDelegateTask: async () => ({ kind: "pass" }) },
    ]);

    const prepared = await prepareSpawn(SPAWN_ARGS, ctx);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const result = await runPreparedSubagent(prepared.prepared, ctx);

    expect(result).toMatchObject({ spawned: true, text: "done" });
    expect(ctx.trace.entries().some((entry) => entry.kind === "delegation_created")).toBe(true);
  });

  it("rejects an augmented prompt over the ceiling before claiming or tracing its task", async () => {
    let marked = false;
    let hooked = false;
    const tracked = {
      id: "t1",
      title: "Tracked",
      status: "pending",
      exit: "x".repeat(DELEGATE_TASK_MAX_CHARS),
    };
    const tasks: TaskTrackingPort = {
      openTasks: () => [tracked],
      getTask: (id) => (id === tracked.id ? tracked : undefined),
      markSpawned: () => {
        marked = true;
        return true;
      },
      markFailed: () => true,
      beforeSpawn: async () => ({ kind: "ok" }),
      noteSpawned: () => {},
      augmentDelegateTask: () => ({
        description: "tracked spawn",
        properties: { task_id: { type: "string" } },
      }),
    };
    const ctx = context(new MockLLM({ script: [] }), [
      {
        preDelegateTask: async () => {
          hooked = true;
          return { kind: "pass" };
        },
      },
    ]);
    ctx.tasks = tasks;

    const prepared = await prepareSpawn({ ...SPAWN_ARGS, task_id: "t1" }, ctx);

    expect(prepared).toMatchObject({ ok: false });
    if (!prepared.ok)
      expect(prepared.text).toContain(`${String(DELEGATE_TASK_MAX_CHARS)}-character`);
    expect(hooked).toBe(false);
    expect(marked).toBe(false);
    expect(ctx.trace.entries().some((entry) => entry.kind === "delegation_created")).toBe(false);
  });

  it("fails closed when the hook itself throws, so a broken gate denies the spawn", async () => {
    const ctx = context(new MockLLM({ script: [{ text: "should never run" }] }), [
      {
        preDelegateTask: () => {
          throw new Error("hook process exited 1");
        },
      },
    ]);

    const prepared = await prepareSpawn(SPAWN_ARGS, ctx);

    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.text).toContain("delegate_task DENIED by a workspace hook");
    expect(prepared.text).toContain("the hook itself failed");
    expect(prepared.text).toContain("hook process exited 1");
    expect(ctx.trace.entries().some((entry) => entry.kind === "delegation_created")).toBe(false);
  });

  it("denies on a throw even when a later hook would have passed the spawn", async () => {
    let laterRan = false;
    const ctx = context(new MockLLM({ script: [] }), [
      {
        preDelegateTask: async () => {
          await Promise.resolve();
          throw new Error("first gate is broken");
        },
      },
      {
        preDelegateTask: async () => {
          laterRan = true;
          return { kind: "pass" };
        },
      },
    ]);

    const prepared = await prepareSpawn(SPAWN_ARGS, ctx);

    expect(prepared.ok).toBe(false);
    expect(laterRan).toBe(false);
  });
});

/**
 * A cancelled sub-agent must leave the tracker exactly as it found it.
 *
 * @remarks Both exits from the run guard on `ctx.signal?.aborted`, and the two
 * are reached differently: the throw path when the model call itself rejects,
 * and the outcome path when the run settles into a non-completed status. The
 * distinction matters because cancellation is not the sub-agent's verdict on
 * its task — marking it failed would record the user's interruption as the
 * work having been attempted and lost, and the task would never be retried.
 *
 * Each test carries a control that aborts nothing, so "markFailed was not
 * called" means the guard held rather than that the path was never reached.
 */
describe("a cancelled sub-agent never mutates the tracker", () => {
  interface Recorder {
    tasks: TaskTrackingPort;
    failed: string[];
  }

  function recordingTracker(): Recorder {
    const tracked = { id: "t1", title: "Tracked", status: "pending" };
    const failed: string[] = [];
    return {
      failed,
      tasks: {
        openTasks: () => [tracked],
        getTask: (id) => (id === tracked.id ? tracked : undefined),
        markSpawned: () => true,
        markFailed: (id) => {
          failed.push(id);
          return true;
        },
        beforeSpawn: async () => ({ kind: "ok" }),
        noteSpawned: () => {},
        augmentDelegateTask: () => ({
          description: "tracked spawn",
          properties: { task_id: { type: "string" } },
        }),
      },
    };
  }

  /** An empty-completion script against a spent ledger settles as `budget_exhausted`. */
  const exhaustingLlm = (): MockLLM =>
    new MockLLM({ script: Array.from({ length: 6 }, () => ({ text: "" })) });

  it("leaves the tracker untouched when the model call rejects under an aborted signal", async () => {
    const { tasks, failed } = recordingTracker();
    const ctx = context(new MockLLM({ script: [] }), []);
    ctx.tasks = tasks;
    const controller = new AbortController();
    ctx.signal = controller.signal;

    const prepared = await prepareSpawn({ ...SPAWN_ARGS, task_id: "t1" }, ctx);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    controller.abort();
    const result = await runPreparedSubagent(prepared.prepared, ctx);

    expect(result.text).toContain("Sub-agent cancelled.");
    expect(failed).toEqual([]);
    const entry = ctx.trace.entries().find((e) => e.kind === "delegation_failed");
    expect((entry?.detail as { status: string }).status).toBe("cancelled");
  });

  it("marks the same throw path failed when nothing aborted, so the guard is what spares it", async () => {
    const { tasks, failed } = recordingTracker();
    const ctx = context(new MockLLM({ script: [] }), []);
    ctx.tasks = tasks;

    const prepared = await prepareSpawn({ ...SPAWN_ARGS, task_id: "t1" }, ctx);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    await runPreparedSubagent(prepared.prepared, ctx);

    expect(failed).toEqual(["t1"]);
  });

  it("leaves the tracker untouched when the run settles while cancellation is in flight", async () => {
    const { tasks, failed } = recordingTracker();
    const controller = new AbortController();
    const ctx = context(exhaustingLlm(), [
      {
        onSubagentComplete: async () => {
          controller.abort();
        },
      },
    ]);
    ctx.tasks = tasks;
    ctx.ledger = createTokenLedger(1);
    ctx.signal = controller.signal;

    const prepared = await prepareSpawn({ ...SPAWN_ARGS, task_id: "t1" }, ctx);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    await runPreparedSubagent(prepared.prepared, ctx);

    const entry = ctx.trace.entries().find((e) => e.kind === "delegation_failed");
    expect((entry?.detail as { status: string }).status).toBe("budget_exhausted");
    expect(failed).toEqual([]);
  });

  it("marks the same outcome path failed when nothing aborted", async () => {
    const { tasks, failed } = recordingTracker();
    const ctx = context(exhaustingLlm(), []);
    ctx.tasks = tasks;
    ctx.ledger = createTokenLedger(1);

    const prepared = await prepareSpawn({ ...SPAWN_ARGS, task_id: "t1" }, ctx);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    await runPreparedSubagent(prepared.prepared, ctx);

    expect(failed).toEqual(["t1"]);
  });
});
