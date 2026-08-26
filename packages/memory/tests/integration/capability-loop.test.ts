/**
 * The two lifecycle seams that only a real loop can prove for the memory
 * capability: what reaches the model, and when the durable run-end write is
 * allowed to release the response.
 *
 * Capability gates, provider surfaces, ingest notice mapping and broker
 * delivery have narrower owners in `tests/component/` and are intentionally
 * not repeated here.
 */
import { describe, expect, it, vi } from "bun:test";

import { loadEnv, type CapabilityRegistry, createCapabilityRegistry } from "@clarvis/capability";
import { executeRun, type ExecuteRunDeps } from "@clarvis/loop";
import { createTestRunInfrastructure, MockLLM } from "@clarvis/loop/testing";

import type { Memory, MemoryToolDef, RunSnapshot } from "../../src/index.ts";
import {
  createMemoryCapability,
  MEMORY_READ_TOOL_NAMES,
  MEMORY_WRITE_TOOL_NAMES,
  type MemoryFactory,
} from "../../src/capability.ts";
import { memorySettingsSpec } from "../../src/settings.ts";
import {
  MEMORY_TOOL_CONTRACTS,
  memoryToolParameters,
  type MemoryToolName,
} from "../../src/tool-contract.ts";

const BODY = {
  messages: [{ role: "user", content: "build the project" }],
  servers: [],
  profiles: [
    {
      name: "solo",
      model: "anthropic/x",
      tools: [],
      iteration_limit: 3,
    },
  ],
  entry: "solo",
  providers: [{ name: "anthropic", kind: "anthropic" }],
  budget: { on_exceed: "stop", total_token_limit: 1000 },
};

const SEED = "profile stuff";

interface FakeMemory {
  memory: Memory;
  seed: ReturnType<typeof vi.fn>;
  enqueue: ReturnType<typeof vi.fn>;
  queued: RunSnapshot[];
}

function memoryTools(): MemoryToolDef[] {
  return [...MEMORY_READ_TOOL_NAMES, ...MEMORY_WRITE_TOOL_NAMES].map((name) => {
    const contract = MEMORY_TOOL_CONTRACTS[name as MemoryToolName];
    return {
      name,
      description: contract.description,
      parameters: memoryToolParameters(name as MemoryToolName),
      execute: () => Promise.resolve({ text: "", isError: false }),
    };
  });
}

function fakeMemory(over: { enqueue?: Memory["enqueue"] } = {}): FakeMemory {
  const queued: RunSnapshot[] = [];
  const seed = vi.fn().mockResolvedValue(SEED);
  const enqueue = vi.fn(
    over.enqueue ??
      ((snapshot: RunSnapshot) => {
        queued.push(snapshot);
        return Promise.resolve({
          run_id: snapshot.run_id,
          state: "pending" as const,
          enqueued_at: 0,
          updated_at: 0,
          attempts: 0,
          history: [],
        });
      }),
  );
  return {
    memory: {
      seed,
      enqueue,
      index: vi.fn(),
      tools: memoryTools(),
    } as unknown as Memory,
    seed,
    enqueue,
    queued,
  };
}

function factoryOf(memory: Memory): MemoryFactory {
  return {
    forOwner: () => memory,
    forOwnerControlPlane: () => memory,
    start: () => {},
    poke: () => {},
    stop: async () => {},
    subscribeToRun: () => () => {},
  };
}

function capabilityRegistry(): CapabilityRegistry {
  const registry = createCapabilityRegistry();
  registry.register(memorySettingsSpec);
  return registry;
}

function deps(memory: Memory, llm: MockLLM): ExecuteRunDeps {
  const env = loadEnv({ CLARVIS_LOG_LEVEL: "silent" });
  const workspaceRoot = process.cwd();
  return {
    ...createTestRunInfrastructure({ env, workspaceRoot }),
    env,
    llm,
    capabilities: [createMemoryCapability(factoryOf(memory))],
    capabilityRegistry: capabilityRegistry(),
  };
}

describe("memory capability through executeRun", () => {
  it("injects the PROFILE seed and advertises the wiki tools to the model", async () => {
    const fake = fakeMemory();
    const llm = new MockLLM({ script: [{ text: "done" }] });

    const { response } = await executeRun({
      rawBody: BODY,
      owner: "owner-1",
      deps: deps(fake.memory, llm),
    });

    expect(response.status).toBe("completed");
    expect(fake.seed).toHaveBeenCalledWith("build the project");
    expect(llm.calls[0]!.messages[1]).toEqual({
      role: "user",
      content: `<memory>\n${SEED}\n</memory>`,
    });
    expect(llm.calls[0]!.tools.map((tool) => tool.wireName).sort()).toEqual(
      [...MEMORY_READ_TOOL_NAMES, ...MEMORY_WRITE_TOOL_NAMES].sort(),
    );
  });

  it("awaits the durable enqueue before returning the completed response", async () => {
    let releaseEnqueue!: () => void;
    let enteredEnqueue!: () => void;
    const enqueueEntered = new Promise<void>((resolve) => {
      enteredEnqueue = resolve;
    });
    const enqueueReleased = new Promise<void>((resolve) => {
      releaseEnqueue = resolve;
    });
    const queued: RunSnapshot[] = [];
    const fake = fakeMemory({
      enqueue: async (snapshot) => {
        queued.push(snapshot);
        enteredEnqueue();
        await enqueueReleased;
        return {
          run_id: snapshot.run_id,
          state: "pending",
          enqueued_at: 0,
          updated_at: 0,
          attempts: 0,
          history: [],
        };
      },
    });
    const running = executeRun({
      rawBody: BODY,
      owner: "owner-1",
      deps: deps(fake.memory, new MockLLM({ script: [{ text: "done" }] })),
    });
    let returned = false;
    void running.then(() => {
      returned = true;
    });

    await enqueueEntered;
    await Promise.resolve();
    expect(returned).toBe(false);

    releaseEnqueue();
    const { executionId, response } = await running;
    expect(response.status).toBe("completed");
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      run_id: executionId,
      workspace: process.cwd(),
      status: "completed",
      task: "build the project",
    });
  });

  it("still queues the persisted record when the run is cancelled", async () => {
    const fake = fakeMemory();

    const { executionId, response } = await executeRun({
      rawBody: BODY,
      owner: "owner-1",
      deps: deps(fake.memory, new MockLLM({ script: [{ text: "unused" }] })),
      externalSignal: AbortSignal.abort({ source: "test" }),
    });

    expect(response.status).toBe("cancelled");
    expect(fake.queued).toHaveLength(1);
    expect(fake.queued[0]).toMatchObject({ run_id: executionId, status: "cancelled" });
  });
});
