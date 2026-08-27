/**
 * Which of the two paths a pass takes, and what it hands `executeRun`.
 *
 * @remarks `planPass` is exported for this. It is the join between a decision
 * that is cheap to check (`continuationBlocker`) and a deps object that is
 * expensive to get wrong: the hot path must *prepend* to the host's capability
 * list and the cold path must *replace* it, and confusing the two fails in
 * opposite, equally silent ways — a prepend on the cold path would hand an
 * isolated pass the host's whole toolset, and a replace on the hot path would
 * strip the tools the provider already cached and re-bill the request.
 */
import { describe, expect, it } from "bun:test";

import type { ExecuteRunDeps } from "@clarvis/loop";
import { createTestTraceStore } from "@clarvis/loop/testing";
import { DEFAULT_BUDGETS } from "../../src/config.ts";
import { planPass } from "../../src/indexer/run.ts";
import { createTouchedLedger } from "../../src/indexer/pyramid.ts";
import { createInMemoryMemoryStore } from "../../src/testing.ts";
import { makeExecutionRecord, run as runSnapshot } from "../helpers/fixtures.ts";
import { fakeIndexerRuntime } from "../helpers/indexer-runtime.ts";
import type { IndexerRuntime } from "../../src/types.ts";
import type { Capability } from "@clarvis/capability";

const MODEL = "anthropic/x";
const OWNER = "o";

/** A capability standing in for whatever else the host has registered. */
function hostCapability(name: string): Capability {
  return { name, forRun: () => null };
}

/**
 * A runtime whose trace store holds the subject run, with `passDeps` wired.
 *
 * @param over - `stored` false leaves the trace store empty; `finalContext`
 *   false stores the run without resumable context; `model` overrides the
 *   pass's model.
 */
async function runtimeFor(
  over: { stored?: boolean; finalContext?: boolean; model?: string; grants?: string[] } = {},
): Promise<{ indexer: IndexerRuntime; subjectId: string }> {
  const { runtime } = fakeIndexerRuntime([]);
  const subjectId = "run_subject";
  const traceStore = createTestTraceStore();

  if (over.stored !== false) {
    await traceStore.insert(
      makeExecutionRecord({
        id: subjectId,
        owner_key_name: OWNER,
        request: {
          messages: [{ role: "user", content: "fix the build" }],
          servers: [],
          entry: "coder",
          profiles: [
            {
              name: "coder",
              model: MODEL,
              tools: ["shell"],
              iteration_limit: 200,
              ...(over.grants !== undefined ? { grants: over.grants } : {}),
            },
          ],
          providers: [{ name: "anthropic", kind: "anthropic" }],
          budget: { on_exceed: "stop", total_token_limit: 900_000 },
        },
        ...(over.finalContext === false
          ? {}
          : { final_context: [{ message: { role: "user", content: "fix the build" } }] }),
      } as Parameters<typeof makeExecutionRecord>[0]),
    );
  }

  const deps: ExecuteRunDeps = { ...runtime.deps, traceStore };
  const passDeps: ExecuteRunDeps = {
    ...deps,
    capabilities: [hostCapability("tools"), hostCapability("memory")],
  };
  return {
    indexer: { ...runtime, owner: OWNER, modelRef: over.model ?? MODEL, deps, passDeps },
    subjectId,
  };
}

/** Run `planPass` over a fresh wiki. */
function plan(indexer: IndexerRuntime, subjectId: string) {
  return planPass({
    run: runSnapshot({ run_id: subjectId }),
    indexer,
    indexerRunId: "run_pass",
    store: createInMemoryMemoryStore(),
    budgets: DEFAULT_BUDGETS,
    ledger: createTouchedLedger(),
  });
}

describe("planning a pass over the indexed run's prefix", () => {
  it("continues the run and prepends to the host's capability list", async () => {
    const { indexer, subjectId } = await runtimeFor();
    const p = plan(indexer, subjectId);
    expect(p.blocker).toBeNull();
    expect(p.rawBody.continue_from).toBe(subjectId);
    expect(p.deps.capabilities).toHaveLength(3);
    expect(p.deps.capabilities!.slice(1).map((c) => c.name)).toEqual(["tools", "memory"]);
  });

  it("takes the pass's own model from the run it continues, not a fresh profile", async () => {
    const { indexer, subjectId } = await runtimeFor();
    const p = plan(indexer, subjectId);
    expect(p.rawBody.entry).toBe("coder");
    expect(p.rawBody.profiles[0]!.tools).toEqual(["shell"]);
  });
});

describe("falling back to an isolated pass", () => {
  it("replaces the capability list rather than prepending", async () => {
    const { indexer, subjectId } = await runtimeFor({ stored: false });
    const p = plan(indexer, subjectId);
    expect(p.blocker).toBe("no-stored-run");
    expect(p.rawBody.continue_from).toBeUndefined();
    expect(p.deps.capabilities).toHaveLength(1);
    expect(p.rawBody.entry).toBe("memory-indexer");
  });

  it("falls back when the host wired no continuation deps at all", async () => {
    const { indexer, subjectId } = await runtimeFor();
    const withoutPassDeps: IndexerRuntime = { ...indexer };
    delete (withoutPassDeps as { passDeps?: unknown }).passDeps;
    const p = plan(withoutPassDeps, subjectId);
    expect(p.blocker).toBe("no-pass-deps");
    expect(p.deps.capabilities).toHaveLength(1);
  });

  it("falls back when the run left nothing to resume", async () => {
    const { indexer, subjectId } = await runtimeFor({ finalContext: false });
    expect(plan(indexer, subjectId).blocker).toBe("no-final-context");
  });

  it("falls back when the pass would run on a different model", async () => {
    const { indexer, subjectId } = await runtimeFor({ model: "openai/gpt-5" });
    expect(plan(indexer, subjectId).blocker).toBe("model-differs");
  });

  it("falls back when a dynamic manager grant is absent from the pass deps", async () => {
    const { indexer, subjectId } = await runtimeFor({ grants: ["workflow"] });
    const p = plan(indexer, subjectId);
    expect(p.blocker).toBe("undeclared-profile-grant");
    expect(p.rawBody.continue_from).toBeUndefined();
    expect(p.rawBody.entry).toBe("memory-indexer");
  });
});
