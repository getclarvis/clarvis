import { describe, it, expect } from "../bun-test.ts";
import { buildSubagentInputPersona } from "../../src/runtime/subagents/build-subagent-input.ts";
import { createTrace } from "@clarvis/trace";
import type { NamespacedRegistry } from "@clarvis/mcp-client";

const registry = (allUnavailable: boolean, toolCount: number): NamespacedRegistry =>
  ({
    tools: Array.from({ length: toolCount }, () => ({})),
    resolve: () => null,
    allUnavailable: () => allUnavailable,
  }) as unknown as NamespacedRegistry;

describe("buildSubagentInputPersona", () => {
  it("includes a 'Current task' anchor and the shared subagent knobs for a non-empty task", () => {
    const p = buildSubagentInputPersona({
      registry: registry(false, 0),
      subagentTaskBody: "do the thing",
      subagentInstanceId: "w1",
      model: "anthropic/x",
      trace: createTrace(),
      hasBuiltinTools: false,
    });
    expect(p.staticAnchor).toEqual({ label: "Current task", body: "do the thing" });
    expect(p.noProgressLimit).toBeGreaterThan(0);
    expect(p.emptyResponseAgent).toBe("LLM");
    expect(p.mcpProgress!({ errText: null, productive: false })).toBe(true);
    expect(p.mcpProgress!({ errText: "boom", productive: true })).toBe(false);
    expect(p.noProgressMessage!(3)).toContain("3 consecutive iterations");
  });

  it("omits the anchor when the task body is empty", () => {
    const p = buildSubagentInputPersona({
      registry: registry(false, 0),
      subagentTaskBody: "",
      subagentInstanceId: "w1",
      model: "m",
      trace: createTrace(),
      hasBuiltinTools: false,
    });
    expect(p.staticAnchor).toBeUndefined();
  });

  it("reports all-tools-unavailable only when tools exist and all are unavailable", () => {
    const trace = createTrace();
    const withTools = buildSubagentInputPersona({
      registry: registry(true, 2),
      subagentTaskBody: "t",
      subagentInstanceId: "w1",
      model: "m",
      trace,
      hasBuiltinTools: false,
    });
    expect(withTools.allToolsUnavailable!()).toBe(true);
    const noTools = buildSubagentInputPersona({
      registry: registry(true, 0),
      subagentTaskBody: "t",
      subagentInstanceId: "w1",
      model: "m",
      trace,
      hasBuiltinTools: false,
    });
    expect(noTools.allToolsUnavailable!()).toBe(false);
  });

  it("never reports all-tools-unavailable when built-in tools are present", () => {
    const p = buildSubagentInputPersona({
      registry: registry(true, 2),
      subagentTaskBody: "t",
      subagentInstanceId: "w1",
      model: "m",
      trace: createTrace(),
      hasBuiltinTools: true,
    });
    expect(p.allToolsUnavailable!()).toBe(false);
  });

  it("onStart records a delegation_started event carrying the instance id and model", () => {
    const trace = createTrace();
    const p = buildSubagentInputPersona({
      registry: registry(false, 0),
      subagentTaskBody: "t",
      subagentInstanceId: "w-abc",
      model: "anthropic/haiku",
      trace,
      hasBuiltinTools: false,
    });
    p.onStart!();
    const started = trace.entries().find((e) => e.kind === "delegation_started");
    expect(started).toBeDefined();
    expect(JSON.stringify(started)).toContain("w-abc");
  });
});
