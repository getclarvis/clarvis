import { describe, expect, it, vi } from "bun:test";

import type { MemoryToolDef } from "../../src/index.ts";

import { buildMemoryToolsHandler } from "../../src/capability.ts";
import { buildMemoryToolset } from "../../src/toolset.ts";
import { makeTrace as createTrace } from "../helpers/capability.ts";
import type { LLMToolCall } from "@clarvis/capability";

function call(name: string, args: unknown = {}, id = "c1"): LLMToolCall {
  return { id, name, arguments: args };
}

/** buildMemoryToolset takes the tool list directly; this just names the array. */
function toolsOf(tools: MemoryToolDef[]): MemoryToolDef[] {
  return tools;
}

function searchTool(over: Partial<MemoryToolDef> = {}): MemoryToolDef {
  return {
    name: "search_records",
    description: "search",
    parameters: { type: "object", properties: {} },
    execute: vi.fn().mockResolvedValue({ text: "hit: rec_1", isError: false }),
    ...over,
  };
}

describe("buildMemoryToolset", () => {
  it("maps MemoryToolDefs to bare-wire-name NamespacedTools", () => {
    const toolset = buildMemoryToolset(toolsOf([searchTool()]), 4);
    expect(toolset.defs).toHaveLength(1);
    expect(toolset.defs[0]).toMatchObject({
      fullName: "search_records",
      wireName: "search_records",
      mcpName: "",
      toolName: "search_records",
      description: "search",
    });
    expect(toolset.names.has("search_records")).toBe(true);
    expect(toolset.callLimit).toBe(4);
  });

  it("dispatch routes to the def and reports unknown names as errors", async () => {
    const execute = vi.fn().mockResolvedValue({ text: "ok", isError: false });
    const toolset = buildMemoryToolset(toolsOf([searchTool({ execute })]), 4);
    const controller = new AbortController();
    await toolset.dispatch("search_records", { query: "x" }, controller.signal);
    expect(execute).toHaveBeenCalledWith({ query: "x" }, controller.signal);

    const unknown = await toolset.dispatch("nope", {});
    expect(unknown.isError).toBe(true);
  });
});

describe("buildMemoryToolsHandler", () => {
  it("matches only memory tool names and executes with trace envelopes", async () => {
    const trace = createTrace();
    const toolset = buildMemoryToolset(toolsOf([searchTool()]), 4);
    const handler = buildMemoryToolsHandler({ base: { trace, agent: "lead" }, toolset });

    expect(handler.matches(call("search_records"))).toBe(true);
    expect(handler.matches(call("fs.read"))).toBe(false);

    const verdict = await handler.handle(call("search_records", { query: "x" }), 1);
    expect(verdict).toMatchObject({ kind: "result", progress: true });
    expect((verdict as { text: string }).text).toContain("hit: rec_1");
    const events = trace.entries().map((e) => e.kind);
    expect(events).toContain("tool_call_started");
    expect(events).toContain("tool_call");
  });

  it("maps error results to a failing envelope with no progress", async () => {
    const tool = searchTool({
      execute: vi.fn().mockResolvedValue({ text: "Invalid arguments: query", isError: true }),
    });
    const handler = buildMemoryToolsHandler({
      base: { trace: createTrace(), agent: "lead" },
      toolset: buildMemoryToolset(toolsOf([tool]), 4),
    });
    const verdict = await handler.handle(call("search_records"), 1);
    expect(verdict).toMatchObject({ kind: "result", progress: false });
    expect((verdict as { text: string }).text).toContain("Invalid arguments");
  });

  it("refuses softly after the per-run call budget without invoking the tool", async () => {
    const execute = vi.fn().mockResolvedValue({ text: "ok", isError: false });
    const toolset = buildMemoryToolset(toolsOf([searchTool({ execute })]), 2);
    const handler = buildMemoryToolsHandler({
      base: { trace: createTrace(), agent: "lead" },
      toolset,
    });

    await handler.handle(call("search_records", { query: "a" }), 1);
    await handler.handle(call("search_records", { query: "b" }), 2);
    const third = await handler.handle(call("search_records", { query: "c" }), 3);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(third).toMatchObject({ kind: "result", progress: false });
    expect((third as { text: string }).text).toContain("budget for this run is exhausted");
  });

  it("each handler instance gets its own budget even when the toolset is shared", async () => {
    const toolset = buildMemoryToolset(toolsOf([searchTool()]), 1);
    const lead = buildMemoryToolsHandler({
      base: { trace: createTrace(), agent: "lead" },
      toolset,
    });
    const sub = buildMemoryToolsHandler({
      base: { trace: createTrace(), agent: "subagent", subagentInstanceId: "s1" },
      toolset,
    });
    const a = await lead.handle(call("search_records", { query: "a" }), 1);
    const b = await sub.handle(call("search_records", { query: "b" }), 1);
    expect(a).toMatchObject({ progress: true });
    expect(b).toMatchObject({ progress: true });
  });
});
