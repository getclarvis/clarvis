import { describe, it, expect } from "bun:test";
import {
  fromTraceEntry,
  fromTraceEvent,
  projectAgentEvent,
  waitAgeSeconds,
  type ProjectionState,
} from "../../src/projection.ts";
import type { TraceEntry } from "@clarvis/capability";
import type { TraceEvent } from "@clarvis/capability";

const NOW = 1_700_000_000_000;

function entry<K extends TraceEntry["kind"]>(kind: K, detail: unknown): TraceEntry {
  return { at: 0, kind, detail } as TraceEntry;
}

function project(e: TraceEntry, state: ProjectionState = {}, now = NOW): string | null {
  return projectAgentEvent(fromTraceEntry(e), state, now);
}

describe("agents projection — included kinds", () => {
  it("an iteration start opens a banner and sets the tag for later lines", () => {
    const state: ProjectionState = {};
    expect(project(entry("subagent_iteration_started", { iteration: 3 }), state)).toBe("[i3] ---");
    expect(state.lastIteration).toBe(3);
  });

  it("a repeated iteration start is not re-announced", () => {
    const state: ProjectionState = { lastIteration: 3 };
    expect(project(entry("subagent_iteration_started", { iteration: 3 }), state)).toBeNull();
  });

  it("a tool call carries an argument digest and an ok size", () => {
    const line = project(
      entry("tool_call", {
        name: "read_file",
        arguments: { path: "src/a.ts" },
        result: "x".repeat(3174),
        error: null,
      }),
      { lastIteration: 2 },
    );
    expect(line).toBe('[i2] tool read_file {path:"src/a.ts"} → ok 3.1kB');
  });

  it("a failed tool call reports err with the message, not the result size", () => {
    const line = project(
      entry("tool_call", {
        name: "shell",
        arguments: { command: "bun test" },
        result: "",
        error: "exit 1",
      }),
      { lastIteration: 2 },
    );
    expect(line).toBe('[i2] tool shell {command:"bun test"} → err exit 1');
  });

  it("an argument digest names the first key and counts the rest", () => {
    const line = project(
      entry("tool_call", {
        name: "edit",
        arguments: { path: "a.ts", old: "x", new: "y" },
        result: "ok",
        error: null,
      }),
      { lastIteration: 1 },
    );
    expect(line).toContain('{path:"a.ts", +2 more}');
  });

  it("a long argument value is truncated rather than pasted whole", () => {
    const line = project(
      entry("tool_call", {
        name: "shell",
        arguments: { command: "x".repeat(400) },
        result: "",
        error: null,
      }),
      { lastIteration: 1 },
    );
    expect(line!.length).toBeLessThan(140);
    expect(line).toContain("…");
  });

  it("assistant text is clipped with its full byte size retained", () => {
    const line = project(
      entry("subagent_iteration", { iteration: 3, response: "The test fails because ".repeat(40) }),
      {},
    );
    expect(line).toContain("[i3] text ");
    expect(line).toContain("…");
    expect(line).toMatch(/\((\d+(\.\d+)?)(B|kB)\)$/);
    expect(line).toContain("(920B)");
    expect(line!.length).toBeLessThan(300);
  });

  it("an empty assistant turn produces no line", () => {
    expect(project(entry("subagent_iteration", { iteration: 1, response: "" }), {})).toBeNull();
  });

  it("an elicitation opens a WAITING line and its resolution closes it with the age", () => {
    const state: ProjectionState = { lastIteration: 3 };
    const asked = project(
      entry("elicitation_requested", { source: "ask_user", question: "may I run bun install?" }),
      state,
      NOW,
    );
    expect(asked).toBe('[i3] elicit "may I run bun install?" — WAITING');
    expect(waitAgeSeconds(state, NOW + 42_000)).toBe(42);

    const resolved = project(
      entry("user_question", { question: "…", outcome: "accept" }),
      state,
      NOW + 42_000,
    );
    expect(resolved).toBe("[i3] elicit resolved: accept after 42s");
    expect(waitAgeSeconds(state, NOW + 90_000)).toBeUndefined();
  });

  it("a grandchild spawn is visible to the grandparent's poll", () => {
    expect(
      project(entry("delegation_created", { title: "extract the plaintiff" }), {
        lastIteration: 2,
      }),
    ).toBe('[i2] spawn sub-agent "extract the plaintiff"');
  });

  it("terminate and run_ended render their reason", () => {
    expect(project(entry("terminate", { reason: "no_progress" }), {})).toBe(
      "[--] terminate no_progress",
    );
    expect(project(entry("run_ended", { reason: "completed" }), {})).toBe("[--] ended completed");
  });
});

