/**
 * The host owns the indexing pass's capability projection.
 *
 * @remarks Dropping the hooks
 * filter fires a `PreToolUse` hook on the indexer's own `write_memory` calls —
 * hooks are not grant-gated, so nothing else would stop it. Dropping
 * `enqueueOnRunEnd: false` lets a pass enqueue itself forever. Retaining active
 * planning lets its gates and finalizer mutate the source plan despite dispatch
 * restrictions; the catalog projection owns neither.
 *
 * `@clarvis/memory`'s own suite proves the flag is invisible on the wire; what
 * only a kernel test can see is that the host actually passes it, and actually
 * removes hooks rather than deactivating them.
 */
import { describe, expect, it } from "bun:test";
import {
  createCapabilityServices,
  HOOKS_CAPABILITY_NAME,
  loadEnv,
  type Capability,
  type RunCapability,
  type RunCapabilityContext,
  type RunRequest,
} from "@clarvis/capability";
import { createMemory } from "@clarvis/memory";
import { MEMORY_CAPABILITY_NAME, type MemoryFactory } from "@clarvis/memory/capability";
import { createInMemoryMemoryStore } from "@clarvis/memory/testing";
import type { ExecuteRunDeps } from "@clarvis/loop";
import { composeIndexPassDeps } from "../../src/memory/pass-deps.ts";
import { createPlansCapability } from "@clarvis/plan/capability";

const named = (name: string): Capability => ({ name, forRun: () => null });

function baseDeps(): ExecuteRunDeps {
  return {
    llm: { call: () => Promise.reject(new Error("unused")) },
    capabilities: [
      named("tools"),
      named(HOOKS_CAPABILITY_NAME),
      named("agents"),
      named(MEMORY_CAPABILITY_NAME),
      named("tasks"),
    ],
  } as unknown as ExecuteRunDeps;
}

function memoryFactory(): MemoryFactory {
  const memory = createMemory({ store: createInMemoryMemoryStore() });
  return { forOwner: () => memory, forOwnerControlPlane: () => memory } as unknown as MemoryFactory;
}

function context(): RunCapabilityContext {
  return {
    owner: "alice",
    request: { entry: "solo" } as RunRequest,
    entryGrants: [],
    env: loadEnv({}),
    workspaceRoot: "/workspace",
    llm: { call: () => Promise.reject(new Error("unused")) },
    emit: () => undefined,
    executionId: "run-1",
    services: createCapabilityServices(),
    requestParam: () => undefined,
  };
}

const names = (deps: ExecuteRunDeps): string[] => (deps.capabilities ?? []).map((c) => c.name);

describe("composeIndexPassDeps", () => {
  it("replaces planning in place with a catalog projection that cannot open the source provider", async () => {
    const planning = createPlansCapability({
      factory: {
        storeFor: async () => {
          throw new Error("Source provider accessed");
        },
      },
      defaultPendingTaskNudges: 3,
      defaultElicitWaitMs: 30000,
    });
    const deps = baseDeps();
    deps.capabilities = [named("tools"), planning, named("tasks")];
    const pass = composeIndexPassDeps(deps, undefined);
    expect(names(pass)).toEqual(["tools", "plans", "tasks", MEMORY_CAPABILITY_NAME]);
    expect(pass.capabilities![0]).toBe(deps.capabilities[0]);
    expect(pass.capabilities![2]).toBe(deps.capabilities[2]);
    expect(pass.capabilities![1]).not.toBe(planning);
    const run = await pass.capabilities![1]!.forRun(context());
    expect(run).not.toHaveProperty("finalizeRun");
    expect(run).not.toHaveProperty("onRunEnd");
  });
  it("removes the workspace-hooks capability rather than leaving it inactive", () => {
    expect(names(composeIndexPassDeps(baseDeps(), undefined))).not.toContain(HOOKS_CAPABILITY_NAME);
  });

  it("keeps every other capability, in the order the host registered them", () => {
    expect(names(composeIndexPassDeps(baseDeps(), undefined)).slice(0, 3)).toEqual([
      "tools",
      "agents",
      "tasks",
    ]);
  });

  it("replaces ordinary memory with exactly one pass capability", () => {
    expect(
      names(composeIndexPassDeps(baseDeps(), undefined)).filter(
        (name) => name === MEMORY_CAPABILITY_NAME,
      ),
    ).toEqual([MEMORY_CAPABILITY_NAME]);
  });

  it("suppresses the post-run enqueue, so a pass cannot index itself", async () => {
    const factory = memoryFactory();
    const pass = composeIndexPassDeps(baseDeps(), factory);
    const capability = (pass.capabilities ?? []).find((c) => c.name === MEMORY_CAPABILITY_NAME)!;

    const run = (await capability.forRun(context())) as RunCapability | null;

    expect(run).not.toBeNull();
    expect(Object.hasOwn(run!, "onRunEnd")).toBe(false);
  });

  it("carries every non-capability dep through untouched", () => {
    const deps = baseDeps();
    const { capabilities: _passCaps, ...restOfPass } = composeIndexPassDeps(deps, undefined);
    const { capabilities: _depCaps, ...restOfDeps } = deps;
    expect(restOfPass).toEqual(restOfDeps);
  });

  it("does not mutate the deps it was given", () => {
    const deps = baseDeps();
    composeIndexPassDeps(deps, undefined);
    expect(names(deps)).toEqual([
      "tools",
      HOOKS_CAPABILITY_NAME,
      "agents",
      MEMORY_CAPABILITY_NAME,
      "tasks",
    ]);
  });
});
