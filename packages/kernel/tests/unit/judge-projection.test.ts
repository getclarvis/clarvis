import { expect, test } from "bun:test";
import { loadEnv } from "@clarvis/capability";
import type { ExecutionRecord, RunRequest, RunResponse, TraceEvent } from "@clarvis/capability";
import { validateBody } from "@clarvis/loop/testing";
import { createJudgeTraceProjection } from "../../src/guard/judge-trace-store.ts";
import { projectJudgeResponse } from "../../src/guard/judge-response-projection.ts";

const secret = "PRIVATE_SENTINEL_COMMAND_EVIDENCE_MODEL";
const request: RunRequest = {
  execution_id: "judge-execution",
  session_id: "work-session",
  agent_instance_id: "judge",
  prompt_cache_ttl: "1h",
  messages: [{ role: "user", content: secret }],
  servers: [],
  entry: "judge",
  shared_prompt: "",
  profiles: [
    { name: "judge", model: "anthropic/test", tools: [], iteration_limit: 2, base_prompt: secret },
  ],
  providers: [
    {
      name: "anthropic",
      kind: "anthropic",
      headers: { private: secret },
      body: { private: secret },
      api_key_env: secret,
    },
  ],
  budget: { on_exceed: "stop", total_token_limit: 4096 },
};
const usage = {
  iterations_used: 1,
  elapsed_ms: 10,
  by_agent: [
    {
      type: "lead" as const,
      model: "anthropic/test",
      input_tokens: 10,
      output_tokens: 2,
      cached_tokens: 5,
      cache_write_tokens: 1,
      iterations: 1,
      subagents_spawned: 0,
    },
  ],
  warnings: [secret],
};
const record = (
  response: RunResponse = { status: "completed", result: { secret }, usage },
): ExecutionRecord => ({
  visibility: "internal",
  id: "judge-execution",
  owner_key_name: "owner",
  status: response.status,
  started_at: 1000,
  ended_at: 1010,
  elapsed_ms: 10,
  request,
  response,
  trace: { events: [] },
  total_input_tokens: 10,
  total_output_tokens: 2,
  total_cached_tokens: 5,
  total_cache_write_tokens: 1,
  final_context: [
    {
      message: { role: "user", content: secret },
      evictable: false,
      summary: false,
      canonical: true,
    },
  ],
  capability_state: { private: secret },
  host_metadata: { private: secret },
});
const events: TraceEvent[] = [
  {
    type: "lead_iteration",
    iteration: 1,
    started_at: 1000,
    ended_at: 1001,
    model: "anthropic/test",
    input_tokens: 10,
    output_tokens: 2,
    cached_tokens: 5,
    cache_write_tokens: 1,
    cache_read_ratio: 0.5,
    response: secret,
  },
  {
    type: "subagent_iteration",
    subagent_instance_id: secret,
    iteration: 1,
    started_at: 1000,
    ended_at: 1001,
    model: "anthropic/test",
    input_tokens: 10,
    output_tokens: 2,
    cached_tokens: 5,
    cache_write_tokens: 1,
    cache_read_ratio: 0.5,
    response: secret,
  },
  {
    type: "tool_call",
    agent: "lead",
    call_id: secret,
    iteration_ref: 1,
    started_at: 1000,
    ended_at: 1001,
    mcp_name: secret,
    tool_name: secret,
    arguments: { secret },
    arguments_original: { secret },
    result: secret,
    result_digest: secret,
    error: secret,
    diff: secret,
  },
  {
    type: "tool_call_started",
    agent: "lead",
    call_id: secret,
    iteration_ref: 1,
    started_at: 1000,
    mcp_name: secret,
    tool_name: secret,
    arguments: { secret },
    control: { tool_execution_id: secret, actions: ["interrupt"] },
  },
  {
    type: "tool_call_announced",
    agent: "lead",
    call_id: secret,
    occurred_at: 1000,
    tool_name: secret,
    iteration: 1,
    attempt: 1,
  },
  {
    type: "model_reasoning",
    agent: "lead",
    iteration: 1,
    occurred_at: 1000,
    model: "anthropic/test",
    text: secret,
  },
  {
    type: "model_call_error",
    agent: "lead",
    iteration: 1,
    occurred_at: 1000,
    model: "anthropic/test",
    kind: "auth",
    message: secret,
    status: 401,
    usage_attributed: true,
  },
  {
    type: "model_call_retry",
    agent: "lead",
    iteration: 1,
    occurred_at: 1000,
    model: "anthropic/test",
    kind: "transient",
    message: secret,
    attempt: 1,
    max_retries: 1,
    delay_ms: 0,
  },
  { type: "cancellation", agent: "lead", occurred_at: 1000, reason: secret },
  {
    type: "convergence_warning",
    agent: "lead",
    occurred_at: 1000,
    code: "stagnation_detected",
    message: secret,
  },
  { type: "compaction_skipped", agent: "lead", occurred_at: 1000, reason: "disabled" },
  { type: "budget_check", checked_at: 1000, tokens_used: 10, tokens_remaining: 20 },
  {
    type: "run_started",
    occurred_at: 1000,
    mode: "subagent-only",
    lead_model: "anthropic/test",
    max_tokens: 1000,
  },
  { type: "run_ended", occurred_at: 1010, reason: "completed", disposition: "final" },
];

