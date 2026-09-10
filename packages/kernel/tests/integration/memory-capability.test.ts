/**
 * One composition-root sentinel for execution memory.
 *
 * The capability's seed/tool/onRunEnd matrix belongs to `@clarvis/memory`.
 * Kernel owns only the join: its registry accepts the memory run parameter,
 * the deps-level capability reaches an ordinary run, and the registered marker
 * remains live when that capability is inactive for a continuation.
 */
import { describe, expect, it, vi } from "bun:test";

import { contentToText, createCapabilityRegistry, loadEnv } from "@clarvis/capability";
import { createMemory } from "@clarvis/memory";
import {
  createMemoryCapability,
  type MemoryFactory,
  type MemoryIngestNotice,
} from "@clarvis/memory/capability";
import { createConnectionManager, defaultMCPClientFactory } from "@clarvis/mcp-client";
import { type ExecuteRunDeps } from "@clarvis/loop";
import { MockLLM } from "@clarvis/loop/testing";
import { createInMemoryMemoryStore } from "@clarvis/memory/testing";
import { createMemoryTraceStore } from "@clarvis/trace/testing";

import { createMemoryConfigStore } from "../../src/config.ts";
import { createInProcessKernel } from "../../src/index.ts";
import { kernelIdentity } from "../helpers/kernel-identity.ts";

const SEED = "<memory>\nprofile stuff\n</memory>";

function memoryComposition(): {
  factory: MemoryFactory;
  capability: ReturnType<typeof createMemoryCapability>;
} {
  const settlements = new Map<string, (notice: MemoryIngestNotice) => void>();
  const memory = createMemory({ store: createInMemoryMemoryStore() });
  memory.seed = vi.fn().mockResolvedValue("profile stuff");
  memory.enqueue = vi.fn().mockImplementation((snapshot: { run_id: string }) =>
    Promise.resolve({
      run_id: snapshot.run_id,
      state: "pending",
      enqueued_at: 0,
      updated_at: 0,
      attempts: 0,
      history: [],
    }),
  );
  const factory: MemoryFactory = {
    forOwner: () => memory,
    forOwnerControlPlane: () => memory,
    start: () => {},
    poke: () => {
      for (const [executionId, settle] of settlements) {
        settlements.delete(executionId);
        settle({
          execution_id: executionId,
          phase: "done",
          written: 0,
          deleted: 0,
          reindexed: false,
        });
      }
    },
    stop: async () => {},
    subscribeToRun: (_owner, executionId, settle) => {
      settlements.set(executionId, settle);
      return () => settlements.delete(executionId);
    },
  };
  return { factory, capability: createMemoryCapability(factory) };
}

describe("kernel memory composition root", () => {
  it("registers the param, injects memory through deps, and keeps its inactive seed marker", async () => {
    const workspaceRoot = process.cwd();
    const env = loadEnv({ CLARVIS_LOG_LEVEL: "silent" });
    const llm = new MockLLM({ script: [{ text: "first" }, { text: "second" }] });
    const memory = memoryComposition();
    const deps: ExecuteRunDeps = {
      env,
      llm,
      connections: createConnectionManager({
        workspace: workspaceRoot,
        factory: defaultMCPClientFactory,
        connectTimeoutMs: env.CLARVIS_MCP_CONNECT_TIMEOUT_MS,
        callTimeoutMs: env.CLARVIS_MCP_TOOL_CALL_TIMEOUT_MS,
        idleTtlMs: env.CLARVIS_MCP_POOL_IDLE_TTL_MS,
      }),
      traceStore: createMemoryTraceStore(),
      workspaceRoot,
      capabilities: [memory.capability],
      // The kernel must merge its own memory settings spec into this empty host
      // registry or the strict run schema rejects `memory` below.
      capabilityRegistry: createCapabilityRegistry(),
    };
    const kernel = createInProcessKernel({
      deps,
      workspaceRoot,
      ...kernelIdentity(workspaceRoot),
      configStore: createMemoryConfigStore(),
      memoryFactory: memory.factory,
      assembleRunRequest: (params) => ({
        execution_id: params.execution_id,
        messages: params.messages,
        servers: [],
        profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 3 }],
        entry: "solo",
        providers: [{ name: "anthropic", kind: "anthropic" }],
        budget: { on_exceed: "stop", total_token_limit: 1000 },
        ...(params.continue_from === undefined
          ? { memory: "on" }
          : { memory: "off", continue_from: params.continue_from }),
      }),
    });

    const first = await kernel.runs.start({
      messages: [{ role: "user", content: "build the project" }],
      agent: "solo",
    });
    for await (const _event of first.events) void _event;
    expect((await first.done).status).toBe("completed");
    expect(kernel.capabilities.memory).toBe(true);
    expect(llm.calls[0]!.messages[1]).toEqual({ role: "user", content: SEED });
    expect(llm.calls[0]!.tools.map((tool) => tool.wireName)).toContain("read_memory");

    const continued = await kernel.runs.start({
      messages: [{ role: "user", content: "continue without memory" }],
      agent: "solo",
      continue_from: first.execution_id,
    });
    for await (const _event of continued.events) void _event;
    expect((await continued.done).status).toBe("completed");
    expect(
      llm.calls[1]!.messages.some((message) =>
        contentToText(message.content).startsWith("<memory>"),
      ),
    ).toBe(true);

    await kernel.close();
  });
});
