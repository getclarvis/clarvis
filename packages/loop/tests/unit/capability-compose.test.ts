import { describe, expect, it } from "../bun-test.ts";

import { capabilitiesForScope, foldContributions } from "@clarvis/capability";
import type {
  AgentCapability,
  AgentLoopContribution,
  AgentScope,
  RunCapability,
} from "@clarvis/capability";
import type { NamespacedTool } from "@clarvis/capability";
import type { FinalizeGate, ToolHandler } from "../../src/runtime/loop/loop-contract.ts";

function tool(name: string): NamespacedTool {
  return {
    fullName: name,
    wireName: name,
    mcpName: "",
    toolName: name,
    description: name,
    inputSchema: { type: "object", properties: {} },
  };
}

function handler(name: string): ToolHandler {
  return {
    matches: (call) => call.name === name,
    handle: () => Promise.resolve({ kind: "result", text: "", progress: false }),
  };
}

const gate: FinalizeGate = { check: () => Promise.resolve({ kind: "pass" }) };

describe("foldContributions", () => {
  it("concatenates tools, handlers and gates in contribution order", () => {
    const folded = foldContributions([
      { tools: [tool("a1"), tool("a2")], handlers: [handler("a")], gates: [gate] },
      { tools: [tool("b1")], handlers: [handler("b")] },
    ]);
    expect(folded.tools.map((t) => t.wireName)).toEqual(["a1", "a2", "b1"]);
    expect(folded.handlers).toHaveLength(2);
    expect(folded.gates).toHaveLength(1);
  });

  it("advertised: false keeps tools out of advertisedTools but in tools", () => {
    const folded = foldContributions([
      { tools: [tool("adv")] },
      { tools: [tool("hidden")], advertised: false },
    ]);
    expect(folded.tools.map((t) => t.wireName)).toEqual(["adv", "hidden"]);
    expect(folded.advertisedTools.map((t) => t.wireName)).toEqual(["adv"]);
  });

  it("rejects a tool wire name claimed by two contributions", () => {
    expect(() =>
      foldContributions([{ tools: [tool("read_files")] }, { tools: [tool("read_files")] }]),
    ).toThrow(/duplicate tool wire name 'read_files'/);
    expect(() => foldContributions([{ tools: [tool("dup"), tool("dup")] }])).toThrow(
      /duplicate tool wire name 'dup'/,
    );
  });

  it("rejects two contributions providing an anchor (or a forcedChoice)", () => {
    const anchor = (): undefined => undefined;
    expect(() => foldContributions([{ anchor }, { anchor }])).toThrow(/anchor/);
    const forcedChoice = (): undefined => undefined;
    expect(() => foldContributions([{ forcedChoice }, { forcedChoice }])).toThrow(/forcedChoice/);
    const single = foldContributions([{ anchor }, {}]);
    expect(single.anchor).toBe(anchor);
  });

  it("hook fields are absent when no contribution sets them (presence checks)", () => {
    const folded = foldContributions([{ tools: [tool("x")] }]);
    expect(folded.hooks.beforeIteration).toBeUndefined();
    expect(folded.hooks.contributesProgress).toBeUndefined();
    expect(folded.hooks.onFinalizeAccepted).toBeUndefined();
  });

  it("hooks fan out to every contribution; contributesProgress is an OR", async () => {
    const seen: string[] = [];
    const contribs: AgentLoopContribution[] = [
      {
        hooks: {
          beforeIteration: () => seen.push("a"),
          contributesProgress: () => false,
        },
      },
      {
        hooks: {
          beforeIteration: () => seen.push("b"),
          contributesProgress: () => true,
          onTeardown: (): void => {
            seen.push("teardown-b");
          },
        },
      },
    ];
    const folded = foldContributions(contribs);
    folded.hooks.beforeIteration!();
    expect(seen).toEqual(["a", "b"]);
    expect(folded.hooks.contributesProgress!()).toBe(true);
    await folded.hooks.onTeardown!();
    expect(seen).toContain("teardown-b");
  });
});

describe("capabilitiesForScope", () => {
  const scope: AgentScope = { agent: "subagent", entry: false, grants: ["use_skills"] };

  it("activates per scope and drops nulls", () => {
    const active: AgentCapability = { attach: () => ({}) };
    const caps: RunCapability[] = [
      { name: "yes", forAgent: () => active },
      { name: "no", forAgent: () => null },
    ];
    expect(capabilitiesForScope(caps, scope)).toEqual([active]);
    expect(capabilitiesForScope(undefined, scope)).toEqual([]);
  });

  it("passes the scope through to forAgent", () => {
    const scopes: AgentScope[] = [];
    const caps: RunCapability[] = [
      {
        name: "spy",
        forAgent: (s) => {
          scopes.push(s);
          return null;
        },
      },
    ];
    capabilitiesForScope(caps, scope);
    expect(scopes).toEqual([scope]);
  });
});
