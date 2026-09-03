import { describe, expect, it } from "bun:test";
import type { TraceEntry, TraceEvent } from "@clarvis/capability";

import { mapEntry } from "../../src/trace-mapper.ts";

const ANCHOR = 1_700_000_000_000;

function map<T extends TraceEvent["type"]>(entry: TraceEntry, type: T) {
  const event = mapEntry(entry, ANCHOR);
  expect(event).not.toBeNull();
  expect(event!.type).toBe(type);
  return event as Extract<TraceEvent, { type: T }>;
}

/**
 * One case per mapper arm the main projection suite does not reach.
 *
 * Each arm is a projection with two halves worth pinning: the fields it always
 * copies, and the optional ones it must *omit* rather than emit as `undefined`
 * — a distinction that survives `JSON.stringify` and therefore reaches a client.
 */
describe("trace-mapper — per-kind projection", () => {
  it("maps guard_escalation, omitting the absent subagent id", () => {
    const event = map(
      {
        at: 10,
        kind: "guard_escalation",
        detail: { agent: "lead", code: "tool_failure_loop", outcome: "declined", escalations: 2 },
      },
      "guard_escalation",
    );
    expect(event).toEqual({
      type: "guard_escalation",
      agent: "lead",
      occurred_at: ANCHOR + 10,
      code: "tool_failure_loop",
      outcome: "declined",
      escalations: 2,
    });
  });

  it("carries the subagent id on guard_escalation when present", () => {
    const event = map(
      {
        at: 10,
        kind: "guard_escalation",
        detail: {
          agent: "subagent",
          subagent_instance_id: "w1",
          code: "stagnation_detected",
          outcome: "continued",
          escalations: 1,
        },
      },
      "guard_escalation",
    );
    expect(event.subagent_instance_id).toBe("w1");
  });

  it("maps convergence_warning fields", () => {
    const event = map(
      {
        at: 4,
        kind: "convergence_warning",
        detail: { agent: "lead", code: "tool_failure_loop", message: "repeated failure" },
      },
      "convergence_warning",
    );
    expect(event.code).toBe("tool_failure_loop");
    expect(event.message).toBe("repeated failure");
  });

  it("maps model_call_retry with its attempt bookkeeping", () => {
    const event = map(
      {
        at: 7,
        kind: "model_call_retry",
        detail: {
          agent: "lead",
          iteration: 3,
          model: "anthropic/x",
          kind: "overloaded",
          message: "provider overloaded",
          attempt: 2,
          max_retries: 5,
          delay_ms: 400,
        },
      },
      "model_call_retry",
    );
    expect(event).toMatchObject({
      agent: "lead",
      iteration: 3,
      occurred_at: ANCHOR + 7,
      model: "anthropic/x",
      kind: "overloaded",
      message: "provider overloaded",
      attempt: 2,
      max_retries: 5,
      delay_ms: 400,
    });
    expect("status" in event).toBe(false);
    expect("retry_after_ms" in event).toBe(false);
  });

  it("carries model_call_retry's optional transport fields when present", () => {
    const event = map(
      {
        at: 7,
        kind: "model_call_retry",
        detail: {
          agent: "lead",
          subagent_instance_id: "w2",
          iteration: 1,
          model: "m",
          kind: "rate_limit",
          message: "rate limited",
          attempt: 1,
          max_retries: 3,
          delay_ms: 100,
          status: 429,
          retry_after_ms: 2000,
        },
      },
      "model_call_retry",
    );
    expect(event.status).toBe(429);
    expect(event.retry_after_ms).toBe(2000);
    expect(event.subagent_instance_id).toBe("w2");
  });

  it("maps model_reasoning and omits an absent subagent id", () => {
    const event = map(
      {
        at: 2,
        kind: "model_reasoning",
        detail: { agent: "lead", iteration: 1, model: "m", text: "because" },
      },
      "model_reasoning",
    );
    expect(event.text).toBe("because");
    expect("subagent_instance_id" in event).toBe(false);
  });

  it("maps model_stream_delta, keeping the channel and the reset flag", () => {
    const event = map(
      {
        at: 3,
        kind: "model_stream_delta",
        detail: {
          agent: "lead",
          iteration: 1,
          model: "m",
          channel: "text",
          text: "partial",
          reset: true,
        },
      },
      "model_stream_delta",
    );
    expect(event).toMatchObject({ channel: "text", text: "partial", reset: true });
  });

  it("maps elicitation_requested with only the fields that were set", () => {
    const bare = map(
      {
        at: 1,
        kind: "elicitation_requested",
        detail: { source: "ask_user", question: "which?" },
      },
      "elicitation_requested",
    );
    expect(bare).toEqual({
      type: "elicitation_requested",
      occurred_at: ANCHOR + 1,
      source: "ask_user",
      question: "which?",
    });

    const full = map(
      {
        at: 1,
        kind: "elicitation_requested",
        detail: {
          source: "guard",
          question: "allow?",
          agent: "lead",
          iteration_ref: 4,
          subagent_instance_id: "w1",
          options: ["yes", "no"],
        },
      },
      "elicitation_requested",
    );
    expect(full).toMatchObject({
      agent: "lead",
      iteration_ref: 4,
      subagent_instance_id: "w1",
      options: ["yes", "no"],
    });
  });

  it("maps every mcp_degraded server", () => {
    const event = map(
      {
        at: 6,
        kind: "mcp_degraded",
        detail: {
          servers: [
            { name: "fs", transport: "stdio", reason: "closed" },
            { name: "net", transport: "sse", reason: "refused" },
          ],
        },
      },
      "mcp_degraded",
    );
    expect(event.servers).toEqual([
      { name: "fs", transport: "stdio", reason: "closed" },
      { name: "net", transport: "sse", reason: "refused" },
    ]);
  });
});

describe("trace-mapper — kinds that are engine-internal", () => {
  it.each(["init", "terminate", "agent_registered", "agent_stopped", "agent_steered"] as const)(
    "maps %s to null rather than leaking the raw envelope onto the wire",
    (kind) => {
      expect(mapEntry({ at: 1, kind, detail: {} } as TraceEntry, ANCHOR)).toBeNull();
    },
  );
});
