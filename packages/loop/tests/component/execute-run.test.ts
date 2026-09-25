import { describe, it, expect } from "../bun-test.ts";
import { executeRun, type ExecuteRunDeps } from "../../src/runtime/execute-run.ts";
import { loadEnv } from "@clarvis/capability";
import { RUN_TRACE_PORT } from "@clarvis/capability";
import type { Capability, TraceEvent } from "@clarvis/capability";
import type { TraceStore } from "@clarvis/trace";
import { createTraceVisibilityView } from "@clarvis/trace";
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
    executionVisibility: "public",
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
  it("shares in-flight execution ids across public and internal views", async () => {
    const physical = makeTestTraceStore();
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const llm = new MockLLM({ script: [{ text: "done" }] });
    const deps = makeDeps({
      traceStore: createTraceVisibilityView(physical, "public"),
      llm: {
        async call(params) {
          started();
          await blocked;
          return llm.call(params);
        },
      },
    });
    const body = { ...BODY, execution_id: "shared-in-flight" };
    const first = executeRun({ rawBody: body, owner: "owner", deps });
    try {
      await entered;
      await expect(
        executeRun({
          rawBody: body,
          owner: "owner",
          deps: {
            ...deps,
            executionVisibility: "internal",
            traceStore: createTraceVisibilityView(physical, "internal"),
          },
        }),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(llm.calls).toHaveLength(0);
    } finally {
      release();
      await first;
    }
    expect(llm.calls).toHaveLength(1);
  });

  it("rejects missing host visibility before activation or inference", async () => {
    let activations = 0;
    const llm = new MockLLM({ script: [{ text: "unreachable" }] });
    const deps = makeDeps({
      llm,
      capabilities: [
        {
          name: "probe",
          forRun() {
            activations++;
            return null;
          },
        },
      ],
    });
    delete (deps as Partial<ExecuteRunDeps>).executionVisibility;
    await expect(executeRun({ rawBody: BODY, owner: "owner", deps })).rejects.toBeInstanceOf(
      PersistenceError,
    );
    expect(activations).toBe(0);
    expect(llm.calls).toHaveLength(0);
  });

  it.each(["public", "internal"] as const)(
    "persists the explicit host %s classification",
    async (visibility) => {
      const deps = makeDeps({ executionVisibility: visibility });
      const result = await executeRun({
        rawBody: { ...BODY, execution_id: "classified" },
        owner: "owner",
        deps,
      });
      expect(result.response.status).toBe("completed");
      expect(deps.traceStore.getById("owner", "classified")?.visibility).toBe(visibility);
    },
  );

  it("publishes the run trace during forRun and journals later contributed records", async () => {
    const journaled: TraceEvent[] = [];
    const traceStore: TraceStore = {
      ...makeTestTraceStore(),
      openJournal: () => ({
        append: (entry) => {
          if (entry !== null) journaled.push(entry);
        },
        close: () => {},
        discard: () => {},
      }),
    };
    const capability: Capability = {
      name: "activation-trace",
      persistedTraceProjectors: [
        {
          kind: "activation_observed",
          project(entry, context) {
            return {
              type: "activation_observed",
              occurred_at: context.absoluteTime(entry.at),
            };
          },
        },
      ],
      forRun(ctx) {
        const trace = ctx.services.get(RUN_TRACE_PORT);
        expect(trace).toBeDefined();
        trace!.record("activation_observed", {});
        return {
          name: "activation-trace",
          forAgent: () => ({
            attach(build) {
              build.trace.record("activation_observed", {});
              return {};
            },
          }),
        };
      },
    };
    const outcome = await executeRun({
      rawBody: BODY,
      owner: "o",
      deps: makeDeps({
        traceStore,
        capabilities: [capability],
      }),
    });
    const persisted = traceStore
      .getById("o", outcome.executionId)!
      .trace.events.filter((entry) => entry.type === "activation_observed");
    expect(persisted).toHaveLength(2);
    expect(journaled.filter((entry) => entry.type === "activation_observed")).toHaveLength(2);
  });

  it("keeps contributed trace accounting out of provider messages and final_context", async () => {
    const run = async (withTrace: boolean) => {
      const calls: unknown[] = [];
      const traceStore = makeTestTraceStore();
      const outcome = await executeRun({
        rawBody: BODY,
        owner: "o",
        deps: makeDeps({
          traceStore,
          llm: {
            async call(params) {
              calls.push(structuredClone(params.messages));
              return {
                text: "done",
                usage: {
                  input_tokens: 1,
                  output_tokens: 1,
                  cached_tokens: 0,
                  cache_write_tokens: 0,
                },
              };
            },
          },
          capabilities: withTrace
            ? [
                {
                  name: "trace-only",
                  forRun(ctx) {
                    ctx.services.get(RUN_TRACE_PORT)!.record("auxiliary_model_call", {
                      usage: "private accounting",
                    });
                    return { name: "trace-only", forAgent: () => null };
                  },
                },
              ]
            : [],
        }),
      });
      return {
        calls,
        context: traceStore.getById("o", outcome.executionId)!.final_context,
      };
    };
    const baseline = await run(false);
    const instrumented = await run(true);
    expect(instrumented.calls).toEqual(baseline.calls);
    expect(instrumented.context).toEqual(baseline.context);
    expect(JSON.stringify(instrumented)).not.toContain("auxiliary_model_call");
    expect(JSON.stringify(instrumented)).not.toContain("private accounting");
  });
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

  it("captures opaque host metadata once and persists it with the run", async () => {
    const traceStore = makeTestTraceStore();
    let reads = 0;
    const extensionProfileMetadata = {
      extension_profile: {
        id: "global:research",
        fingerprint: `sha256:${"a".repeat(64)}`,
      },
    };
    const outcome = await executeRun({
      rawBody: BODY,
      owner: "o",
      deps: makeDeps({
        traceStore,
        hostMetadata: () => {
          reads += 1;
          return extensionProfileMetadata;
        },
      }),
    });

    expect(reads).toBe(1);
    expect(traceStore.getById("o", outcome.executionId)?.host_metadata).toEqual(
      extensionProfileMetadata,
    );
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
