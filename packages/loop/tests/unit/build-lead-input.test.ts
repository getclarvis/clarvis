import { describe, it, expect } from "../bun-test.ts";
import { buildLeadInputPersona } from "../../src/runtime/subagents/build-lead-input.ts";
import type { NamespacedRegistry } from "@clarvis/mcp-client";
import type { LoopAgentBuildContext } from "../../src/runtime/loop/loop-contract.ts";
import { createLiveContext, DISABLED_COMPACTION } from "../../src/runtime/context/index.ts";

const registry = (allUnavailable: boolean, toolCount: number): NamespacedRegistry =>
  ({
    tools: Array.from({ length: toolCount }, () => ({})),
    resolve: () => null,
    allUnavailable: () => allUnavailable,
  }) as unknown as NamespacedRegistry;

const persona = (
  overrides: Partial<Parameters<typeof buildLeadInputPersona>[0]> = {},
): ReturnType<typeof buildLeadInputPersona> =>
  buildLeadInputPersona({
    registry: registry(false, 0),
    entryMax: 10,
    softMode: false,
    leadHasBuiltins: false,
    subagentsHaveBuiltins: false,
    buildSubagentRegistry: () => registry(false, 0),
    ...overrides,
  });

describe("buildLeadInputPersona", () => {
  it("carries the lead knobs: full toolset, productive-only progress, 'Lead' empty-response agent", () => {
    const p = persona();
    expect(p.mcpFullToolset).toBe(true);
    expect(p.emptyResponseAgent).toBe("Lead");
    expect(p.noProgressLimit).toBeGreaterThan(0);
    expect(p.mcpProgress!({ errText: null, productive: true })).toBe(true);
    expect(p.mcpProgress!({ errText: "boom", productive: true })).toBe(false);
    expect(p.mcpProgress!({ errText: "timeout", productive: false })).toBe(false);
    expect(p.noProgressMessage!(4)).toContain("4 consecutive iterations");
    expect(p.textNoSubmitMessage!(3)).toContain("without calling submit_result");
  });

  it("reports all-tools-unavailable only when both the lead and subagent registries are down", () => {
    const bothDown = persona({
      registry: registry(true, 2),
      buildSubagentRegistry: () => registry(true, 1),
    });
    expect(bothDown.allToolsUnavailable!()).toBe(true);
    const subagentsUp = persona({
      registry: registry(true, 2),
      buildSubagentRegistry: () => registry(false, 1),
    });
    expect(subagentsUp.allToolsUnavailable!()).toBe(false);
    const subagentsToolless = persona({
      registry: registry(true, 2),
      buildSubagentRegistry: () => registry(false, 0),
    });
    expect(subagentsToolless.allToolsUnavailable!()).toBe(true);
  });

  it("never reports all-tools-unavailable when the lead or any spawnable profile has built-ins", () => {
    const viaLead = persona({
      registry: registry(true, 2),
      leadHasBuiltins: true,
      buildSubagentRegistry: () => registry(true, 1),
    });
    expect(viaLead.allToolsUnavailable!()).toBe(false);
    const viaSubagents = persona({
      registry: registry(true, 2),
      subagentsHaveBuiltins: true,
      buildSubagentRegistry: () => registry(true, 1),
    });
    expect(viaSubagents.allToolsUnavailable!()).toBe(false);
  });

  it("beforeCheckpoint appends the runtime budget note, honoring soft mode as unbounded iterations", () => {
    const notes: { kind: string; content: string }[] = [];
    const bc = {
      ctx: { appendRuntimeNote: (kind: string, content: string) => notes.push({ kind, content }) },
      budget: {
        ledger: { remaining: () => 120 },
        counter: { count: () => 3 },
      },
    } as unknown as LoopAgentBuildContext;
    persona({ entryMax: 10 }).buildBeforeCheckpoint!(bc)();
    expect(notes[0]).toEqual({
      kind: "tokens_remaining",
      content: "[runtime: tokens_remaining=120, lead_iterations_remaining=7]",
    });
    persona({ entryMax: 10, softMode: true }).buildBeforeCheckpoint!(bc)();
    expect(notes[1]).toEqual({
      kind: "tokens_remaining",
      content: "[runtime: tokens_remaining=120, lead_iterations_remaining=unbounded]",
    });
  });

  it("budget notes retain their frequency and append each observation", () => {
    const ctx = createLiveContext([], DISABLED_COMPACTION, { agent: "lead" });
    const bc = {
      ctx,
      budget: {
        ledger: { remaining: () => 120 },
        counter: { count: () => 3 },
      },
    } as unknown as LoopAgentBuildContext;
    const p = persona({ entryMax: 10 });
    p.buildBeforeCheckpoint!(bc)();
    p.buildBeforeCheckpoint!(bc)();
    const notes = ctx.messages.filter(
      (m) => typeof m.content === "string" && m.content.includes("tokens_remaining="),
    );
    expect(notes).toHaveLength(2);
  });
});
