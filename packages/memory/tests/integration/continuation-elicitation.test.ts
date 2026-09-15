/**
 * A pass may continue a run whose profile can talk to the human.
 *
 * @remarks `executeRun` refuses a request outright — before any model call —
 * when the derived shape enables user input and no `elicit` is wired:
 * `an 'ask_user' grant, a soft budget, or a capability that must reach the human
 * requires an MCP client that declares the 'elicitation' capability`. A
 * continuation inherits the indexed run's entry profile **verbatim**, grants
 * included, because grants decide the tool array and the system head — so the
 * moment a real coder profile carried `ask_user`, every continuation failed
 * deterministically and the run lost its learning.
 *
 * Stripping the grant is not available: it would change the advertised tools and
 * the system head, which is exactly the prefix the pass exists to reuse. The
 * answer is to supply an elicit that declines, which is also the truth — the
 * pass runs on a background drain with no human attached, and `ask_user` is
 * refused at dispatch anyway.
 *
 * The isolated pass never hit this: its profile is a constant with no grants at
 * all. That is precisely why the hot path needed its own test.
 */
import { describe, expect, it } from "bun:test";

import type { Capability } from "@clarvis/capability";
import { executeRun, type ExecuteRunDeps } from "@clarvis/loop";
import { createTestTraceStore } from "@clarvis/loop/testing";
import { DEFAULT_BUDGETS } from "../../src/config.ts";
import { indexRun } from "../../src/indexer/run.ts";
import { createInMemoryMemoryStore } from "../../src/testing.ts";
import { makeExecutionRecord, run as runSnapshot } from "../helpers/fixtures.ts";
import { fakeIndexerRuntime } from "../helpers/indexer-runtime.ts";
import type { IndexerRuntime } from "../../src/types.ts";

const MODEL = "anthropic/x";
const OWNER = "o";
const SUBJECT = "run_subject";

/** A capability standing in for whatever else the host has registered. */
const hostCapability: Capability = { name: "tools", forRun: () => null };

/**
 * A runtime whose stored subject carries `grants`, with `passDeps` wired.
 *
 * @param grants - the entry profile's grants; `["ask_user"]` is the case that
 *   used to fail.
 */
async function runtimeWithGrants(grants: string[], asks = false): Promise<IndexerRuntime> {
  const { runtime } = fakeIndexerRuntime(
    asks
      ? [
          { toolCalls: [{ name: "ask_user", arguments: { question: "continue?" } }] },
          { text: "Nothing worth recording." },
        ]
      : [{ text: "Nothing worth recording." }],
  );
  const traceStore = createTestTraceStore();
  await traceStore.insert(
    makeExecutionRecord({
      id: SUBJECT,
      owner_key_name: OWNER,
      request: {
        messages: [{ role: "user", content: "fix the build" }],
        servers: [],
        entry: "coder",
        profiles: [{ name: "coder", model: MODEL, tools: [], iteration_limit: 200, grants }],
        providers: [{ name: "anthropic", kind: "anthropic" }],
        budget: { on_exceed: "stop", total_token_limit: 900_000 },
      },
      final_context: [
        {
          message: { role: "user", content: "fix the build" },
          evictable: false,
          canonical: false,
          summary: false,
        },
      ],
    } as Parameters<typeof makeExecutionRecord>[0]),
  );

  const deps: ExecuteRunDeps = { ...runtime.deps, traceStore };
  const passDeps: ExecuteRunDeps = { ...deps, capabilities: [hostCapability] };
  return { ...runtime, owner: OWNER, modelRef: MODEL, deps, passDeps };
}

/** Run one pass over a fresh wiki. */
async function pass(indexer: IndexerRuntime) {
  return indexRun({
    run: runSnapshot({ run_id: SUBJECT }),
    store: createInMemoryMemoryStore(),
    budgets: DEFAULT_BUDGETS,
    indexer,
  });
}

describe("continuing a run whose profile carries an ask_user grant", () => {
  it("recovers the last persisted history across an empty reservation without changing instance", async () => {
    const indexer = await runtimeWithGrants([]);
    const subject = indexer.deps.traceStore.getById(OWNER, SUBJECT)!;
    const prior = {
      ...subject,
      id: "run_prior_index",
      request: { ...subject.request, session_id: "session", agent_instance_id: "memory-instance" },
      final_context: [
        ...subject.final_context!,
        {
          message: { role: "user" as const, content: "Persisted indexing cursor" },
          evictable: false,
          canonical: false,
          summary: false,
        },
      ],
    };
    await indexer.deps.traceStore.insert(prior);
    let observed = false;
    indexer.executeRun = (args) => {
      const request = args.rawBody as typeof subject.request;
      expect(request.continue_from).toBe(prior.id);
      expect(request.agent_instance_id).toBe("memory-instance");
      expect(request.session_id).toBe("session");
      observed = true;
      return executeRun(args);
    };
    await indexRun({
      run: runSnapshot({ run_id: SUBJECT }),
      store: createInMemoryMemoryStore(),
      budgets: DEFAULT_BUDGETS,
      indexer,
      agentInstanceId: "memory-instance",
      executionId: "run_resumed_index",
      priorExecutions: ["run_empty_claim", prior.id],
    });
    expect(observed).toBe(true);
    const resumed = indexer.deps.traceStore.getById(OWNER, "run_resumed_index")!;
    expect(resumed.final_context?.slice(0, prior.final_context.length)).toEqual(
      prior.final_context,
    );
  });

  it("does not fail the pre-flight elicitation check", async () => {
    const report = await pass(await runtimeWithGrants(["ask_user"]));
    expect(report.continuation_blocker).toBeNull();
    expect(report.run_id).toBe(SUBJECT);
  });

  it("still works for a profile with no grants at all", async () => {
    const report = await pass(await runtimeWithGrants([]));
    expect(report.continuation_blocker).toBeNull();
  });

  it("carries the grant through, since it decides the cached tool array", async () => {
    const indexer = await runtimeWithGrants(["ask_user"]);
    await pass(indexer);
    const sent = indexer.deps.traceStore.getById(OWNER, SUBJECT)!;
    expect(sent.request.profiles[0]!.grants).toEqual(["ask_user"]);
  });

  it("declines an ask_user call raised by the unattended pass", async () => {
    const report = await pass(await runtimeWithGrants(["ask_user"], true));
    expect(report.run_id).toBe(SUBJECT);
  });

  it("names the blocking batch when recovery must be resolved first", async () => {
    const store = createInMemoryMemoryStore();
    store.recover = () =>
      Promise.resolve({
        required: true,
        entries: [{ batch_id: "blocked", outcome: "required", paths: [] }],
      });

    await expect(
      indexRun({
        run: runSnapshot({ run_id: SUBJECT }),
        store,
        budgets: DEFAULT_BUDGETS,
        indexer: await runtimeWithGrants([]),
      }),
    ).rejects.toThrow("batch blocked");
  });

  it("classifies an invalid assembled run as a terminal generation failure", async () => {
    const indexer = await runtimeWithGrants([]);
    indexer.modelRef = "undeclared/model";

    await expect(
      indexRun({
        run: runSnapshot({ run_id: SUBJECT }),
        store: createInMemoryMemoryStore(),
        budgets: DEFAULT_BUDGETS,
        indexer,
      }),
    ).rejects.toMatchObject({ phase: "generate", terminal: true });
  });
});
