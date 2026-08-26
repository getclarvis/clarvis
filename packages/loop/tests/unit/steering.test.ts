import { describe, it, expect } from "../bun-test.ts";
import { runAgent, type RunAgentInput } from "../../src/runtime/loop/run-agent.ts";
import type { AgentBuildContext } from "../../src/runtime/loop/run-agent.ts";
import type { AgentCapability, AgentLoopContribution } from "@clarvis/capability";
import { createTrace, type TraceHandle } from "@clarvis/trace";
import { createTokenLedger, createIterationCounter } from "../../src/runtime/budget/index.ts";
import { buildRegistry } from "../../src/runtime/tools/mcp-registry.ts";
import { compileResultContract } from "../../src/runtime/tools/index.ts";
import { DISABLED_COMPACTION } from "../../src/runtime/context/index.ts";
import type { SteerMessage, SteerSource } from "@clarvis/capability";
import { MockLLM } from "../helpers/fixtures.ts";

const SCHEMA = {
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

interface SteerDetail {
  iteration_ref: number;
  message: string;
  subagent_instance_id?: string;
}

function makeSteer(): { source: SteerSource; push: (m: SteerMessage) => void } {
  let pending: SteerMessage[] = [];
  return {
    source: {
      drain(): SteerMessage[] {
        if (pending.length === 0) return [];
        const out = pending;
        pending = [];
        return out;
      },
    },
    push: (m: SteerMessage) => pending.push(m),
  };
}

function noopTool(name: string) {
  return {
    fullName: name,
    wireName: name,
    mcpName: "",
    toolName: name,
    inputSchema: { type: "object" as const, properties: {} },
  };
}

function makeInput(
  llm: MockLLM,
  opts: {
    steer?: SteerSource;
    buildContribution?: (bc: AgentBuildContext) => AgentLoopContribution;
    noProgressLimit?: number;
    trace?: TraceHandle;
    agent?: "lead" | "subagent";
  } = {},
): RunAgentInput {
  return {
    agent: opts.agent ?? "subagent",
    subagentInstanceId: "w1",
    messages: [{ role: "user", content: "go" }],
    ...(opts.steer ? { steer: opts.steer } : {}),
    target: {
      llm,
      model: "m",
      provider: "anthropic",
      capabilities: new Set(["tool_calling", "vision"]),
    },
    budget: {
      ledger: createTokenLedger(1_000_000),
      counter: createIterationCounter(50),
      usage: { input: 0, output: 0, cached: 0, cache_write: 0 },
    },
    runtime: { trace: opts.trace ?? createTrace() },
    compaction: DISABLED_COMPACTION,
    registry: buildRegistry([], []),
    contract: compileResultContract(SCHEMA),
    mcpProgress: (r) => r.errText === null,
    allToolsUnavailable: () => false,
    noProgressLimit: opts.noProgressLimit ?? 6,
    noProgressMessage: (streak) => `no progress for ${streak}.`,
    emptyResponseAgent: "LLM",
    ...(opts.buildContribution
      ? {
          agentCapabilities: [
            {
              attach: (bc: AgentBuildContext): AgentLoopContribution => ({
                ...opts.buildContribution!(bc),
                advertised: false,
              }),
            } as AgentCapability,
          ],
        }
      : {}),
  };
}

function steerEntries(trace: TraceHandle): SteerDetail[] {
  return trace
    .entries()
    .filter((e) => e.kind === "user_steering")
    .map((e) => e.detail as SteerDetail);
}

describe("steering injection", () => {
  it("injects a queued steer as a user message on the NEXT iteration, not the current one", async () => {
    const trace = createTrace();
    const { source, push } = makeSteer();
    const contribution: AgentLoopContribution = {
      tools: [noopTool("noop")],
      handlers: [
        {
          matches: (c) => c.name === "noop",
          handle: async () => {
            push({ content: "also handle the empty case" });
            return { kind: "result", text: "ok", progress: true };
          },
        },
      ],
      gates: [],
      hooks: {},
    };
    const llm = new SnapshotLLM({
      script: [
        { toolCalls: [{ name: "noop", arguments: {} }] },
        { toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] },
      ],
    });
    const res = await runAgent(
      makeInput(llm, { steer: source, buildContribution: () => contribution, trace }),
    );
    expect(res.status).toBe("completed");
    expect(llm.snapshots).toHaveLength(2);

    const first = llm.snapshots[0]!;
    const second = llm.snapshots[1]!;
    expect(first.some((m) => m.role === "user" && m.content === "also handle the empty case")).toBe(
      false,
    );
    expect(
      second.some((m) => m.role === "user" && m.content === "also handle the empty case"),
    ).toBe(true);

    const steers = steerEntries(trace);
    expect(steers).toHaveLength(1);
    expect(steers[0]!.iteration_ref).toBe(2);
    expect(steers[0]!.message).toBe("also handle the empty case");
    expect(steers[0]!.subagent_instance_id).toBe("w1");
  });

  it("drains multiple queued steers FIFO — ordered user messages and one event each", async () => {
    const trace = createTrace();
    const { source, push } = makeSteer();
    const contribution: AgentLoopContribution = {
      tools: [noopTool("noop")],
      handlers: [
        {
          matches: (c) => c.name === "noop",
          handle: async () => {
            push({ content: "first" });
            push({ content: "second" });
            return { kind: "result", text: "ok", progress: true };
          },
        },
      ],
      gates: [],
      hooks: {},
    };
    const llm = new SnapshotLLM({
      script: [
        { toolCalls: [{ name: "noop", arguments: {} }] },
        { toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] },
      ],
    });
    const res = await runAgent(
      makeInput(llm, { steer: source, buildContribution: () => contribution, trace }),
    );
    expect(res.status).toBe("completed");

    const second = llm.snapshots[1]!;
    const userTexts = second
      .filter((m) => m.role === "user" && typeof m.content === "string")
      .map((m) => m.content as string);
    const firstIdx = userTexts.indexOf("first");
    const secondIdx = userTexts.indexOf("second");
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);

    expect(steerEntries(trace).map((s) => s.message)).toEqual(["first", "second"]);
  });

  it("carries multimodal (image) steer content through to the model call", async () => {
    const { source, push } = makeSteer();
    const image = "data:image/png;base64,AAAA";
    const contribution: AgentLoopContribution = {
      tools: [noopTool("noop")],
      handlers: [
        {
          matches: (c) => c.name === "noop",
          handle: async () => {
            push({ content: [{ type: "image", image }] });
            return { kind: "result", text: "ok", progress: true };
          },
        },
      ],
      gates: [],
      hooks: {},
    };
    const llm = new SnapshotLLM({
      script: [
        { toolCalls: [{ name: "noop", arguments: {} }] },
        { toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] },
      ],
    });
    const res = await runAgent(
      makeInput(llm, { steer: source, buildContribution: () => contribution }),
    );
    expect(res.status).toBe("completed");

    const second = llm.snapshots[1]!;
    const imageMsg = second.find((m) => m.role === "user" && Array.isArray(m.content));
    expect(imageMsg).toBeDefined();
    expect(imageMsg!.content).toEqual([{ type: "image", image }]);
  });

  it("resets the no-progress streak so a redirected run gets an extra iteration", async () => {
    const trace = createTrace();
    const { source, push } = makeSteer();
    let pushed = false;
    const contribution: AgentLoopContribution = {
      tools: [noopTool("noop")],
      handlers: [
        {
          matches: (c) => c.name === "noop",
          handle: async () => {
            if (!pushed) {
              push({ content: "keep going, try another approach" });
              pushed = true;
            }
            return { kind: "result", text: "unproductive", progress: false };
          },
        },
      ],
      gates: [],
      hooks: {},
    };
    const llm = new SnapshotLLM({
      script: [
        { toolCalls: [{ name: "noop", arguments: {} }] },
        { toolCalls: [{ name: "noop", arguments: {} }] },
        { toolCalls: [{ name: "noop", arguments: {} }] },
        { toolCalls: [{ name: "noop", arguments: {} }] },
      ],
    });
    const res = await runAgent(
      makeInput(llm, {
        steer: source,
        buildContribution: () => contribution,
        noProgressLimit: 2,
        trace,
      }),
    );
    expect(res.status).toBe("error");
    expect(res.error?.code).toBe("no_progress");
    expect(llm.snapshots).toHaveLength(3);
    expect(steerEntries(trace)).toHaveLength(1);
  });

  it("does nothing when the steer source stays empty", async () => {
    const trace = createTrace();
    const { source } = makeSteer();
    const llm = new SnapshotLLM({
      script: [{ toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] }],
    });
    const res = await runAgent(makeInput(llm, { steer: source, trace }));
    expect(res.status).toBe("completed");
    expect(steerEntries(trace)).toHaveLength(0);
  });
});
