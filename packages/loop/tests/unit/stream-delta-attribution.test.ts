import { describe, it, expect } from "../bun-test.ts";
import { runAgent, type RunAgentInput } from "../../src/runtime/loop/run-agent.ts";
import { createTrace } from "@clarvis/trace";
import { createTokenLedger, createIterationCounter } from "../../src/runtime/budget/index.ts";
import { buildRegistry } from "../../src/runtime/tools/mcp-registry.ts";
import { compileResultContract } from "../../src/runtime/tools/index.ts";
import { DISABLED_COMPACTION } from "../../src/runtime/context/index.ts";
import { mapEntry } from "@clarvis/trace";
import type { LLMProvider, LLMCallParams, LLMCallResult } from "@clarvis/capability";
import type { TraceEntry } from "@clarvis/capability";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { name: { type: "string" } },
  required: ["name"],
};

/** A provider that streams one delta per call before answering. */
class StreamingLLM implements LLMProvider {
  constructor(private readonly text: string) {}

  async call(params: LLMCallParams): Promise<LLMCallResult> {
    params.onStreamDelta?.({ channel: "text", text: this.text, reset: true });
    params.onToolInputDelta?.({
      call_id: "call-1",
      tool_name: "shell",
      chars: 0,
      stream_chars: 13,
    });
    params.onToolInputDelta?.({
      call_id: "call-1",
      tool_name: "shell",
      chars: 7,
      stream_chars: 20,
      complete: true,
    });
    return {
      text: this.text,
      usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cache_write_tokens: 0 },
    };
  }
}

/** A provider facade that exposes two physical-attempt lifecycles through one logical call. */
class RetryingToolInputLLM implements LLMProvider {
  async call(params: LLMCallParams): Promise<LLMCallResult> {
    params.onToolInputDelta?.({ call_id: "reused", tool_name: "write_file", chars: 0 });
    params.onToolInputDelta?.({ call_id: "reused", tool_name: "write_file", chars: 8 });
    params.onRetry?.({
      attempt: 1,
      maxRetries: 3,
      delayMs: 0,
      kind: "transient",
      message: "tool argument stream became inactive",
    });
    params.onToolInputDelta?.({ call_id: "reused", tool_name: "write_file", chars: 0 });
    params.onToolInputDelta?.({
      call_id: "reused",
      tool_name: "write_file",
      chars: 12,
      complete: true,
    });
    return {
      text: "done",
      usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cache_write_tokens: 0 },
    };
  }
}

type StreamDeltaEntry = Extract<TraceEntry, { kind: "model_stream_delta" }>;

function makeInput(
  llm: LLMProvider,
  trace: RunAgentInput["runtime"]["trace"],
  subagentInstanceId?: string,
): RunAgentInput {
  return {
    agent: subagentInstanceId !== undefined ? "subagent" : "lead",
    ...(subagentInstanceId !== undefined ? { subagentInstanceId } : {}),
    messages: [{ role: "user", content: "go" }],
    target: {
      llm,
      model: "m",
      provider: "anthropic",
      capabilities: new Set(["tool_calling"]),
    },
    budget: {
      ledger: createTokenLedger(1_000_000),
      counter: createIterationCounter(1),
      usage: { input: 0, output: 0, cached: 0, cache_write: 0 },
    },
    runtime: { trace },
    compaction: DISABLED_COMPACTION,
    registry: buildRegistry([], []),
    contract: compileResultContract(SCHEMA),
    mcpProgress: (r) => r.errText === null,
    allToolsUnavailable: () => false,
    noProgressLimit: 6,
    noProgressMessage: (streak) => `No progress for ${streak} iterations.`,
    emptyResponseAgent: "LLM",
  };
}

async function captureDeltas(subagentInstanceId?: string): Promise<StreamDeltaEntry[]> {
  const streamed: TraceEntry[] = [];
  const trace = createTrace(0, (e) => streamed.push(e));
  await runAgent(makeInput(new StreamingLLM("streamed text"), trace, subagentInstanceId));
  return streamed.filter((e): e is StreamDeltaEntry => e.kind === "model_stream_delta");
}

describe("streaming delta attribution", () => {
  it("stamps a sub-agent's stream deltas with its instance id, intact through mapEntry", async () => {
    const deltas = await captureDeltas("w1");

    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.detail.agent).toBe("subagent");
    expect(deltas[0]!.detail.subagent_instance_id).toBe("w1");

    expect(mapEntry(deltas[0]!, 1000)).toMatchObject({
      type: "model_stream_delta",
      agent: "subagent",
      subagent_instance_id: "w1",
      text: "streamed text",
    });
  });

  it("leaves the lead's stream deltas without a sub-agent id", async () => {
    const deltas = await captureDeltas();

    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.detail.agent).toBe("lead");
    expect(deltas[0]!.detail.subagent_instance_id).toBeUndefined();
  });

  it("records streamed tool-input attribution beside text deltas", async () => {
    const streamed: TraceEntry[] = [];
    const trace = createTrace(0, (entry) => streamed.push(entry));
    await runAgent(makeInput(new StreamingLLM("done"), trace, "worker"));

    expect(
      streamed.filter((entry) => entry.kind === "tool_input_delta").at(-1)?.detail,
    ).toMatchObject({
      agent: "subagent",
      subagent_instance_id: "worker",
      call_id: "call-1",
      tool_name: "shell",
      chars: 7,
      stream_chars: 20,
      complete: true,
    });
  });

  it("persists one announcement per call while keeping cumulative progress live-only", async () => {
    const observed: Array<{ entry: TraceEntry; durable: boolean }> = [];
    const trace = createTrace(0, (entry, durable) => observed.push({ entry, durable }));
    await runAgent(makeInput(new StreamingLLM("done"), trace));

    const toolInput = observed.filter(({ entry }) => entry.kind === "tool_input_delta");
    expect(toolInput).toHaveLength(2);
    expect(toolInput.map(({ durable }) => durable)).toEqual([true, false]);
    expect(trace.entries().filter((entry) => entry.kind === "tool_input_delta")).toHaveLength(1);
  });

  it("records a fresh announcement after retry even when the provider reuses the call id", async () => {
    const observed: Array<{ entry: TraceEntry; durable: boolean }> = [];
    const trace = createTrace(0, (entry, durable) => observed.push({ entry, durable }));
    await runAgent(makeInput(new RetryingToolInputLLM(), trace));

    const toolInput = observed.filter(({ entry }) => entry.kind === "tool_input_delta");
    expect(toolInput.map(({ durable }) => durable)).toEqual([true, false, true, false]);
    expect(trace.entries().filter((entry) => entry.kind === "tool_input_delta")).toHaveLength(2);
    expect(
      trace.entries().find((entry) => entry.kind === "model_call_retry")?.detail,
    ).toMatchObject({
      message: "tool argument stream became inactive",
    });
  });
});
