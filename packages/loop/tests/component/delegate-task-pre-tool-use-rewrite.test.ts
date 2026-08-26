import { describe, expect, it } from "../bun-test.ts";
import { loadEnv, type LifecycleHook } from "@clarvis/capability";
import { createTrace } from "@clarvis/trace";
import { runAgent, type AgentBuildContext } from "../../src/runtime/loop/run-agent.ts";
import type { RunAgentInput } from "../../src/runtime/loop/run-agent.ts";
import type { AgentCapability, AgentLoopContribution } from "@clarvis/capability";
import { createTokenLedger, createIterationCounter } from "../../src/runtime/budget/index.ts";
import { createSemaphore } from "../../src/runtime/support/concurrency.ts";
import { buildRegistry } from "../../src/runtime/tools/mcp-registry.ts";
import { compileResultContract } from "../../src/runtime/tools/index.ts";
import { DISABLED_COMPACTION } from "../../src/runtime/context/index.ts";
import { buildDelegationContribution } from "../../src/runtime/delegation.ts";
import { resolveSubagentProfiles } from "../../src/runtime/subagents/subagent-profiles.ts";
import { MockLLM } from "../helpers/fixtures.ts";

/**
 * The standing proof that refusing a `preDelegateTask` rewrite costs nothing.
 *
 * `spawn_subagent` is dispatched through the ordinary tool loop, so the fire
 * point that *does* replace a call's arguments — `beforeToolUse` — reaches a
 * delegation like any other tool, upstream of the delegation's own validation.
 * Everything the weaker channel would have offered is here and more: the
 * sub-agent runs the replacement, the model is told what actually ran, and the
 * assistant message it produced is left exactly as it sent it, so the request
 * prefix every later call is served from does not move.
 *
 * If this file ever goes red, refusing the `preDelegateTask` rewrite has become
 * a loss of capability and the decision recorded in `prepareSpawn`'s TSDoc has
 * to be revisited.
 */

const env = loadEnv({});

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { name: { type: "string" } },
  required: ["name"],
};

interface WireMessage {
  role: string;
  content: unknown;
  tool_call_id?: string;
}

class SnapshotLLM extends MockLLM {
  readonly snapshots: WireMessage[][] = [];
  override async call(params: Parameters<MockLLM["call"]>[0]): ReturnType<MockLLM["call"]> {
    this.snapshots.push([...(params.messages as WireMessage[])]);
    return super.call(params);
  }
}

const ORIGINAL = { title: "original", task: "read the README", profile: "researcher" };
const REPLACEMENT = { title: "replaced", task: "read the changelog", profile: "implementer" };

function profiles(): ReturnType<typeof resolveSubagentProfiles> {
  return resolveSubagentProfiles(
    [
      { name: "researcher", model: "anthropic/x", base_prompt: "research", tools: [] },
      { name: "implementer", model: "anthropic/x", base_prompt: "implement", tools: [] },
    ],
    [{ name: "anthropic", kind: "anthropic" }],
    env,
  );
}

function leadScript(): SnapshotLLM {
  return new SnapshotLLM({
    script: [
      { toolCalls: [{ name: "spawn_subagent", arguments: ORIGINAL }] },
      { toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] },
    ],
  });
}

function makeInput(
  lead: MockLLM,
  subagent: MockLLM,
  hooks: LifecycleHook[],
  trace: ReturnType<typeof createTrace>,
): RunAgentInput {
  const ledger = createTokenLedger(1_000_000);
  return {
    agent: "lead",
    messages: [{ role: "user", content: "go" }],
    hooks,
    target: {
      llm: lead,
      model: "m",
      provider: "anthropic",
      capabilities: new Set(["tool_calling"]),
    },
    budget: {
      ledger,
      counter: createIterationCounter(50),
      usage: { input: 0, output: 0, cached: 0, cache_write: 0 },
    },
    runtime: { trace },
    compaction: DISABLED_COMPACTION,
    registry: buildRegistry([], []),
    contract: compileResultContract(SCHEMA),
    mcpProgress: (r: { errText: string | null }) => r.errText === null,
    allToolsUnavailable: () => false,
    noProgressLimit: 6,
    noProgressMessage: (streak: number) => `no progress for ${String(streak)}.`,
    emptyResponseAgent: "LLM",
    agentCapabilities: [
      {
        attach: (bc: AgentBuildContext): AgentLoopContribution => ({
          ...buildDelegationContribution({
            bc,
            env,
            opened: [],
            profiles: profiles(),
            iterationLimitDefault: 5,
            llm: subagent,
            ledger,
            subagentAggByModel: new Map(),
            semaphore: createSemaphore(1),
            hooks,
          }),
          advertised: false,
        }),
      } as AgentCapability,
    ],
  };
}

function toolResults(messages: WireMessage[]): string[] {
  return messages.filter((m) => m.role === "tool").map((m) => m.content as string);
}

const rewritingHook = (): LifecycleHook => ({
  beforeToolUse: async (c) =>
    c.tool === "spawn_subagent" ? { kind: "rewrite", arguments: REPLACEMENT } : { kind: "pass" },
});

describe("a pre_tool_use hook rewrites a delegation's brief and profile", () => {
  it("spawns the sub-agent the hook chose, on the brief the hook wrote", async () => {
    const lead = leadScript();
    const trace = createTrace();
    await runAgent(
      makeInput(lead, new MockLLM({ script: [{ text: "done" }] }), [rewritingHook()], trace),
    );

    const created = trace.entries().find((e) => e.kind === "delegation_created");
    expect(created?.detail).toMatchObject({
      title: REPLACEMENT.title,
      task: REPLACEMENT.task,
      profile: REPLACEMENT.profile,
    });
  });

  it("tells the model what actually ran", async () => {
    const lead = leadScript();
    await runAgent(
      makeInput(
        lead,
        new MockLLM({ script: [{ text: "done" }] }),
        [rewritingHook()],
        createTrace(),
      ),
    );

    const results = toolResults(lead.snapshots[1]!);
    expect(results[0]).toContain("[advisor]");
    expect(results[0]).toContain("replaced this call's arguments");
    expect(results[0]).toContain(REPLACEMENT.task);
  });

  it("leaves the assistant message the model produced untouched while the spawn diverges", async () => {
    const lead = leadScript();
    const trace = createTrace();
    await runAgent(
      makeInput(lead, new MockLLM({ script: [{ text: "done" }] }), [rewritingHook()], trace),
    );

    const created = trace.entries().find((e) => e.kind === "delegation_created");
    expect((created?.detail as { task: string }).task).toBe(REPLACEMENT.task);

    const assistant = lead.snapshots[1]!.find(
      (m) => m.role === "assistant" && "tool_calls" in m,
    ) as unknown as { tool_calls: { arguments: unknown }[] };
    expect(assistant.tool_calls[0]!.arguments).toEqual(ORIGINAL);
  });

  it("spawns the model's own choice when no hook rewrites it", async () => {
    const lead = leadScript();
    const trace = createTrace();
    await runAgent(makeInput(lead, new MockLLM({ script: [{ text: "done" }] }), [], trace));

    const created = trace.entries().find((e) => e.kind === "delegation_created");
    expect(created?.detail).toMatchObject({
      title: ORIGINAL.title,
      task: ORIGINAL.task,
      profile: ORIGINAL.profile,
    });
  });
});
