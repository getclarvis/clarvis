/**
 * Contract-only test doubles for the capability-side suites.
 *
 * `@clarvis/loop` ships equivalents in `src/runtime/capabilities/testing.ts` and
 * an Ajv-backed `createToolArgValidator`, but this package cannot reach either:
 * the loop depends on it, so importing from there would close a cycle. These
 * build the same shapes out of `@clarvis/capability` alone — the same
 * arrangement `packages/memory/tests/helpers.ts` already uses.
 */
import type {
  AgentBuildContext,
  AgentScope,
  ConvergenceGuards,
  ContextPort,
  RunCapabilityContext,
  RunRequest,
  ToolArgValidate,
  TraceEntry,
  TracePort,
} from "@clarvis/capability";
import { createCapabilityServices, loadEnv } from "@clarvis/capability";

export interface MemoryTrace extends TracePort {
  entries(): TraceEntry[];
}

/**
 * An in-memory {@link TracePort} that accumulates the entries `record` produces.
 *
 * @remarks `signal` is a no-op, matching production: `@clarvis/trace`'s handle
 *   appends only `record` to the persisted entries and treats `signal` as
 *   live-only. Routing both into one array would make `entries()` mean
 *   "recorded or streamed", so a change that swapped a `record` for a `signal` —
 *   losing persistence — would keep every assertion here green. This is the same
 *   fake `@clarvis/memory`'s test helpers already carry.
 */
export function makeTrace(): MemoryTrace {
  const entries: TraceEntry[] = [];
  const origin = performance.now();
  const now = (): number => performance.now() - origin;
  return {
    record: (kind, detail) => entries.push({ at: now(), kind, detail }),
    signal: () => undefined,
    now,
    entries: () => entries,
  };
}

/** A minimal valid {@link RunRequest}; `over` shallow-overrides it. */
function fakeRunRequest(over: Partial<RunRequest> = {}): RunRequest {
  const request: RunRequest = {
    messages: [{ role: "user", content: "task" }],
    servers: [],
    profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 3 }],
    entry: "solo",
    providers: [{ name: "anthropic", kind: "anthropic" }],
    budget: { on_exceed: "stop", total_token_limit: 100_000 },
    ...over,
  };
  return request;
}

/** A minimal valid {@link RunCapabilityContext}; `over` shallow-overrides it. */
export function fakeRunCapabilityContext(
  over: Partial<RunCapabilityContext> = {},
): RunCapabilityContext {
  const context: RunCapabilityContext = {
    owner: "test",
    request: fakeRunRequest(),
    requestParam: () => undefined,
    entryGrants: [],
    env: loadEnv({}),
    workspaceRoot: "/ws",
    llm: {
      call: () => {
        throw new Error("fakeRunCapabilityContext: llm.call not stubbed");
      },
    },
    emit: () => undefined,
    services: createCapabilityServices(),
    executionId: "test-execution",
    ...over,
  };
  return context;
}

/** An {@link AgentScope} for driving `forAgent`; `over` shallow-overrides it. */
export function fakeAgentScope(over: Partial<AgentScope> = {}): AgentScope {
  return { agent: "subagent", entry: true, grants: [], ...over };
}

/**
 * An {@link AgentBuildContext} for driving a contribution's `attach`, whose
 * `trace` is the concrete fake so a test can read back what was recorded.
 */
export function fakeAgentBuildContext(
  over: Partial<Omit<AgentBuildContext, "trace">> & { trace?: MemoryTrace } = {},
): AgentBuildContext & { trace: MemoryTrace } {
  const notes: string[] = [];
  const ctx: ContextPort = {
    appendNote: (note: string) => notes.push(note),
    setStableBlock: () => undefined,
    setCanonicalState: () => undefined,
  };
  const guards: ConvergenceGuards = {
    record: () => undefined,
    takeSoft: () => [],
    tripped: () => null,
    reset: () => undefined,
  };
  return {
    agent: "subagent",
    ctx,
    state: { lastAssistantText: "" },
    trace: over.trace ?? makeTrace(),
    guards,
    toolProgress: (r) => r.errText === null,
    maybeCancelled: () => null,
    validateArgs: fakeValidateArgs,
    ...over,
  };
}

/** One `properties` entry of the JSON Schema subset {@link fakeValidateArgs} reads. */
interface PropertyRule {
  type?: unknown;
  minLength?: unknown;
}

/**
 * A {@link ToolArgValidate} over the JSON Schema subset `load_skill` declares:
 * `type: "object"`, `required`, `additionalProperties: false`, and per-property
 * `type: "string"` + `minLength`.
 *
 * @remarks Deliberately a real validator rather than a `() => null` stub. The
 * engine injects an Ajv-backed one, which this package cannot depend on; a stub
 * that answered "valid" to everything would turn every argument-rejection
 * assertion in the suite green regardless of whether the schema was ever
 * consulted. Error messages mirror Ajv's `errorsText` with `dataVar:
 * "arguments"` so the assertions read the same as they did in the engine's
 * suite.
 */
export const fakeValidateArgs: ToolArgValidate = (schema, args) => {
  const fail = (detail: string): string => `InputValidationError: arguments ${detail}`;
  const failAt = (key: string, detail: string): string =>
    `InputValidationError: arguments/${key} ${detail}`;
  if (
    schema.type === "object" &&
    (typeof args !== "object" || args === null || Array.isArray(args))
  ) {
    return fail("must be object");
  }
  const value = (args ?? {}) as Record<string, unknown>;
  const properties = (schema.properties ?? {}) as Record<string, PropertyRule>;

  for (const key of Array.isArray(schema.required) ? (schema.required as string[]) : []) {
    if (!(key in value)) return fail(`must have required property '${key}'`);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) return fail("must NOT have additional properties");
    }
  }
  for (const [key, rule] of Object.entries(properties)) {
    if (!(key in value)) continue;
    const held = value[key];
    if (rule.type === "string" && typeof held !== "string") {
      return failAt(key, "must be string");
    }
    if (typeof held === "string" && typeof rule.minLength === "number") {
      if (held.length < rule.minLength) {
        return failAt(key, `must NOT have fewer than ${rule.minLength} characters`);
      }
    }
  }
  return null;
};
