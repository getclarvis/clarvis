import { describe, expect, it } from "../bun-test.ts";
import type {
  AgentCapability,
  AgentLoopContribution,
  LifecycleHook,
  PreFinalizeContext,
} from "@clarvis/capability";
import { createTrace } from "@clarvis/trace";
import { createTokenLedger, createIterationCounter } from "../../src/runtime/budget/index.ts";
import { DISABLED_COMPACTION } from "../../src/runtime/context/index.ts";
import { runAgent, type RunAgentInput } from "../../src/runtime/loop/run-agent.ts";
import { buildRegistry } from "../../src/runtime/tools/mcp-registry.ts";
import { compileResultContract } from "../../src/runtime/tools/index.ts";
import { MockLLM } from "../helpers/fixtures.ts";

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { name: { type: "string" } },
  required: ["name"],
};

interface WireMessage {
  role: string;
  content: unknown;
}

class SnapshotLLM extends MockLLM {
  readonly snapshots: WireMessage[][] = [];

  override async call(params: Parameters<MockLLM["call"]>[0]): ReturnType<MockLLM["call"]> {
    this.snapshots.push([...(params.messages as WireMessage[])]);
    return super.call(params);
  }
}

function input(
  llm: MockLLM,
  options: {
    hooks?: LifecycleHook[];
    contribution?: AgentLoopContribution;
    forceToolOnNudge?: boolean;
    contract?: boolean;
    noProgressLimit?: number;
  } = {},
): RunAgentInput {
  const capability: AgentCapability | undefined =
    options.contribution === undefined
      ? undefined
      : {
          attach: () => ({ ...options.contribution!, advertised: false }),
        };
  return {
    agent: "subagent",
    subagentInstanceId: "worker-1",
    messages: [{ role: "user", content: "go" }],
    ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
    target: {
      llm,
      model: "model",
      provider: "anthropic",
      capabilities: new Set(["tool_calling", "vision"]),
    },
    budget: {
      ledger: createTokenLedger(1_000_000),
      counter: createIterationCounter(50),
      usage: { input: 0, output: 0, cached: 0, cache_write: 0 },
    },
    runtime: { trace: createTrace() },
    compaction: DISABLED_COMPACTION,
    registry: buildRegistry([], []),
    ...(options.contract !== false ? { contract: compileResultContract(RESULT_SCHEMA) } : {}),
    mcpProgress: (result) => result.errText === null,
    allToolsUnavailable: () => false,
    noProgressLimit: options.noProgressLimit ?? 6,
    noProgressMessage: (streak) => `no progress for ${streak}.`,
    emptyResponseAgent: "LLM",
    ...(capability !== undefined ? { agentCapabilities: [capability] } : {}),
    ...(options.forceToolOnNudge !== undefined
      ? { forceToolOnNudge: options.forceToolOnNudge }
      : {}),
  };
}

const submit = { toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] };

