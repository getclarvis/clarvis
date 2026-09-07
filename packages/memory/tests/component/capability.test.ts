import { describe, expect, it, vi } from "bun:test";

import { SEED_OPEN_TAG, type Memory, type MemoryToolDef } from "../../src/index.ts";

import { loadEnv } from "@clarvis/capability";
import {
  createMemoryCapability,
  MEMORY_CAPABILITY_NAME,
  MEMORY_READ_TOOL_NAMES,
  MEMORY_WRITE_TOOL_NAMES,
  prepareMemoryRuntime,
  type MemoryFactory,
  type MemoryIngestNotice,
} from "../../src/capability.ts";
import { fakeAgentBuildContext, fakeRunCapabilityContext } from "../helpers/capability.ts";
import { makeExecutionRecord } from "../helpers/fixtures.ts";
import type { AgentBuildContext, CapabilityEvent, RunCapabilityContext } from "@clarvis/capability";
import {
  MEMORY_TOOL_CONTRACTS,
  memoryToolParameters,
  type MemoryToolName,
} from "../../src/tool-contract.ts";

function memTool(name: string): MemoryToolDef {
  const canonical = MEMORY_TOOL_CONTRACTS[name as MemoryToolName];
  return {
    name,
    description: canonical.description,
    parameters: memoryToolParameters(name as MemoryToolName),
    execute: vi.fn().mockResolvedValue({ text: "ok", isError: false }),
  };
}

/**
 * A wiki must declare the whole fixed vocabulary — `wikiMemoryProvider` asserts
 * it — so the fake ships all seven rather than an empty list.
 */
const ALL_MEMORY_TOOLS = (): MemoryToolDef[] =>
  [...MEMORY_READ_TOOL_NAMES, ...MEMORY_WRITE_TOOL_NAMES].map(memTool);

function fakeMemory(
  over: Partial<Record<"seed" | "enqueue" | "index" | "tools", unknown>> = {},
): Memory {
  return {
    seed: vi.fn().mockResolvedValue("seed"),
    enqueue: vi.fn().mockImplementation((snapshot: { run_id: string }) =>
      Promise.resolve({
        run_id: snapshot.run_id,
        state: "pending",
        enqueued_at: 0,
        updated_at: 0,
        attempts: 0,
        history: [],
      }),
    ),
    index: vi.fn(),
    tools: ALL_MEMORY_TOOLS(),
    ...over,
  } as unknown as Memory;
}

function factoryOf(memory: Memory, over: Partial<MemoryFactory> = {}): MemoryFactory {
  return {
    forOwner: () => memory,
    forOwnerControlPlane: () => memory,
    start: () => {},
    poke: () => {},
    stop: async () => {},
    subscribeToRun: () => () => {},
    ...over,
  };
}

function ctxOf(over: Partial<RunCapabilityContext> = {}): RunCapabilityContext {
  return fakeRunCapabilityContext({
    owner: "o",
    entryGrants: [],
    llm: { call: vi.fn() },
    ...over,
  });
}

function bcOf(): AgentBuildContext {
  return fakeAgentBuildContext({ agent: "lead" });
}

