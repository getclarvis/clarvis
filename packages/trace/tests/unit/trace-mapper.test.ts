import { describe, it, expect } from "bun:test";
import { mapTrace, mapEntry, RESULT_MAX } from "@clarvis/trace";
import { DELEGATE_TASK_MAX_CHARS, type TraceEntry, type TraceEvent } from "@clarvis/capability";

const ANCHOR = 1_700_000_000_000;

function byType<T extends TraceEvent["type"]>(
  events: TraceEvent[],
  type: T,
): Extract<TraceEvent, { type: T }>[] {
  return events.filter((e) => e.type === type) as Extract<TraceEvent, { type: T }>[];
}

describe("trace-mapper — tool projection", () => {
  it("carries a tool_call diff onto the persisted event", () => {
    const entries: TraceEntry[] = [
      {
        at: 3,
        kind: "tool_call",
        detail: {
          agent: "lead",
          iteration_ref: 1,
          started_at: 1,
          ended_at: 3,
          name: "edit_file",
          arguments: { path: "a.ts" },
          result: "Replaced 1 occurrence in a.ts.",
          error: null,
          diff: "@@ -1 +1 @@\n-old\n+new\n",
          guard: { mode: "auto", outcome: "allowed", answerer: "judge" },
        },
      },
    ];
    const ev = byType(mapTrace(entries, ANCHOR).events, "tool_call")[0]!;
    expect(ev.diff).toBe("@@ -1 +1 @@\n-old\n+new\n");
    expect(ev.guard).toEqual({ mode: "auto", outcome: "allowed", answerer: "judge" });
  });
});

