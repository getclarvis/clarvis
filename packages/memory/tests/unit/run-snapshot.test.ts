import { describe, expect, it } from "bun:test";

import { firstUserText, storedExecutionToRunSnapshot } from "../../src/run-snapshot.ts";
import type { TraceEvent } from "@clarvis/capability";
import { makeExecutionRecord } from "../helpers/fixtures.ts";

function toolCall(over: Partial<Extract<TraceEvent, { type: "tool_call" }>> = {}): TraceEvent {
  return {
    type: "tool_call",
    agent: "lead",
    iteration_ref: 1,
    started_at: 10,
    ended_at: 20,
    mcp_name: "fs",
    tool_name: "read_file",
    arguments: { path: "a.ts" },
    result: "ok",
    error: null,
    ...over,
  };
}

describe("storedExecutionToRunSnapshot", () => {
  it("maps identity, timing, task, final answer and tool calls", () => {
    const record = makeExecutionRecord({
      id: "exec_1",
      owner_key_name: "evandro",
      trace: {
        events: [
          { type: "init", occurred_at: 0 } as unknown as TraceEvent,
          toolCall({ call_id: "c1" }),
          {
            type: "user_steering",
            agent: "lead",
            iteration_ref: 2,
            occurred_at: 15,
            message: "focus on the tests",
          },
          toolCall({ subagent_instance_id: "sub-1", error: "boom", result: "" }),
        ],
      },
    });
    const snap = storedExecutionToRunSnapshot(record, { workspace: "/ws" });

    expect(snap.run_id).toBe("exec_1");
    expect(snap.workspace).toBe("/ws");
    expect(snap.status).toBe("completed");
    expect(snap.started_at).toBe(record.started_at);
    expect(snap.ended_at).toBe(record.ended_at);
    expect(snap.task).toBe("x");
    expect(snap.final_answer).toBe("r");
    expect(snap.tool_calls).toHaveLength(2);
    expect(snap.tool_calls[0]).toMatchObject({
      call_id: "c1",
      tool_name: "read_file",
      server: "fs",
      error: null,
    });
    expect(snap.tool_calls[1]).toMatchObject({ subagent: "sub-1", error: "boom" });
    expect(snap.steering).toEqual(["focus on the tests"]);
  });

  it("puts a builtin tool's bare name (carried in mcp_name) into tool_name with no server", () => {
    const record = makeExecutionRecord({
      id: "e",
      owner_key_name: "o",
      trace: { events: [toolCall({ mcp_name: "shell", tool_name: "" })] },
    });
    const snap = storedExecutionToRunSnapshot(record, { workspace: "/ws" });
    expect(snap.tool_calls[0]?.tool_name).toBe("shell");
    expect(snap.tool_calls[0]?.server).toBeUndefined();
  });

  it("re-truncates results to 2000 chars", () => {
    const record = makeExecutionRecord({
      id: "e",
      owner_key_name: "o",
      trace: { events: [toolCall({ result: "y".repeat(5000) })] },
    });
    const snap = storedExecutionToRunSnapshot(record, { workspace: "/ws" });
    expect(snap.tool_calls[0]?.result_excerpt.length).toBe(2000);
  });

  it("task is the FIRST user message, not the joined user text", () => {
    const record = makeExecutionRecord({ id: "e", owner_key_name: "o" });
    record.request = {
      ...record.request,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "the real task" },
        { role: "user", content: "a follow-up" },
      ],
    };
    expect(firstUserText(record.request.messages)).toBe("the real task");
    expect(storedExecutionToRunSnapshot(record, { workspace: "/ws" }).task).toBe("the real task");
  });

  it("omits final_answer for error runs and serializes structured results", () => {
    const errored = makeExecutionRecord({
      id: "e1",
      owner_key_name: "o",
      status: "error",
      response: {
        status: "error",
        error: { code: "internal_error", message: "x" },
        usage: { iterations_used: 1, elapsed_ms: 1, by_agent: [] },
      },
    });
    expect(
      storedExecutionToRunSnapshot(errored, { workspace: "/ws" }).final_answer,
    ).toBeUndefined();

    const structured = makeExecutionRecord({
      id: "e2",
      owner_key_name: "o",
      response: {
        status: "completed",
        result: { answer: 42 },
        usage: { iterations_used: 1, elapsed_ms: 1, by_agent: [] },
      },
    });
    expect(storedExecutionToRunSnapshot(structured, { workspace: "/ws" }).final_answer).toBe(
      '{"answer":42}',
    );
  });

  it("threads workspace_state through and omits empty steering", () => {
    const record = makeExecutionRecord({ id: "e", owner_key_name: "o" });
    const snap = storedExecutionToRunSnapshot(record, {
      workspace: "/ws",
      workspaceState: { vcs: "git", branch: "develop", commit: "abc", dirty: false },
    });
    expect(snap.workspace_state).toEqual({
      vcs: "git",
      branch: "develop",
      commit: "abc",
      dirty: false,
    });
    expect(snap.steering).toBeUndefined();
  });
});