test("reconstructs a valid request and keeps identity/accounting without any private payload", () => {
  const projection = createJudgeTraceProjection();
  const input = record();
  input.trace.events = events;
  const projected = projection.record(input);
  expect(JSON.stringify(projected)).not.toContain(secret);
  expect(projected).toMatchObject({
    visibility: "internal",
    id: input.id,
    owner_key_name: input.owner_key_name,
    total_input_tokens: 10,
    total_cached_tokens: 5,
    total_cache_write_tokens: 1,
    request: { session_id: "work-session", agent_instance_id: "judge", prompt_cache_ttl: "1h" },
  });
  expect(projected.final_context).toBeUndefined();
  expect(projected.capability_state).toBeUndefined();
  expect(projected.host_metadata).toBeUndefined();
  expect(() => validateBody(projected.request, loadEnv({}))).not.toThrow();
  const header = projection.header({
    visibility: "internal",
    id: input.id,
    owner_key_name: input.owner_key_name,
    started_at: input.started_at,
    request,
  });
  expect(JSON.stringify(header)).not.toContain(secret);
  expect(projection.context(input.final_context!)).toEqual([]);
  expect(input.request.messages[0]!.content).toBe(secret);
});

test.each(events)("closes every classified event shape: $type", (event) => {
  const projection = createJudgeTraceProjection();
  const projected = projection.event(event);
  expect(JSON.stringify(projected)).not.toContain(secret);
  expect(projected?.type).toBe(event.type);
  expect(() => projection.event({ ...event, future_private_field: secret })).toThrow();
});

test("tool lifecycle identities correlate within one projection and differ across stores", () => {
  const first = createJudgeTraceProjection();
  const second = createJudgeTraceProjection();
  const start = first.event(events[3]!) as { call_id: string };
  const finish = first.event(events[2]!) as { call_id: string };
  expect(start.call_id).toBe(finish.call_id);
  expect(start.call_id).not.toBe(secret);
  expect((second.event(events[3]!) as { call_id: string }).call_id).not.toBe(start.call_id);
});

test.each(["future_event", "model_stream_delta", "lead_iteration_started", "user_question"])(
  "rejects unknown or unreachable durable kind %s",
  (type) => {
    expect(() =>
      createJudgeTraceProjection().event({ type, occurred_at: 0, detail: { secret } }),
    ).toThrow();
  },
);

test("rejects unclassified record, response and request fields", () => {
  const projection = createJudgeTraceProjection();
  expect(() =>
    projection.record({ ...record(), private_future: secret } as ExecutionRecord),
  ).toThrow();
  expect(() =>
    projection.record({
      ...record(),
      request: { ...request, private_future: secret } as RunRequest,
    }),
  ).toThrow();
  expect(() =>
    projectJudgeResponse({
      status: "completed",
      result: secret,
      usage,
      private_future: secret,
    } as RunResponse),
  ).toThrow();
});