describe("trace-mapper — mapping, anchoring, ordering", () => {
  it("converts monotonic offsets to absolute unix-ms via the anchor", () => {
    const entries: TraceEntry[] = [
      {
        at: 12,
        kind: "lead_iteration",
        detail: {
          iteration: 1,
          started_at: 2,
          ended_at: 12,
          model: "anthropic/x",
          input_tokens: 10,
          output_tokens: 4,
          cached_tokens: 1,
          cache_write_tokens: 0,
          cache_read_ratio: 0.1,
          response: "planning",
        },
      },
    ];
    const lead = byType(mapTrace(entries, ANCHOR).events, "lead_iteration")[0]!;
    expect(lead.started_at).toBe(ANCHOR + 2);
    expect(lead.ended_at).toBe(ANCHOR + 12);
  });

  it("persists final model prose beyond the compact tool-result cap", () => {
    const response = "answer ".repeat(Math.ceil((RESULT_MAX + 1) / 7));
    const entries: TraceEntry[] = [
      {
        at: 12,
        kind: "lead_iteration",
        detail: {
          iteration: 1,
          started_at: 2,
          ended_at: 12,
          model: "anthropic/x",
          input_tokens: 10,
          output_tokens: 4,
          cached_tokens: 1,
          cache_write_tokens: 0,
          cache_read_ratio: 0.1,
          response,
        },
      },
    ];

    expect(response.length).toBeGreaterThan(RESULT_MAX);
    expect(byType(mapTrace(entries, ANCHOR).events, "lead_iteration")[0]?.response).toBe(response);
  });

  it("passes the cache-health counters through unchanged (not rebased, not truncated)", () => {
    const entries: TraceEntry[] = [
      {
        at: 12,
        kind: "lead_iteration",
        detail: {
          iteration: 1,
          started_at: 2,
          ended_at: 12,
          model: "anthropic/x",
          input_tokens: 200,
          output_tokens: 4,
          cached_tokens: 150,
          cache_write_tokens: 30,
          cache_read_ratio: 0.75,
          response: "planning",
        },
      },
      {
        at: 14,
        kind: "subagent_iteration",
        detail: {
          subagent_instance_id: "w1",
          iteration: 1,
          started_at: 13,
          ended_at: 14,
          model: "anthropic/y",
          input_tokens: 50,
          output_tokens: 2,
          cached_tokens: 0,
          cache_write_tokens: 50,
          cache_read_ratio: 0,
          response: "work",
        },
      },
    ];
    const { events } = mapTrace(entries, ANCHOR);
    const lead = byType(events, "lead_iteration")[0]!;
    expect(lead.cache_write_tokens).toBe(30);
    expect(lead.cache_read_ratio).toBe(0.75);
    const sub = byType(events, "subagent_iteration")[0]!;
    expect(sub.cache_write_tokens).toBe(50);
    expect(sub.cache_read_ratio).toBe(0);
  });

  // A payload that is not an object means the provider handed back something that
  // did not decode to arguments — the exact case a truncated tool call produces.
  // Persisting `{}` for it asserted the model sent nothing when it had sent a
  // payload cut in transit, and that erasure is what made the defect take a full
  // investigation: the truth survived only in the run's final context.
  it("keeps a non-object tool_call arguments payload instead of erasing it", () => {
    const asNull: TraceEntry[] = [
      {
        at: 3,
        kind: "tool_call",
        detail: {
          agent: "lead",
          iteration_ref: 1,
          started_at: 1,
          ended_at: 3,
          name: "fs.read",
          arguments: null as unknown as Record<string, unknown>,
          result: "ok",
          error: null,
        },
      },
    ];
    expect(byType(mapTrace(asNull, ANCHOR).events, "tool_call")[0]!.arguments).toEqual({
      malformed_arguments: "null",
    });

    const asString: TraceEntry[] = [
      {
        at: 3,
        kind: "tool_call_started",
        detail: {
          agent: "lead",
          iteration_ref: 1,
          call_id: "c1",
          started_at: 1,
          name: "fs.read",
          arguments: "not-an-object" as unknown as Record<string, unknown>,
        },
      },
    ];
    expect(byType(mapTrace(asString, ANCHOR).events, "tool_call_started")[0]!.arguments).toEqual({
      malformed_arguments: "not-an-object",
    });
  });

  it("still reports an absent arguments payload as an empty object", () => {
    const absent: TraceEntry[] = [
      {
        at: 3,
        kind: "tool_call",
        detail: {
          agent: "lead",
          iteration_ref: 1,
          started_at: 1,
          ended_at: 3,
          name: "fs.list",
          arguments: undefined as unknown as Record<string, unknown>,
          result: "ok",
          error: null,
        },
      },
    ];
    expect(byType(mapTrace(absent, ANCHOR).events, "tool_call")[0]!.arguments).toEqual({});
  });

  // A payload the JSON serializer itself refuses (a bigint throws) must still
  // produce a persistable event rather than taking the mapper down mid-run.
  it("survives a malformed payload that cannot be serialized at all", () => {
    const unserializable: TraceEntry[] = [
      {
        at: 3,
        kind: "tool_call",
        detail: {
          agent: "lead",
          iteration_ref: 1,
          started_at: 1,
          ended_at: 3,
          name: "fs.read",
          arguments: 1n as unknown as Record<string, unknown>,
          result: "ok",
          error: null,
        },
      },
    ];
    expect(byType(mapTrace(unserializable, ANCHOR).events, "tool_call")[0]!.arguments).toEqual({
      malformed_arguments: "",
    });
  });

  it("bounds a very large malformed payload rather than persisting it whole", () => {
    const huge: TraceEntry[] = [
      {
        at: 3,
        kind: "tool_call",
        detail: {
          agent: "lead",
          iteration_ref: 1,
          started_at: 1,
          ended_at: 3,
          name: "fs.read",
          arguments: "x".repeat(50_000) as unknown as Record<string, unknown>,
          result: "ok",
          error: null,
        },
      },
    ];
    const kept = (
      byType(mapTrace(huge, ANCHOR).events, "tool_call")[0]!.arguments as {
        malformed_arguments: string;
      }
    ).malformed_arguments;
    expect(kept.length).toBeLessThan(50_000);
    expect(kept).toContain("x");
  });

  it("maps a kind the engine does not declare to the contributed shape, instead of dropping it", () => {
    const contributed: TraceEntry = {
      at: 1,
      kind: "totally_unknown_kind",
      detail: { foo: "bar" },
    };
    expect(mapEntry(contributed, ANCHOR)).toEqual({
      type: "totally_unknown_kind",
      occurred_at: ANCHOR + 1,
      detail: { foo: "bar" },
    });
  });

  it("splits namespaced tool names into mcp_name/tool_name", () => {
    const entries: TraceEntry[] = [
      {
        at: 3,
        kind: "tool_call",
        detail: {
          agent: "lead",
          iteration_ref: 1,
          started_at: 1,
          ended_at: 3,
          name: "github.search_issues",
          arguments: {},
          result: "ok",
          error: null,
        },
      },
    ];
    const tc = byType(mapTrace(entries, ANCHOR).events, "tool_call")[0]!;
    expect(tc.mcp_name).toBe("github");
    expect(tc.tool_name).toBe("search_issues");
    expect(tc.agent).toBe("lead");
    expect(tc.subagent_instance_id).toBeUndefined();
  });

  it("preserves chronological order across a delegation lifecycle", () => {
    const entries: TraceEntry[] = [
      {
        at: 1,
        kind: "delegation_created",
        detail: { delegation_id: "w1", title: "label", task: "t", tools: ["fs.read"] },
      },
      {
        at: 2,
        kind: "delegation_completed",
        detail: { delegation_id: "w1", status: "completed", result: "done" },
      },
    ];
    const { events } = mapTrace(entries, ANCHOR);
    expect(events.map((e) => e.type)).toEqual(["delegation_created", "delegation_completed"]);
    expect(byType(events, "delegation_created")[0]!.spawned_at).toBe(ANCHOR + 1);
    expect(byType(events, "delegation_created")[0]!.title).toBe("label");
    expect(byType(events, "delegation_completed")[0]!.completed_at).toBe(ANCHOR + 2);
  });

  it("links subagent events by delegation_id", () => {
    const entries: TraceEntry[] = [
      {
        at: 1,
        kind: "delegation_created",
        detail: { delegation_id: "w-42", title: "label", task: "t", tools: [] },
      },
      {
        at: 2,
        kind: "subagent_iteration",
        detail: {
          subagent_instance_id: "w-42",
          iteration: 1,
          started_at: 1,
          ended_at: 2,
          model: "m",
          input_tokens: 1,
          output_tokens: 1,
          cached_tokens: 0,
          cache_write_tokens: 0,
          cache_read_ratio: 0,
          response: "hi",
        },
      },
    ];
    const { events } = mapTrace(entries, ANCHOR);
    const ids = new Set(
      events.map((event) =>
        "delegation_id" in event
          ? event.delegation_id
          : "subagent_instance_id" in event
            ? event.subagent_instance_id
            : undefined,
      ),
    );
    expect(ids).toEqual(new Set(["w-42"]));
  });

  it("maps budget_check with absolute checked_at", () => {
    const entries: TraceEntry[] = [
      { at: 9, kind: "budget_check", detail: { tokens_used: 50, tokens_remaining: 950 } },
    ];
    const bc = byType(mapTrace(entries, ANCHOR).events, "budget_check")[0]!;
    expect(bc).toEqual({
      type: "budget_check",
      checked_at: ANCHOR + 9,
      tokens_used: 50,
      tokens_remaining: 950,
    });
  });

  it("omits tokens_remaining from budget_check when the budget is unbounded (non-finite)", () => {
    const entries: TraceEntry[] = [
      {
        at: 9,
        kind: "budget_check",
        detail: { tokens_used: 50, tokens_remaining: Number.POSITIVE_INFINITY },
      },
    ];
    const bc = byType(mapTrace(entries, ANCHOR).events, "budget_check")[0]!;
    expect(bc).toEqual({ type: "budget_check", checked_at: ANCHOR + 9, tokens_used: 50 });
    expect("tokens_remaining" in bc).toBe(false);
  });
});

