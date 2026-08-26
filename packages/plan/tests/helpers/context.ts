/**
 * Contract-shaped test doubles for the `plans` capability suite.
 *
 * `@clarvis/plan` must never import `@clarvis/loop` — that edge would close a
 * dependency cycle the loop's own tests enforce — so these are not copies of
 * the engine's fakes (`packages/loop/src/runtime/capabilities/testing.ts`).
 * They are the smallest shapes `createPlansCapability` actually exercises,
 * built directly out of `@clarvis/capability`, following the precedent in
 * `packages/memory/tests/helpers.ts`.
 */
import {
  createCapabilityServices,
  loadEnv,
  type AgentBuildContext,
  type ContextPort,
  type ExecutionRecord,
  type RunCapabilityContext,
  type RunRequest,
  type RunResponse,
  type TraceEntry,
  type TracePort,
} from "@clarvis/capability";

/** A minimal valid {@link RunRequest}; `over` shallow-overrides it. */
function fakeRunRequest(over: Partial<RunRequest> = {}): RunRequest {
  return {
    messages: [{ role: "user", content: "task" }],
    servers: [],
    profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 3 }],
    entry: "solo",
    providers: [{ name: "anthropic", kind: "anthropic" }],
    budget: { on_exceed: "stop", total_token_limit: 100_000 },
    ...over,
  } as RunRequest;
}

/**
 * A minimal valid {@link RunCapabilityContext}; `over` shallow-overrides it.
 *
 * @remarks Unlike memory's equivalent, `executionId`, `services` and
 * `requestParam` are supplied by default: `createPlansCapability.forRun`
 * reads all three, where memory's capability reads none of them.
 */
export function fakeRunCapabilityContext(
  over: Partial<RunCapabilityContext> = {},
): RunCapabilityContext {
  return {
    owner: "test",
    request: fakeRunRequest(),
    entryGrants: [],
    env: loadEnv({}),
    workspaceRoot: "/ws",
    llm: {
      call: () => {
        throw new Error("fakeRunCapabilityContext: llm.call not stubbed");
      },
    },
    emit: () => undefined,
    executionId: "run-1",
    services: createCapabilityServices(),
    requestParam: () => undefined,
    ...over,
  } as RunCapabilityContext;
}

/** An in-memory {@link TracePort} that just accumulates what it is given. */
export function makeTrace(): TracePort & { entries: () => TraceEntry[] } {
  const entries: TraceEntry[] = [];
  const startedAt = performance.now();
  const now = (): number => performance.now() - startedAt;
  const push: TracePort["record"] = (kind, detail): void => {
    entries.push({ at: now(), kind, detail });
  };
  const signal: TracePort["signal"] = () => undefined;
  return {
    record: push,
    signal,
    entries: () => entries,
    now,
  };
}

/** A complete terminal record whose capability state can be varied per case. */
export function fakeExecutionRecord(
  status: ExecutionRecord["status"],
  capabilityState: Record<string, unknown> = {},
): ExecutionRecord {
  const usage = { iterations_used: 0, elapsed_ms: 0, by_agent: [] };
  const response: RunResponse =
    status === "error"
      ? { status, error: { code: "test_error", message: "test error" }, usage }
      : { status, result: null, usage };
  return {
    id: "run-1",
    owner_key_name: "test",
    status,
    started_at: 0,
    ended_at: 0,
    elapsed_ms: 0,
    request: fakeRunRequest(),
    response,
    trace: { events: [] },
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cached_tokens: 0,
    total_cache_write_tokens: 0,
    capability_state: capabilityState,
  };
}

/** A minimal valid {@link AgentBuildContext}; `over` shallow-overrides it. */
export function fakeAgentBuildContext(over: Partial<AgentBuildContext> = {}): AgentBuildContext {
  const notes: string[] = [];
  const ctx: ContextPort = {
    appendNote: (note: string) => notes.push(note),
    setStableBlock: () => undefined,
    setCanonicalState: () => undefined,
  };
  return {
    agent: "lead",
    ctx,
    state: { lastAssistantText: "" },
    trace: makeTrace(),
    guards: {
      record: () => undefined,
      takeSoft: () => [],
      tripped: () => null,
      reset: () => undefined,
    },
    toolProgress: (r) => r.errText === null,
    maybeCancelled: () => null,
    ...over,
  } as AgentBuildContext;
}
