import { expect, it } from "bun:test";
import type { AgentBuildContext, AgentResult, RunCapabilityContext } from "@clarvis/capability";
import { createStewardResultGate } from "../../src/goals/steward-result-gate.ts";
import { loadEnv } from "@clarvis/capability";
import type { ExecuteRunDeps } from "@clarvis/loop";
import { createStewardExecutionRuntime } from "../../src/goals/steward-runtime.ts";
import {
  captureRunInstructions,
  readRunInstructions,
} from "../../src/runs/instruction-snapshot.ts";

it("excludes required Judge from the Steward execution while retaining tools and its result gate", async () => {
  let executions = 0;
  const runtime = createStewardExecutionRuntime({
    owner: "fixture",
    model: "fixture/model",
    providers: [{ name: "fixture", kind: "anthropic" }],
    settings: {},
    workTokenLimit: 10000,
    promptCacheTtl: "1h",
    configurationGeneration: "fixture",
    deps: {
      env: loadEnv({}),
      llm: {
        call: async () => {
          throw new Error("Executor fixture must not call the model");
        },
      },
      capabilities: [
        { name: "tools", forRun: () => null },
        {
          name: "judge",
          required: true,
          forRun: () => {
            throw new Error("Steward must not instantiate Judge");
          },
        },
      ],
    } as unknown as ExecuteRunDeps,
    executeRun: async (args) => {
      executions++;
      expect(args.deps.capabilities?.map((capability) => capability.name)).toEqual([
        "tools",
        "goal-steward-result",
      ]);
      return {
        executionId: "steward",
        response: {
          status: "completed",
          result: { decision: "aligned", summary: "Work remains aligned" },
          usage: { iterations_used: 1, elapsed_ms: 1, by_agent: [] },
        },
      };
    },
  });
  expect(
    (
      await runtime.run({
        execution_id: "steward",
        session_id: "session",
        projection: "frame",
        budget: runtime.budget,
        prompt_cache_ttl: "1h",
        validateResult: async () => undefined,
      })
    ).result.decision,
  ).toBe("aligned");
  expect(executions).toBe(1);
});

it("fingerprints resolved model metadata and opaque configuration generation without spending the work allowance", () => {
  const make = (
    generation: string,
    contextWindowTokens = 32768,
    ttl: "5m" | "1h" = "5m",
    content = "Verify changes",
  ) =>
    createStewardExecutionRuntime({
      instructions: readRunInstructions(captureRunInstructions({}, [{ scope: "global", content }])),
      owner: "fixture",
      model: "logical/model",
      providers: [],
      settings: {},
      workTokenLimit: 12345,
      promptCacheTtl: ttl,
      configurationGeneration: generation,
      deps: {
        env: loadEnv({}),
        capabilities: [],
        modelExecutionResolver: {
          resolve: () => ({
            provider: "logical",
            model: "model",
            kind: "openai-compatible",
            contextWindowTokens,
            maxOutputTokens: 4096,
            capabilities: ["tool_calling"],
            reasoningEfforts: undefined,
            promptCache: undefined,
          }),
        },
      } as unknown as ExecuteRunDeps,
      executeRun: async () => {
        throw new Error("No inference in fingerprint construction");
      },
    });
  const first = make("generation-one");
  expect(first.fingerprint).toBe(make("generation-one").fingerprint);
  expect(first.fingerprint).not.toBe(make("generation-two").fingerprint);
  expect(first.fingerprint).not.toBe(make("generation-one", 65536).fingerprint);
  expect(first.fingerprint).not.toBe(make("generation-one", 32768, "1h").fingerprint);
  expect(first.fingerprint).not.toBe(
    make("generation-one", 32768, "5m", "Changed instructions").fingerprint,
  );
  expect(first.budget.max_net_tokens).toBe(12345);
  expect(first.workspaceReadAvailable).toBe(false);
});

for (const rejected of [false, true]) {
  it(`preserves cancellation while Steward result validation ${rejected ? "rejects" : "succeeds"}`, async () => {
    const validation = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let cancelled: AgentResult | null = null;
    const capability = createStewardResultGate(async () => {
      entered.resolve();
      await validation.promise;
    });
    const run = await capability.forRun({} as RunCapabilityContext);
    const contribution = run!.forAgent({ entry: true, agent: "subagent", grants: [] })!.attach({
      maybeCancelled: () => cancelled,
      state: { lastAssistantText: "" },
    } as AgentBuildContext);
    const outcome = contribution.gates![0]!.check({ mode: "submit", value: {} });
    await entered.promise;
    cancelled = { status: "cancelled", partialText: "" };
    if (rejected) validation.reject(new Error("cancelled read"));
    else validation.resolve();
    expect(await outcome).toEqual({ kind: "terminal", result: cancelled });
  });
}