describe("trace-mapper — in-flight started edges", () => {
  it("maps tool_call_started: splits the name, rebases started_at, carries call_id + arguments", () => {
    const entries: TraceEntry[] = [
      {
        at: 6,
        kind: "tool_call_started",
        detail: {
          agent: "subagent",
          subagent_instance_id: "w1",
          iteration_ref: 2,
          call_id: "call_abc",
          started_at: 6,
          name: "tools.shell",
          arguments: { command: "npm test" },
        },
      },
    ];
    const ev = byType(mapTrace(entries, ANCHOR).events, "tool_call_started")[0]!;
    expect(ev).toEqual({
      type: "tool_call_started",
      agent: "subagent",
      subagent_instance_id: "w1",
      call_id: "call_abc",
      iteration_ref: 2,
      started_at: ANCHOR + 6,
      mcp_name: "tools",
      tool_name: "shell",
      arguments: { command: "npm test" },
    });
  });

  it("maps tool_output_delta: rebases occurred_at, carries call_id + attribution, passes a full coalesced flush through whole", () => {
    const flush = "z\n".repeat(4096);
    const entries: TraceEntry[] = [
      {
        at: 7,
        kind: "tool_output_delta",
        detail: {
          agent: "subagent",
          subagent_instance_id: "w1",
          call_id: "call_abc",
          chunk: flush,
        },
      },
    ];
    const ev = byType(mapTrace(entries, ANCHOR).events, "tool_output_delta")[0]!;
    expect(ev).toMatchObject({
      type: "tool_output_delta",
      agent: "subagent",
      subagent_instance_id: "w1",
      call_id: "call_abc",
      occurred_at: ANCHOR + 7,
    });
    expect(ev.chunk).toBe(flush);
  });

  it("maps tool_input_delta: rebases occurred_at, carries the tool name, size and attribution", () => {
    const entries: TraceEntry[] = [
      {
        at: 11,
        kind: "tool_input_delta",
        detail: {
          agent: "subagent",
          subagent_instance_id: "w1",
          call_id: "call_abc",
          tool_name: "write_file",
          chars: 4096,
          stream_chars: 4352,
        },
      },
    ];
    const ev = byType(mapTrace(entries, ANCHOR).events, "tool_input_delta")[0]!;
    expect(ev).toEqual({
      type: "tool_input_delta",
      agent: "subagent",
      subagent_instance_id: "w1",
      call_id: "call_abc",
      occurred_at: ANCHOR + 11,
      tool_name: "write_file",
      chars: 4096,
      stream_chars: 4352,
    });
  });

  it("omits subagent_instance_id from a lead's tool_input_delta rather than carrying undefined", () => {
    const entries: TraceEntry[] = [
      {
        at: 1,
        kind: "tool_input_delta",
        detail: { agent: "lead", call_id: "c1", tool_name: "read_file", chars: 0 },
      },
    ];
    const ev = byType(mapTrace(entries, ANCHOR).events, "tool_input_delta")[0]!;
    expect("subagent_instance_id" in ev).toBe(false);
  });

  it("omits subagent_instance_id on a lead tool_call_started", () => {
    const entries: TraceEntry[] = [
      {
        at: 1,
        kind: "tool_call_started",
        detail: {
          agent: "lead",
          iteration_ref: 1,
          call_id: "c1",
          started_at: 1,
          name: "tools-ro.read_file",
          arguments: {},
        },
      },
    ];
    const ev = byType(mapTrace(entries, ANCHOR).events, "tool_call_started")[0]!;
    expect(ev.agent).toBe("lead");
    expect(ev.subagent_instance_id).toBeUndefined();
    expect(ev.mcp_name).toBe("tools-ro");
    expect(ev.tool_name).toBe("read_file");
  });

  it("tool_call carries call_id when the detail has one, and omits it when absent", () => {
    const withId: TraceEntry[] = [
      {
        at: 3,
        kind: "tool_call",
        detail: {
          agent: "subagent",
          subagent_instance_id: "w1",
          iteration_ref: 1,
          call_id: "call_xyz",
          started_at: 1,
          ended_at: 3,
          name: "tools.shell",
          arguments: {},
          result: "ok",
          error: null,
        },
      },
    ];
    expect(byType(mapTrace(withId, ANCHOR).events, "tool_call")[0]!.call_id).toBe("call_xyz");

    const withoutId: TraceEntry[] = [
      {
        at: 3,
        kind: "tool_call",
        detail: {
          agent: "lead",
          iteration_ref: 1,
          started_at: 1,
          ended_at: 3,
          name: "submit_result",
          arguments: {},
          result: "accepted",
          error: null,
        },
      },
    ];
    expect(byType(mapTrace(withoutId, ANCHOR).events, "tool_call")[0]!.call_id).toBeUndefined();
  });

  it("maps subagent_iteration_started and lead_iteration_started with rebased started_at", () => {
    const entries: TraceEntry[] = [
      {
        at: 2,
        kind: "subagent_iteration_started",
        detail: { subagent_instance_id: "w7", iteration: 3, started_at: 2, model: "m" },
      },
      {
        at: 4,
        kind: "lead_iteration_started",
        detail: { iteration: 1, started_at: 4, model: "lead-m" },
      },
    ];
    const { events } = mapTrace(entries, ANCHOR);
    expect(byType(events, "subagent_iteration_started")[0]!).toEqual({
      type: "subagent_iteration_started",
      subagent_instance_id: "w7",
      iteration: 3,
      started_at: ANCHOR + 2,
      model: "m",
    });
    expect(byType(events, "lead_iteration_started")[0]!).toEqual({
      type: "lead_iteration_started",
      iteration: 1,
      started_at: ANCHOR + 4,
      model: "lead-m",
    });
  });
});

