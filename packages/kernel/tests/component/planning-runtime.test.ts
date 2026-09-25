import { describe, expect, it, vi } from "bun:test";
import {
  createCapabilityServices,
  loadEnv,
  type RunCapabilityContext,
  type RunRequest,
} from "@clarvis/capability";
import { createPlanStore, type PlanStore } from "@clarvis/plan";
import { createInMemoryPlanRepository } from "@clarvis/plan/testing";

import { createPlansService } from "../../src/plans/plans-service.ts";
import { createPlanningRuntime } from "../../src/plans/planning-runtime.ts";

const REQUEST = {
  messages: [{ role: "user", content: "task" }],
  servers: [],
  providers: [{ name: "anthropic", kind: "anthropic" }],
  profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 3 }],
  entry: "solo",
  budget: { on_exceed: "stop", total_token_limit: 1_000 },
} as RunRequest;

function context(owner: string): RunCapabilityContext {
  return {
    owner,
    request: REQUEST,
    entryGrants: [],
    env: loadEnv({}),
    workspaceRoot: "/workspace",
    resolvedPromptCacheTtl: "5m",
    executionBaseLlm: {
      call: async () => {
        throw new Error("Unused execution provider");
      },
    },
    llm: { call: () => Promise.reject(new Error("unused")) },
    emit: () => undefined,
    executionId: "run-1",
    services: createCapabilityServices(),
    requestParam: () => undefined,
  };
}

describe("createPlanningRuntime", () => {
  it("shares one owner store between capability and control plane", async () => {
    const buildStore = vi.fn((): PlanStore =>
      createPlanStore({ repository: createInMemoryPlanRepository() }),
    );
    const runtime = createPlanningRuntime({
      workspaceRoot: "/workspace",
      env: loadEnv({}),
      storeFor: buildStore,
      loadProvider: () => undefined,
    });
    expect(await runtime.capability.forRun(context("alice"))).not.toBeNull();
    const store = (await runtime.planFactory.storeFor("alice")).store;
    const created = await store.create({
      title: "Shared",
      objective: "one store",
      tasks: [{ title: "verify" }],
      createdByRun: "run-1",
    });
    const service = createPlansService({ resolve: () => runtime.planFactory.storeFor("alice") });
    expect((await service.read(created.id)).title).toBe("Shared");
    expect(buildStore).toHaveBeenCalledTimes(1);
  });
});
