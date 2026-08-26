import { describe, it, expect } from "bun:test";
import type { StoredExecution } from "@clarvis/loop";
import type { PlanRef } from "@clarvis/protocol";
import { storedToDetail } from "../../src/runs/map-result.ts";

const validPlanRef: PlanRef = {
  id: "p1",
  provider_key: "markdown",
  path: ".clarvis/plans/p.md",
  final_revision: 3,
  final_spec_revision: 2,
  status: "completed",
  retention: "keep",
};

function baseStoredExecution(capabilityState?: Record<string, unknown>): StoredExecution {
  return {
    id: "exec_1",
    owner_key_name: "owner",
    status: "completed",
    started_at: 0,
    ended_at: 10,
    elapsed_ms: 10,
    request: {
      messages: [],
      servers: [],
      profiles: [],
      entry: "lead",
      budget: { on_exceed: "stop" },
      providers: [],
    },
    response: {
      status: "completed",
      result: null,
      usage: { iterations_used: 1, elapsed_ms: 10, by_agent: [] },
    },
    trace: { events: [] },
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cached_tokens: 0,
    total_cache_write_tokens: 0,
    ...(capabilityState !== undefined ? { capability_state: capabilityState } : {}),
  };
}

describe("storedToDetail — plan_ref sourced from capability_state.plans", () => {
  it("emits the same plan_ref a well-formed plans slot always produced", () => {
    const detail = storedToDetail(baseStoredExecution({ plans: validPlanRef }));
    expect(detail.plan_ref).toEqual(validPlanRef);
  });

  it("omits plan_ref, without throwing, when capability_state is absent", () => {
    const detail = storedToDetail(baseStoredExecution());
    expect(detail.plan_ref).toBeUndefined();
  });

  it("omits plan_ref, without throwing, when the plans slot is not an object", () => {
    const detail = storedToDetail(baseStoredExecution({ plans: "not-a-ref" }));
    expect(detail.plan_ref).toBeUndefined();
  });

  it("omits plan_ref, without throwing, when the plans slot is missing a required field", () => {
    const { final_spec_revision: _omit, ...incomplete } = validPlanRef;
    const detail = storedToDetail(baseStoredExecution({ plans: incomplete }));
    expect(detail.plan_ref).toBeUndefined();
  });
});

describe("storedToDetail — active_task sourced from capability_state.tasks", () => {
  it("projects only stable identity fields from valid task run state", () => {
    const detail = storedToDetail(
      baseStoredExecution({
        tasks: {
          version: 2,
          providerKey: "mcp:jira-work:tasks:abc",
          taskId: "CLAR-42",
          mode: "work",
          lastRevision: "18",
          lastStage: "review",
          claim: { executionId: "exec_1", claimantId: "agent" },
        },
      }),
    );

    expect(detail.active_task).toEqual({
      id: "CLAR-42",
      provider_key: "mcp:jira-work:tasks:abc",
      mode: "work",
    });
  });

  it("omits malformed task state", () => {
    expect(
      storedToDetail(baseStoredExecution({ tasks: { version: 2 } })).active_task,
    ).toBeUndefined();
    expect(
      storedToDetail(
        baseStoredExecution({
          tasks: {
            version: 1,
            providerKey: "mcp:jira-work:tasks:abc",
            taskId: "CLAR-42",
            mode: "work",
            lastStage: "review",
          },
        }),
      ).active_task,
    ).toBeUndefined();
    expect(
      storedToDetail(
        baseStoredExecution({
          tasks: {
            version: 2,
            providerKey: "mcp:jira-work:tasks:abc",
            taskId: "CLAR-42",
            mode: "work",
            lastStage: "review",
            pendingMutations: [{ operation: "comment" }],
          },
        }),
      ).active_task,
    ).toBeUndefined();
  });
});

describe("storedToDetail — workflow contributed trace rehydration", () => {
  it("rehydrates all three persisted workflow edges through their public narrowing", () => {
    const stored = baseStoredExecution();
    stored.trace.events = [
      {
        type: "workflow_run_started",
        run_id: "leader-1",
        parent_run_id: "exec_1",
        started_at: 2,
        task: "inspect",
        profile: "researcher",
        round_id: "inspect",
        pass: 0,
        item_index: 1,
        replica: 0,
        replica_count: 2,
      },
      {
        type: "workflow_run_completed",
        run_id: "leader-1",
        parent_run_id: "exec_1",
        completed_at: 8,
        status: "completed",
      },
      {
        type: "workflow_run_failed",
        run_id: "leader-2",
        parent_run_id: "exec_1",
        completed_at: 9,
        status: "error",
        error: { code: "boom", message: "failed" },
      },
    ];

    expect(storedToDetail(stored).events).toEqual([
      {
        type: "workflow_run_started",
        at: 2,
        run_id: "leader-1",
        parent_run_id: "exec_1",
        profile: "researcher",
        title: "inspect",
        task: "inspect",
        round_id: "inspect",
        pass: 0,
        item_index: 1,
        replica: 0,
        replica_count: 2,
      },
      {
        type: "workflow_run_completed",
        at: 8,
        run_id: "leader-1",
        parent_run_id: "exec_1",
        status: "completed",
      },
      {
        type: "workflow_run_failed",
        at: 9,
        run_id: "leader-2",
        parent_run_id: "exec_1",
        status: "failed",
        error: { code: "boom", message: "failed" },
      },
    ]);
  });
});

describe("storedToDetail — the recovery counts of a partially recovered run", () => {
  it("forwards the stored counts to the client verbatim", () => {
    const stored: StoredExecution = {
      ...baseStoredExecution(),
      recovery: { skipped_lines: 3, synthesized_tool_calls: 1 },
    };
    expect(storedToDetail(stored).recovery).toEqual({
      skipped_lines: 3,
      synthesized_tool_calls: 1,
    });
  });

  it("omits the field entirely for an intact record", () => {
    const detail = storedToDetail(baseStoredExecution());
    expect(detail.recovery).toBeUndefined();
    expect(Object.hasOwn(detail, "recovery")).toBe(false);
  });
});
