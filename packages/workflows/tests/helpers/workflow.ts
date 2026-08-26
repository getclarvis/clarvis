import { createAgentRegistry, type AgentRegistry, type AgentsLimits } from "@clarvis/supervision";
import type {
  AgentBuildContext,
  AgentScope,
  LLMToolCall,
  RunCapabilityContext,
  RunRequest,
} from "@clarvis/capability";
import { createCapabilityServices, createSemaphore } from "@clarvis/capability";
import type { ExecuteRunArgs, ExecuteRunOutcome } from "@clarvis/loop";
import { AGENT_REGISTRY_PORT } from "@clarvis/supervision";
import { WORKFLOW_GRANT } from "../../src/capability.ts";
import { createWorkflowLedger } from "../../src/ledger.ts";
import type { WorkflowCtx, WorkflowRunDeps } from "../../src/types.ts";

/** A per-test workflow execution fake. Calls and id allocation are owned by the
 * returned instance, so no test mutates process-wide module state. */
export interface RecordingWorkflowRunDeps extends WorkflowRunDeps {
  readonly calls: ExecuteRunArgs[];
}

export function workflowRunDeps(
  execute: (args: ExecuteRunArgs) => Promise<ExecuteRunOutcome> = () =>
    Promise.reject(new Error("workflow executeRun was not stubbed by this test")),
): RecordingWorkflowRunDeps {
  let nextId = 0;
  const calls: ExecuteRunArgs[] = [];
  return {
    calls,
    generateExecutionId: () => `leader-${++nextId}`,
    executeRun(args): Promise<ExecuteRunOutcome> {
      calls.push(args);
      return execute(args);
    },
  };
}

/** A minimal {@link WorkflowCtx} for capability tests; `deps` is inert because the
 * leader's `executeRun` is faked (or never reached). */
export function makeCtx(overrides: Partial<WorkflowCtx> = {}): WorkflowCtx {
  return {
    deps: {} as WorkflowCtx["deps"],
    runDeps: workflowRunDeps(),
    owner: "owner",
    semaphore: createSemaphore(4),
    ledger: createWorkflowLedger(null),
    maxConcurrency: 4,
    assemble: () => ({}) as RunRequest,
    managerRunId: "manager-1",
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** An entry-lead agent scope carrying the workflow grant by default. */
export function scope(partial: Partial<AgentScope> = {}): AgentScope {
  return { agent: "lead", entry: true, grants: [WORKFLOW_GRANT], ...partial };
}

/** A fake {@link AgentBuildContext} whose trace records into a captured array. */
export function recordingBc(): {
  bc: AgentBuildContext;
  records: Array<{ kind: string; detail: unknown }>;
} {
  const records: Array<{ kind: string; detail: unknown }> = [];
  const bc: AgentBuildContext = {
    agent: "lead",
    ctx: {
      appendNote: () => undefined,
      setStableBlock: () => undefined,
      setCanonicalState: () => undefined,
    },
    state: { lastAssistantText: "" },
    trace: {
      record: (kind, detail) => records.push({ kind, detail }),
      signal: () => undefined,
      now: () => 0,
    },
    guards: {
      record: () => undefined,
      takeSoft: () => [],
      tripped: () => null,
      reset: () => undefined,
    },
    toolProgress: ({ productive }) => productive,
    maybeCancelled: () => null,
  };
  return { bc, records };
}

/** A complete, inert run request whose only meaningful field is its prompt. */
export function requestWithPrompt(prompt: string, overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    messages: [{ role: "user", content: prompt }],
    servers: [],
    profiles: [],
    entry: "lead",
    budget: { on_exceed: "stop" },
    providers: [],
    ...overrides,
  };
}

/** Read the text prompt from the execution fake's complete request fixture. */
export function promptFrom(args: ExecuteRunArgs): string {
  const request = args.rawBody as RunRequest;
  const content = request.messages[0]?.content;
  if (typeof content !== "string") throw new Error("expected a text prompt");
  return content;
}

/** A `run_leader` tool call carrying the given arguments. */
export function runLeaderCall(args: Record<string, unknown>): LLMToolCall {
  return { id: "call", name: "run_leader", arguments: args };
}

/** Bounds used by the test registry; generous, since nothing here tests them. */
const TEST_LIMITS: AgentsLimits = {
  bufferLines: 500,
  bufferBytes: 131_072,
  maxTotalBufferBytes: 6_291_456,
  pollMaxBytes: 8192,
  awaitTimeoutMs: 5000,
  maxLiveChildren: 16,
  maxRetainedChildren: 32,
  maxNoticesPerIteration: 8,
  maxConsecutiveFailedChildren: 3,
  finishNudges: 2,
};

/** A run context carrying a live registry, plus the join point background tests
 * need now that `run_leader` no longer hands its promise to the dispatch. */
export interface TestRunCtx {
  runCtx: RunCapabilityContext;
  registry: AgentRegistry;
  /** Await every leader task the registry has adopted so far. */
  settle: () => Promise<void>;
}

/** Minimal run context exposing supervision through the generic service registry. */
export function runContextWithAgents(agents: AgentRegistry): RunCapabilityContext {
  const services = createCapabilityServices();
  services.provide(AGENT_REGISTRY_PORT, agents);
  return {
    request: requestWithPrompt(""),
    requestParam: () => undefined,
    owner: "owner",
    entryGrants: [],
    env: {} as RunCapabilityContext["env"],
    workspaceRoot: "/workspace",
    llm: { call: () => Promise.reject(new Error("test LLM was not stubbed")) },
    emit: () => undefined,
    services,
    executionId: "manager-1",
  };
}

/**
 * Build a {@link RunCapabilityContext} with a real {@link AgentRegistry}.
 *
 * @remarks `run_leader` is background-only, so its handler answers before the
 * leader has run and the promise lives in the registry rather than in the
 * verdict. `settle()` is the seam that replaces the old `await verdict.run()`:
 * the assertions about concurrency, ledger spend and trace edges are unchanged,
 * only the point at which the test joins the work has moved.
 */
export function testRunCtx(over: Partial<AgentsLimits> = {}): TestRunCtx {
  const registry = createAgentRegistry({ limits: { ...TEST_LIMITS, ...over } });
  const tasks: Promise<unknown>[] = [];
  const wrapped: AgentRegistry = {
    ...registry,
    adopt(id: string, task: Promise<unknown>): void {
      tasks.push(task);
      registry.adopt(id, task);
    },
  };
  return {
    runCtx: runContextWithAgents(wrapped),
    registry: wrapped,
    settle: async (): Promise<void> => {
      await Promise.allSettled([...tasks]);
    },
  };
}
