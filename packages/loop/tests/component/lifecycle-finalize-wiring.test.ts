import { describe, expect, it } from "../bun-test.ts";
import type {
  AgentCapability,
  AgentLoopContribution,
  LifecycleHook,
  PreFinalizeContext,
} from "@clarvis/capability";
import { createTrace } from "@clarvis/trace";
import {
  createTokenLedger,
  createIterationCounter,
  type IterationCounter,
} from "../../src/runtime/budget/index.ts";
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
    contract?: boolean;
    noProgressLimit?: number;
    /** Supplied by a case that needs to compare the counted iterations with the calls made. */
    counter?: IterationCounter;
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
      counter: options.counter ?? createIterationCounter(50),
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

/**
 * A finalize gate's nudge is answered with feedback, never with a forced tool.
 *
 * @remarks The loop used to put `toolChoice: "required"` on the iteration after
 * any nudge, for every gate in every persona. Two things were wrong with that.
 * A provider that refuses a forced choice — a thinking model, for one — answered
 * the nudge with an HTTP 400 that ended the run, so the recovery the nudge exists
 * to trigger became the failure. And where it was accepted it answered a
 * wrong-*tool* problem with a *different* wrong tool, because "you must call
 * something" says nothing about which call was missing; the gate's own note is
 * what says that. So every case here asserts on the calls the provider actually
 * received: the note is present, `toolChoice` is absent, and a gate that keeps
 * refusing still terminates through the pre-existing no-progress policy.
 */
describe("a finalize-gate nudge never forces a tool call", () => {
  const NUDGE_NOTE = "[runtime: do the thing]";

  function nudgeFirst(count: number, unbounded = false): AgentLoopContribution {
    let attempts = 0;
    return {
      gates: [
        {
          fastAcceptOk: () => attempts >= count,
          check: async () => {
            attempts += 1;
            return attempts <= count
              ? { kind: "nudge", note: NUDGE_NOTE, unbounded }
              : { kind: "pass" };
          },
        },
      ],
    };
  }

  it("continues a refused text finish with the gate's note, unforced", async () => {
    const llm = new MockLLM({ script: [{ text: "not yet" }, { text: "done" }] });

    const result = await runAgent(input(llm, { contribution: nudgeFirst(1), contract: false }));

    expect(result.status).toBe("completed");
    expect(llm.calls.map((call) => call.toolChoice)).toEqual([undefined, undefined]);
    const followed = JSON.stringify(llm.calls[1]!.messages);
    expect(followed).toContain(NUDGE_NOTE);
    expect(JSON.stringify(llm.calls[0]!.messages)).not.toContain(NUDGE_NOTE);
  });

  it("continues a refused submit through the tool envelope, unforced", async () => {
    const llm = new MockLLM({ script: [submit, submit] });

    const result = await runAgent(input(llm, { contribution: nudgeFirst(1) }));

    expect(result.status).toBe("completed");
    expect(llm.calls.map((call) => call.toolChoice)).toEqual([undefined, undefined]);
    const denial = llm.calls[1]!.messages.find((message) => message.role === "tool");
    expect(JSON.stringify(denial)).toContain(NUDGE_NOTE);
  });

  it("keeps every later call unforced across nudges in both modes", async () => {
    let attempts = 0;
    const contribution: AgentLoopContribution = {
      gates: [
        {
          check: async () => {
            attempts += 1;
            return attempts <= 2 ? { kind: "nudge", note: NUDGE_NOTE } : { kind: "pass" };
          },
        },
      ],
    };
    const llm = new MockLLM({
      script: [submit, { text: "prose" }, submit],
    });

    const result = await runAgent(input(llm, { contribution }));

    expect(result.status).toBe("completed");
    expect(llm.calls.map((call) => call.toolChoice)).toEqual([undefined, undefined, undefined]);
  });

  it("lets the no-progress policy bound an unbounded nudge, counting each iteration once", async () => {
    const counter = createIterationCounter(50);
    const llm = new MockLLM({
      script: Array.from({ length: 6 }, () => ({ text: "still not submitted" })),
    });

    const result = await runAgent(
      input(llm, {
        contribution: nudgeFirst(Number.POSITIVE_INFINITY, true),
        contract: false,
        noProgressLimit: 2,
        counter,
      }),
    );

    expect(result).toMatchObject({ status: "error", error: { code: "no_progress" } });
    expect(counter.count()).toBe(llm.calls.length);
    expect(llm.calls.every((call) => call.toolChoice === undefined)).toBe(true);
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
          await Promise.resolve();
          settled = true;
        },
      },
    };
    const llm = new MockLLM({ script: [submit] });

    await runAgent(input(llm, { contribution }));

    expect(settled).toBe(true);
  });
});
