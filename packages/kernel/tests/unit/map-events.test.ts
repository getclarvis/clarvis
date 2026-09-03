import { describe, it, expect } from "bun:test";
import type { TraceEvent } from "@clarvis/loop";
import {
  capabilityEventToProto,
  engineEventToProto,
  MAX_CAPABILITY_EVENT_DETAIL_BYTES,
} from "../../src/runs/map-events.ts";

describe("engineEventToProto (TraceEvent → engine-independent RunEvent projection)", () => {
  it("maps tool_call, keying ok on error === null and renaming mcp_name → server", () => {
    const ev: TraceEvent = {
      type: "tool_call",
      agent: "lead",
      iteration_ref: 1,
      started_at: 10,
      ended_at: 20,
      mcp_name: "filesystem",
      tool_name: "read_file",
      arguments: {},
      result: "ok",
      error: null,
      guard: { mode: "auto", outcome: "allowed", answerer: "judge" },
    };
    expect(engineEventToProto(ev)).toEqual({
      type: "tool_call",
      at: 20,
      agent: "lead",
      tool: "read_file",
      server: "filesystem",
      arguments: {},
      ok: true,
      result: "ok",
      guard: { mode: "auto", outcome: "allowed", answerer: "judge" },
    });
  });

  it("maps the live-only tool_output_delta, keeping its call_id join key", () => {
    expect(
      engineEventToProto({
        type: "tool_output_delta",
        agent: "subagent",
        subagent_instance_id: "s1",
        call_id: "c7",
        occurred_at: 42,
        chunk: "compiling...\n",
      }),
    ).toEqual({
      type: "tool_output_delta",
      at: 42,
      agent: "subagent",
      subagent_id: "s1",
      call_id: "c7",
      chunk: "compiling...\n",
    });
  });

  it("maps the live-only tool_input_delta, so it is not lost to the default arm", () => {
    // `engineEventToProto`'s default returns null instead of failing to compile,
    // so a new engine event that nobody adds a case for is dropped between the
    // kernel and the client with a green build and a green suite. This is the
    // only thing standing in for the exhaustiveness check the others get.
    expect(
      engineEventToProto({
        type: "tool_input_delta",
        agent: "lead",
        call_id: "c9",
        occurred_at: 7,
        tool_name: "write_file",
        chars: 2048,
        stream_chars: 2304,
      }),
    ).toEqual({
      type: "tool_input_delta",
      at: 7,
      agent: "lead",
      call_id: "c9",
      tool: "write_file",
      chars: 2048,
      stream_chars: 2304,
    });
  });

  it("collapses lead_iteration to iteration_completed with an agent field + tokens", () => {
    const ev: TraceEvent = {
      type: "lead_iteration",
      iteration: 2,
      started_at: 10,
      ended_at: 30,
      model: "m",
      input_tokens: 100,
      output_tokens: 50,
      cached_tokens: 40,
      cache_write_tokens: 0,
      cache_read_ratio: 0,
      response: "hi",
      response_phase: "commentary",
    };
    expect(engineEventToProto(ev)).toEqual({
      type: "iteration_completed",
      at: 30,
      agent: "lead",
      iteration: 2,
      model: "m",
      response: "hi",
      response_phase: "commentary",
      input_tokens: 100,
      output_tokens: 50,
      cached_tokens: 40,
    });
  });

  it("attributes a sub-agent iteration with subagent_id", () => {
    const ev: TraceEvent = {
      type: "subagent_iteration",
      subagent_instance_id: "s1",
      iteration: 1,
      started_at: 1,
      ended_at: 2,
      model: "m",
      input_tokens: 5,
      output_tokens: 3,
      cached_tokens: 0,
      cache_write_tokens: 0,
      cache_read_ratio: 0,
      response: "x",
    };
    expect(engineEventToProto(ev)).toMatchObject({
      type: "iteration_completed",
      agent: "subagent",
      subagent_id: "s1",
      input_tokens: 5,
      output_tokens: 3,
    });
  });

  it("maps model_stream_delta to text_delta carrying the channel", () => {
    const base = { agent: "lead" as const, iteration: 1, occurred_at: 5, model: "m", reset: false };
    expect(
      engineEventToProto({ type: "model_stream_delta", ...base, channel: "text", text: "hi" }),
    ).toMatchObject({
      type: "text_delta",
      channel: "text",
      text: "hi",
    });
    expect(
      engineEventToProto({ type: "model_stream_delta", ...base, channel: "reasoning", text: "hm" }),
    ).toMatchObject({
      type: "text_delta",
      channel: "reasoning",
    });
  });

  it("carries a sub-agent's instance id onto its text_delta (attribution)", () => {
    expect(
      engineEventToProto({
        type: "model_stream_delta",
        agent: "subagent",
        subagent_instance_id: "s1",
        iteration: 2,
        occurred_at: 5,
        model: "m",
        channel: "text",
        text: "hi",
        reset: true,
      }),
    ).toMatchObject({ type: "text_delta", agent: "subagent", subagent_id: "s1" });
  });

  it("maps confirmed capability plan projections", () => {
    const detail = {
      id: "plan-1",
      path: ".clarvis/plans/p.md",
      title: "Plan",
      status: "active",
      retention: "keep",
      revision: 3,
      spec_revision: 2,
      objective: "internal objective omitted from the wire projection",
      context: "internal context omitted from the wire projection",
      validation: ["internal validation omitted from the wire projection"],
      tasks: [{ id: "t1", title: "T", status: "pending" }],
    };
    const created = capabilityEventToProto({
      capability: "plans",
      kind: "plan_created",
      detail,
      wire: { type: "plan_created", detail },
    });
    expect(created).toMatchObject({
      type: "plan_created",
      path: ".clarvis/plans/p.md",
      revision: 3,
      spec_revision: 2,
      tasks: [{ id: "t1", title: "T", status: "pending" }],
    });
    expect(created).not.toHaveProperty("objective");
    expect(created).not.toHaveProperty("context");
  });

  it("does not let capability detail override a closed event discriminator or timestamp", () => {
    const projected = capabilityEventToProto({
      capability: "malicious",
      kind: "spoof",
      detail: {},
      wire: {
        type: "plan_created",
        detail: { type: "bogus", at: 0, secret: "Bearer secret-token" },
      },
    });

    expect(projected).toMatchObject({
      type: "capability_event",
      capability: "malicious",
      projection: "plan_created",
    });
    expect(JSON.stringify(projected)).not.toContain("secret-token");
  });

  it("projects a capability the kernel was never taught about, given its wire declaration", () => {
    expect(
      capabilityEventToProto({
        capability: "audit",
        kind: "audit_finding_recorded",
        detail: { id: "f1" },
        wire: { type: "audit_finding_recorded", detail: { id: "f1", severity: "high" } },
      }),
    ).toMatchObject({
      type: "capability_event",
      capability: "audit",
      kind: "audit_finding_recorded",
      projection: "audit_finding_recorded",
      detail: { id: "f1", severity: "high" },
      truncated: false,
    });
  });

  it("sanitizes and bounds generic capability projections", () => {
    const projected = capabilityEventToProto({
      capability: "audit\u001b[2J",
      kind: "finding\u0007",
      detail: {},
      wire: {
        type: "future\u001b[31m",
        detail: { message: `Bearer secret-token\u001b[2J ${"abcdefgh ".repeat(10_000)}` },
      },
    });
    expect(projected).toMatchObject({
      type: "capability_event",
      capability: "audit",
      kind: "finding",
      projection: "future",
      truncated: true,
    });
    expect(JSON.stringify(projected)).not.toContain("secret-token");
    expect(JSON.stringify(projected)).not.toContain("\u001b");
  });

  it("pre-bounds cyclic, deep, accessor, and huge open capability details", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let depth = 0; depth < 1_000; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "danger", {
      enumerable: true,
      get() {
        throw new Error("must not execute");
      },
    });

    for (const detail of [cyclic, deep, accessor, { body: "x".repeat(2 * 1024 * 1024) }]) {
      const projected = capabilityEventToProto({
        capability: "future",
        kind: "progress",
        wire: { type: "future_progress", detail },
      });
      expect(projected).toMatchObject({ type: "capability_event", truncated: true });
      const encodedDetail =
        JSON.stringify(projected?.type === "capability_event" ? projected.detail : undefined) ?? "";
      expect(Buffer.byteLength(encodedDetail, "utf8")).toBeLessThanOrEqual(
        MAX_CAPABILITY_EVENT_DETAIL_BYTES,
      );
    }
  });

  it("drops an event that declares no projection, whatever capability emitted it", () => {
    expect(
      capabilityEventToProto({ capability: "plans", kind: "plan_created", detail: { path: "p" } }),
    ).toBeNull();
  });

  it("maps a memory ingest notice to the live-only memory_ingest event", () => {
    expect(
      capabilityEventToProto({
        capability: "memory",
        kind: "ingest",
        detail: { execution_id: "exec_1", phase: "done", written: 2, deleted: 1 },
      }),
    ).toMatchObject({
      type: "memory_ingest",
      detail: { execution_id: "exec_1", phase: "done", written: 2, deleted: 1 },
    });
    expect(capabilityEventToProto({ capability: "memory", kind: "other", detail: {} })).toBeNull();
    expect(capabilityEventToProto({ capability: "memory", kind: "ingest" })).toBeNull();
  });

  it("validates the complete memory notice while preserving declared optional fields", () => {
    expect(
      capabilityEventToProto({
        capability: "memory",
        kind: "ingest",
        detail: { execution_id: "exec_1", phase: "failed", error: "boom", indexer_run_id: "ix_9" },
      }),
    ).toMatchObject({
      type: "memory_ingest",
      detail: { phase: "failed", error: "boom", indexer_run_id: "ix_9" },
    });
    expect(
      capabilityEventToProto({
        capability: "memory",
        kind: "ingest",
        detail: { execution_id: "exec_1", phase: "failed", injected: true },
      }),
    ).toBeNull();
  });

  it("maps every phase the durable job queue actually emits, not just done/failed", () => {
    // Regression: the phase allowlist was never widened when the loop's
    // memory-ingest notice grew "queued" (fired on every run's happy path) and
    // "blocked" (no indexer model configured) — both were silently dropped
    // instead of reaching the wire.
    expect(
      capabilityEventToProto({
        capability: "memory",
        kind: "ingest",
        detail: { execution_id: "exec_1", phase: "queued" },
      }),
    ).toMatchObject({ type: "memory_ingest", detail: { phase: "queued" } });
    expect(
      capabilityEventToProto({
        capability: "memory",
        kind: "ingest",
        detail: { execution_id: "exec_1", phase: "blocked", note: "no model" },
      }),
    ).toMatchObject({ type: "memory_ingest", detail: { phase: "blocked", note: "no model" } });
  });

  it("maps the persisted delegation trace, so a rehydrated run keeps its sub-agents", () => {
    expect(
      engineEventToProto({
        type: "delegation_created",
        delegation_id: "w1",
        task_id: "t2",
        spawned_at: 11,
        title: "explorer",
        task: "look at auth",
        profile: "explorer",
        tools: ["docs.search"],
      }),
    ).toEqual({
      type: "delegation_created",
      at: 11,
      delegation_id: "w1",
      task_id: "t2",
      title: "explorer",
      task: "look at auth",
      profile: "explorer",
      tools: ["docs.search"],
    });

    expect(
      engineEventToProto({
        type: "delegation_started",
        delegation_id: "w1",
        occurred_at: 12,
        model: "anthropic/x",
      }),
    ).toEqual({ type: "delegation_started", at: 12, delegation_id: "w1", model: "anthropic/x" });

    expect(
      engineEventToProto({
        type: "delegation_completed",
        delegation_id: "w1",
        task_id: "t2",
        completed_at: 13,
        status: "completed",
        result: "auth uses JWT",
      }),
    ).toEqual({
      type: "delegation_completed",
      at: 13,
      delegation_id: "w1",
      task_id: "t2",
      status: "completed",
      summary: "auth uses JWT",
    });

    expect(
      engineEventToProto({
        type: "delegation_failed",
        delegation_id: "w2",
        completed_at: 14,
        status: "error",
        result: "boom",
      }),
    ).toMatchObject({ type: "delegation_failed", at: 14, delegation_id: "w2", status: "error" });
  });

  it("drops a capability-contributed event (e.g. plan_review), whose outcome reaches clients on the capability channel instead", () => {
    expect(
      engineEventToProto({
        type: "plan_review",
        occurred_at: 5,
        detail: { outcome: "approved", revision_index: 2 },
      }),
    ).toBeNull();
  });

  it("drops a workflow discriminator whose persisted shape fails the workflows guard", () => {
    expect(
      engineEventToProto({
        type: "workflow_run_started",
        run_id: "leader",
        parent_run_id: "manager",
        started_at: "not-a-timestamp",
        task: "inspect",
      }),
    ).toBeNull();
  });

  it("maps mcp_degraded (dropping transport) and run_ended reason → status", () => {
    expect(
      engineEventToProto({
        type: "mcp_degraded",
        occurred_at: 7,
        servers: [{ name: "fs", transport: "stdio", reason: "timeout" }],
      }),
    ).toEqual({ type: "mcp_degraded", at: 7, servers: [{ name: "fs", reason: "timeout" }] });
    expect(
      engineEventToProto({ type: "run_ended", occurred_at: 1, reason: "error" }),
    ).toMatchObject({
      type: "run_ended",
      status: "failed",
    });
  });

  it("projects an answered user_question to elicitation_resolved (for resume recovery)", () => {
    expect(
      engineEventToProto({
        type: "user_question",
        agent: "lead",
        iteration_ref: 4,
        occurred_at: 9,
        question: "Deploy to prod?",
        outcome: "accept",
        answer: "yes",
        options: ["yes", "no"],
      }),
    ).toEqual({
      type: "elicitation_resolved",
      at: 9,
      agent: "lead",
      question: "Deploy to prod?",
      outcome: "accept",
      answer: "yes",
      options: ["yes", "no"],
    });
  });

  it("maps model_reasoning to a reasoning event, carrying the sub-agent id when present", () => {
    expect(
      engineEventToProto({
        type: "model_reasoning",
        agent: "lead",
        iteration: 3,
        occurred_at: 6,
        model: "m",
        text: "thinking...",
      }),
    ).toEqual({
      type: "reasoning",
      at: 6,
      agent: "lead",
      iteration: 3,
      text: "thinking...",
    });

    expect(
      engineEventToProto({
        type: "model_reasoning",
        agent: "subagent",
        subagent_instance_id: "s1",
        iteration: 3,
        occurred_at: 6,
        model: "m",
        text: "thinking...",
      }),
    ).toEqual({
      type: "reasoning",
      at: 6,
      agent: "subagent",
      subagent_id: "s1",
      iteration: 3,
      text: "thinking...",
    });
  });

  it("maps model_call_error to model_error, carrying kind and message", () => {
    expect(
      engineEventToProto({
        type: "model_call_error",
        agent: "lead",
        iteration: 4,
        occurred_at: 7,
        model: "m",
        kind: "transient",
        message: "429 from provider",
      }),
    ).toEqual({
      type: "model_error",
      at: 7,
      agent: "lead",
      iteration: 4,
      kind: "transient",
      message: "429 from provider",
    });

    expect(
      engineEventToProto({
        type: "model_call_error",
        agent: "subagent",
        subagent_instance_id: "s2",
        iteration: 4,
        occurred_at: 7,
        model: "m",
        kind: "auth",
        message: "timed out",
      }),
    ).toMatchObject({ type: "model_error", agent: "subagent", subagent_id: "s2", kind: "auth" });
  });

  it("maps soft_limit_check onto its wire projection (dimension/used/limit/outcome)", () => {
    expect(
      engineEventToProto({
        type: "soft_limit_check",
        agent: "lead",
        occurred_at: 8,
        dimension: "iterations",
        used: 9,
        limit: 10,
        outcome: "continued",
        escalations: 0,
      }),
    ).toEqual({
      type: "soft_limit_check",
      at: 8,
      dimension: "iterations",
      used: 9,
      limit: 10,
      outcome: "continued",
    });
  });

  it("maps compaction, spreading freed_chars only when present and attributing sub-agents", () => {
    expect(
      engineEventToProto({
        type: "compaction_started",
        agent: "lead",
        mode: "scheduled",
        occurred_at: 8,
      }),
    ).toEqual({
      type: "compaction_started",
      at: 8,
      agent: "lead",
      mode: "scheduled",
    });

    expect(
      engineEventToProto({
        type: "compaction",
        agent: "lead",
        operation: "truncation",
        occurred_at: 9,
      }),
    ).toEqual({
      type: "compaction",
      at: 9,
      agent: "lead",
      operation: "truncation",
    });

    expect(
      engineEventToProto({
        type: "compaction",
        agent: "subagent",
        subagent_instance_id: "s3",
        operation: "eviction",
        fallback_reason: "summarization_failed",
        occurred_at: 9,
        freed_chars: 4096,
        contribution_count: 3,
        requested: true,
        user_contribution_count: 2,
      }),
    ).toEqual({
      type: "compaction",
      at: 9,
      agent: "subagent",
      subagent_id: "s3",
      operation: "eviction",
      fallback_reason: "summarization_failed",
      freed_chars: 4096,
      contribution_count: 3,
      requested: true,
      user_contribution_count: 2,
    });
  });

  it("maps an observable skipped compaction without persisting request text", () => {
    expect(
      engineEventToProto({
        type: "compaction_skipped",
        agent: "lead",
        reason: "summarization_failed",
        occurred_at: 10,
      }),
    ).toEqual({
      type: "compaction_skipped",
      at: 10,
      agent: "lead",
      reason: "summarization_failed",
    });
  });

  it("maps elicitation_requested, omitting agent/subagent_id/options when absent", () => {
    expect(
      engineEventToProto({
        type: "elicitation_requested",
        occurred_at: 10,
        source: "ask_user",
        question: "Deploy to prod?",
      }),
    ).toEqual({
      type: "elicitation_requested",
      at: 10,
      question: "Deploy to prod?",
    });

    expect(
      engineEventToProto({
        type: "elicitation_requested",
        agent: "subagent",
        subagent_instance_id: "s4",
        occurred_at: 10,
        source: "tool_relay",
        question: "Confirm?",
        options: ["yes", "no"],
      }),
    ).toEqual({
      type: "elicitation_requested",
      at: 10,
      agent: "subagent",
      subagent_id: "s4",
      question: "Confirm?",
      options: ["yes", "no"],
    });
  });

  it("drops events that are not part of the run view", () => {
    expect(
      engineEventToProto({
        type: "budget_check",
        agent: "lead",
        checked_at: 1,
        tokens_used: 10,
      } as TraceEvent),
    ).toBeNull();
  });
});