describe("mapEntry (shared per-entry mapper)", () => {
  it("maps a lead_iteration to absolute timestamps", () => {
    const entry: TraceEntry = {
      at: 10,
      kind: "lead_iteration",
      detail: {
        iteration: 1,
        started_at: 5,
        ended_at: 10,
        model: "anthropic/claude",
        input_tokens: 3,
        output_tokens: 4,
        cached_tokens: 0,
        cache_write_tokens: 0,
        cache_read_ratio: 0,
        response: "ok",
        response_phase: "commentary",
      },
    };
    const ev = mapEntry(entry, ANCHOR);
    expect(ev).not.toBeNull();
    expect(ev).toMatchObject({
      type: "lead_iteration",
      iteration: 1,
      started_at: ANCHOR + 5,
      ended_at: ANCHOR + 10,
      model: "anthropic/claude",
      response: "ok",
      response_phase: "commentary",
    });
  });
});

describe("trace-mapper — lifecycle events", () => {
  it("rebases timestamps and carries run_started fields (lead_model present only in lead-subagent)", () => {
    const entries: TraceEntry[] = [
      {
        at: 5,
        kind: "run_started",
        detail: { mode: "lead-subagent", lead_model: "p/lead", subagent_model: "p/wrk" },
      },
      { at: 6, kind: "run_started", detail: { mode: "subagent-only", subagent_model: "p/x" } },
    ];
    const [lw, wo] = byType(mapTrace(entries, ANCHOR).events, "run_started");
    expect(lw!.occurred_at).toBe(ANCHOR + 5);
    expect(lw!.mode).toBe("lead-subagent");
    expect(lw!.lead_model).toBe("p/lead");
    expect(lw!.subagent_model).toBe("p/wrk");
    expect(wo!.mode).toBe("subagent-only");
    expect(wo!.subagent_model).toBe("p/x");
    expect("lead_model" in wo!).toBe(false);
  });

  it("carries the optional token ceiling on run_started when present", () => {
    const entries: TraceEntry[] = [
      {
        at: 3,
        kind: "run_started",
        detail: {
          mode: "lead-subagent",
          lead_model: "p/lead",
          subagent_model: "p/wrk",
          max_tokens: 128000,
        },
      },
    ];
    const ev = byType(mapTrace(entries, ANCHOR).events, "run_started")[0]!;
    expect(ev.max_tokens).toBe(128000);
    expect(ev.occurred_at).toBe(ANCHOR + 3);
  });

  it("carries run_ended reason, with code only for the non-clean reasons", () => {
    const entries: TraceEntry[] = [
      { at: 1, kind: "run_ended", detail: { reason: "completed" } },
      { at: 2, kind: "run_ended", detail: { reason: "guard_trip", code: "tool_failure_loop" } },
    ];
    const [clean, guard] = byType(mapTrace(entries, ANCHOR).events, "run_ended");
    expect(clean!.reason).toBe("completed");
    expect("code" in clean!).toBe(false);
    expect(guard!.reason).toBe("guard_trip");
    expect(guard!.code).toBe("tool_failure_loop");
    expect(guard!.occurred_at).toBe(ANCHOR + 2);
  });

  it("carries delegation_started fields", () => {
    const entries: TraceEntry[] = [
      { at: 9, kind: "delegation_started", detail: { delegation_id: "w1", model: "p/x" } },
    ];
    const ev = byType(mapTrace(entries, ANCHOR).events, "delegation_started")[0]!;
    expect(ev.delegation_id).toBe("w1");
    expect(ev.model).toBe("p/x");
    expect(ev.occurred_at).toBe(ANCHOR + 9);
  });

  it("maps model_call_error classification and optional transport fields", () => {
    const entries: TraceEntry[] = [
      {
        at: 10,
        kind: "model_call_error",
        detail: {
          agent: "subagent",
          subagent_instance_id: "w1",
          iteration: 2,
          model: "p/x",
          kind: "transient",
          status: 429,
          retry_after_ms: 1000,
          message: "overloaded",
        },
      },
      {
        at: 11,
        kind: "model_call_error",
        detail: { agent: "lead", iteration: 1, model: "p/lead", kind: "auth", message: "boom" },
      },
    ];
    const [full, lean] = byType(mapTrace(entries, ANCHOR).events, "model_call_error");
    expect(full!.message).toBe("overloaded");
    expect(full!.kind).toBe("transient");
    expect(full!.status).toBe(429);
    expect(full!.retry_after_ms).toBe(1000);
    expect(full!.subagent_instance_id).toBe("w1");
    expect(lean!.message).toBe("boom");
    expect("status" in lean!).toBe(false);
    expect("retry_after_ms" in lean!).toBe(false);
    expect("subagent_instance_id" in lean!).toBe(false);
  });

  it("maps subagent reasoning and omits the subagent id for lead reasoning", () => {
    const entries: TraceEntry[] = [
      {
        at: 20,
        kind: "model_reasoning",
        detail: {
          agent: "subagent",
          subagent_instance_id: "w1",
          iteration: 4,
          model: "p/x",
          text: "worker rationale",
        },
      },
      {
        at: 21,
        kind: "model_reasoning",
        detail: { agent: "lead", iteration: 2, model: "p/lead", text: "because" },
      },
    ];
    const [wrk, lead] = byType(mapTrace(entries, ANCHOR).events, "model_reasoning");
    expect(wrk!.text).toBe("worker rationale");
    expect(wrk!.agent).toBe("subagent");
    expect(wrk!.subagent_instance_id).toBe("w1");
    expect(wrk!.iteration).toBe(4);
    expect(wrk!.occurred_at).toBe(ANCHOR + 20);
    expect(lead!.text).toBe("because");
    expect(lead!.agent).toBe("lead");
    expect("subagent_instance_id" in lead!).toBe(false);
  });
});

