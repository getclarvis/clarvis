import { describe, it, expect } from "bun:test";
import type { RunEvent } from "@clarvis/protocol";
import { deriveRunEventSpan } from "../../src/runs/run-event-span.ts";

describe("deriveRunEventSpan (RunEvent → span)", () => {
  it("scopes run start/end to the run span", () => {
    expect(deriveRunEventSpan({ type: "run_started", at: 0 })).toEqual({
      span_id: "run",
      phase: "start",
      kind: "run",
    });
    expect(deriveRunEventSpan({ type: "run_ended", at: 1, status: "completed" })).toEqual({
      span_id: "run",
      phase: "end",
      kind: "run",
    });
  });

  it("groups model output under its iteration span (lead vs subagent)", () => {
    const lead: RunEvent = { type: "reasoning", at: 1, agent: "lead", iteration: 2, text: "x" };
    expect(deriveRunEventSpan(lead)).toEqual({
      span_id: "lead:2",
      phase: "point",
      kind: "iteration",
    });

    const subStart: RunEvent = {
      type: "iteration_started",
      at: 1,
      agent: "subagent",
      subagent_id: "s1",
      iteration: 3,
    };
    expect(deriveRunEventSpan(subStart)).toEqual({
      span_id: "s1:3",
      phase: "start",
      kind: "iteration",
    });
  });

  it("isolates a sub-agent event that lost its id instead of claiming the lead's span", () => {
    const orphan: RunEvent = {
      type: "text_delta",
      at: 1,
      agent: "subagent",
      iteration: 4,
      channel: "text",
      text: "hi",
      reset: false,
    };
    const span = deriveRunEventSpan(orphan);
    expect(span.span_id).not.toBe("lead:4");
    expect(span).toEqual({ span_id: "subagent-unknown:4", phase: "point", kind: "iteration" });

    expect(deriveRunEventSpan({ ...orphan, subagent_id: "s2" })).toMatchObject({
      span_id: "s2:4",
    });
  });

  it("pairs tool start/end by call_id", () => {
    expect(
      deriveRunEventSpan({
        type: "tool_call_started",
        at: 1,
        agent: "lead",
        call_id: "c1",
        tool: "read",
        server: "fs",
      }),
    ).toEqual({ span_id: "c1", phase: "start", kind: "tool" });
    expect(
      deriveRunEventSpan({
        type: "tool_call",
        at: 2,
        agent: "lead",
        call_id: "c1",
        tool: "read",
        server: "fs",
        ok: true,
      }),
    ).toEqual({ span_id: "c1", phase: "end", kind: "tool" });
  });

  it("routes sub-agent lifecycle to its subagent span", () => {
    expect(
      deriveRunEventSpan({
        type: "delegation_created",
        at: 1,
        delegation_id: "s1",
        title: "t",
        task: "k",
      }),
    ).toEqual({
      span_id: "subagent:s1",
      phase: "start",
      kind: "subagent",
    });
  });

  it("routes run-level annotations to the event kind (so the activity store folds them)", () => {
    expect(
      deriveRunEventSpan({
        type: "soft_limit_check",
        at: 1,
        dimension: "tokens",
        used: 9,
        limit: 10,
        outcome: "continued",
      }),
    ).toMatchObject({ kind: "event", phase: "point" });
  });

  it("closes an iteration span on iteration_completed for both lead and subagent", () => {
    expect(
      deriveRunEventSpan({
        type: "iteration_completed",
        at: 1,
        agent: "lead",
        iteration: 5,
        model: "m",
        response: "r",
        input_tokens: 1,
        output_tokens: 1,
      }),
    ).toEqual({ span_id: "lead:5", phase: "end", kind: "iteration" });

    expect(
      deriveRunEventSpan({
        type: "iteration_completed",
        at: 1,
        agent: "subagent",
        subagent_id: "s9",
        iteration: 5,
        model: "m",
        response: "r",
        input_tokens: 1,
        output_tokens: 1,
      }),
    ).toEqual({ span_id: "s9:5", phase: "end", kind: "iteration" });
  });

  it("scopes delegation_started and delegation completion (both statuses) to the subagent span", () => {
    expect(
      deriveRunEventSpan({
        type: "delegation_started",
        at: 1,
        delegation_id: "d1",
        model: "m",
      }),
    ).toEqual({ span_id: "subagent:d1", phase: "point", kind: "subagent" });

    expect(
      deriveRunEventSpan({
        type: "delegation_completed",
        at: 1,
        delegation_id: "d1",
        status: "completed",
      }),
    ).toEqual({ span_id: "subagent:d1", phase: "end", kind: "subagent" });

    expect(
      deriveRunEventSpan({
        type: "delegation_failed",
        at: 1,
        delegation_id: "d2",
        status: "error",
      }),
    ).toEqual({ span_id: "subagent:d2", phase: "end", kind: "subagent" });
  });

  it("scopes workflow run lifecycle events to a workflow span (start, point, end x2)", () => {
    expect(
      deriveRunEventSpan({
        type: "workflow_run_started",
        at: 1,
        run_id: "w1",
        parent_run_id: "p1",
        title: "Do task",
        task: "t",
      }),
    ).toEqual({ span_id: "workflow:w1", phase: "start", kind: "subagent" });

    expect(
      deriveRunEventSpan({
        type: "workflow_title_updated",
        at: 1,
        run_id: "p1",
        title: "Do task",
      }),
    ).toEqual({ span_id: "workflow:p1", phase: "point", kind: "event" });

    expect(
      deriveRunEventSpan({
        type: "workflow_sequence_state",
        at: 1,
        run_id: "p1",
        session_id: "wfseq-1",
        status: "awaiting_manager",
        revision: 1,
        next_round_id: "verify",
        next_pass: 0,
        leaders_started: 1,
        max_total_leaders: 32,
      }),
    ).toEqual({ span_id: "workflow:p1", phase: "point", kind: "event" });

    expect(
      deriveRunEventSpan({
        type: "workflow_run_progress",
        at: 1,
        run_id: "w1",
        parent_run_id: "p1",
        iterations: 3,
        input_tokens: 10,
        output_tokens: 5,
      }),
    ).toEqual({ span_id: "workflow:w1", phase: "point", kind: "subagent" });

    expect(
      deriveRunEventSpan({
        type: "workflow_run_completed",
        at: 1,
        run_id: "w1",
        parent_run_id: "p1",
        status: "completed",
      }),
    ).toEqual({ span_id: "workflow:w1", phase: "end", kind: "subagent" });

    expect(
      deriveRunEventSpan({
        type: "workflow_run_failed",
        at: 1,
        run_id: "w2",
        parent_run_id: "p1",
        status: "failed",
      }),
    ).toEqual({ span_id: "workflow:w2", phase: "end", kind: "subagent" });
  });

  it("marks tool_output_delta as a point on the tool span, keyed by call_id", () => {
    expect(
      deriveRunEventSpan({
        type: "tool_output_delta",
        at: 1,
        agent: "lead",
        call_id: "c1",
        chunk: "...",
      }),
    ).toEqual({ span_id: "c1", phase: "point", kind: "tool" });
  });

  it("attributes steering_applied to the subagent span when present, else to run", () => {
    expect(
      deriveRunEventSpan({
        type: "steering_applied",
        at: 1,
        agent: "subagent",
        subagent_id: "s3",
        message: "hurry up",
      }),
    ).toEqual({ span_id: "subagent:s3", phase: "point", kind: "iteration" });

    expect(
      deriveRunEventSpan({
        type: "steering_applied",
        at: 1,
        agent: "lead",
        message: "hurry up",
      }),
    ).toEqual({ span_id: "run", phase: "point", kind: "iteration" });
  });

  it("scopes compaction to the subagent span when present, else to a run-level event", () => {
    expect(
      deriveRunEventSpan({
        type: "compaction_started",
        at: 1,
        agent: "lead",
        mode: "scheduled",
      }),
    ).toEqual({ span_id: "run", phase: "point", kind: "event" });

    expect(
      deriveRunEventSpan({
        type: "compaction",
        at: 1,
        agent: "subagent",
        subagent_id: "s4",
        operation: "eviction",
      }),
    ).toEqual({ span_id: "subagent:s4", phase: "point", kind: "subagent" });

    expect(
      deriveRunEventSpan({
        type: "compaction",
        at: 1,
        agent: "lead",
        operation: "eviction",
      }),
    ).toEqual({ span_id: "run", phase: "point", kind: "event" });

    expect(
      deriveRunEventSpan({
        type: "compaction_skipped",
        at: 1,
        agent: "subagent",
        subagent_id: "s4",
        reason: "nothing_to_compact",
      }),
    ).toEqual({ span_id: "subagent:s4", phase: "point", kind: "subagent" });
  });

  it("routes elicitation_requested (a standalone notice) to a run-level point", () => {
    expect(
      deriveRunEventSpan({
        type: "elicitation_requested",
        at: 1,
        question: "Proceed?",
      }),
    ).toEqual({ span_id: "run", phase: "point", kind: "event" });
  });

  it("falls through the exhaustiveness guard unchanged for an unrecognized type (compile-time-only guard)", () => {
    const bogus = { type: "not_a_real_event" } as unknown as RunEvent;
    expect(deriveRunEventSpan(bogus)).toBe(
      bogus as unknown as ReturnType<typeof deriveRunEventSpan>,
    );
  });
});
