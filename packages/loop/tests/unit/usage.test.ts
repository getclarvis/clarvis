import { describe, it, expect } from "../bun-test.ts";
import { finalizeLeadSubagentUsage } from "../../src/runtime/usage.ts";
import type { SubagentAggregate } from "@clarvis/capability";

describe("finalizeLeadSubagentUsage", () => {
  it("builds [lead, subagent] entries and sums iterations_used", () => {
    const usage = finalizeLeadSubagentUsage({
      leadModel: "anthropic/claude-opus-4-5",
      primarySubagentModel: "anthropic/claude-haiku-4-5",
      leadUsage: { input: 150, output: 30, cached: 8, cache_write: 0 },
      leadIterations: 5,
      subagentsByModel: new Map<string, SubagentAggregate>([
        [
          "anthropic/claude-haiku-4-5",
          { input: 1200, output: 438, cached: 0, cache_write: 0, iterations: 7, instances: 3 },
        ],
      ]),
      elapsedMs: 1840.6,
    });

    expect(usage.iterations_used).toBe(12);
    expect(usage.elapsed_ms).toBe(1841);
    expect(usage.by_agent).toEqual([
      {
        type: "lead",
        model: "anthropic/claude-opus-4-5",
        input_tokens: 150,
        output_tokens: 30,
        cached_tokens: 8,
        cache_write_tokens: 0,
        iterations: 5,
        subagents_spawned: 3,
      },
      {
        type: "subagent",
        model: "anthropic/claude-haiku-4-5",
        input_tokens: 1200,
        output_tokens: 438,
        cached_tokens: 0,
        cache_write_tokens: 0,
        iterations: 7,
        instances: 3,
      },
    ]);
    expect(usage.warnings).toBeUndefined();
  });

  it("emits one subagent entry per distinct model when the Lead spawns a mix", () => {
    const usage = finalizeLeadSubagentUsage({
      leadModel: "anthropic/claude-opus-4-5",
      primarySubagentModel: "anthropic/claude-haiku-4-5",
      leadUsage: { input: 10, output: 5, cached: 0, cache_write: 0 },
      leadIterations: 4,
      subagentsByModel: new Map<string, SubagentAggregate>([
        [
          "anthropic/claude-haiku-4-5",
          { input: 100, output: 40, cached: 0, cache_write: 0, iterations: 3, instances: 2 },
        ],
        [
          "openai/gpt-x",
          { input: 200, output: 60, cached: 1, cache_write: 0, iterations: 5, instances: 1 },
        ],
      ]),
      elapsedMs: 10,
    });

    const subagents = usage.by_agent.filter((a) => a.type === "subagent");
    expect(subagents).toHaveLength(2);
    expect(subagents.map((w) => w.model)).toEqual(["anthropic/claude-haiku-4-5", "openai/gpt-x"]);
    const lead = usage.by_agent[0] as { subagents_spawned: number };
    expect(lead.subagents_spawned).toBe(3);
    expect(usage.iterations_used).toBe(4 + 3 + 5);
  });

  it("reports instances:0 and subagents_spawned:0 when the Lead never spawns", () => {
    const usage = finalizeLeadSubagentUsage({
      leadModel: "anthropic/claude-opus-4-5",
      primarySubagentModel: "anthropic/claude-haiku-4-5",
      leadUsage: { input: 20, output: 10, cached: 0, cache_write: 0 },
      leadIterations: 1,
      subagentsByModel: new Map(),
      elapsedMs: 5,
    });
    const lead = usage.by_agent[0] as { subagents_spawned: number };
    const subagent = usage.by_agent[1] as { instances: number; iterations: number; model: string };
    expect(lead.subagents_spawned).toBe(0);
    expect(subagent.model).toBe("anthropic/claude-haiku-4-5");
    expect(subagent.instances).toBe(0);
    expect(subagent.iterations).toBe(0);
    expect(usage.iterations_used).toBe(1);
  });

  it("includes warnings when present", () => {
    const usage = finalizeLeadSubagentUsage({
      leadModel: "anthropic/o",
      primarySubagentModel: "anthropic/w",
      leadUsage: { input: 1, output: 1, cached: 0, cache_write: 0 },
      leadIterations: 1,
      subagentsByModel: new Map(),
      elapsedMs: 1,
      warnings: ["subagent_has_no_tools"],
    });
    expect(usage.warnings).toEqual(["subagent_has_no_tools"]);
  });
});