describe("trace-mapper — carries or omits optional detail fields per event kind", () => {
  it("compaction: carries every optional field when present", () => {
    const entries: TraceEntry[] = [
      {
        at: 5,
        kind: "compaction",
        detail: {
          agent: "subagent",
          subagent_instance_id: "w1",
          operation: "eviction",
          fallback_reason: "summarization_failed",
          evicted_count: 2,
          freed_chars: 100,
          original_chars: 500,
          kept_chars: 400,
          task_id: "t1",
          contribution_count: 3,
          requested: true,
          user_contribution_count: 2,
        },
      },
    ];
    const ev = byType(mapTrace(entries, ANCHOR).events, "compaction")[0]!;
    expect(ev).toEqual({
      type: "compaction",
      agent: "subagent",
      operation: "eviction",
      fallback_reason: "summarization_failed",
      occurred_at: ANCHOR + 5,
      subagent_instance_id: "w1",
      evicted_count: 2,
      freed_chars: 100,
      original_chars: 500,
      kept_chars: 400,
      task_id: "t1",
      contribution_count: 3,
      requested: true,
      user_contribution_count: 2,
    });
  });

  it("compaction_started: maps the live lifecycle phase and scope", () => {
    const event = mapEntry(
      {
        at: 4,
        kind: "compaction_started",
        detail: {
          agent: "subagent",
          subagent_instance_id: "w1",
          mode: "scheduled",
        },
      },
      ANCHOR,
    );
    expect(event).toEqual({
      type: "compaction_started",
      agent: "subagent",
      subagent_instance_id: "w1",
      mode: "scheduled",
      occurred_at: ANCHOR + 4,
    });
  });

  it("compaction_skipped: persists the reason and scope without request text", () => {
    const entries: TraceEntry[] = [
      {
        at: 7,
        kind: "compaction_skipped",
        detail: {
          agent: "lead",
          reason: "summarization_failed",
        },
      },
    ];

    expect(byType(mapTrace(entries, ANCHOR).events, "compaction_skipped")[0]).toEqual({
      type: "compaction_skipped",
      agent: "lead",
      reason: "summarization_failed",
      occurred_at: ANCHOR + 7,
    });
  });

  it("vision_analysis: persists the reading, the model and the image count", () => {
    const entries: TraceEntry[] = [
      {
        at: 3,
        kind: "vision_analysis",
        detail: {
          model: "anthropic/vision",
          image_count: 2,
          status: "completed",
          result: "two cats",
        },
      },
    ];

    expect(byType(mapTrace(entries, ANCHOR).events, "vision_analysis")[0]).toEqual({
      type: "vision_analysis",
      model: "anthropic/vision",
      image_count: 2,
      status: "completed",
      result: "two cats",
      occurred_at: ANCHOR + 3,
    });
  });

  it("compaction: omits all optionals for a lead truncation", () => {
    const entries: TraceEntry[] = [
      { at: 6, kind: "compaction", detail: { agent: "lead", operation: "truncation" } },
    ];
    const ev = byType(mapTrace(entries, ANCHOR).events, "compaction")[0]!;
    expect(ev).toEqual({
      type: "compaction",
      agent: "lead",
      operation: "truncation",
      occurred_at: ANCHOR + 6,
    });
  });

  it("cancellation: carries subagent_instance_id/reason when present, omits when absent", () => {
    const entries: TraceEntry[] = [
      {
        at: 10,
        kind: "cancellation",
        detail: { agent: "subagent", subagent_instance_id: "w1", reason: "user_abort" },
      },
      { at: 11, kind: "cancellation", detail: { agent: "lead" } },
    ];
    const [full, lean] = byType(mapTrace(entries, ANCHOR).events, "cancellation");
    expect(full!.subagent_instance_id).toBe("w1");
    expect(full!.reason).toBe("user_abort");
    expect(full!.occurred_at).toBe(ANCHOR + 10);
    expect("subagent_instance_id" in lean!).toBe(false);
    expect("reason" in lean!).toBe(false);
    expect(lean!.agent).toBe("lead");
  });

  it("user_question: carries answer/options when present and omits them when absent", () => {
    const entries: TraceEntry[] = [
      {
        at: 12,
        kind: "user_question",
        detail: {
          agent: "subagent",
          subagent_instance_id: "w1",
          iteration_ref: 2,
          question: "continue?",
          outcome: "accept",
          answer: "a".repeat(10),
          options: ["yes", "no"],
        },
      },
      {
        at: 13,
        kind: "user_question",
        detail: {
          agent: "lead",
          iteration_ref: 1,
          question: "short?",
          outcome: "cancel",
        },
      },
    ];
    const [full, lean] = byType(mapTrace(entries, ANCHOR).events, "user_question");
    expect(full!.question).toBe("continue?");
    expect(full!.answer).toBe("a".repeat(10));
    expect(full!.options).toEqual(["yes", "no"]);
    expect(full!.subagent_instance_id).toBe("w1");
    expect(lean!.question).toBe("short?");
    expect("answer" in lean!).toBe(false);
    expect("options" in lean!).toBe(false);
    expect("subagent_instance_id" in lean!).toBe(false);
  });

  it("soft_limit_check: carries new_checkpoint when present, omits when absent", () => {
    const entries: TraceEntry[] = [
      {
        at: 14,
        kind: "soft_limit_check",
        detail: {
          agent: "lead",
          dimension: "tokens",
          used: 90,
          limit: 100,
          outcome: "continued",
          new_checkpoint: 200,
          escalations: 1,
        },
      },
      {
        at: 15,
        kind: "soft_limit_check",
        detail: {
          agent: "subagent",
          dimension: "iterations",
          used: 5,
          limit: 5,
          outcome: "escalations_exhausted",
          escalations: 3,
        },
      },
    ];
    const [withCp, withoutCp] = byType(mapTrace(entries, ANCHOR).events, "soft_limit_check");
    expect(withCp!.new_checkpoint).toBe(200);
    expect(withCp!.occurred_at).toBe(ANCHOR + 14);
    expect("new_checkpoint" in withoutCp!).toBe(false);
    expect(withoutCp!.outcome).toBe("escalations_exhausted");
  });

  it("delegation_created: carries task_id/profile when present", () => {
    const entries: TraceEntry[] = [
      {
        at: 18,
        kind: "delegation_created",
        detail: {
          delegation_id: "w1",
          title: "t",
          task: "do it",
          tools: ["fs.read"],
          task_id: "task-1",
          profile: "researcher",
        },
      },
    ];
    const ev = byType(mapTrace(entries, ANCHOR).events, "delegation_created")[0]!;
    expect(ev.task_id).toBe("task-1");
    expect(ev.profile).toBe("researcher");
  });

  it("delegation_created: bounds a legacy task that bypassed the recording handle", () => {
    const entries: TraceEntry[] = [
      {
        at: 18,
        kind: "delegation_created",
        detail: {
          delegation_id: "w1",
          title: "t",
          task: "x".repeat(DELEGATE_TASK_MAX_CHARS + 1),
          tools: [],
        },
      },
    ];
    const ev = byType(mapTrace(entries, ANCHOR).events, "delegation_created")[0]!;
    expect(ev.task).toHaveLength(DELEGATE_TASK_MAX_CHARS);
    expect(ev.task.endsWith("...[truncated]")).toBe(true);
  });
});