describe("createMemoryCapability", () => {
  it("exposes the static seed marker even without a factory", () => {
    const cap = createMemoryCapability();
    expect(cap.name).toBe(MEMORY_CAPABILITY_NAME);
    expect(cap.seedMarker).toBe(SEED_OPEN_TAG);
    expect(cap.reservedWireNames).toEqual([...MEMORY_READ_TOOL_NAMES, ...MEMORY_WRITE_TOOL_NAMES]);
    expect(cap.toolEffects).toEqual({
      ...Object.fromEntries(MEMORY_READ_TOOL_NAMES.map((name) => [name, "read"])),
      ...Object.fromEntries(MEMORY_WRITE_TOOL_NAMES.map((name) => [name, "mutate"])),
    });
  });

  it("prepares a provider-opaque runtime lease with canonical calls and host run-end", async () => {
    const events: CapabilityEvent[] = [];
    const execute = vi.fn().mockResolvedValue({ text: "host memory", isError: false });
    const readTools = MEMORY_READ_TOOL_NAMES.map((name) =>
      name === "read_memory" ? { ...memTool(name), execute } : memTool(name),
    );
    const writeTools = MEMORY_WRITE_TOOL_NAMES.map(memTool);
    const memory = fakeMemory();
    const runtime = await prepareMemoryRuntime(
      factoryOf(memory, {
        providerFor: async () => ({
          ok: true,
          provider: {
            kind: "fixture",
            readTools,
            writeTools,
            seed: vi.fn().mockResolvedValue("runtime seed"),
          },
          key: `fixture:${"a".repeat(64)}`,
          seedMaxChars: 7_000,
        }),
      }),
      ctxOf({ emit: (event) => events.push(event) }),
    );

    expect(runtime?.descriptor).toEqual({
      providerDigest: "a".repeat(64),
      seedMaxChars: 7_000,
      readTools: [...MEMORY_READ_TOOL_NAMES],
    });
    await expect(runtime?.seed("task")).resolves.toBe("runtime seed");
    expect(runtime?.accepts("read_memory", { paths: ["PROFILE.md"] })).toBe(true);
    expect(runtime?.accepts("write_memory", { path: "PROFILE.md", content: "x" })).toBe(false);
    expect(runtime?.accepts("read_memory", { paths: [] })).toBe(false);
    await expect(runtime?.invoke("read_memory", { paths: ["PROFILE.md"] })).resolves.toEqual({
      text: "host memory",
      isError: false,
    });
    await runtime?.finish(makeExecutionRecord({ id: "runtime-run", owner_key_name: "o" }));
    expect(events.map((event) => (event.detail as MemoryIngestNotice).phase)).toEqual([
      "started",
      "queued",
    ]);
  });

  it("forRun gates: no factory / memory 'off' / forOwner undefined → null (global activation, no grant gate)", async () => {
    const memory = fakeMemory();
    const factory = {
      forOwner: () => memory,
      forOwnerControlPlane: () => memory,
      start: () => {},
      poke: () => {},
      stop: async () => {},
      subscribeToRun: () => () => {},
    };
    expect(await createMemoryCapability().forRun(ctxOf())).toBeNull();
    expect(
      await createMemoryCapability(factory).forRun(
        ctxOf({ requestParam: (k: string) => (k === "memory" ? "off" : undefined) }),
      ),
    ).toBeNull();
    expect(
      await createMemoryCapability({
        forOwner: () => undefined,
        forOwnerControlPlane: () => undefined,
        start: () => {},
        poke: () => {},
        stop: async () => {},
        subscribeToRun: () => () => {},
      }).forRun(ctxOf()),
    ).toBeNull();
    expect(await createMemoryCapability(factory).forRun(ctxOf({ entryGrants: [] }))).not.toBeNull();
    expect(await createMemoryCapability(factory).forRun(ctxOf())).not.toBeNull();
  });

  it("gives the entry agent read+write tools but a spawned subagent read-only", async () => {
    const tools = ALL_MEMORY_TOOLS();
    const run = await createMemoryCapability({
      forOwner: () => fakeMemory({ tools }),
      forOwnerControlPlane: () => fakeMemory({ tools }),
      start: () => {},
      poke: () => {},
      stop: async () => {},
      subscribeToRun: () => () => {},
    }).forRun(ctxOf());
    expect(run).not.toBeNull();

    const entry = run!.forAgent({ agent: "lead", entry: true, grants: [] });
    const entryContribution = entry!.attach(bcOf());
    expect(entryContribution.tools!.map((t) => t.wireName).sort()).toEqual(
      [...MEMORY_READ_TOOL_NAMES, ...MEMORY_WRITE_TOOL_NAMES].sort(),
    );
    expect(entryContribution.handlers).toHaveLength(2);
    expect(entryContribution.advertised).toBe(true);

    const spawned = run!.forAgent({ agent: "subagent", entry: false, grants: [] });
    const spawnedContribution = spawned!.attach(bcOf());
    expect(spawnedContribution.tools!.map((t) => t.wireName).sort()).toEqual(
      [...MEMORY_READ_TOOL_NAMES].sort(),
    );
    expect(spawnedContribution.handlers).toHaveLength(1);
  });

  it("stays active for a workspace with no indexer model, and still enqueues", async () => {
    // A missing model costs the run its learning, not its memory: forOwner
    // gates on the model, forOwnerControlPlane does not, and the run resolves
    // through the latter. The enqueue still happens because the queue is
    // durable — the drain reports such a job blocked, and recovers it whole
    // once a model is configured.
    const events: CapabilityEvent[] = [];
    const enqueue = vi.fn().mockImplementation((snapshot: { run_id: string }) =>
      Promise.resolve({
        run_id: snapshot.run_id,
        state: "pending",
        enqueued_at: 0,
        updated_at: 0,
        attempts: 0,
        history: [],
      }),
    );
    const memory = fakeMemory({ enqueue });
    const run = await createMemoryCapability({
      forOwner: () => undefined,
      forOwnerControlPlane: () => memory,
      start: () => {},
      poke: () => {},
      stop: async () => {},
      subscribeToRun: () => () => {},
    }).forRun(ctxOf({ emit: (e) => events.push(e) }));

    expect(run).not.toBeNull();
    await expect(run!.seedBlock!()).resolves.toBe("<memory>\nseed\n</memory>");
    await run!.onRunEnd!(makeExecutionRecord({ id: "run-1", owner_key_name: "o" }));
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(events.map((event) => (event.detail as MemoryIngestNotice).phase)).toEqual([
      "started",
      "queued",
    ]);
  });

  it("a read-only selected provider emits a skipped ingest and never enqueues", async () => {
    const events: CapabilityEvent[] = [];
    const memory = fakeMemory();
    const enqueue = vi.fn();
    memory.enqueue = enqueue;
    const poke = vi.fn();
    const subscribeToRun = vi.fn(() => () => {});
    const provider = {
      kind: "constitution",
      readTools: [...MEMORY_READ_TOOL_NAMES].map(memTool),
      seed: vi.fn().mockResolvedValue("constitution"),
    };
    const run = await createMemoryCapability({
      forOwner: () => memory,
      forOwnerControlPlane: () => memory,
      providerFor: async () => ({
        ok: true,
        provider,
        key: "plugin:constitution",
        seedMaxChars: 6000,
      }),
      start: () => {},
      poke,
      stop: async () => {},
      subscribeToRun,
    }).forRun(ctxOf({ emit: (event) => events.push(event) }));
    await run!.onRunEnd!({ id: "read-only", owner: "o", request: { messages: [] } } as never);
    expect(enqueue).not.toHaveBeenCalled();
    expect(poke).not.toHaveBeenCalled();
    expect(subscribeToRun).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        capability: MEMORY_CAPABILITY_NAME,
        kind: "ingest",
        detail: {
          execution_id: "read-only",
          phase: "done",
          skipped: true,
          note: "provider-read-only",
        },
      },
    ]);
  });

  it("tells every agent the wiki exists even when the tree is empty", async () => {
    // An empty tree yields no seed block, so the system section is the only
    // thing that can say memory is there at all.
    const memory = fakeMemory({ seed: vi.fn().mockResolvedValue(null) });
    const run = await createMemoryCapability({
      forOwner: () => memory,
      forOwnerControlPlane: () => memory,
      start: () => {},
      poke: () => {},
      stop: async () => {},
      subscribeToRun: () => () => {},
    }).forRun(ctxOf());
    await expect(run!.seedBlock!()).resolves.toBeUndefined();

    const entry = run!.systemSection!({ agent: "lead", entry: true, grants: [] })!;
    expect(entry).toContain("query_memories");
    expect(entry).toContain("PROFILE.md");
    expect(entry).toContain("write_memory");

    const spawned = run!.systemSection!({ agent: "subagent", entry: false, grants: [] })!;
    expect(spawned).toContain("query_memories");
    expect(spawned).not.toContain("write_memory");
    expect(spawned).not.toContain("edit_memory");
  });

  it("each attach gets its own navigation call budget", async () => {
    const execute = vi.fn().mockResolvedValue({ text: "ok", isError: false });
    const read: MemoryToolDef = {
      ...memTool("list_memories"),
      execute,
    };
    const tools = [read, ...ALL_MEMORY_TOOLS().filter((t) => t.name !== "list_memories")];
    const env = loadEnv({ CLARVIS_MEMORY_TOOL_CALL_LIMIT: "1" });
    const run = await createMemoryCapability({
      forOwner: () => fakeMemory({ tools }),
      forOwnerControlPlane: () => fakeMemory({ tools }),
      start: () => {},
      poke: () => {},
      stop: async () => {},
      subscribeToRun: () => () => {},
    }).forRun(ctxOf({ env }));
    const agent = run!.forAgent({ agent: "lead", entry: true, grants: [] });

    const first = agent!.attach(bcOf()).handlers![0]!;
    const second = agent!.attach(bcOf()).handlers![0]!;
    const call = { id: "c1", name: "list_memories", arguments: {} };
    await expect(first.handle(call, 1)).resolves.toMatchObject({ progress: true });
    await expect(first.handle(call, 2)).resolves.toMatchObject({ progress: false });
    await expect(second.handle(call, 1)).resolves.toMatchObject({ progress: true });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("a throwing seed degrades to no block and warns instead of failing", async () => {
    const warn = vi.fn();
    const exploding = fakeMemory({ seed: vi.fn().mockRejectedValue(new Error("seed exploded")) });
    const run = await createMemoryCapability({
      forOwner: () => exploding,
      forOwnerControlPlane: () => exploding,
      start: () => {},
      poke: () => {},
      stop: async () => {},
      subscribeToRun: () => () => {},
    }).forRun(ctxOf({ logger: { warn } as unknown as RunCapabilityContext["logger"] }));
    await expect(run!.seedBlock!()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("alone escapes, sanitizes, clips and wraps raw provider seeds", async () => {
    const memory = fakeMemory();
    const provider = {
      kind: "fixture",
      readTools: MEMORY_READ_TOOL_NAMES.map(memTool),
      seed: vi
        .fn()
        .mockResolvedValue(`before <memory>nested</memory> token=super-secret ${"x".repeat(200)}`),
    };
    const run = await createMemoryCapability({
      ...factoryOf(memory),
      providerFor: async () => ({
        ok: true,
        provider,
        key: `fixture:${"a".repeat(64)}`,
        seedMaxChars: 96,
      }),
    }).forRun(ctxOf());

    const block = await run!.seedBlock!();
    expect(block?.length).toBeLessThanOrEqual(96);
    expect(block?.match(/<memory>/g)).toHaveLength(1);
    expect(block).toContain("&lt;memory&gt;nested&lt;/memory&gt;");
    expect(block).toContain("token: [redacted]");
    expect(block?.endsWith("</memory>")).toBe(true);
  });

  it("changes the stable system prefix when the effective provider declaration changes", async () => {
    const memory = fakeMemory();
    const provider = {
      kind: "fixture",
      readTools: MEMORY_READ_TOOL_NAMES.map(memTool),
      seed: vi.fn().mockResolvedValue(null),
    };
    const sectionFor = async (digest: string): Promise<string> => {
      const run = await createMemoryCapability({
        ...factoryOf(memory),
        providerFor: async () => ({
          ok: true,
          provider,
          key: `fixture:${digest}`,
          seedMaxChars: 6000,
        }),
      }).forRun(ctxOf());
      return run!.systemSection!({ agent: "lead", entry: true, grants: [] })!;
    };

    const first = await sectionFor("a".repeat(64));
    const second = await sectionFor("b".repeat(64));
    expect(first).not.toBe(second);
    expect(first).toContain(`<!-- memory-provider:${"a".repeat(64)} -->`);
    expect(first).not.toContain("fixture:");
  });

  it("reports enqueue failure through ctx.emit and immediately unsubscribes", async () => {
    const events: CapabilityEvent[] = [];
    const memory = fakeMemory();
    (memory.enqueue as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const unsubscribe = vi.fn();
    const run = await createMemoryCapability(
      factoryOf(memory, { subscribeToRun: () => unsubscribe }),
    ).forRun(ctxOf({ emit: (e) => events.push(e) }));
    await run!.onRunEnd!(makeExecutionRecord({ id: "run-1", owner_key_name: "o" }));
    expect(events.map((e) => e.kind)).toEqual(["ingest", "ingest"]);
    expect(events.every((e) => e.capability === MEMORY_CAPABILITY_NAME)).toBe(true);
    const phases = events.map((e) => (e.detail as { phase: string }).phase);
    expect(phases).toEqual(["started", "failed"]);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("subscribes before enqueue, pokes after it, and forwards a later settlement", async () => {
    const order: string[] = [];
    const events: CapabilityEvent[] = [];
    let settle: ((notice: MemoryIngestNotice) => void) | undefined;
    const memory = fakeMemory({
      enqueue: vi.fn().mockImplementation((snapshot: { run_id: string }) => {
        order.push("enqueue");
        return Promise.resolve({
          run_id: snapshot.run_id,
          state: "pending",
          enqueued_at: 0,
          updated_at: 0,
          attempts: 0,
          history: [],
        });
      }),
    });
    const run = await createMemoryCapability(
      factoryOf(memory, {
        subscribeToRun: (_owner, _runId, onSettled) => {
          order.push("subscribe");
          settle = onSettled;
          return () => {};
        },
        poke: () => order.push("poke"),
      }),
    ).forRun(ctxOf({ emit: (event) => events.push(event) }));

    await run!.onRunEnd!(makeExecutionRecord({ id: "run-late", owner_key_name: "o" }));

    expect(order).toEqual(["subscribe", "enqueue", "poke"]);
    expect(events.map((event) => (event.detail as MemoryIngestNotice).phase)).toEqual([
      "started",
      "queued",
    ]);

    settle?.({
      execution_id: "run-late",
      phase: "done",
      written: 2,
      deleted: 0,
      reindexed: true,
    });
    expect(events.map((event) => (event.detail as MemoryIngestNotice).phase)).toEqual([
      "started",
      "queued",
      "done",
    ]);
    expect(events[2]?.detail).toMatchObject({ execution_id: "run-late", written: 2 });
  });
});
