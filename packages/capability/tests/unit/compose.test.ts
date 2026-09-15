import { describe, expect, it } from "../helpers/bun-test.ts";

import { capabilitiesForScope, foldContributions } from "../../src/compose.ts";
import type {
  AgentCapability,
  AgentLoopContribution,
  AgentScope,
  RunCapability,
} from "../../src/contract.ts";
import type { NamespacedTool } from "../../src/run.ts";
import type { FinalizeGate, ToolHandler } from "../../src/loop-contract.ts";

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

  it("carries one output budget and rejects ambiguous duplicates", () => {
    const outputBudget = { remaining: () => 10, reserveOutput: () => null };
    expect(foldContributions([{ outputBudget }]).outputBudget).toBe(outputBudget);
    expect(() => foldContributions([{ outputBudget }, { outputBudget }])).toThrow(/outputBudget/);
  });

  it("hook fields are absent when no contribution sets them (presence checks)", () => {
    const folded = foldContributions([{ tools: [tool("x")] }]);
    expect(folded.hooks).toEqual({});
  });

  it("awaits iteration preparation and stops the sweep on a terminal result or retired signal", async () => {
    for (const abort of [false, true]) {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const controller = new AbortController();
      const seen: string[] = [];
      const folded = foldContributions([
        {
          hooks: {
            async beforeIteration() {
              seen.push("first");
              entered.resolve();
              await release.promise;
              if (!abort)
                return {
                  status: "error",
                  partialText: "",
                  error: { code: "state_unavailable", message: "Unavailable" },
                };
            },
          },
        },
        {
          hooks: {
            beforeIteration: () => {
              seen.push("second");
            },
          },
        },
      ]);
      const pending = folded.hooks.beforeIteration!(controller.signal);
      await entered.promise;
      expect(seen).toEqual(["first"]);
      if (abort) controller.abort(new Error("retired"));
      release.resolve();
      if (abort) await expect(Promise.resolve(pending)).rejects.toThrow("retired");
      else expect(await pending).toMatchObject({ status: "error" });
      expect(seen).toEqual(["first"]);
    }
  });

  it("every hook fans out in contribution order; contributesProgress is an OR", async () => {
    const seen: string[] = [];
    const contribs: AgentLoopContribution[] = [
      {
        hooks: {
          beforeIteration: () => void seen.push("before-a"),
          afterDispatch: () => seen.push("after-a"),
          contributesProgress: () => false,
          onFinalizeAccepted: () => seen.push("finalize-a"),
          onTeardown: () => void seen.push("teardown-a"),
        },
      },
      {
        hooks: {
          beforeIteration: () => void seen.push("before-b"),
          afterDispatch: () => seen.push("after-b"),
          contributesProgress: () => true,
          onFinalizeAccepted: () => seen.push("finalize-b"),
          onTeardown: () => void seen.push("teardown-b"),
        },
      },
    ];
    const folded = foldContributions(contribs);
    await folded.hooks.beforeIteration!();
    folded.hooks.afterDispatch!();
    folded.hooks.onFinalizeAccepted!({ mode: "text", text: "finished" });
    await folded.hooks.onTeardown!();
    expect(seen).toEqual([
      "before-a",
      "before-b",
      "after-a",
      "after-b",
      "finalize-a",
      "finalize-b",
      "teardown-a",
      "teardown-b",
    ]);
    expect(folded.hooks.contributesProgress!()).toBe(true);
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

  it("maps a required entry attachment failure unless cancellation already retired it", () => {
    const failure = new Error("fixture attachment failed");
    const required: RunCapability = {
      name: "required",
      required: true,
      forAgent: () => ({
        attach: () => {
          throw failure;
        },
      }),
    };
    const entry = { ...scope, entry: true };
    const active = capabilitiesForScope([required], entry)[0]!;
    expect(() => active.attach({} as never)).toThrow("Required capability 'required'");

    const retired = capabilitiesForScope([required], {
      ...entry,
      signal: AbortSignal.abort(new Error("retired")),
    })[0]!;
    expect(() => retired.attach({} as never)).toThrow(failure);
  });
});