describe("pre_finalize hook wiring", () => {
  it("passes the structured submit context from the loop to a fake hook", async () => {
    const seen: PreFinalizeContext[] = [];
    const llm = new MockLLM({ script: [submit] });

    const result = await runAgent(
      input(llm, {
        hooks: [
          {
            async preFinalize(context) {
              seen.push(context);
              return { kind: "pass" };
            },
          },
        ],
      }),
    );

    expect(result.status).toBe("completed");
    expect(result.structuredResult).toEqual({ value: { name: "Ada" } });
    expect(seen).toEqual([
      {
        agent: "subagent",
        subagentInstanceId: "worker-1",
        mode: "submit",
        value: { name: "Ada" },
      },
    ]);
  });

  it("feeds one denied finalize back to the model before a later pass", async () => {
    let attempts = 0;
    const llm = new SnapshotLLM({ script: [submit, submit] });
    const hooks: LifecycleHook[] = [
      {
        preFinalize: async () => {
          attempts += 1;
          return attempts === 1 ? { kind: "deny", message: "tests are red" } : { kind: "pass" };
        },
      },
    ];

    const result = await runAgent(input(llm, { hooks }));

    expect(result.status).toBe("completed");
    expect(attempts).toBe(2);
    const denial = llm.snapshots[1]!.find((message) => message.role === "tool");
    expect(denial?.content).toContain("finalize rejected by a workspace hook: tests are red");
  });

  it("runs an earlier capability gate before consulting preFinalize", async () => {
    let hookCalls = 0;
    let capabilityGateCalls = 0;
    const contribution: AgentLoopContribution = {
      gates: [
        {
          check: async () => {
            capabilityGateCalls += 1;
            return capabilityGateCalls === 1
              ? { kind: "nudge", note: "[runtime: tasks pending]" }
              : { kind: "pass" };
          },
        },
      ],
    };
    const llm = new MockLLM({ script: [submit, submit] });

    const result = await runAgent(
      input(llm, {
        contribution,
        hooks: [
          {
            preFinalize: async () => {
              hookCalls += 1;
              return { kind: "pass" };
            },
          },
        ],
      }),
    );

    expect(result.status).toBe("completed");
    expect(capabilityGateCalls).toBe(2);
    expect(hookCalls).toBe(1);
  });

  it("propagates a terminal capability gate through the submit handler", async () => {
    const contribution: AgentLoopContribution = {
      gates: [
        {
          fastAcceptOk: () => false,
          check: async () => ({
            kind: "terminal",
            result: {
              status: "error",
              partialText: "partial",
              error: { code: "no_progress", message: "capability stopped finalization" },
            },
          }),
        },
      ],
    };

    const result = await runAgent(input(new MockLLM({ script: [submit] }), { contribution }));

    expect(result).toMatchObject({
      status: "error",
      partialText: "partial",
      error: { code: "no_progress", message: "capability stopped finalization" },
    });
  });

  it("bounds a persistently denied text finalize through no-progress policy", async () => {
    const llm = new MockLLM({
      script: Array.from({ length: 10 }, () => ({ text: "not yet" })),
    });
    const hooks: LifecycleHook[] = [
      {
        preFinalize: async () => ({ kind: "deny", message: "still incomplete" }),
      },
    ];

    const result = await runAgent(input(llm, { hooks, contract: false, noProgressLimit: 2 }));

    expect(result).toMatchObject({ status: "error", error: { code: "no_progress" } });
    expect(llm.calls.length).toBeLessThanOrEqual(3);
  });
});

describe("force_tool_on_nudge wiring", () => {
  function nudgeFirst(count: number): AgentLoopContribution {
    let attempts = 0;
    return {
      gates: [
        {
          fastAcceptOk: () => attempts >= count,
          check: async () => {
            attempts += 1;
            return attempts <= count
              ? { kind: "nudge", note: "[runtime: do the thing]" }
              : { kind: "pass" };
          },
        },
      ],
    };
  }

  it.each([
    ["enabled", true, "required"],
    ["disabled", false, undefined],
  ] as const)("leaves the next model call %s", async (_label, enabled, expected) => {
    const llm = new MockLLM({ script: [submit, submit] });

    await runAgent(input(llm, { contribution: nudgeFirst(1), forceToolOnNudge: enabled }));

    expect(llm.calls[0]!.toolChoice).toBeUndefined();
    expect(llm.calls[1]!.toolChoice).toBe(expected);
  });

  it("forces each iteration immediately following a nudge", async () => {
    const llm = new MockLLM({ script: [submit, submit, submit] });

    await runAgent(input(llm, { contribution: nudgeFirst(2), forceToolOnNudge: true }));

    expect(llm.calls.map((entry) => entry.toolChoice)).toEqual([undefined, "required", "required"]);
  });
});

/**
 * A forced tool choice is consumed exactly once.
 *
 * @remarks The wiring tests above show every iteration *following a nudge* is
 * forced, which is the flag being set. What none of them shows is the flag being
 * cleared: their scripts end on the forced call, so a `takeForcedChoice` that
 * forgot to reset `forceToolNextIteration` would keep them all green while every
 * later iteration in a real run was silently forced to call a tool. That is not
 * a cosmetic difference — an agent permanently denied the option of answering
 * cannot finish, and the run dies on the iteration cap instead.
 *
 * The third iteration is reached by having the forced call name a tool the
 * registry does not carry: the dispatch reports an error, no finalize is
 * attempted, and the loop comes round again with the flag already spent.
 */
