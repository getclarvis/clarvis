import { describe, it, expect } from "bun:test";
import { RUN_EVENT_POLICY } from "@clarvis/kernel/policy";
import type { RunEvent } from "@clarvis/protocol";
import {
  meetsThreshold,
  mergeEvents,
  mergeKeyOf,
  viewOf,
  type EventView,
} from "../../src/mcp/event-view.ts";

const AT = 1_800_000_000_000;

describe("meetsThreshold", () => {
  it("passes an event whose level is at or above the threshold", () => {
    expect(meetsThreshold("info", "info")).toBe(true);
    expect(meetsThreshold("warning", "info")).toBe(true);
  });

  it("blocks an event whose level is below the threshold", () => {
    expect(meetsThreshold("debug", "info")).toBe(false);
  });

  it("defaults an unknown threshold string to the info floor", () => {
    expect(meetsThreshold("info", "not-a-level")).toBe(true);
    expect(meetsThreshold("debug", "not-a-level")).toBe(false);
  });

  it("clamps a threshold above error (critical/alert/emergency) to the error floor", () => {
    expect(meetsThreshold("error", "critical")).toBe(true);
    expect(meetsThreshold("error", "emergency")).toBe(true);
    expect(meetsThreshold("warning", "emergency")).toBe(false);
  });

  it("passes the lowest level when the threshold is debug", () => {
    expect(meetsThreshold("debug", "debug")).toBe(true);
  });
});