/**
 * `engineEventToProto` ends in `default: return null`, not an exhaustiveness
 * check, so a new engine event that nobody wires here vanishes silently instead
 * of failing the build. These pin the mapping the compiler will not.
 */
describe("engineEventToProto — model_call_retry", () => {
  it("projects a retry onto model_retry with its attempt, cap and delay", () => {
    const ev: TraceEvent = {
      type: "model_call_retry",
      agent: "lead",
      iteration: 3,
      occurred_at: 1234,
      model: "anthropic/x",
      kind: "transient",
      message: "overloaded",
      status: 529,
      retry_after_ms: 30000,
      attempt: 2,
      max_retries: 3,
      delay_ms: 30000,
    };
    expect(engineEventToProto(ev)).toEqual({
      type: "model_retry",
      at: 1234,
      agent: "lead",
      iteration: 3,
      kind: "transient",
      status: 529,
      retry_after_ms: 30000,
      attempt: 2,
      max_retries: 3,
      delay_ms: 30000,
    });
  });

  it("omits status and retry_after_ms when the failure carried neither", () => {
    const ev: TraceEvent = {
      type: "model_call_retry",
      agent: "subagent",
      subagent_instance_id: "sub-1",
      iteration: 1,
      occurred_at: 5,
      model: "anthropic/x",
      kind: "transient",
      message: "temporarily unavailable",
      attempt: 1,
      max_retries: 3,
      delay_ms: 1000,
    };
    const out = engineEventToProto(ev);
    expect(out).toEqual({
      type: "model_retry",
      at: 5,
      agent: "subagent",
      subagent_id: "sub-1",
      iteration: 1,
      kind: "transient",
      attempt: 1,
      max_retries: 3,
      delay_ms: 1000,
    });
    expect(out && "status" in out).toBe(false);
  });
});

/**
 * Both are recorded and persisted by the engine but have no wire projection
 * yet. They are handled explicitly rather than left to `engineEventToProto`'s
 * `default: return null`, so the omission reads as a decision — these pin that
 * it stays one.
 */
describe("engineEventToProto — engine-internal guard events", () => {
  it("does not project a convergence warning onto the wire", () => {
    const ev: TraceEvent = {
      type: "convergence_warning",
      agent: "lead",
      occurred_at: 1,
      code: "tool_failure_loop",
      message: "close to the limit",
    };
    expect(engineEventToProto(ev)).toBeNull();
  });

  it("does not project a guard escalation onto the wire", () => {
    const ev: TraceEvent = {
      type: "guard_escalation",
      agent: "lead",
      occurred_at: 1,
      code: "stagnation_detected",
      outcome: "continued",
      escalations: 1,
    };
    expect(engineEventToProto(ev)).toBeNull();
  });
});
