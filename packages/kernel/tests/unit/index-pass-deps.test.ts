/**
 * The indexing pass's deps must differ from the run's in exactly two ways.
 *
 * @remarks Both differences are invisible everywhere else. Dropping the hooks
 * filter fires a `PreToolUse` hook on the indexer's own `write_memory` calls —
 * hooks are not grant-gated, so nothing else would stop it — and a capability
 * that is present but inactive strips the seed block the continuation carried
 * out of the middle of the transcript, re-billing every token behind it.
 * Dropping `enqueueOnRunEnd: false` lets a pass enqueue itself forever.
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

const named = (name: string): Capability => ({ name, forRun: () => null });

function baseDeps(): ExecuteRunDeps {
  return {
    llm: { call: () => Promise.reject(new Error("unused")) },
    capabilities: [named("tools"), named(HOOKS_CAPABILITY_NAME), named("agents")],
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
  it("removes the workspace-hooks capability rather than leaving it inactive", () => {
    expect(names(composeIndexPassDeps(baseDeps(), undefined))).not.toContain(HOOKS_CAPABILITY_NAME);
  });

  it("keeps every other capability, in the order the host registered them", () => {
    expect(names(composeIndexPassDeps(baseDeps(), undefined)).slice(0, 2)).toEqual([
      "tools",
      "agents",
    ]);
  });

  it("registers memory unconditionally, so a carried seed marker stays recognised", () => {
    expect(names(composeIndexPassDeps(baseDeps(), undefined))).toContain(MEMORY_CAPABILITY_NAME);
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
    expect(names(deps)).toEqual(["tools", HOOKS_CAPABILITY_NAME, "agents"]);
  });
});
