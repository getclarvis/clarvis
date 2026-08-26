import { describe, it, expect } from "bun:test";
import { deriveEventSpan, iterationSpanId } from "@clarvis/trace";
import type { TraceEvent } from "@clarvis/capability";

const iter = {
  started_at: 0,
  ended_at: 1,
  model: "m",
  input_tokens: 1,
  output_tokens: 1,
  cached_tokens: 0,
  cache_write_tokens: 0,
  cache_read_ratio: 0,
  response: "r",
};

describe("iterationSpanId", () => {
  it("scopes subagent iterations by instance id and everything else to the lead", () => {
    expect(iterationSpanId("subagent", "w1", 3)).toBe("w1:3");
    expect(iterationSpanId("subagent", undefined, 3)).toBe("lead:3");
    expect(iterationSpanId("lead", undefined, 2)).toBe("lead:2");
    expect(iterationSpanId(undefined, "w1", 2)).toBe("lead:2");
  });
});

describe("deriveEventSpan", () => {
  it("maps the run lifecycle to the run span", () => {
    expect(deriveEventSpan({ type: "run_started", occurred_at: 0, mode: "subagent-only" })).toEqual(
      {
        span_id: "run",
        phase: "start",
        kind: "run",
      },
    );
    expect(deriveEventSpan({ type: "run_ended", occurred_at: 0, reason: "completed" })).toEqual({
      span_id: "run",
      phase: "end",
      kind: "run",
    });
  });

  it("maps lead and subagent iterations to iteration spans", () => {
    expect(
      deriveEventSpan({ type: "lead_iteration_started", iteration: 2, started_at: 0, model: "m" }),
    ).toEqual({ span_id: "lead:2", phase: "start", kind: "iteration" });
    expect(deriveEventSpan({ type: "lead_iteration", iteration: 2, ...iter })).toEqual({
      span_id: "lead:2",
      phase: "end",
      kind: "iteration",
    });
    expect(
      deriveEventSpan({
        type: "subagent_iteration_started",
        subagent_instance_id: "w1",
        iteration: 1,
        started_at: 0,
        model: "m",
      }),
    ).toEqual({ span_id: "w1:1", phase: "start", kind: "iteration" });
    expect(
      deriveEventSpan({
        type: "subagent_iteration",
        subagent_instance_id: "w1",
        iteration: 1,
        ...iter,
      }),
    ).toEqual({ span_id: "w1:1", phase: "end", kind: "iteration" });
  });

  it("maps the subagent lifecycle to the subagent span", () => {
    expect(
      deriveEventSpan({
        type: "delegation_created",
        delegation_id: "w1",
        spawned_at: 0,
        title: "t",
        task: "x",
        tools: [],
      }),
    ).toEqual({ span_id: "delegation:w1", phase: "start", kind: "subagent" });
    expect(
      deriveEventSpan({
        type: "delegation_started",
        delegation_id: "w1",
        occurred_at: 0,
        model: "m",
      }),
    ).toEqual({ span_id: "delegation:w1", phase: "point", kind: "subagent" });
    expect(
      deriveEventSpan({
        type: "delegation_completed",
        delegation_id: "w1",
        completed_at: 0,
        status: "completed",
        result: "r",
      }),
    ).toEqual({ span_id: "delegation:w1", phase: "end", kind: "subagent" });
  });

  it("maps tool calls by call id, with an iteration fallback for legacy tool_call rows", () => {
    expect(
      deriveEventSpan({
        type: "tool_call_started",
        agent: "lead",
        call_id: "c1",
        iteration_ref: 1,
        started_at: 0,
        mcp_name: "fs",
        tool_name: "read",
        arguments: {},
      }),
    ).toEqual({ span_id: "c1", phase: "start", kind: "tool" });
    expect(
      deriveEventSpan({
        type: "tool_call",
        agent: "lead",
        iteration_ref: 4,
        started_at: 0,
        ended_at: 1,
        mcp_name: "fs",
        tool_name: "read",
        arguments: {},
        result: "r",
        error: null,
      }),
    ).toEqual({ span_id: "lead:4:tool", phase: "end", kind: "tool" });
    expect(
      deriveEventSpan({
        type: "tool_output_delta",
        agent: "lead",
        call_id: "c1",
        occurred_at: 2,
        chunk: "building...\n",
      }),
    ).toEqual({ span_id: "c1", phase: "point", kind: "tool" });
    // Composing a call is a point on the same tool span, under the same id the
    // eventual tool_call_started uses -- which is what lets a client reconcile
    // the two instead of drawing the call twice.
    expect(
      deriveEventSpan({
        type: "tool_input_delta",
        agent: "lead",
        call_id: "c1",
        occurred_at: 1,
        tool_name: "write_file",
        chars: 128,
      }),
    ).toEqual({ span_id: "c1", phase: "point", kind: "tool" });
  });

  it("canonical drift case: a subagent-scoped compaction/cancellation is a subagent-span point", () => {
    expect(
      deriveEventSpan({
        type: "compaction",
        agent: "subagent",
        subagent_instance_id: "w1",
        operation: "eviction",
        occurred_at: 0,
      }),
    ).toEqual({ span_id: "subagent:w1", phase: "point", kind: "subagent" });
    expect(
      deriveEventSpan({
        type: "compaction_skipped",
        agent: "subagent",
        subagent_instance_id: "w1",
        reason: "nothing_to_compact",
        occurred_at: 0,
      }),
    ).toEqual({ span_id: "subagent:w1", phase: "point", kind: "subagent" });
    expect(
      deriveEventSpan({
        type: "vision_analysis",
        model: "anthropic/vision",
        image_count: 1,
        status: "completed",
        result: "a cat",
        occurred_at: 0,
      }),
    ).toEqual({ span_id: "run", phase: "point", kind: "event" });
    expect(
      deriveEventSpan({
        type: "cancellation",
        agent: "subagent",
        subagent_instance_id: "w1",
        occurred_at: 0,
      }),
    ).toEqual({ span_id: "subagent:w1", phase: "point", kind: "subagent" });
  });

  it("an unscoped compaction/cancellation is a run-span point event", () => {
    expect(
      deriveEventSpan({ type: "compaction", agent: "lead", operation: "eviction", occurred_at: 0 }),
    ).toEqual({ span_id: "run", phase: "point", kind: "event" });
    expect(deriveEventSpan({ type: "cancellation", agent: "lead", occurred_at: 0 })).toEqual({
      span_id: "run",
      phase: "point",
      kind: "event",
    });
  });

  it("maps iteration-anchored point events onto their iteration span", () => {
    expect(
      deriveEventSpan({
        type: "model_call_error",
        agent: "subagent",
        subagent_instance_id: "w1",
        iteration: 5,
        occurred_at: 0,
        model: "m",
        kind: "transient",
        message: "x",
      }),
    ).toEqual({ span_id: "w1:5", phase: "point", kind: "iteration" });
    expect(
      deriveEventSpan({
        type: "user_steering",
        agent: "lead",
        iteration_ref: 3,
        occurred_at: 0,
        message: "go",
      }),
    ).toEqual({ span_id: "lead:3", phase: "point", kind: "iteration" });
  });

  it("anchors a streaming delta on the same iteration span as its final iteration event", () => {
    expect(
      deriveEventSpan({
        type: "model_stream_delta",
        agent: "subagent",
        subagent_instance_id: "w1",
        iteration: 5,
        occurred_at: 0,
        model: "m",
        channel: "text",
        text: "hel",
        reset: true,
      }),
    ).toEqual({ span_id: "w1:5", phase: "point", kind: "iteration" });
    expect(
      deriveEventSpan({
        type: "model_stream_delta",
        agent: "lead",
        iteration: 3,
        occurred_at: 0,
        model: "m",
        channel: "reasoning",
        text: "why",
        reset: false,
      }),
    ).toEqual({ span_id: "lead:3", phase: "point", kind: "iteration" });
  });

  it("maps run-level point events, and any capability-contributed kind, to the run span as kind event", () => {
    const events: TraceEvent[] = [
      { type: "budget_check", checked_at: 0, tokens_used: 1 },
      { type: "some_capability_event", occurred_at: 0, detail: { anything: "goes" } },
      {
        type: "soft_limit_check",
        agent: "lead",
        occurred_at: 0,
        dimension: "tokens",
        used: 1,
        limit: 2,
        outcome: "continued",
        escalations: 0,
      },
      {
        type: "plan_review",
        occurred_at: 0,
        detail: { outcome: "presented", revision_index: 0 },
      },
      {
        type: "task_nudge",
        occurred_at: 0,
        detail: {
          outcome: "nudged",
          pending_task_ids: [],
          nudge_index: 1,
          progressed: false,
        },
      },
      {
        type: "elicitation_requested",
        occurred_at: 0,
        source: "ask_user",
        question: "?",
      },
    ];
    for (const e of events) {
      expect(deriveEventSpan(e)).toEqual({ span_id: "run", phase: "point", kind: "event" });
    }
  });
});
