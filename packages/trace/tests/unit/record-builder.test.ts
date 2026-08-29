import { describe, expect, it } from "bun:test";
import type {
  ContextSnapshotEntry,
  PerAgentUsage,
  RunRequest,
  RunResponse,
  Trace,
} from "@clarvis/capability";

import { buildRecord } from "../../src/record-builder.ts";

const REQUEST: RunRequest = {
  messages: [{ role: "user", content: "x" }],
  servers: [],
  entry: "solo",
  profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 1 }],
  providers: [{ name: "anthropic", kind: "anthropic" }],
  budget: { on_exceed: "stop", total_token_limit: 1 },
};

function lead(over: Partial<Omit<PerAgentUsage, "type">> = {}): PerAgentUsage {
  return {
    type: "lead",
    model: "anthropic/x",
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    cache_write_tokens: 0,
    iterations: 1,
    subagents_spawned: 0,
    ...over,
  };
}

function subagent(over: Partial<Omit<PerAgentUsage, "type">> = {}): PerAgentUsage {
  return {
    type: "subagent",
    model: "anthropic/x",
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    cache_write_tokens: 0,
    ...over,
  };
}

const FINAL_CONTEXT: ContextSnapshotEntry[] = [
  {
    message: { role: "user", content: "x" },
    evictable: false,
    summary: false,
    canonical: false,
  },
];

const PLAN_STATE = {
  id: "p1",
  path: "/plans/p1.md",
  final_revision: 2,
  final_spec_revision: 1,
  status: "completed",
  retention: "keep",
};

function response(by_agent: PerAgentUsage[], elapsed_ms = 500): RunResponse {
  return {
    status: "completed",
    result: "r",
    usage: { iterations_used: 1, elapsed_ms, by_agent },
  };
}

describe("buildRecord", () => {
  it("sums per-agent usage into the record's four roll-up totals", () => {
    const record = buildRecord({
      id: "exec_1",
      owner: "alice",
      request: REQUEST,
      response: response([
        lead({ input_tokens: 10, output_tokens: 3, cached_tokens: 1, cache_write_tokens: 2 }),
        subagent({
          input_tokens: 5,
          output_tokens: 7,
          cached_tokens: 4,
          cache_write_tokens: 6,
        }),
      ]),
      trace: { events: [] },
      wallStartedAt: 1_700_000_000_000,
    });

    expect(record.total_input_tokens).toBe(15);
    expect(record.total_output_tokens).toBe(10);
    expect(record.total_cached_tokens).toBe(5);
    expect(record.total_cache_write_tokens).toBe(8);
  });

  it("totals zero for a run that used no agent", () => {
    const record = buildRecord({
      id: "exec_2",
      owner: "alice",
      request: REQUEST,
      response: response([]),
      trace: { events: [] },
      wallStartedAt: 0,
    });
    expect(record.total_input_tokens).toBe(0);
    expect(record.total_output_tokens).toBe(0);
    expect(record.total_cached_tokens).toBe(0);
    expect(record.total_cache_write_tokens).toBe(0);
  });

  it("derives ended_at from the wall start plus the reported elapsed time", () => {
    const record = buildRecord({
      id: "exec_3",
      owner: "alice",
      request: REQUEST,
      response: response([lead()], 250),
      trace: { events: [] },
      wallStartedAt: 1_700_000_000_000,
    });
    expect(record.started_at).toBe(1_700_000_000_000);
    expect(record.elapsed_ms).toBe(250);
    expect(record.ended_at).toBe(1_700_000_000_250);
  });

  it("carries the response's status, the id, the owner and the trace through", () => {
    const trace: Trace = { events: [] };
    const record = buildRecord({
      id: "exec_4",
      owner: "bob",
      request: REQUEST,
      response: {
        status: "error",
        error: { code: "internal_error", message: "boom" },
        usage: { iterations_used: 1, elapsed_ms: 500, by_agent: [lead()] },
      },
      trace,
      wallStartedAt: 5,
    });
    expect(record.id).toBe("exec_4");
    expect(record.owner_key_name).toBe("bob");
    expect(record.status).toBe("error");
    expect(record.trace).toBe(trace);
    expect(record.request).toBe(REQUEST);
  });

  it("omits final_context and capability_state entirely when neither is supplied", () => {
    const record = buildRecord({
      id: "exec_5",
      owner: "alice",
      request: REQUEST,
      response: response([lead()]),
      trace: { events: [] },
      wallStartedAt: 0,
    });
    expect("final_context" in record).toBe(false);
    expect("capability_state" in record).toBe(false);
  });

  it("includes final_context and capability_state when supplied", () => {
    const record = buildRecord({
      id: "exec_6",
      owner: "alice",
      request: REQUEST,
      response: response([lead()]),
      trace: { events: [] },
      wallStartedAt: 0,
      finalContext: FINAL_CONTEXT,
      capabilityState: { plans: PLAN_STATE },
    });
    expect(record.final_context).toEqual(FINAL_CONTEXT);
    expect(record.capability_state).toEqual({ plans: PLAN_STATE });
  });

  it("carries opaque host metadata into the immutable execution snapshot", () => {
    const environment = {
      environment: {
        id: "global:research",
        fingerprint: `sha256:${"a".repeat(64)}`,
      },
    };
    const record = buildRecord({
      id: "exec_7",
      owner: "alice",
      request: REQUEST,
      response: response([lead()]),
      trace: { events: [] },
      wallStartedAt: 0,
      hostMetadata: environment,
    });
    expect(record.host_metadata).toEqual(environment);
  });
});
