import { describe, expect, it, vi } from "bun:test";

import { loadEnv, type CapabilityEvent, type ExecutionRecord } from "@clarvis/capability";
import type { ExecuteRunDeps } from "@clarvis/loop";
import type { Memory } from "@clarvis/memory";
import {
  MEMORY_READ_TOOL_NAMES,
  MEMORY_TOOL_CONTRACTS,
  memoryToolParameters,
  type MemoryFactory,
  type MemoryToolDef,
  type MemoryToolName,
} from "@clarvis/memory/capability";
import {
  createHostMemoryBridge,
  RUNTIME_MEMORY_METHOD,
  RUNTIME_MEMORY_REVISION,
  validRuntimeMemoryDescriptor,
} from "../../src/runtime/memory-bridge.ts";

function tool(name: MemoryToolName, execute = vi.fn()): MemoryToolDef {
  execute.mockResolvedValue({ text: "HOST_MEMORY_RESULT", isError: false });
  return {
    name,
    description: MEMORY_TOOL_CONTRACTS[name].description,
    parameters: memoryToolParameters(name),
    execute,
  };
}

function request(memory: "on" | "off" = "on") {
  return {
    execution_id: "run-1",
    messages: [{ role: "user" as const, content: "HOST_MEMORY_TASK" }],
    servers: [],
    profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 3 }],
    entry: "solo",
    providers: [{ name: "anthropic", kind: "anthropic" as const }],
    memory,
    budget: { on_exceed: "stop" as const, total_token_limit: 1_000 },
  };
}

describe("runtime memory bridge", () => {
  it("keeps provider execution and post-run handling on the host", async () => {
    const seed = vi.fn().mockResolvedValue("HOST_MEMORY_SEED");
    const read = vi.fn();
    const provider = {
      kind: "fixture",
      readTools: MEMORY_READ_TOOL_NAMES.map((name) =>
        tool(name, name === "read_memory" ? read : vi.fn()),
      ),
      seed,
    };
    const memory = {} as Memory;
    const factory: MemoryFactory = {
      forOwner: () => memory,
      forOwnerControlPlane: () => memory,
      providerFor: async () => ({
        ok: true,
        provider,
        key: `fixture:${"a".repeat(64)}`,
        seedMaxChars: 6_000,
      }),
      start() {},
      poke() {},
      async stop() {},
      subscribeToRun: () => () => undefined,
    };
    const record = {
      id: "run-1",
      owner_key_name: "owner",
      request: request(),
    } as unknown as ExecutionRecord;
    const events: CapabilityEvent[] = [];
    const deps = {
      env: loadEnv({}),
      workspaceRoot: "/host/private/workspace",
      llm: { call: () => Promise.reject(new Error("unused")) },
      traceStore: {
        getById: (owner: string, id: string) =>
          owner === "owner" && id === "run-1" ? record : null,
      },
    } as unknown as ExecuteRunDeps;
    const bridge = await createHostMemoryBridge({
      factory,
      rawBody: request(),
      owner: "owner",
      runId: "run-1",
      deps,
      onCapabilityEvent: (event) => events.push(event),
    });
    if (bridge === undefined) throw new Error("expected host memory bridge");

    expect(validRuntimeMemoryDescriptor(bridge.descriptor)).toBe(true);
    expect(JSON.stringify(bridge.descriptor)).not.toContain("/host/private");
    expect(bridge.grant).toMatchObject({
      method: RUNTIME_MEMORY_METHOD,
      revision: RUNTIME_MEMORY_REVISION,
      idempotent: false,
    });
    await expect(
      bridge.grant.invoke({ operation: "seed" }, new AbortController().signal),
    ).resolves.toEqual({ kind: "seed", value: "HOST_MEMORY_SEED" });
    expect(seed).toHaveBeenCalledWith("HOST_MEMORY_TASK");
    expect(
      bridge.grant.validateArguments({
        operation: "call",
        name: "read_memory",
        arguments: { paths: [] },
      }),
    ).toBe(false);
    await expect(
      bridge.grant.invoke(
        {
          operation: "call",
          name: "read_memory",
          arguments: { paths: ["PROFILE.md"] },
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: "result", text: "HOST_MEMORY_RESULT", isError: false });
    expect(read).toHaveBeenCalledTimes(1);
    await expect(
      bridge.grant.invoke({ operation: "finish" }, new AbortController().signal),
    ).resolves.toEqual({ kind: "finished" });
    expect(events).toEqual([
      {
        capability: "memory",
        kind: "ingest",
        detail: {
          execution_id: "run-1",
          phase: "done",
          skipped: true,
          note: "provider-read-only",
        },
      },
    ]);
    await expect(
      bridge.grant.invoke({ operation: "finish" }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("withholds the bridge when the run explicitly disables memory", async () => {
    const factory = {
      forOwnerControlPlane: () => ({}) as Memory,
    } as unknown as MemoryFactory;
    await expect(
      createHostMemoryBridge({
        factory,
        rawBody: request("off"),
        owner: "owner",
        runId: "run-1",
        deps: {
          env: loadEnv({}),
          workspaceRoot: "/workspace",
          llm: { call: () => Promise.reject(new Error("unused")) },
        } as unknown as ExecuteRunDeps,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects forged mutations even when the host provider supports writes", async () => {
    const memory = {} as Memory;
    const factory: MemoryFactory = {
      forOwner: () => memory,
      forOwnerControlPlane: () => memory,
      providerFor: async () => ({
        ok: true,
        provider: {
          kind: "read-write-fixture",
          readTools: MEMORY_READ_TOOL_NAMES.map((name) => tool(name)),
          writeTools: [tool("write_memory")],
          seed: async () => null,
        },
        key: `fixture:${"b".repeat(64)}`,
        seedMaxChars: 6_000,
      }),
      start() {},
      poke() {},
      async stop() {},
      subscribeToRun: () => () => undefined,
    };
    const bridge = await createHostMemoryBridge({
      factory,
      rawBody: request(),
      owner: "owner",
      runId: "run-1",
      deps: {
        env: loadEnv({}),
        workspaceRoot: "/host/private/workspace",
        llm: { call: () => Promise.reject(new Error("unused")) },
      } as unknown as ExecuteRunDeps,
    });
    if (bridge === undefined) throw new Error("expected host memory bridge");

    expect(bridge.descriptor).toEqual({
      providerDigest: "b".repeat(64),
      seedMaxChars: 6_000,
      readTools: [...MEMORY_READ_TOOL_NAMES],
    });
    expect(
      validRuntimeMemoryDescriptor({
        ...bridge.descriptor,
        writeTools: ["write_memory"],
      }),
    ).toBe(false);
    expect(
      validRuntimeMemoryDescriptor({
        ...bridge.descriptor,
        readTools: [...bridge.descriptor.readTools, "read_memory"],
      }),
    ).toBe(false);
    const forged = {
      operation: "call",
      name: "write_memory",
      arguments: { path: "PROFILE.md", content: "forged" },
    };
    expect(bridge.grant.validateArguments(forged)).toBe(false);
    await expect(bridge.grant.invoke(forged, new AbortController().signal)).rejects.toMatchObject({
      code: "invalid_request",
    });
  });
});
