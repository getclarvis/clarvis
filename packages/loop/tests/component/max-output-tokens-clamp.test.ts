/**
 * Clamping a profile's requested `max_output_tokens` to what the model's context
 * window can actually serve.
 *
 * @remarks Named for what it clamps, because the old `output-budget-clamp` read
 * as a test of `OutputTokenBudget` and its reservations — the workflow-tree
 * ledger — which nothing here touches.
 */
import { describe, expect, it } from "../bun-test.ts";

import { loadEnv } from "@clarvis/capability";
import { executeRun, type ExecuteRunDeps } from "../../src/runtime/execute-run.ts";
import { MockLLM, mockConnections, mockMCPFactory } from "../helpers/fixtures.ts";
import { makeTestTraceStore } from "../contract/_helpers.ts";

function body(models: Record<string, unknown>): Record<string, unknown> {
  return {
    messages: [{ role: "user", content: "hi" }],
    servers: [],
    profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 3 }],
    entry: "solo",
    providers: [{ name: "anthropic", kind: "anthropic", models }],
    budget: { on_exceed: "stop", total_token_limit: 1000 },
  };
}

function makeDeps(llm: MockLLM): ExecuteRunDeps {
  return {
    env: loadEnv({}),
    llm,
    connections: mockConnections(mockMCPFactory({})),
    traceStore: makeTestTraceStore(),
    workspaceRoot: process.cwd(),
  };
}

describe("completion budget clamp (prompt + completion must fit the window)", () => {
  it("clamps a max_output_tokens sized at the full context window", async () => {
    const llm = new MockLLM({ script: [{ text: "done" }] });
    await executeRun({
      rawBody: body({ x: { context_window_tokens: 1000, max_output_tokens: 1000 } }),
      owner: "o",
      deps: makeDeps(llm),
    });
    const sent = llm.calls[0]!.maxOutputTokens;
    expect(sent).toBeDefined();
    expect(sent!).toBeLessThan(1000);
    expect(sent!).toBeGreaterThan(0);
  });

  it("leaves a modest configured budget untouched", async () => {
    const llm = new MockLLM({ script: [{ text: "done" }] });
    await executeRun({
      rawBody: body({ x: { context_window_tokens: 1_000_000, max_output_tokens: 4096 } }),
      owner: "o",
      deps: makeDeps(llm),
    });
    expect(llm.calls[0]!.maxOutputTokens).toBe(4096);
  });

  it("sends no completion budget when none is configured", async () => {
    const llm = new MockLLM({ script: [{ text: "done" }] });
    await executeRun({
      rawBody: body({ x: { context_window_tokens: 1000 } }),
      owner: "o",
      deps: makeDeps(llm),
    });
    expect(llm.calls[0]!.maxOutputTokens).toBeUndefined();
  });
});
