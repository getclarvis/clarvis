import { describe, it, expect } from "../bun-test.ts";
import { executeRun, type ExecuteRunDeps } from "../../src/runtime/execute-run.ts";
import { loadEnv } from "@clarvis/capability";
import type { Capability, TraceEvent } from "@clarvis/capability";
import type { TraceStore } from "@clarvis/trace";
import { ConflictError, PersistenceError } from "@clarvis/capability";
import { MockLLM, mockConnections, mockMCPFactory } from "../helpers/fixtures.ts";
import { makeTestTraceStore } from "../contract/_helpers.ts";
import { makeExecutionRecord } from "../helpers/execution-record.ts";

const BODY = {
  messages: [{ role: "user", content: "hi" }],
  servers: [],
  profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 3 }],
  entry: "solo",
  providers: [{ name: "anthropic", kind: "anthropic" }],
  budget: { on_exceed: "stop", total_token_limit: 1000 },
};

function makeDeps(over: Partial<ExecuteRunDeps> = {}): ExecuteRunDeps {
  return {
    env: loadEnv({}),
    llm: new MockLLM({ script: [{ text: "done" }] }),
    connections: mockConnections(mockMCPFactory({})),
    traceStore: makeTestTraceStore(),
    workspaceRoot: process.cwd(),
    ...over,
  };
}

function insertThrows(thrown: unknown): TraceStore {
  return {
    ...makeTestTraceStore(),
    existsForOwner: () => false,
    async insert() {
      throw thrown;
    },
  } satisfies TraceStore;
}

describe("executeRun (shared engine)", () => {
  it("runs a subagent-only request to completion and returns an execution id + response", async () => {
    const { executionId, response } = await executeRun({
      rawBody: BODY,
      owner: "o",
      deps: makeDeps(),
    });
    expect(executionId).toMatch(/^exec_/);
    expect(response.status).toBe("completed");
    expect(response.usage).toBeDefined();
  });

  it("throws ConflictError when a caller execution_id already exists for the owner", async () => {
    const traceStore = makeTestTraceStore();
    await traceStore.insert(makeExecutionRecord({ id: "dup", owner_key_name: "o" }));
    await expect(
      executeRun({
        rawBody: { ...BODY, execution_id: "dup" },
        owner: "o",
        deps: makeDeps({ traceStore }),
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("throws PersistenceError when the store insert fails", async () => {
    await expect(
      executeRun({
        rawBody: BODY,
        owner: "o",
        deps: makeDeps({ traceStore: insertThrows(new Error("read-only")) }),
      }),
    ).rejects.toBeInstanceOf(PersistenceError);
  });

  it("rejects a request that needs a human when no elicit handler is injected", async () => {
    const askUserBody = {
      ...BODY,
      profiles: [
        { name: "solo", model: "anthropic/x", tools: [], iteration_limit: 3, grants: ["ask_user"] },
      ],
    };
    await expect(
      executeRun({ rawBody: askUserBody, owner: "o", deps: makeDeps() }),
    ).rejects.toMatchObject({ code: "elicitation_not_supported" });
  });

  it("forwards the onEvent sink (live trace events are observed during the run)", async () => {
    const seen: TraceEvent[] = [];
    await executeRun({
      rawBody: BODY,
      owner: "o",
      deps: makeDeps(),
      onEvent: (e) => seen.push(e),
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((e) => e.type === "subagent_iteration")).toBe(true);
  });

  it("shares one capability projector composition between live and persisted mapping", async () => {
    const seen: TraceEvent[] = [];
    let projections = 0;
    const capability: Capability = {
      name: "iteration-projector",
      persistedTraceProjectors: [
        {
          kind: "capability_iteration",
          project(entry, context) {
            projections += 1;
            return {
              type: "projected_iteration",
              occurred_at: context.absoluteTime(entry.at),
              source_kind: entry.kind,
            };
          },
        },
      ],
      forRun: () => ({
        name: "iteration-projector",
        forAgent: () => ({
          attach(build) {
            build.trace.record("capability_iteration", { agent: build.agent });
            return {};
          },
        }),
      }),
    };
    const traceStore = makeTestTraceStore();
    const outcome = await executeRun({
      rawBody: BODY,
      owner: "o",
      deps: makeDeps({ traceStore, capabilities: [capability] }),
      onEvent: (event) => seen.push(event),
    });

    const live = seen.find((event) => event.type === "projected_iteration");
    const persisted = traceStore
      .getById("o", outcome.executionId)!
      .trace.events.find((event) => event.type === "projected_iteration");
    expect(JSON.stringify(persisted)).toBe(JSON.stringify(live));
    expect(projections).toBe(2);
  });
});

describe("executeRun error and cancellation contract", () => {
  it("maps a ConflictError from insert (duplicate id) to a fresh ConflictError", async () => {
    await expect(
      executeRun({
        rawBody: BODY,
        owner: "o",
        deps: makeDeps({
          traceStore: insertThrows(new ConflictError("execution_id 'x' already exists")),
        }),
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("treats a non-conflict insert failure as a persistence failure", async () => {
    await expect(
      executeRun({
        rawBody: BODY,
        owner: "o",
        deps: makeDeps({ traceStore: insertThrows("read-only filesystem") }),
      }),
    ).rejects.toBeInstanceOf(PersistenceError);
  });

  it("cancels immediately when the external signal is already aborted", async () => {
    const { response } = await executeRun({
      rawBody: BODY,
      owner: "o",
      deps: makeDeps(),
      externalSignal: AbortSignal.abort({ source: "mcp" }),
    });
    expect(response.status).toBe("cancelled");
  });
});