describe("viewOf", () => {
  const cases: Array<[RunEvent, EventView]> = [
    [
      { type: "run_started", at: AT },
      { level: "info", logger: "clarvis.run", label: "run started" },
    ],
    [
      { type: "run_ended", at: AT, status: "completed" },
      { level: "info", logger: "clarvis.run", label: "run completed" },
    ],
    [
      { type: "iteration_started", at: AT, agent: "lead", iteration: 3 },
      { level: "debug", logger: "clarvis.iteration", label: "iteration 3" },
    ],
    [
      {
        type: "iteration_completed",
        at: AT,
        agent: "lead",
        iteration: 3,
        response: "hi",
        input_tokens: 1,
        output_tokens: 1,
      },
      { level: "debug", logger: "clarvis.iteration", label: "iteration 3 done" },
    ],
    [
      {
        type: "tool_call_started",
        at: AT,
        agent: "lead",
        call_id: "c1",
        tool: "read",
        server: "tools",
      },
      { level: "info", logger: "clarvis.tool", label: "tools.read" },
    ],
    [
      {
        type: "tool_call",
        at: AT,
        agent: "lead",
        tool: "read",
        server: "tools",
        ok: true,
      },
      { level: "info", logger: "clarvis.tool", label: "tools.read ok" },
    ],
    [
      {
        type: "tool_call",
        at: AT,
        agent: "lead",
        tool: "read",
        server: "tools",
        ok: false,
      },
      { level: "warning", logger: "clarvis.tool", label: "tools.read failed" },
    ],
    [
      { type: "tool_output_delta", at: AT, agent: "lead", call_id: "c1", chunk: "x" },
      { level: "debug", logger: "clarvis.tool", label: "tool output" },
    ],
    [
      {
        type: "tool_input_delta",
        at: AT,
        agent: "lead",
        call_id: "c1",
        tool: "write_file",
        chars: 42,
      },
      { level: "debug", logger: "clarvis.tool", label: "composing write_file" },
    ],
    [
      {
        type: "text_delta",
        at: AT,
        agent: "lead",
        iteration: 1,
        channel: "text",
        text: "hi",
        reset: false,
      },
      { level: "debug", logger: "clarvis.text", label: "generating" },
    ],
    [
      { type: "reasoning", at: AT, agent: "lead", iteration: 1, text: "thinking" },
      { level: "debug", logger: "clarvis.text", label: "reasoning" },
    ],
    [
      {
        type: "model_error",
        at: AT,
        agent: "lead",
        iteration: 1,
        kind: "rate_limit",
        message: "slow down",
      },
      { level: "warning", logger: "clarvis.model", label: "model error: rate_limit" },
    ],
    [
      {
        type: "model_retry",
        at: AT,
        agent: "lead",
        iteration: 2,
        kind: "rate_limit",
        attempt: 2,
        max_retries: 3,
        delay_ms: 2_600,
      },
      { level: "info", logger: "clarvis.model", label: "retrying in 3s (2/3)" },
    ],
    [
      {
        type: "delegation_created",
        at: AT,
        delegation_id: "d1",
        title: "sub task",
        task: "do it",
      },
      { level: "info", logger: "clarvis.delegation", label: "sub-agent started" },
    ],
    [
      { type: "delegation_started", at: AT, delegation_id: "d1" },
      { level: "info", logger: "clarvis.delegation", label: "sub-agent started" },
    ],
    [
      { type: "delegation_completed", at: AT, delegation_id: "d1", status: "done" },
      { level: "info", logger: "clarvis.delegation", label: "sub-agent done" },
    ],
    [
      { type: "delegation_failed", at: AT, delegation_id: "d1", status: "failed" },
      { level: "info", logger: "clarvis.delegation", label: "sub-agent failed" },
    ],
    [
      {
        type: "workflow_run_started",
        at: AT,
        run_id: "r1",
        parent_run_id: "p1",
        title: "Lead team",
        task: "lead a team",
      },
      { level: "info", logger: "clarvis.workflow", label: "leader started" },
    ],
    [
      {
        type: "workflow_title_updated",
        at: AT,
        run_id: "p1",
        title: "Audit authentication",
      },
      { level: "debug", logger: "clarvis.workflow", label: "workflow titled" },
    ],
    [
      {
        type: "workflow_sequence_state",
        at: AT,
        run_id: "p1",
        session_id: "wfseq-1",
        status: "awaiting_manager",
        revision: 1,
        round_id: "first",
        pass: 0,
        next_round_id: "second",
        next_pass: 0,
        leaders_started: 1,
        max_total_leaders: 32,
      },
      { level: "notice", logger: "clarvis.workflow", label: "workflow awaiting Admiral" },
    ],
    [
      {
        type: "workflow_run_completed",
        at: AT,
        run_id: "r1",
        parent_run_id: "p1",
        status: "completed",
      },
      { level: "info", logger: "clarvis.workflow", label: "leader completed" },
    ],
    [
      {
        type: "workflow_run_failed",
        at: AT,
        run_id: "r1",
        parent_run_id: "p1",
        status: "failed",
      },
      { level: "info", logger: "clarvis.workflow", label: "leader failed" },
    ],
    [
      {
        type: "workflow_run_progress",
        at: AT,
        run_id: "r1",
        parent_run_id: "p1",
        iterations: 2,
        input_tokens: 10,
        output_tokens: 5,
      },
      { level: "debug", logger: "clarvis.workflow", label: "leader progress" },
    ],
    [
      {
        type: "plan_created",
        at: AT,
        id: "pl1",
        title: "My Plan",
        status: "awaiting_approval",
        retention: "keep",
        revision: 1,
        spec_revision: 1,
        tasks: [],
      },
      { level: "info", logger: "clarvis.plan", label: "plan: My Plan" },
    ],
    [
      {
        type: "plan_updated",
        at: AT,
        change: "content",
        id: "pl1",
        title: "My Plan",
        status: "awaiting_approval",
        retention: "keep",
        revision: 2,
        spec_revision: 2,
        tasks: [],
      },
      { level: "info", logger: "clarvis.plan", label: "plan updated" },
    ],
    [
      { type: "plan_removed", at: AT, id: "pl1", revision: 3, spec_revision: 2 },
      { level: "info", logger: "clarvis.plan", label: "plan removed" },
    ],
    [
      {
        type: "plan_review_requested",
        at: AT,
        id: "pl1",
        title: "My Plan",
        status: "awaiting_approval",
        retention: "keep",
        revision: 1,
        spec_revision: 1,
        tasks: [],
      },
      { level: "notice", logger: "clarvis.plan", label: "plan awaiting review" },
    ],
    [
      {
        type: "plan_review_resolved",
        at: AT,
        outcome: "approved",
        id: "pl1",
        title: "My Plan",
        status: "awaiting_approval",
        retention: "keep",
        revision: 2,
        spec_revision: 1,
        tasks: [],
      },
      { level: "info", logger: "clarvis.plan", label: "plan approved" },
    ],
    [
      { type: "elicitation_requested", at: AT, question: "ok?" },
      { level: "notice", logger: "clarvis.elicit", label: "question asked" },
    ],
    [
      { type: "elicitation_resolved", at: AT, question: "ok?", outcome: "accept" },
      { level: "info", logger: "clarvis.elicit", label: "question accept" },
    ],
    [
      {
        type: "soft_limit_check",
        at: AT,
        dimension: "tokens",
        used: 100,
        limit: 200,
        outcome: "ok",
      },
      { level: "notice", logger: "clarvis.budget", label: "tokens limit" },
    ],
    [
      { type: "compaction_started", at: AT, agent: "lead", mode: "scheduled" },
      { level: "info", logger: "clarvis.context", label: "context compaction started" },
    ],
    [
      { type: "compaction", at: AT, agent: "lead", operation: "trim" },
      { level: "debug", logger: "clarvis.context", label: "context compacted" },
    ],
    [
      {
        type: "compaction_skipped",
        at: AT,
        agent: "lead",
        reason: "summarization_failed",
      },
      {
        level: "warning",
        logger: "clarvis.context",
        label: "context compaction skipped: summarization_failed",
      },
    ],
    [
      {
        type: "vision_analysis",
        at: AT,
        model: "anthropic/vision",
        image_count: 2,
        status: "completed",
        result: "two cats",
      },
      { level: "info", logger: "clarvis.vision", label: "read 2 image(s)" },
    ],
    [
      {
        type: "vision_analysis",
        at: AT,
        model: "anthropic/vision",
        image_count: 1,
        status: "failed",
        result: "boom",
      },
      { level: "warning", logger: "clarvis.vision", label: "image reading failed" },
    ],
    [
      { type: "steering_applied", at: AT, agent: "lead", message: "focus on x" },
      { level: "info", logger: "clarvis.run", label: "steering applied" },
    ],
    [
      { type: "memory_ingest", at: AT, detail: { execution_id: "e1", phase: "done" } },
      { level: "debug", logger: "clarvis.memory", label: "memory indexed" },
    ],
    [
      {
        type: "capability_event",
        at: AT,
        capability: "audit",
        kind: "finding",
        projection: "finding.recorded",
        truncated: false,
      },
      {
        level: "debug",
        logger: "clarvis.capability.audit",
        label: "finding.recorded",
      },
    ],
    [
      { type: "events_dropped", at: AT, dropped: 4 },
      { level: "warning", logger: "clarvis.stream", label: "events dropped" },
    ],
    [
      { type: "mcp_degraded", at: AT, servers: [{ name: "foo", reason: "timeout" }] },
      { level: "warning", logger: "clarvis.mcp", label: "mcp server degraded" },
    ],
  ];

  for (const [event, expected] of cases) {
    it(`projects ${event.type}`, () => {
      expect(viewOf(event)).toEqual(expected);
    });
  }
});

