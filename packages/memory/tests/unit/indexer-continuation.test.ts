/**
 * Choosing and assembling a pass that continues the run it indexes.
 *
 * @remarks Both halves are pure, and both are places where a plausible-looking
 * change costs the whole prompt-cache saving without failing anything: a request
 * that rebuilds a field instead of carrying it over moves the first differing
 * byte forward, and an eligibility check that is too permissive sends a
 * full-price 100k-token transcript where a 4k digest would have done.
 */
import { describe, expect, it } from "bun:test";

import type { StoredExecution } from "@clarvis/loop";
import {
  buildIndexerContinuationRequest,
  buildIndexerRequest,
  continuationBlocker,
  INDEXER_CONTINUATION_INSTRUCTION,
  INDEXER_ITERATION_LIMIT,
  INDEXER_TOKEN_LIMIT,
} from "../../src/indexer/request.ts";

const MODEL = "anthropic/claude-sonnet-5";

/** Providers as the factory resolves them from live settings. */
const LIVE_PROVIDERS = [{ name: "anthropic", kind: "anthropic" as const }];

/** A stored run that is eligible to be continued; `over` breaks one thing. */
function subject(over: Partial<StoredExecution> = {}): StoredExecution {
  return {
    id: "run_subject",
    owner_key_name: "o",
    status: "completed",
    started_at: 1,
    ended_at: 2,
    elapsed_ms: 1,
    request: {
      messages: [{ role: "user", content: "fix the build" }],
      servers: [],
      entry: "coder",
      profiles: [
        { name: "coder", model: MODEL, tools: ["shell"], iteration_limit: 200 },
        { name: "helper", model: MODEL, tools: [], iteration_limit: 40 },
      ],
      providers: [{ name: "anthropic", kind: "anthropic" }],
      budget: { on_exceed: "stop", total_token_limit: 900_000 },
    },
    response: { status: "completed", result: "done", usage: { iterations_used: 3, elapsed_ms: 1 } },
    trace: { events: [] },
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cached_tokens: 0,
    total_cache_write_tokens: 0,
    final_context: [{ message: { role: "user", content: "fix the build" } }],
    ...over,
  } as unknown as StoredExecution;
}

/** `subject()` with one field of its request replaced. */
function withRequest(over: Record<string, unknown>): StoredExecution {
  const base = subject();
  return { ...base, request: { ...base.request, ...over } } as StoredExecution;
}

describe("deciding whether a pass may continue the run it indexes", () => {
  it("allows it when the run left a resumable context on the same model", () => {
    expect(continuationBlocker(subject(), MODEL)).toBeNull();
  });

  it("refuses when the run is no longer stored", () => {
    expect(continuationBlocker(null, MODEL)).toBe("no-stored-run");
  });

  it("refuses when the run captured no continuation context", () => {
    expect(continuationBlocker(subject({ final_context: undefined }), MODEL)).toBe(
      "no-final-context",
    );
    expect(continuationBlocker(subject({ final_context: [] }), MODEL)).toBe("no-final-context");
  });

  it("refuses a run that declared MCP servers, whose tools are in the cached array", () => {
    expect(continuationBlocker(withRequest({ servers: [{ name: "fs" }] }), MODEL)).toBe(
      "mcp-servers-declared",
    );
  });

  it("refuses when the pass would run on a different model than the run did", () => {
    expect(continuationBlocker(subject(), "openai/gpt-5")).toBe("model-differs");
  });

  it("refuses when the entry profile is missing", () => {
    expect(continuationBlocker(withRequest({ entry: "gone" }), MODEL)).toBe("no-entry-profile");
  });

  it("refuses when the pass deps do not declare a carried profile grant", () => {
    const granted = withRequest({
      profiles: [
        {
          name: "coder",
          model: MODEL,
          tools: ["run_leader"],
          iteration_limit: 200,
          grants: ["workflow"],
        },
      ],
    });
    expect(continuationBlocker(granted, MODEL, new Set(["ask_user"]))).toBe(
      "undeclared-profile-grant",
    );
  });
});

