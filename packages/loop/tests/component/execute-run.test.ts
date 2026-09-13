import { describe, it, expect } from "../bun-test.ts";
import { executeRun, type ExecuteRunDeps } from "../../src/runtime/execute-run.ts";
import { loadEnv } from "@clarvis/capability";
import { OPERATOR_AUTHORITY_PORT, type OperatorAuthorityState } from "@clarvis/capability";
import type { Capability, TraceEvent, SteerMessage } from "@clarvis/capability";
import type { TraceStore } from "@clarvis/trace";
import { ConflictError, PersistenceError } from "@clarvis/capability";
import { MockLLM, mockConnections, mockMCPFactory } from "../helpers/fixtures.ts";
import { makeTestTraceStore } from "../contract/_helpers.ts";
import { makeExecutionRecord } from "../helpers/execution-record.ts";
import { createAskUserCapability } from "../../src/runtime/capabilities/ask-user.ts";

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
  it("rejects authority-shaped public request fields before host runtime creation", async () => {
    for (const key of [
      "operator_evidence",
      "operatorAuthoritySeed",
      "controller_epoch",
      "operator_authority_state",
    ]) {
      let created = false;
      await expect(
        executeRun({
          rawBody: { ...BODY, [key]: {} },
          owner: "o",
          deps: makeDeps({
            operatorAuthority: () => {
              created = true;
              throw new Error("not admitted");
            },
          }),
        }),
      ).rejects.toMatchObject({ code: "invalid_message_format" });
      expect(created).toBe(false);
    }
  });
  it("prepublishes one authority reader and revokes intent without cancelling background execution", async () => {
    const retirement = new AbortController();
    const state: OperatorAuthorityState = {
      version: 1,
      status: "active",
      revision: 1,
      binding: { owner_key_name: "o", session_id: "session", controller_epoch: "epoch" },
      evidence: [{ id: "operator", source: "start", text: "Inspect", execution_id: "run" }],
    };
    const reader = { snapshot: () => structuredClone(state) };
    const traceStore = makeTestTraceStore();
    let creations = 0;
    const observers: Capability[] = ["first", "second"].map((name) => ({
      name,
      forRun(ctx) {
        expect(ctx.services.get(OPERATOR_AUTHORITY_PORT)).toBe(reader);
        return { name, forAgent: () => null };
      },
    }));
    const result = await executeRun({
      rawBody: BODY,
      owner: "o",
      operatorAuthoritySignal: retirement.signal,
      operatorAuthoritySeed: { binding: state.binding, evidence: state.evidence },
      deps: makeDeps({
        traceStore,
        capabilities: observers,
        operatorAuthority(input) {
          creations++;
          expect(input.seed?.evidence).toEqual(state.evidence);
          input.signal?.addEventListener("abort", () => {
            state.status = "revoked";
            state.revision++;
          });
          return {
            reader,
            onSteer: () => {},
            onElicitation: () => {},
            finalize: () => structuredClone(state),
          };
        },
        llm: {
          async call() {
            retirement.abort();
            return {
              text: "done",
              usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cache_write_tokens: 0 },
            };
          },
        },
      }),
    });
    expect(creations).toBe(1);
    expect(result.response).toMatchObject({ status: "completed" });
    expect(traceStore.getById("o", result.executionId)?.operator_authority_state).toMatchObject({
      version: 1,
      status: "revoked",
      revision: 2,
    });
  });
  it("publishes pending steer intent before capability activation and preserves its delivery identity", async () => {
    const state: OperatorAuthorityState = {
      version: 1,
      status: "active",
      revision: 1,
      binding: { owner_key_name: "o", session_id: "session", controller_epoch: "epoch" },
      evidence: [{ id: "seed", source: "start", text: "Create a skill", execution_id: "run" }],
    };
    const pending: SteerMessage[] = [{ content: "Do not write settings" }];
    const received: string[] = [];
    const unique = new Set<string>();
    let unsubscribed = false;
    let closed = false;
    const traceStore = makeTestTraceStore();
    const result = await executeRun({
      rawBody: BODY,
      owner: "o",
      operatorAuthoritySeed: { binding: state.binding, evidence: state.evidence },
      steer: {
        onPending(listener) {
          for (const message of pending) listener(message);
          return () => {
            unsubscribed = true;
          };
        },
        drain: () => pending.splice(0),
        close: () => {
          closed = true;
        },
      },
      deps: makeDeps({
        traceStore,
        capabilities: [
          {
            name: "observer",
            forRun(ctx) {
              expect(received).toHaveLength(1);
              expect(ctx.services.get(OPERATOR_AUTHORITY_PORT)?.snapshot().revision).toBe(2);
              return { name: "observer", forAgent: () => null };
            },
          },
        ],
        operatorAuthority() {
          return {
            reader: { snapshot: () => structuredClone(state) },
            onSteer(context) {
              expect(context.message).toBe("Do not write settings");
              received.push(context.id!);
              if (!unique.has(context.id!)) {
                unique.add(context.id!);
                state.revision++;
              }
            },
            onElicitation() {},
            finalize: () => structuredClone(state),
          };
        },
      }),
    });
    expect(result.response.status).toBe("completed");
    expect(received.length).toBeGreaterThanOrEqual(2);
    expect(unique.size).toBe(1);
    expect(unsubscribed).toBeTrue();
    expect(closed).toBeTrue();
    expect(traceStore.getById("o", result.executionId)?.operator_authority_state?.revision).toBe(2);
  });

  it("admits an accepted ask_user answer with the model question before the next iteration", async () => {
    const state: OperatorAuthorityState = {
      version: 1,
      status: "active",
      revision: 1,
      binding: { owner_key_name: "o", session_id: "session", controller_epoch: "epoch" },
      evidence: [{ id: "seed", source: "start", text: "Inspect", execution_id: "run" }],
    };
    const admitted: Array<{ question: string; answer: string }> = [];
    const traceStore = makeTestTraceStore();
    const result = await executeRun({
      rawBody: {
        ...BODY,
        profiles: [
          {
            name: "solo",
            model: "anthropic/x",
            tools: [],
            iteration_limit: 3,
            grants: ["ask_user"],
          },
        ],
      },
      owner: "o",
      operatorAuthoritySeed: { binding: state.binding, evidence: state.evidence },
      elicit: async (params) => {
        expect(params.kind).toBe("ask_user");
        return { action: "accept", content: { response: "Authorize the three lines" } };
      },
      deps: makeDeps({
        traceStore,
        capabilities: [createAskUserCapability()],
        llm: new MockLLM({
          script: [
            {
              toolCalls: [
                {
                  name: "ask_user",
                  arguments: { question: "May I update SAFE-09 through SAFE-11?" },
                },
              ],
            },
            { text: "done" },
          ],
        }),
        operatorAuthority() {
          return {
            reader: { snapshot: () => structuredClone(state) },
            onSteer() {},
            onElicitation(context) {
              admitted.push(context);
              state.revision++;
              state.evidence.push({
                id: "elicitation",
                source: "ask_user",
                prompt: context.question,
                text: context.answer,
                execution_id: "run",
              });
            },
            finalize: () => structuredClone(state),
          };
        },
      }),
    });
    expect(result.response.status).toBe("completed");
    expect(admitted).toEqual([
      {
        question: "May I update SAFE-09 through SAFE-11?",
        answer: "Authorize the three lines",
      },
    ]);
    expect(traceStore.getById("o", result.executionId)?.operator_authority_state?.revision).toBe(2);
  });

  it.each(["decline", "cancel"] as const)(
    "does not admit a %s ask_user outcome as operator evidence",
    async (action) => {
      const state: OperatorAuthorityState = {
        version: 1,
        status: "active",
        revision: 1,
        binding: { owner_key_name: "o", session_id: "session", controller_epoch: "epoch" },
        evidence: [{ id: "seed", source: "start", text: "Inspect", execution_id: "run" }],
      };
      let admissions = 0;
      const result = await executeRun({
        rawBody: {
          ...BODY,
          profiles: [
            {
              name: "solo",
              model: "anthropic/x",
              tools: [],
              iteration_limit: 3,
              grants: ["ask_user"],
            },
          ],
        },
        owner: "o",
        operatorAuthoritySeed: { binding: state.binding, evidence: state.evidence },
        elicit: async () => ({ action }),
        deps: makeDeps({
          capabilities: [createAskUserCapability()],
          llm: new MockLLM({
            script: [
              { toolCalls: [{ name: "ask_user", arguments: { question: "Proceed?" } }] },
              { text: "done" },
            ],
          }),
          operatorAuthority() {
            return {
              reader: { snapshot: () => structuredClone(state) },
              onSteer() {},
              onElicitation() {
                admissions++;
              },
              finalize: () => structuredClone(state),
            };
          },
        }),
      });
      expect(result.response.status).toBe("completed");
      expect(admissions).toBe(0);
      expect(state.revision).toBe(1);
    },
  );

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