describe("mergeKeyOf", () => {
  it("keys a non-reset text_delta by agent/subagent/iteration/channel", () => {
    const event: RunEvent = {
      type: "text_delta",
      at: AT,
      agent: "lead",
      iteration: 1,
      channel: "text",
      text: "hi",
      reset: false,
    };
    expect(mergeKeyOf(event)).toBe("t:lead::1:text");
  });

  it("includes subagent_id in the text_delta key when present", () => {
    const event: RunEvent = {
      type: "text_delta",
      at: AT,
      agent: "subagent",
      subagent_id: "sub-1",
      iteration: 2,
      channel: "reasoning",
      text: "hi",
      reset: false,
    };
    expect(mergeKeyOf(event)).toBe("t:subagent:sub-1:2:reasoning");
  });

  it("returns undefined for a reset text_delta so it never merges into the tail", () => {
    const event: RunEvent = {
      type: "text_delta",
      at: AT,
      agent: "lead",
      iteration: 1,
      channel: "text",
      text: "hi",
      reset: true,
    };
    expect(mergeKeyOf(event)).toBeUndefined();
  });

  it("keys a tool_output_delta by agent/subagent/call_id", () => {
    const event: RunEvent = {
      type: "tool_output_delta",
      at: AT,
      agent: "lead",
      call_id: "call-1",
      chunk: "x",
    };
    expect(mergeKeyOf(event)).toBe("o:lead::call-1");
  });

  it("keys a tool_input_delta by agent/subagent/call_id", () => {
    const event: RunEvent = {
      type: "tool_input_delta",
      at: AT,
      agent: "subagent",
      subagent_id: "sub-1",
      call_id: "call-1",
      tool: "write_file",
      chars: 42,
    };
    expect(mergeKeyOf(event)).toBe("i:subagent:sub-1:call-1");
  });

  it("returns undefined for event types that never merge", () => {
    const event: RunEvent = { type: "run_started", at: AT };
    expect(mergeKeyOf(event)).toBeUndefined();
  });

  it("gates on kernel's RUN_EVENT_POLICY: every non-coalescing type returns undefined", () => {
    for (const type of Object.keys(RUN_EVENT_POLICY) as (keyof typeof RUN_EVENT_POLICY)[]) {
      if (RUN_EVENT_POLICY[type].coalesce !== false) continue;
      const event = { type } as unknown as RunEvent;
      expect(mergeKeyOf(event)).toBeUndefined();
    }
  });
});