describe("assembling the continuation request", () => {
  it("resumes the indexed run and appends the instruction as the only message", () => {
    const request = buildIndexerContinuationRequest({
      executionId: "run_pass",
      subject: subject(),
      providers: LIVE_PROVIDERS,
    });
    expect(request.continue_from).toBe("run_subject");
    expect(request.execution_id).toBe("run_pass");
    expect(request.messages).toEqual([{ role: "user", content: INDEXER_CONTINUATION_INSTRUCTION }]);
  });

  it("carries over every field the provider hashes, byte for byte", () => {
    const s = subject();
    const request = buildIndexerContinuationRequest({
      executionId: "run_pass",
      subject: s,
      providers: LIVE_PROVIDERS,
    });
    expect(request.entry).toBe(s.request.entry);
    expect(request.providers).toEqual(s.request.providers);
    expect(request.servers).toEqual([]);
    const entry = request.profiles.find((p) => p.name === "coder")!;
    expect(entry.model).toBe(MODEL);
    expect(entry.tools).toEqual(["shell"]);
  });

  it("bounds the entry profile and leaves helper retry policy unchanged", () => {
    const request = buildIndexerContinuationRequest({
      executionId: "run_pass",
      subject: subject(),
      providers: LIVE_PROVIDERS,
    });
    expect(request.profiles.find((p) => p.name === "coder")!.iteration_limit).toBe(
      INDEXER_ITERATION_LIMIT,
    );
    expect(request.profiles.find((p) => p.name === "coder")!.retry).toEqual({ max_retries: 0 });
    expect(request.profiles.find((p) => p.name === "helper")!.iteration_limit).toBe(40);
    expect(request.profiles.find((p) => p.name === "helper")!.retry).toBeUndefined();
  });

  it("derives a stable Memory-only branch from the indexed run's prompt cache key", () => {
    const keyed = withRequest({ session_id: "session_42" });
    expect(
      buildIndexerContinuationRequest({
        executionId: "run_pass",
        subject: keyed,
        providers: LIVE_PROVIDERS,
      }).session_id,
    ).toBe("session_42");
  });

  it("derives the Memory branch from the indexed run id when no explicit key exists", () => {
    expect(
      buildIndexerContinuationRequest({
        executionId: "run_pass",
        subject: subject(),
        providers: LIVE_PROVIDERS,
      }).session_id,
    ).toBe("run_subject");
  });

  it("preserves both persisted components without silently truncating identifiers", () => {
    const keyed = withRequest({ session_id: "x".repeat(510) });
    const request = buildIndexerContinuationRequest({
      executionId: "run_pass",
      subject: keyed,
      providers: LIVE_PROVIDERS,
    });
    expect(request.session_id).toBe(keyed.request.session_id);
    expect(request.agent_instance_id).toBe("run_pass");
  });
});

describe("bounding provider attempts inside a durable job attempt", () => {
  it("disables transport retries on the isolated indexer profile", () => {
    const request = buildIndexerRequest({
      executionId: "run_pass",
      task: "index this run",
      modelRef: MODEL,
      providers: LIVE_PROVIDERS,
    });
    expect(request.profiles[0]!.retry).toEqual({ max_retries: 0 });
  });

  it("overrides a continued entry profile without changing its other retry ceiling", () => {
    const carried = withRequest({
      profiles: [
        {
          name: "coder",
          model: MODEL,
          tools: ["shell"],
          iteration_limit: 200,
          retry: { max_retries: 3, max_retry_after_ms: 9_000 },
        },
      ],
    });
    const request = buildIndexerContinuationRequest({
      executionId: "run_pass",
      subject: carried,
      providers: LIVE_PROVIDERS,
    });
    expect(request.profiles[0]!.retry).toEqual({
      max_retries: 0,
      max_retry_after_ms: 9_000,
    });
  });
});

/**
 * Whether continuing a run is worth it, judged from what that run was charged.
 *
 * @remarks The numbers are the ones a real workspace produced. Passes over
 * `deepseek` through OpenRouter reported 91.8%-98.1% cache on their continued
 * transcripts — the design working. Runs on `alibaba/qwen3.6-flash` reported
 * **zero** cached tokens over 5.1M of input, and a continuation there came back
 * `budget_exhausted` twice: the engine's ledger discounts only what the provider
 * reports, so an unreported cache charges the whole transcript every iteration.
 */
function costed(over: { input: number; cached: number; iterations?: number }): StoredExecution {
  const base = subject();
  return {
    ...base,
    total_input_tokens: over.input,
    total_cached_tokens: over.cached,
    response: {
      status: "completed",
      result: "done",
      usage: { iterations_used: over.iterations ?? 10, elapsed_ms: 1 },
    },
  } as unknown as StoredExecution;
}

describe("refusing to continue a run that got no cache", () => {
  it("blocks the case that failed in production: 5.1M input, nothing cached", () => {
    expect(continuationBlocker(costed({ input: 5_110_875, cached: 0 }), MODEL)).toBe(
      "no-cache-observed",
    );
  });

  it("allows a run whose transcript really was served from cache", () => {
    expect(continuationBlocker(costed({ input: 2_270_231, cached: 2_083_456 }), MODEL)).toBeNull();
  });

  it("does not judge a run too small for a cache to have paid yet", () => {
    expect(continuationBlocker(costed({ input: 8_937, cached: 0 }), MODEL)).toBeNull();
  });
});

describe("the continuation's token allowance", () => {
  it("scales with what the indexed run was actually charged per iteration", () => {
    const cheap = buildIndexerContinuationRequest({
      executionId: "run_pass",
      subject: costed({ input: 2_270_231, cached: 2_083_456, iterations: 40 }),
      providers: LIVE_PROVIDERS,
    });
    const dear = buildIndexerContinuationRequest({
      executionId: "run_pass",
      subject: costed({ input: 2_270_231, cached: 0, iterations: 40 }),
      providers: LIVE_PROVIDERS,
    });
    expect(dear.budget.total_token_limit).toBeGreaterThan(cheap.budget.total_token_limit!);
  });

  it("would have covered the pass that exhausted a flat 200k", () => {
    const request = buildIndexerContinuationRequest({
      executionId: "run_pass",
      subject: costed({ input: 264_503, cached: 0, iterations: 2 }),
      providers: LIVE_PROVIDERS,
    });
    expect(request.budget.total_token_limit).toBeGreaterThan(264_503);
  });

  it("stays at the base allowance for a run that cost nothing to re-send", () => {
    const request = buildIndexerContinuationRequest({
      executionId: "run_pass",
      subject: costed({ input: 1000, cached: 1000 }),
      providers: LIVE_PROVIDERS,
    });
    expect(request.budget.total_token_limit).toBe(INDEXER_TOKEN_LIMIT);
  });
});
