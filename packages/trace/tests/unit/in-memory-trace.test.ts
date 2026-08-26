import { isBuiltinTraceEntry } from "@clarvis/capability";
import { describe, it, expect } from "bun:test";
import { createTrace } from "@clarvis/trace";
import { ARGS_MAX, MODEL_RESPONSE_MAX, RESULT_MAX, TRUNCATED_SUFFIX } from "@clarvis/trace";
import type { TraceEntry } from "@clarvis/capability";

describe("createTrace seal", () => {
  it("records normally before seal()", () => {
    const t = createTrace(0);
    t.record("run_started", { mode: "subagent-only", subagent_model: "m" });
    t.record("run_ended", { reason: "completed" });
    expect(t.entries()).toHaveLength(2);
  });

  it("drops record() (in-memory and onRecord) after seal()", () => {
    const streamed: TraceEntry[] = [];
    const t = createTrace(0, (e) => streamed.push(e));
    t.record("run_started", { mode: "subagent-only", subagent_model: "m" });
    t.record("run_ended", { reason: "completed" });
    t.seal();
    t.record("run_ended", { reason: "timeout", code: "timeout" });
    t.record("terminate", { reason: "completed" });
    expect(t.entries()).toHaveLength(2);
    expect(streamed).toHaveLength(2);
  });
});

describe("createTrace capping", () => {
  const bigToolCall = (result: string, content: string) =>
    ({
      agent: "lead",
      iteration_ref: 1,
      started_at: 0,
      ended_at: 1,
      name: "write",
      arguments: { content },
      result,
      error: null,
    }) as const;

  it("caps a recorded tool result and its arguments, in entries and on the onRecord stream", () => {
    const streamed: TraceEntry[] = [];
    const t = createTrace(0, (e) => streamed.push(e));
    t.record("tool_call", bigToolCall("x".repeat(200_000), "y".repeat(200_000)));

    const entry = t.entries()[0]!;
    if (!isBuiltinTraceEntry(entry) || entry.kind !== "tool_call")
      throw new Error("expected a tool_call entry");
    expect(entry.detail.result).toHaveLength(RESULT_MAX + TRUNCATED_SUFFIX.length);
    expect((entry.detail.arguments as { content: string }).content).toHaveLength(
      ARGS_MAX + TRUNCATED_SUFFIX.length,
    );
    expect(streamed[0]!.detail).toBe(entry.detail);
  });

  it("retains final model prose beyond the compact tool-result cap", () => {
    const response = "answer ".repeat(1_000);
    const t = createTrace(0);
    t.record("lead_iteration", {
      iteration: 1,
      started_at: 0,
      ended_at: 1,
      model: "m",
      input_tokens: 1,
      output_tokens: 1,
      cached_tokens: 0,
      cache_write_tokens: 0,
      cache_read_ratio: 0,
      response,
    });

    const entry = t.entries()[0]!;
    if (!isBuiltinTraceEntry(entry) || entry.kind !== "lead_iteration")
      throw new Error("expected a lead_iteration entry");
    expect(response.length).toBeGreaterThan(RESULT_MAX);
    expect(response.length).toBeLessThan(MODEL_RESPONSE_MAX);
    expect(entry.detail.response).toBe(response);
  });

  it("caps a signalled live chunk without persisting it", () => {
    const streamed: TraceEntry[] = [];
    const t = createTrace(0, (e) => streamed.push(e));
    t.signal("tool_output_delta", {
      agent: "lead",
      call_id: "c1",
      chunk: "z".repeat(200_000),
    });
    const signalled = streamed[0]!;
    if (!isBuiltinTraceEntry(signalled) || signalled.kind !== "tool_output_delta")
      throw new Error("expected a tool_output_delta");
    expect(signalled.detail.chunk.length).toBeLessThan(200_000);
    expect(t.entries()).toHaveLength(0);
  });

  it("does not let a run of large tool calls grow the trace in proportion to their output", () => {
    const t = createTrace(0);
    for (let i = 0; i < 50; i++) {
      t.record("tool_call", bigToolCall("x".repeat(128 * 1024), "y".repeat(128 * 1024)));
    }
    const retained = JSON.stringify(t.entries()).length;
    expect(retained).toBeLessThan(50 * (RESULT_MAX + ARGS_MAX + 1024));
    expect(retained).toBeLessThan(50 * 128 * 1024);
  });
});

describe("createTrace signal (live-only)", () => {
  it("notifies onRecord without persisting to entries", () => {
    const streamed: TraceEntry[] = [];
    const t = createTrace(0, (e) => streamed.push(e));
    t.record("run_started", { mode: "subagent-only", subagent_model: "m" });
    t.signal("model_stream_delta", {
      agent: "lead",
      iteration: 1,
      model: "m",
      channel: "text",
      text: "hel",
      reset: true,
    });
    t.signal("model_stream_delta", {
      agent: "lead",
      iteration: 1,
      model: "m",
      channel: "text",
      text: "lo",
      reset: false,
    });
    expect(streamed.filter((e) => e.kind === "model_stream_delta")).toHaveLength(2);
    expect(t.entries()).toHaveLength(1);
    expect(t.entries()[0]!.kind).toBe("run_started");
  });

  /**
   * Both paths reach the *same* sink with structurally identical entries, so a
   * consumer that persists cannot tell them apart from the entry alone. The
   * flag is the only thing standing between a journal and every streaming
   * delta the run produces.
   */
  it("tells the sink which entries are durable", () => {
    const seen: { kind: string; durable: boolean }[] = [];
    const t = createTrace(0, (e, durable) => seen.push({ kind: e.kind, durable }));
    t.record("run_started", { mode: "subagent-only", subagent_model: "m" });
    t.signal("model_stream_delta", {
      agent: "lead",
      iteration: 1,
      model: "m",
      channel: "text",
      text: "hi",
      reset: true,
    });

    expect(seen).toEqual([
      { kind: "run_started", durable: true },
      { kind: "model_stream_delta", durable: false },
    ]);
  });

  it("drops signal() after seal()", () => {
    const streamed: TraceEntry[] = [];
    const t = createTrace(0, (e) => streamed.push(e));
    t.seal();
    t.signal("model_stream_delta", {
      agent: "lead",
      iteration: 1,
      model: "m",
      channel: "text",
      text: "x",
      reset: true,
    });
    expect(streamed).toHaveLength(0);
    expect(t.entries()).toHaveLength(0);
  });
});