describe("mergeEvents", () => {
  it("concatenates text across two text_delta events, keeping prev's at/reset", () => {
    const prev: RunEvent = {
      type: "text_delta",
      at: 0,
      agent: "lead",
      iteration: 1,
      channel: "text",
      text: "hel",
      reset: true,
    };
    const next: RunEvent = {
      type: "text_delta",
      at: 1,
      agent: "lead",
      iteration: 1,
      channel: "text",
      text: "lo",
      reset: false,
    };
    expect(mergeEvents(prev, next)).toEqual({
      type: "text_delta",
      at: 0,
      agent: "lead",
      iteration: 1,
      channel: "text",
      text: "hello",
      reset: true,
    });
  });

  it("concatenates chunks across two tool_output_delta events, keeping prev's at", () => {
    const prev: RunEvent = {
      type: "tool_output_delta",
      at: 0,
      agent: "lead",
      call_id: "c1",
      chunk: "ab",
    };
    const next: RunEvent = {
      type: "tool_output_delta",
      at: 1,
      agent: "lead",
      call_id: "c1",
      chunk: "cd",
    };
    expect(mergeEvents(prev, next)).toEqual({
      type: "tool_output_delta",
      at: 0,
      agent: "lead",
      call_id: "c1",
      chunk: "abcd",
    });
  });

  it("falls back to next unchanged when the pair is not a mergeable-type match", () => {
    const prev: RunEvent = { type: "run_started", at: 0 };
    const next: RunEvent = { type: "run_ended", at: 1, status: "completed" };
    expect(mergeEvents(prev, next)).toBe(next);
  });

  it("falls back to next when types match a merge key shape but not each other", () => {
    const prev: RunEvent = {
      type: "text_delta",
      at: 0,
      agent: "lead",
      iteration: 1,
      channel: "text",
      text: "hi",
      reset: false,
    };
    const next: RunEvent = {
      type: "tool_output_delta",
      at: 1,
      agent: "lead",
      call_id: "c1",
      chunk: "x",
    };
    expect(mergeEvents(prev, next)).toBe(next);
  });
});