describe("agents projection — exclusions", () => {
  it("high-frequency signal kinds project to null even though they reach a trace sink", () => {
    expect(project(entry("model_stream_delta", { chunk: "a" }), {})).toBeNull();
    expect(project(entry("tool_output_delta", { call_id: "c", chunk: "a" }), {})).toBeNull();
  });

  it("bookkeeping kinds a parent cannot act on project to null", () => {
    expect(project(entry("compaction", { operation: "eviction" }), {})).toBeNull();
    expect(project(entry("budget_check", { tokens_used: 1, tokens_remaining: 2 }), {})).toBeNull();
    expect(project(entry("tool_call_started", { name: "x", call_id: "c" }), {})).toBeNull();
    expect(project(entry("init", {}), {})).toBeNull();
  });

  it("an unrecognized kind is dropped rather than throwing", () => {
    expect(projectAgentEvent({ kind: "something_new", detail: {} }, {}, NOW)).toBeNull();
  });
});

describe("agents projection — the leader (wire) adapter", () => {
  it("reassembles a wire tool_call's split name so one projector serves both shapes", () => {
    const event = {
      type: "tool_call",
      agent: "lead",
      iteration_ref: 2,
      started_at: 0,
      ended_at: 1,
      mcp_name: "fs",
      tool_name: "read_file",
      arguments: { path: "a.ts" },
      result: "ok",
      error: null,
    } as unknown as TraceEvent;
    expect(projectAgentEvent(fromTraceEvent(event), { lastIteration: 2 }, NOW)).toBe(
      '[i2] tool fs.read_file {path:"a.ts"} → ok 2B',
    );
  });

  it("a builtin tool with no mcp name keeps its bare name", () => {
    const event = {
      type: "tool_call",
      mcp_name: "",
      tool_name: "shell",
      arguments: {},
      result: "",
      error: null,
    } as unknown as TraceEvent;
    expect(projectAgentEvent(fromTraceEvent(event), { lastIteration: 1 }, NOW)).toContain(
      "tool shell",
    );
  });

  it("projects a leader's own iterations the same way as a sub-agent's", () => {
    const event = {
      type: "lead_iteration",
      iteration: 4,
      response: "done",
    } as unknown as TraceEvent;
    expect(projectAgentEvent(fromTraceEvent(event), {}, NOW)).toBe('[i4] text "done" (4B)');
  });
});

/**
 * The arms a child reaches only once it starts producing children or blocking on
 * a human — the ones that make `agent_poll` answer "is it going well?" rather
 * than "is it alive?".
 */
describe("agents projection — spawning, waiting and ending", () => {
  it("falls back from a spawn's title to its task, and to empty", () => {
    expect(project(entry("delegation_created", { task: "audit the parser" }), {})).toBe(
      '[--] spawn sub-agent "audit the parser"',
    );
    expect(project(entry("delegation_created", {}), {})).toBe('[--] spawn sub-agent ""');
  });

  it("names a spawned leader by its task, so a manager's fan-out is visible too", () => {
    expect(project(entry("workflow_run_started", { task: "wave 1" }), { lastIteration: 2 })).toBe(
      '[i2] spawn leader "wave 1"',
    );
    expect(project(entry("workflow_run_started", {}), {})).toBe('[--] spawn leader ""');
  });

  it("reports an answer with no recorded wait without inventing a duration", () => {
    expect(project(entry("user_question", {}), { lastIteration: 1 })).toBe(
      "[i1] elicit resolved: ?",
    );
  });

  it("shows a steer's text, a cancellation's reason and a model error's message", () => {
    expect(project(entry("user_steering", { message: "focus on tests" }), {})).toBe(
      '[--] steer "focus on tests"',
    );
    expect(project(entry("cancellation", { reason: "parent stopped" }), {})).toBe(
      "[--] cancelled: parent stopped",
    );
    expect(project(entry("cancellation", {}), {})).toBe("[--] cancelled");
    expect(project(entry("model_call_error", { message: "overloaded" }), {})).toBe(
      "[--] model error overloaded",
    );
    expect(project(entry("model_call_error", { error: "overloaded" }), {})).toBe(
      "[--] model error overloaded",
    );
  });
});
