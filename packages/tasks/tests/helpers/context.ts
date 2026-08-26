import {
  createCapabilityServices,
  loadEnv,
  type AgentBuildContext,
  type ContextPort,
  type RunCapabilityContext,
  type RunRequest,
  type TraceEntry,
  type TracePort,
} from "@clarvis/capability";

export function runRequest(grants: string[] = []): RunRequest {
  return {
    messages: [{ role: "user", content: "work" }],
    servers: [],
    profiles: [
      {
        name: "solo",
        model: "anthropic/test",
        tools: [],
        grants,
        iteration_limit: 5,
      },
    ],
    entry: "solo",
    providers: [{ name: "anthropic", kind: "anthropic" }],
    budget: { on_exceed: "stop", total_token_limit: 10_000 },
  } as RunRequest;
}

export function runContext(
  over: Partial<RunCapabilityContext> & { task?: unknown } = {},
): RunCapabilityContext {
  const { task, ...rest } = over;
  const request = rest.request ?? runRequest();
  return {
    owner: "owner-a",
    request,
    entryGrants: [],
    env: loadEnv({}),
    workspaceRoot: "/workspace",
    llm: { call: async () => ({}) as never },
    emit: () => undefined,
    executionId: "exec-1",
    services: createCapabilityServices(),
    requestParam: (key) => (key === "task" ? task : undefined),
    ...rest,
  } as RunCapabilityContext;
}

export interface TestTrace extends TracePort {
  entries: TraceEntry[];
}

export function testTrace(): TestTrace {
  const entries: TraceEntry[] = [];
  let at = 0;
  return {
    entries,
    now: () => ++at,
    record: (kind, detail) => entries.push({ at: ++at, kind, detail } as TraceEntry),
    signal: () => undefined,
  };
}

export function buildContext(
  over: Partial<AgentBuildContext> = {},
): AgentBuildContext & { blocks: Map<string, string>; trace: TestTrace } {
  const blocks = new Map<string, string>();
  const context: ContextPort = {
    appendNote: () => undefined,
    setStableBlock: (kind, content) => blocks.set(kind, content),
    setCanonicalState: () => undefined,
  };
  const trace = testTrace();
  return {
    agent: "lead",
    ctx: context,
    state: { lastAssistantText: "" },
    trace,
    blocks,
    guards: {
      record: () => undefined,
      takeSoft: () => [],
      tripped: () => null,
      reset: () => undefined,
    },
    toolProgress: () => true,
    validateArgs: () => null,
    maybeCancelled: () => null,
    ...over,
  } as AgentBuildContext & { blocks: Map<string, string>; trace: TestTrace };
}