test.each([
  "completed",
  "cancelled",
  "budget_exhausted",
  "soft_limit_declined",
  "interrupted",
] as const)("preserves %s status and checkpoint metadata shape with constant content", (status) => {
  const projected = projectJudgeResponse({
    status,
    result: { secret },
    usage,
    disposition: "checkpoint",
    checkpoint: { summary: secret, next_step: secret },
  });
  expect(projected).toMatchObject({
    status,
    disposition: "checkpoint",
    usage: { iterations_used: 1, elapsed_ms: 10 },
  });
  expect(JSON.stringify(projected)).not.toContain(secret);
});

test("retains only classified operational error details", () => {
  const projected = projectJudgeResponse({
    status: "error",
    error: {
      code: "provider_error",
      message: secret,
      details: {
        kind: "auth",
        status: 401,
        retry_after_ms: 2,
        timeout_ms: secret,
        nested: { secret },
        arbitrary: secret,
      },
    },
    usage,
    disposition: "final",
  });
  expect(projected).toMatchObject({
    status: "error",
    disposition: "final",
    error: { code: "provider_error", details: { kind: "auth", status: 401, retry_after_ms: 2 } },
  });
  expect(JSON.stringify(projected)).not.toContain(secret);
  expect(() => projectJudgeResponse({ status: "error", usage } as RunResponse)).toThrow();
  expect(() =>
    projectJudgeResponse({
      status: "completed",
      result: secret,
      usage,
      error: { code: "internal_error", message: secret },
    } as RunResponse),
  ).toThrow();
  expect(() =>
    projectJudgeResponse({
      status: "completed",
      result: secret,
      usage,
      disposition: "checkpoint",
    } as RunResponse),
  ).toThrow();
});

const liveEvents: TraceEvent[] = [
  { type: "lead_iteration_started", iteration: 1, started_at: 1, model: "anthropic/test" },
  {
    type: "subagent_iteration_started",
    subagent_instance_id: secret,
    iteration: 1,
    started_at: 1,
    model: "anthropic/test",
  },
  {
    type: "model_stream_delta",
    agent: "subagent",
    subagent_instance_id: secret,
    iteration: 1,
    occurred_at: 1,
    model: "anthropic/test",
    channel: "reasoning",
    text: secret,
    reset: false,
  },
  { type: "tool_output_delta", agent: "subagent", call_id: secret, occurred_at: 1, chunk: secret },
  {
    type: "tool_input_delta",
    agent: "subagent",
    call_id: secret,
    occurred_at: 1,
    tool_name: secret,
    chars: 1,
    stream_chars: 1,
    complete: true,
  },
];
test.each(liveEvents)(
  "discards classified live-only event $type from journals and final records",
  (event) => {
    const projection = createJudgeTraceProjection();
    expect(projection.event(event)).toBeNull();
    const input = record();
    input.trace.events = [event];
    expect(projection.record(input).trace.events).toEqual([]);
    expect(() => projection.event({ ...event, unknown: secret })).toThrow();
  },
);
test("classifies the single-agent entry delegation without preserving task content", () => {
  const event = {
    type: "delegation_started",
    delegation_id: secret,
    task_id: secret,
    occurred_at: 1,
    model: "anthropic/test",
  } as const;
  expect(createJudgeTraceProjection().event(event)).toEqual({
    type: "delegation_started",
    delegation_id: "judge",
    task_id: undefined,
    occurred_at: 1,
    model: "anthropic/test",
  });
});

test("classifies only the fixed private invalid-response code alongside engine codes", () => {
  const response: RunResponse = {
    status: "error",
    usage,
    error: { code: "judge_invalid_response", message: secret },
  };
  expect(projectJudgeResponse(response)).toMatchObject({
    status: "error",
    error: { code: "judge_invalid_response" },
  });
  const projection = createJudgeTraceProjection();
  expect(
    projection.event({
      type: "run_ended",
      occurred_at: 1,
      reason: "error",
      code: "judge_invalid_response",
    }),
  ).toMatchObject({ code: "judge_invalid_response" });
  expect(() =>
    projectJudgeResponse({ ...response, error: { code: secret, message: secret } }),
  ).toThrow();
});
