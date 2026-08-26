import { describe, expect, it } from "bun:test";
import {
  closeRunningEdges,
  freshLeaderProgress,
  isLeaderEntryIteration,
  reconcileRunningWorkflowRecord,
} from "../../src/workflows/workflows-service.ts";
import {
  WORKFLOW_PERSIST_DELAY_MS,
  createWorkflowSaveQueue,
  type WorkflowEdge,
  type WorkflowRecord,
} from "../../src/workflows/workflow-store.ts";

describe("isLeaderEntryIteration", () => {
  it("never attributes a delegated child's turns to the entry, regardless of arrival order", () => {
    const progress = freshLeaderProgress();
    progress.delegatedIds.add("child-1");

    expect(isLeaderEntryIteration({ agent: "subagent", subagent_id: "child-1" }, progress)).toBe(
      false,
    );
    expect(isLeaderEntryIteration({ agent: "subagent", subagent_id: "entry-1" }, progress)).toBe(
      true,
    );
  });

  it("always attributes an agent:'lead' turn to the entry", () => {
    expect(isLeaderEntryIteration({ agent: "lead" }, freshLeaderProgress())).toBe(true);
  });
});

describe("closeRunningEdges", () => {
  it("closes every running edge without changing an already terminal leader", () => {
    const edges: WorkflowEdge[] = [
      { run_id: "mgr", kind: "manager", title: "root", status: "running" },
      { run_id: "leader-1", parent_run_id: "mgr", kind: "leader", title: "a", status: "running" },
      {
        run_id: "leader-2",
        parent_run_id: "mgr",
        kind: "leader",
        title: "b",
        status: "completed",
        ended_at: 5,
      },
    ];

    closeRunningEdges(edges, "cancelled", 100);

    expect(edges[0]).toMatchObject({ status: "cancelled", ended_at: 100 });
    expect(edges[1]).toMatchObject({ status: "cancelled", ended_at: 100 });
    expect(edges[2]).toMatchObject({ status: "completed", ended_at: 5 });
  });

  it("is a no-op when nothing is still running", () => {
    const edges: WorkflowEdge[] = [
      { run_id: "mgr", kind: "manager", title: "root", status: "completed", ended_at: 1 },
    ];
    closeRunningEdges(edges, "cancelled", 999);
    expect(edges[0]).toMatchObject({ status: "completed", ended_at: 1 });
  });
});

describe("reconcileRunningWorkflowRecord", () => {
  const runningRecord = (): WorkflowRecord => ({
    id: "manager",
    root_run_id: "manager",
    title: "manager",
    workspace: "/ws",
    status: "running",
    created_at: 1,
    updated_at: 10,
    edges: [
      { run_id: "manager", kind: "manager", title: "manager", status: "running" },
      {
        run_id: "done",
        kind: "leader",
        title: "done",
        status: "completed",
        ended_at: 8,
      },
      { run_id: "pending", kind: "leader", title: "pending", status: "running" },
    ],
    output_tokens: 0,
  });

  it("maps terminal root evidence and closes only edges still running", () => {
    for (const [traceStatus, workflowStatus] of [
      ["completed", "completed"],
      ["cancelled", "cancelled"],
      ["interrupted", "failed"],
      ["budget_exhausted", "failed"],
      ["soft_limit_declined", "failed"],
      ["error", "failed"],
    ] as const) {
      const original = runningRecord();
      const repaired = reconcileRunningWorkflowRecord(original, {
        status: traceStatus,
        ended_at: 50,
      });
      expect(repaired).not.toBe(original);
      expect(repaired).toMatchObject({ status: workflowStatus, updated_at: 50 });
      expect(repaired.edges[0]).toMatchObject({ status: workflowStatus, ended_at: 50 });
      expect(repaired.edges[1]).toMatchObject({ status: "completed", ended_at: 8 });
      expect(repaired.edges[2]).toMatchObject({ status: workflowStatus, ended_at: 50 });
      expect(original.status).toBe("running");
      expect(original.edges[0]?.status).toBe("running");
    }
  });

  it("does nothing without terminal evidence or for an already terminal record", () => {
    const running = runningRecord();
    expect(reconcileRunningWorkflowRecord(running, null)).toBe(running);
    const terminal = { ...running, status: "completed" };
    expect(reconcileRunningWorkflowRecord(terminal, { status: "interrupted", ended_at: 50 })).toBe(
      terminal,
    );
  });
});

describe("coalesced workflow persistence", () => {
  it("turns hundreds of event requests into bounded snapshot count and bytes", () => {
    let pending: (() => void) | undefined;
    let scheduled = 0;
    let observedDelay = -1;
    const record: WorkflowRecord = {
      id: "manager",
      root_run_id: "manager",
      title: "manager",
      workspace: "/ws",
      status: "running",
      created_at: 1,
      updated_at: 1,
      edges: [{ run_id: "manager", kind: "manager", title: "manager", status: "running" }],
      output_tokens: 0,
    };
    let saves = 0;
    let savedBytes = 0;
    const queue = createWorkflowSaveQueue({
      save() {
        saves += 1;
        savedBytes += Buffer.byteLength(JSON.stringify(record), "utf8");
      },
      delayMs: Number.POSITIVE_INFINITY,
      runtime: {
        schedule(task, delayMs) {
          scheduled += 1;
          observedDelay = delayMs;
          pending = task;
          return {
            cancel() {
              if (pending === task) pending = undefined;
            },
          };
        },
      },
    });

    for (let index = 0; index < 200; index += 1) {
      record.edges.push({
        run_id: `leader-${String(index)}`,
        kind: "leader",
        title: "leader",
        task: "do work",
        status: "running",
      });
      queue.request();
    }
    expect(scheduled).toBe(1);
    expect(observedDelay).toBe(WORKFLOW_PERSIST_DELAY_MS);
    const firstSave = pending!;
    pending = undefined;
    firstSave();
    expect(saves).toBe(1);

    for (const edge of record.edges) {
      edge.status = "completed";
      queue.request();
    }
    expect(scheduled).toBe(2);
    queue.flush();
    expect(pending).toBeUndefined();
    expect(saves).toBe(2);
    const finalBytes = Buffer.byteLength(JSON.stringify(record), "utf8");
    expect(savedBytes).toBeLessThanOrEqual(finalBytes * 2);
  });

  it("reports a background save failure without letting the timer callback throw", () => {
    const failure = new Error("disk full");
    const observed: unknown[] = [];
    let pending: (() => void) | undefined;
    const queue = createWorkflowSaveQueue({
      save() {
        throw failure;
      },
      runtime: {
        schedule(task) {
          pending = task;
          return { cancel() {} };
        },
      },
      onBackgroundError(error) {
        observed.push(error);
      },
    });

    queue.request();

    expect(() => pending?.()).not.toThrow();
    expect(observed).toEqual([failure]);
  });
});
