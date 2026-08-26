/** Contract-only doubles for capability and component tests. */
import type {
  AgentBuildContext,
  ContextPort,
  LLMCallParams,
  LLMCallResult,
  LLMProvider,
  RunCapabilityContext,
  RunRequest,
  TraceEntry,
  TracePort,
} from "@clarvis/capability";
import { loadEnv } from "@clarvis/capability";

/**
 * Contract-shaped test doubles for the capability-side suites.
 *
 * @remarks These predate the edge inversion, when this package could not import
 * `@clarvis/loop` at all and had to restate the smallest shapes its suites
 * exercise. They stay because they are smaller and cheaper than the engine's,
 * not because the import is still forbidden.
 */

/** An in-memory {@link TracePort} that just accumulates what it is given. */
export function makeTrace(): TracePort & { entries: () => TraceEntry[] } {
  const entries: TraceEntry[] = [];
  const startedAt = performance.now();
  const now = (): number => performance.now() - startedAt;
  const push = (kind: string, detail: unknown): void => {
    entries.push({ at: now(), kind, detail } as TraceEntry);
  };
  return {
    trace: { entries },
    record: push,
    signal: () => undefined,
    entries: () => entries,
    now,
  } as unknown as TracePort & { entries: () => TraceEntry[] };
}

/**
 * A scripted {@link LLMProvider} that records the calls it received and answers
 * one script step per call, throwing once the script runs out.
 *
 * @remarks The engine ships an equivalent as `MockLLM`; this reproduces the
 * wire shape a memory indexer pass actually reads, which is `text` plus a
 * snake_case `usage` block.
 */
export class ScriptedLLM implements LLMProvider {
  readonly calls: LLMCallParams[] = [];
  private cursor = 0;

  constructor(private readonly opts: { script: { text?: string; throw?: Error }[] }) {}

  call(params: LLMCallParams): Promise<LLMCallResult> {
    this.calls.push({ ...params, messages: structuredClone(params.messages) });
    const step = this.opts.script[this.cursor];
    if (step === undefined) {
      throw new Error(`ScriptedLLM exhausted (call #${this.cursor + 1}); add more script steps.`);
    }
    this.cursor += 1;
    if (step.throw) throw step.throw;
    return Promise.resolve({
      text: step.text,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cached_tokens: 0,
        cache_write_tokens: 0,
      },
    } as unknown as LLMCallResult);
  }
}
/**
 * Contract-shaped fakes for the capability suites.
 *
 * @remarks `@clarvis/loop` ships equivalents in
 * `src/runtime/capabilities/testing.ts`, but a capability that lives outside the
 * engine cannot reach them without closing a cycle — the loop depends on this
 * package. These build the same shapes out of the contract alone.
 */
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

/** A minimal valid {@link RunCapabilityContext}; `over` shallow-overrides it. */
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
    requestParam: () => undefined,
    ...over,
  } as RunCapabilityContext;
}

/** A minimal valid {@link AgentBuildContext}; `over` shallow-overrides it. */
export function fakeAgentBuildContext(over: Partial<AgentBuildContext> = {}): AgentBuildContext {
  const notes: string[] = [];
  const ctx: ContextPort = {
    appendNote: (note: string) => notes.push(note),
    setStableBlock: () => undefined,
    setCanonicalState: () => undefined,
  } as unknown as ContextPort;
  return {
    agent: "subagent",
    ctx,
    state: { lastAssistantText: "" },
    trace: makeTrace(),
    guards: { noteToolCall: () => undefined } as unknown as AgentBuildContext["guards"],
    toolProgress: (r) => r.errText === null,
    maybeCancelled: () => null,
    ...over,
  } as AgentBuildContext;
}