describe("trace-mapper — user_steering", () => {
  it("maps a lead steer with absolute occurred_at and no subagent id", () => {
    const entries: TraceEntry[] = [
      {
        at: 12,
        kind: "user_steering",
        detail: {
          agent: "lead",
          iteration_ref: 3,
          message: "actually focus on the parser first",
        },
      },
    ];
    const ev = byType(mapTrace(entries, ANCHOR).events, "user_steering")[0]!;
    expect(ev).toEqual({
      type: "user_steering",
      agent: "lead",
      iteration_ref: 3,
      occurred_at: ANCHOR + 12,
      message: "actually focus on the parser first",
    });
    expect("subagent_instance_id" in ev).toBe(false);
  });

  it("carries subagent_instance_id and id when present", () => {
    const entries: TraceEntry[] = [
      {
        at: 7,
        kind: "user_steering",
        detail: {
          agent: "subagent",
          subagent_instance_id: "w1",
          iteration_ref: 1,
          message: "hi",
          id: "steer-42",
        },
      },
    ];
    const ev = byType(mapTrace(entries, ANCHOR).events, "user_steering")[0]!;
    expect(ev.subagent_instance_id).toBe("w1");
    expect(ev.id).toBe("steer-42");
  });
});

/**
 * The redaction contract at the persistence boundary. `mapEntry` is the one
 * funnel every event passes through on its way to `~/.clarvis/traces`, so what
 * it does here is what actually lands on disk.
 */
describe("mapEntry — what reaches the persisted trace", () => {
  const toolCall = (args: Record<string, unknown>, result: string): TraceEntry => ({
    at: 10,
    kind: "tool_call",
    detail: {
      agent: "lead",
      iteration_ref: 1,
      call_id: "c1",
      started_at: 5,
      ended_at: 10,
      name: "shell",
      arguments: args,
      result,
      error: null,
    },
  });

  it("does not persist a bearer token passed in tool arguments", () => {
    const ev = mapEntry(
      toolCall({ headers: { Authorization: "Bearer abc.DEF-123_xyz_secret" } }, "ok"),
      ANCHOR,
    );
    const dumped = JSON.stringify(ev);
    expect(dumped).not.toContain("abc.DEF-123_xyz_secret");
    expect(dumped).toContain("[redacted]");
  });
});
