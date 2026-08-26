import { describe, expect, it } from "../bun-test.ts";
import type {
  ConvergenceGuards,
  LLMToolCall,
  TraceDetailFor,
  TraceKind,
  TracePort,
} from "@clarvis/capability";
import { buildAgentToolsHandler } from "../../src/runtime/capabilities/tools.ts";
import type { AgentToolResult, AgentToolset } from "../../src/runtime/tools/builtin/toolset.ts";

function call(name: string, args: unknown, id = "c1"): LLMToolCall {
  return { id, name, arguments: args };
}

interface FakeTrace extends TracePort {
  records: Array<{ kind: TraceKind; detail: unknown }>;
  signals: Array<{ kind: TraceKind; detail: unknown }>;
}

function fakeTrace(): FakeTrace {
  const records: FakeTrace["records"] = [];
  const signals: FakeTrace["signals"] = [];
  let clock = 0;
  return {
    records,
    signals,
    record<K extends TraceKind>(kind: K, detail: TraceDetailFor<K>) {
      records.push({ kind, detail });
    },
    signal<K extends TraceKind>(kind: K, detail: TraceDetailFor<K>) {
      signals.push({ kind, detail });
    },
    now() {
      clock += 1;
      return clock;
    },
  };
}

interface FakeGuards extends ConvergenceGuards {
  records: Array<[signature: string, result: string, isError: boolean]>;
}

function fakeGuards(): FakeGuards {
  const records: FakeGuards["records"] = [];
  return {
    records,
    record(signature, result, isError) {
      records.push([signature, result, isError]);
    },
    takeSoft: () => [],
    tripped: () => null,
    reset: () => {},
  };
}

interface FakeToolset extends AgentToolset {
  calls: Array<{
    name: string;
    args: Record<string, unknown>;
    signal?: AbortSignal;
  }>;
}

function fakeToolset(
  result: AgentToolResult,
  names: readonly string[] = ["read_file", "write_file"],
): FakeToolset {
  const calls: FakeToolset["calls"] = [];
  return {
    defs: [],
    names: new Set(names),
    calls,
    async dispatch(name, args, signal, onOutput) {
      calls.push({ name, args, ...(signal !== undefined ? { signal } : {}) });
      onOutput?.("live chunk");
      return result;
    },
  };
}

function build(result: AgentToolResult, signal?: AbortSignal) {
  const trace = fakeTrace();
  const guards = fakeGuards();
  const toolset = fakeToolset(result);
  const progressInputs: Array<{ errText: string | null; productive: boolean }> = [];
  const handler = buildAgentToolsHandler({
    base: {
      trace,
      agent: "subagent",
      subagentInstanceId: "worker-1",
      ...(signal !== undefined ? { signal } : {}),
    },
    toolset,
    guards,
    progress(input) {
      progressInputs.push(input);
      return input.errText === null;
    },
  });
  return { handler, trace, guards, toolset, progressInputs };
}

describe("buildAgentToolsHandler", () => {
  it("matches only names exposed by the injected toolset", () => {
    const { handler } = build({ isError: false, text: "ok" });

    expect(handler.matches(call("read_file", {}))).toBe(true);
    expect(handler.matches(call("shell", {}))).toBe(false);
    expect(handler.matches(call("ask_user", {}))).toBe(false);
  });

  it("dispatches success through the port and records durable/live trace separately", async () => {
    const { handler, trace, guards, toolset, progressInputs } = build({
      isError: false,
      text: "written",
      diff: "@@ -1 +1 @@",
      images: [{ data: "AAAA", mediaType: "image/png" }],
    });

    const verdict = await handler.handle(call("write_file", { path: "a.txt" }, "call-9"), 3);

    expect(verdict).toEqual({
      kind: "result",
      text: "Tool 'write_file' result: written",
      progress: true,
      images: [{ data: "AAAA", mediaType: "image/png" }],
    });
    expect(toolset.calls).toEqual([{ name: "write_file", args: { path: "a.txt" } }]);
    expect(trace.signals).toEqual([
      {
        kind: "tool_output_delta",
        detail: {
          agent: "subagent",
          subagent_instance_id: "worker-1",
          call_id: "call-9",
          chunk: "live chunk",
        },
      },
    ]);
    expect(trace.records.map((entry) => entry.kind)).toEqual(["tool_call_started", "tool_call"]);
    expect(trace.records[1]!.detail).toMatchObject({
      name: "write_file",
      error: null,
      diff: "@@ -1 +1 @@",
      started_at: 1,
      ended_at: 2,
    });
    expect(guards.records).toEqual([['write_file:{"path":"a.txt"}', "written", false]]);
    expect(progressInputs).toEqual([{ errText: null, productive: true }]);
  });

  it("wraps a dispatch failure without turning it into an exception", async () => {
    const { handler, trace, guards, progressInputs } = build({ isError: true, text: "denied" });

    const verdict = await handler.handle(call("write_file", {}), 1);

    expect(verdict).toEqual({
      kind: "result",
      text: "Tool 'write_file' result (error): denied",
      progress: false,
    });
    expect(trace.records[1]!.detail).toMatchObject({ error: "denied", result: "denied" });
    expect(guards.records).toEqual([["write_file:{}", "denied", true]]);
    expect(progressInputs).toEqual([{ errText: "denied", productive: false }]);
  });

  it("owns malformed provider arguments without calling the dispatch port", async () => {
    const { handler, toolset, trace, guards } = build({ isError: false, text: "unused" });
    const malformed = {
      ...call("read_file", {}, "bad-call"),
      malformedArguments: '{"path":',
    };

    const verdict = await handler.handle(malformed, 2);

    expect(verdict.kind).toBe("result");
    if (verdict.kind === "result") expect(verdict.text).toContain("truncated or malformed");
    expect(toolset.calls).toEqual([]);
    expect(trace.records.map((entry) => entry.kind)).toEqual(["tool_call"]);
    expect(guards.records[0]?.[0]).toBe('read_file:malformed:{"path":');
  });

  it("does not feed convergence after the run has been aborted", async () => {
    const signal = AbortSignal.abort();
    const { handler, guards, toolset } = build({ isError: true, text: "cancelled" }, signal);

    await handler.handle(call("read_file", {}), 1);

    expect(toolset.calls[0]?.signal).toBe(signal);
    expect(guards.records).toEqual([]);
  });
});