describe("the forced choice after a nudge is one-shot", () => {
  const unknownTool = { toolCalls: [{ name: "not_a_tool", arguments: {} }] };

  function nudgeOnce(): AgentLoopContribution {
    let attempts = 0;
    return {
      gates: [
        {
          fastAcceptOk: () => attempts >= 1,
          check: async () => {
            attempts += 1;
            return attempts <= 1
              ? { kind: "nudge", note: "[runtime: keep going]" }
              : { kind: "pass" };
          },
        },
      ],
    };
  }

  it("releases the force on the iteration after the forced one", async () => {
    const llm = new MockLLM({ script: [submit, unknownTool, submit] });

    await runAgent(input(llm, { contribution: nudgeOnce(), forceToolOnNudge: true }));

    expect(llm.calls.map((entry) => entry.toolChoice)).toEqual([undefined, "required", undefined]);
  });

  it("forces again only when a second nudge asks for it", async () => {
    let attempts = 0;
    const contribution: AgentLoopContribution = {
      gates: [
        {
          fastAcceptOk: () => attempts >= 2,
          check: async () => {
            attempts += 1;
            return attempts <= 2 ? { kind: "nudge", note: "[runtime: again]" } : { kind: "pass" };
          },
        },
      ],
    };
    const llm = new MockLLM({ script: [submit, unknownTool, submit, unknownTool, submit] });

    await runAgent(input(llm, { contribution, forceToolOnNudge: true }));

    expect(llm.calls.map((entry) => entry.toolChoice)).toEqual([
      undefined,
      "required",
      undefined,
      "required",
      undefined,
    ]);
  });
});

/**
 * `onTeardown` fires on every exit path from the iteration loop, and is awaited.
 *
 * @remarks It lives in the loop's `finally`, so "every path" includes the ones
 * no happy-path test reaches: a budget that runs out, a no-progress streak, and
 * an error thrown out of the loop body. A capability may hold background work —
 * a spawned child, an open elicit — that must wind down before the run's trace
 * and accounting close over it, so a teardown that silently did not run on the
 * failure paths would leak exactly where a run is least observed.
 *
 * Each case asserts the count, not merely that it happened: firing twice would
 * tear down a capability's state underneath its own second teardown.
 */
describe("onTeardown fires exactly once on every exit path", () => {
  function counting(): { contribution: AgentLoopContribution; count: () => number } {
    let count = 0;
    return {
      count: () => count,
      contribution: {
        hooks: {
          onTeardown: (): void => {
            count += 1;
          },
        },
      },
    };
  }

  it("on a completed run", async () => {
    const { contribution, count } = counting();
    const llm = new MockLLM({ script: [submit] });

    const result = await runAgent(input(llm, { contribution }));

    expect(result.status).toBe("completed");
    expect(count()).toBe(1);
  });

  it("on a no-progress termination", async () => {
    const { contribution, count } = counting();
    const llm = new MockLLM({
      script: Array.from({ length: 10 }, () => ({
        toolCalls: [{ name: "not_a_tool", arguments: {} }],
      })),
    });

    const result = await runAgent(input(llm, { contribution, noProgressLimit: 2 }));

    expect(result.status).toBe("error");
    expect(count()).toBe(1);
  });

  it("when the provider itself throws out of the loop", async () => {
    const { contribution, count } = counting();
    const llm = new MockLLM({ script: [{ throw: new Error("provider exploded") }] });

    await expect(runAgent(input(llm, { contribution }))).rejects.toThrow("provider exploded");
    expect(count()).toBe(1);
  });

  it("is awaited, so background work has settled before the run returns", async () => {
    let settled = false;
    const contribution: AgentLoopContribution = {
      hooks: {
        onTeardown: async (): Promise<void> => {
          await new Promise((r) => setTimeout(r, 10));
          settled = true;
        },
      },
    };
    const llm = new MockLLM({ script: [submit] });

    await runAgent(input(llm, { contribution }));

    expect(settled).toBe(true);
  });
});
