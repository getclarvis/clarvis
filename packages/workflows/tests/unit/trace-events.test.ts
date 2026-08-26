import { describe, expect, it } from "bun:test";
import type { TraceEntry, TraceEvent } from "@clarvis/capability";
import { createWorkflowsCapability } from "../../src/capability.ts";
import {
  isWorkflowPersistedTraceEvent,
  WORKFLOW_PERSISTED_TRACE_PROJECTORS,
  WORKFLOW_RUN_COMPLETED_TRACE_KIND,
  WORKFLOW_RUN_FAILED_TRACE_KIND,
  WORKFLOW_RUN_STARTED_TRACE_KIND,
  type WorkflowPersistedTraceEvent,
} from "../../src/trace-events.ts";
import { makeCtx } from "../helpers/workflow.ts";

const ANCHOR = 1_700_000_000_000;

function project(entry: TraceEntry): WorkflowPersistedTraceEvent {
  const projector = WORKFLOW_PERSISTED_TRACE_PROJECTORS.find(
    (candidate) => candidate.kind === entry.kind,
  );
  if (projector === undefined) throw new Error(`missing projector for ${entry.kind}`);
  const event = projector.project(entry, {
    absoluteTime: (offset) => ANCHOR + Math.round(offset),
  });
  if (event === null || !isWorkflowPersistedTraceEvent(event)) {
    throw new Error(`projector for ${entry.kind} returned an invalid event`);
  }
  return event;
}

describe("workflow-owned persisted trace projections", () => {
  it("registers the canonical projectors on the workflows capability", () => {
    expect(createWorkflowsCapability(makeCtx()).persistedTraceProjectors).toBe(
      WORKFLOW_PERSISTED_TRACE_PROJECTORS,
    );
  });

  it("preserves the chosen JSON bytes for all three workflow edges", () => {
    const events = [
      project({
        at: 2,
        kind: WORKFLOW_RUN_STARTED_TRACE_KIND,
        detail: {
          run_id: "leader-1",
          parent_run_id: "manager",
          title: "Inspect parser",
          task: "inspect",
          profile: "researcher",
        },
      }),
      project({
        at: 9,
        kind: WORKFLOW_RUN_COMPLETED_TRACE_KIND,
        detail: { run_id: "leader-1", parent_run_id: "manager", status: "completed" },
      }),
      project({
        at: 12,
        kind: WORKFLOW_RUN_FAILED_TRACE_KIND,
        detail: {
          run_id: "leader-2",
          parent_run_id: "manager",
          status: "error",
          error: { code: "boom", message: "kaboom" },
        },
      }),
    ];

    expect(JSON.stringify({ events })).toBe(
      '{"events":[{"type":"workflow_run_started","run_id":"leader-1","parent_run_id":"manager","started_at":1700000000002,"title":"Inspect parser","task":"inspect","profile":"researcher"},{"type":"workflow_run_completed","run_id":"leader-1","parent_run_id":"manager","completed_at":1700000000009,"status":"completed"},{"type":"workflow_run_failed","run_id":"leader-2","parent_run_id":"manager","completed_at":1700000000012,"status":"error","error":{"code":"boom","message":"kaboom"}}]}',
    );
  });

  it("rejects invalid opaque detail instead of persisting a malformed typed edge", () => {
    for (const kind of [
      WORKFLOW_RUN_STARTED_TRACE_KIND,
      WORKFLOW_RUN_COMPLETED_TRACE_KIND,
      WORKFLOW_RUN_FAILED_TRACE_KIND,
    ]) {
      const projector = WORKFLOW_PERSISTED_TRACE_PROJECTORS.find(
        (candidate) => candidate.kind === kind,
      );
      expect(() =>
        projector?.project(
          { at: 1, kind, detail: { run_id: 42 } },
          { absoluteTime: (offset) => ANCHOR + offset },
        ),
      ).toThrow(`invalid ${kind} trace detail`);
    }
  });

  it("persists round context on started edges without requiring it from legacy edges", () => {
    expect(
      project({
        at: 3,
        kind: WORKFLOW_RUN_STARTED_TRACE_KIND,
        detail: {
          run_id: "leader-3",
          parent_run_id: "manager",
          title: "Verify finding",
          task: "verify",
          round_id: "verify",
          pass: 1,
          item_index: 2,
          replica: 1,
          replica_count: 3,
        },
      }),
    ).toEqual({
      type: "workflow_run_started",
      run_id: "leader-3",
      parent_run_id: "manager",
      started_at: ANCHOR + 3,
      title: "Verify finding",
      task: "verify",
      round_id: "verify",
      pass: 1,
      item_index: 2,
      replica: 1,
      replica_count: 3,
    });
  });

  it("narrows only structurally valid persisted workflow events", () => {
    const valid: TraceEvent = {
      type: WORKFLOW_RUN_FAILED_TRACE_KIND,
      run_id: "leader",
      parent_run_id: "manager",
      completed_at: ANCHOR,
      status: "error",
      error: { code: "boom", message: "failed" },
    };
    const malformed: TraceEvent = {
      type: WORKFLOW_RUN_FAILED_TRACE_KIND,
      run_id: "leader",
      parent_run_id: "manager",
      completed_at: "yesterday",
      status: "error",
    };
    const foreign: TraceEvent = {
      type: "plugin_owned_event",
    };

    expect(isWorkflowPersistedTraceEvent(valid)).toBe(true);
    expect(isWorkflowPersistedTraceEvent(malformed)).toBe(false);
    expect(isWorkflowPersistedTraceEvent(foreign)).toBe(false);
  });
});
