import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, spyOn } from "bun:test";
import { loadEnv, type ExecutionRecord } from "@clarvis/capability";
import { createConnectionManager, defaultMCPClientFactory } from "@clarvis/mcp-client";
import { ownerFromWorkspace, workspaceScopeKey } from "@clarvis/paths";
import { createMemoryTraceStore } from "@clarvis/trace/testing";
import { MockLLM } from "@clarvis/loop/testing";
import { memoizeByOwner, type ExecuteRunDeps } from "@clarvis/loop";
import type { MemoryFactory } from "@clarvis/memory/capability";
import { createFileMemoryStore, createMemory } from "@clarvis/memory";
import {
  createFilePlanRepository,
  createPlanStore,
  type PlanFactory,
  type PlanStore,
} from "@clarvis/plan";
import { createInProcessKernel, createWorkflowStore } from "../../src/index.ts";
import { createMemoryConfigStore } from "../../src/config.ts";
import type { Logger } from "@clarvis/capability";
import { kernelIdentity } from "../helpers/kernel-identity.ts";

const PROVIDERS = [{ name: "anthropic", kind: "anthropic" }];
const PROJECT_ID = "prj_test";
const WORKSPACE_ID = "ws_test";

function stateOwner(owner: string): string {
  return workspaceScopeKey(owner, PROJECT_ID, WORKSPACE_ID);
}

function planFactoryFor(storeFor: (owner: string) => PlanStore): PlanFactory {
  return {
    async storeFor(owner) {
      return { key: "markdown", providerKind: "markdown", store: storeFor(owner) };
    },
  };
}

function seededConfig() {
  return createMemoryConfigStore({
    settings: { workspace: { providers: PROVIDERS, default_model: "anthropic/x" } },
    agents: [
      {
        name: "solo",
        scope: "workspace",
        frontmatter: { model: "anthropic/x", tools: [] },
        body: "You are solo.",
        model: "anthropic/x",
      },
    ],
  });
}

/** A kernel whose plan repositories are rooted per owner. */
function makeKernel(
  ws: string,
  ownerCache?: { maxOwners?: number; idleMs?: number },
  retirement?: {
    stopOwner?: (owner: string) => Promise<void>;
    onOwnerRetired?: (owner: string) => void | Promise<void>;
  },
  runDelayMs = 0,
  logger?: Logger,
) {
  const env = loadEnv({ CLARVIS_LOG_LEVEL: "silent", CLARVIS_MCP_CONNECT_TIMEOUT_MS: "2000" });
  const traceStore = createMemoryTraceStore();
  const memoryFor = memoizeByOwner((owner: string) =>
    createMemory({
      store: createFileMemoryStore({
        root: join(ws, ".clarvis", "owners", owner, "memory"),
      }),
    }),
  );
  const startedMemoryOwners: string[] = [];
  let memoryStops = 0;
  const stoppedMemoryOwners: string[] = [];
  const memoryFactory: MemoryFactory = {
    forOwner: memoryFor,
    forOwnerControlPlane: memoryFor,
    start(owner) {
      startedMemoryOwners.push(owner);
    },
    poke() {},
    async stop() {
      memoryStops += 1;
    },
    async stopOwner(owner) {
      stoppedMemoryOwners.push(owner);
      await retirement?.stopOwner?.(owner);
    },
    subscribeToRun: () => () => {},
  };
  const deps: ExecuteRunDeps = {
    env,
    llm: new MockLLM({ script: [{ text: "Done.", delayMs: runDelayMs }] }),
    connections: createConnectionManager({
      workspace: ws,
      factory: defaultMCPClientFactory,
      connectTimeoutMs: env.CLARVIS_MCP_CONNECT_TIMEOUT_MS,
      callTimeoutMs: env.CLARVIS_MCP_TOOL_CALL_TIMEOUT_MS,
    }),
    traceStore,
    workspaceRoot: ws,
    capabilities: [],
  };
  const kernel = createInProcessKernel({
    deps,
    ...(logger === undefined ? {} : { logger }),
    workspaceRoot: ws,
    ...kernelIdentity(ws),
    configStore: seededConfig(),
    globalConfigDir: join(ws, "global"),
    memoryFactory,
    planFactory: planFactoryFor(
      memoizeByOwner((owner: string) =>
        createPlanStore({
          repository: createFilePlanRepository({
            workspaceRoot: ws,
            root: join(ws, ".clarvis", "owners", owner, "plans"),
          }),
        }),
      ),
    ),
    ...(ownerCache === undefined ? {} : { ownerCache }),
    ...(retirement?.onOwnerRetired === undefined
      ? {}
      : { onOwnerRetired: retirement.onOwnerRetired }),
  });
  return {
    kernel,
    traceStore,
    deps,
    startedMemoryOwners,
    stoppedMemoryOwners,
    memoryStops: () => memoryStops,
  };
}

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function record(owner: string, id: string, startedAt: number): ExecutionRecord {
  return {
    id,
    owner_key_name: owner,
    status: "completed",
    started_at: startedAt,
    ended_at: startedAt + 10,
    elapsed_ms: 10,
    request: {
      messages: [{ role: "user", content: "x" }],
      servers: [],
      entry: "solo",
      profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 1 }],
      providers: PROVIDERS as never,
      budget: { on_exceed: "stop", total_token_limit: 1 },
    },
    response: {
      status: "completed",
      result: "ok",
      usage: { iterations_used: 1, elapsed_ms: 10, by_agent: [] },
    },
    trace: { events: [] } as never,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cached_tokens: 0,
    total_cache_write_tokens: 0,
  } as ExecutionRecord;
}

describe("owner isolation", () => {
  it("rejects invalid owner-cache bounds and a cross-project workspace", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-own-invalid-cache-"));
    expect(() => makeKernel(ws, { maxOwners: 0 })).toThrow("maxOwners");
    expect(() => makeKernel(ws, { idleMs: -1 })).toThrow("idleMs");
    const fixture = makeKernel(ws);
    const identity = kernelIdentity(ws);
    expect(() =>
      createInProcessKernel({
        deps: fixture.deps,
        workspaceRoot: ws,
        project: identity.project,
        workspace: { ...identity.workspace, projectId: "prj_other" },
        configStore: seededConfig(),
      }),
    ).toThrow("workspace.projectId must match project.id");
    await expect(fixture.kernel.plugins.list()).resolves.toEqual([]);
    await fixture.kernel.close();
  });

  it("retires an idle owner after a non-zero cache delay", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-own-idle-"));
    const { kernel, stoppedMemoryOwners } = makeKernel(ws, { idleMs: 5 });
    const owner = await kernel.acquireOwner("alice");
    owner.release();

    await Bun.sleep(20);

    expect(stoppedMemoryOwners).toEqual([stateOwner("alice")]);
    await kernel.close();
  });

  it("keeps plans separate: bob sees neither alice's list nor her plan by id", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-own-"));
    const { kernel } = makeKernel(ws);
    const alice = kernel.forOwner("alice");
    const bob = kernel.forOwner("bob");

    const aliceStore = createPlanStore({
      repository: createFilePlanRepository({
        workspaceRoot: ws,
        root: join(ws, ".clarvis", "owners", stateOwner("alice"), "plans"),
      }),
    });
    const created = await aliceStore.create({
      title: "Alice's plan",
      objective: "hers",
      tasks: [{ title: "one" }],
      createdByRun: "run-1",
    });

    expect((await alice.plans.list()).plans.map((p) => p.id)).toEqual([created.id]);
    expect((await bob.plans.list()).plans).toHaveLength(0);
    await expect(bob.plans.read(created.id)).rejects.toThrow(/Plan not found/);
    expect((await alice.plans.read(created.id)).title).toBe("Alice's plan");
  });

  it("keeps sessions separate", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-own-"));
    const { kernel } = makeKernel(ws);
    const alice = kernel.forOwner("alice");
    const bob = kernel.forOwner("bob");

    await alice.sessions.save({
      id: "s1",
      project_id: PROJECT_ID,
      workspace: WORKSPACE_ID,
      created_at: 1,
      updated_at: 1,
      turns: [],
      totals: {},
    } as never);

    expect((await alice.sessions.list()).map((s) => s.id)).toEqual(["s1"]);
    expect(await bob.sessions.list()).toEqual([]);
    expect(await bob.sessions.get("s1")).toBeNull();
  });

  it("keeps memory documents separate", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-own-"));
    const { kernel } = makeKernel(ws);
    const alice = kernel.forOwner("alice");
    const bob = kernel.forOwner("bob");

    await createFileMemoryStore({
      root: join(ws, ".clarvis", "owners", stateOwner("alice"), "memory"),
    }).write(
      "preferences/editor/MEMORY.md",
      "---\ndescription: Alice editor preference\n---\nUses modal editing.\n",
    );

    expect((await alice.memory.health()).totals.documents).toBeGreaterThan(0);
    expect((await bob.memory.health()).totals.documents).toBe(0);
  });

  it("keeps workflow records separate", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-own-"));
    const { kernel } = makeKernel(ws);
    createWorkflowStore({ dir: join(ws, "global"), owner: stateOwner("alice") }).save({
      id: "workflow-a",
      root_run_id: "workflow-a",
      title: "Alice workflow",
      workspace: ws,
      status: "completed",
      created_at: 1,
      updated_at: 2,
      edges: [
        {
          run_id: "workflow-a",
          kind: "manager",
          title: "Alice workflow",
          status: "completed",
        },
      ],
      output_tokens: 0,
    });

    expect((await kernel.forOwner("alice").workflows.list()).items).toHaveLength(1);
    expect((await kernel.forOwner("bob").workflows.list()).items).toEqual([]);
    await expect(kernel.forOwner("bob").workflows.get("workflow-a")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("keeps traces separate: cross-owner get and delete both report not_found", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-own-"));
    const { kernel, traceStore } = makeKernel(ws);
    await traceStore.insert(record(stateOwner("alice"), "a1", 1_000));
    await traceStore.insert(record(stateOwner("bob"), "b1", 2_000));

    const alice = kernel.forOwner("alice");
    expect((await alice.runs.list()).total).toBe(1);
    expect((await alice.runs.get("a1")).execution_id).toBe("a1");
    await expect(alice.runs.get("b1")).rejects.toMatchObject({ code: "not_found" });
    await expect(alice.runs.delete("b1")).rejects.toMatchObject({ code: "not_found" });
    expect((await kernel.forOwner("bob").runs.list()).total).toBe(1);
  });

  it("memoizes each owner's scope and binds the unscoped services to the default owner", () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-own-"));
    const { kernel } = makeKernel(ws);

    expect(kernel.forOwner("alice")).toBe(kernel.forOwner("alice"));
    expect(kernel.forOwner("alice")).not.toBe(kernel.forOwner("bob"));

    const fallback = kernel.forOwner(ownerFromWorkspace(ws));
    expect(kernel.runs).toBe(fallback.runs);
    expect(kernel.plans).toBe(fallback.plans);
    expect(kernel.memory).toBe(fallback.memory);
    expect(kernel.sessions).toBe(fallback.sessions);
    expect(kernel.ownershipMode).toBe("single");
    expect(kernel.scopePolicy.plans).toBe("workspace");
    expect(kernel.scopePolicy.memory).toBe("workspace");
  });

  it("leases owner scopes and evicts only after the last release", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-own-"));
    const { kernel, stoppedMemoryOwners } = makeKernel(ws, { idleMs: 0 });

    const first = await kernel.acquireOwner("alice");
    const second = await kernel.acquireOwner("alice");
    expect(second.value).toBe(first.value);
    first.release();
    await Promise.resolve();
    expect(stoppedMemoryOwners).toEqual([]);

    second.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(stoppedMemoryOwners).toEqual([stateOwner("alice")]);

    const rebuilt = await kernel.acquireOwner("alice");
    expect(rebuilt.value).not.toBe(first.value);
    rebuilt.release();
    await kernel.close();
  });

  it("keeps an owner resident until every run started from it is closed", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-own-run-"));
    const { kernel, stoppedMemoryOwners } = makeKernel(ws, { idleMs: 0 }, undefined, 100);
    const owner = await kernel.acquireOwner("alice");
    const handle = await owner.value.runs.start({
      messages: [{ role: "user", content: "stay resident" }],
      agent: "solo",
    });

    owner.release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stoppedMemoryOwners).toEqual([]);

    await handle.cancel();
    await handle.closed;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stoppedMemoryOwners).toEqual([stateOwner("alice")]);
    await expect(
      owner.value.runs.start({ messages: [{ role: "user", content: "too late" }], agent: "solo" }),
    ).rejects.toMatchObject({ code: "unavailable" });
    await kernel.close();
  });

  it("waits for an active owner run to close before retiring it during kernel shutdown", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-own-shutdown-run-"));
    let runClosed = false;
    let ownerStoppedAfterRun = false;
    const { kernel } = makeKernel(
      ws,
      { idleMs: 0 },
      {
        async stopOwner() {
          ownerStoppedAfterRun = runClosed;
        },
      },
      100,
    );
    const owner = await kernel.acquireOwner("alice");
    const handle = await owner.value.runs.start({
      messages: [{ role: "user", content: "stop cleanly" }],
      agent: "solo",
    });
    owner.release();
    void handle.closed.then(() => {
      runClosed = true;
    });

    await kernel.close();

    expect(runClosed).toBeTrue();
    expect(ownerStoppedAfterRun).toBeTrue();
  });

  it("rejects admission when every resident owner is active or pinned", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-own-"));
    const { kernel } = makeKernel(ws, { maxOwners: 2, idleMs: 60_000 });
    const alice = await kernel.acquireOwner("alice");

    await expect(kernel.acquireOwner("bob")).rejects.toMatchObject({
      code: "resource_exhausted",
    });
    alice.release();
    await kernel.close();
  });

  it("counts an owner undergoing teardown against the admission limit", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-own-"));
    const cleanup = deferred();
    const { kernel, startedMemoryOwners } = makeKernel(
      ws,
      { maxOwners: 2, idleMs: 0 },
      {
        stopOwner: (owner) => (owner === stateOwner("alice") ? cleanup.promise : Promise.resolve()),
      },
    );
    kernel.startMemoryRecovery();
    const alice = await kernel.acquireOwner("alice");

    alice.release();
    await Promise.resolve();
    await expect(kernel.acquireOwner("bob")).rejects.toMatchObject({
      code: "resource_exhausted",
    });
    expect(startedMemoryOwners).not.toContain(stateOwner("bob"));

    cleanup.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const bob = await kernel.acquireOwner("bob");
    expect(startedMemoryOwners).toContain(stateOwner("bob"));
    bob.release();
    await kernel.close();
  });

  it("waits for an owner's own teardown before rebuilding its scope", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-own-"));
    const cleanup = deferred();
    const { kernel, startedMemoryOwners } = makeKernel(
      ws,
      { maxOwners: 2, idleMs: 0 },
      {
        stopOwner: (owner) => (owner === stateOwner("alice") ? cleanup.promise : Promise.resolve()),
      },
    );
    kernel.startMemoryRecovery();
    const first = await kernel.acquireOwner("alice");
    first.release();

    let rebuilt = false;
    const reacquiring = kernel.acquireOwner("alice").then((lease) => {
      rebuilt = true;
      return lease;
    });
    await Promise.resolve();
    expect(rebuilt).toBe(false);
    expect(startedMemoryOwners.filter((owner) => owner === stateOwner("alice"))).toHaveLength(1);

    cleanup.resolve();
    const second = await reacquiring;
    expect(second.value).not.toBe(first.value);
    expect(startedMemoryOwners.filter((owner) => owner === stateOwner("alice"))).toHaveLength(2);
    second.release();
    await kernel.close();
  });

  it("observes detached cleanup rejection and waits for it during close", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-own-"));
    const cleanup = deferred();
    const warning = spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const warned: { fields: unknown; message: unknown }[] = [];
    const recording: Logger = {
      debug: () => {},
      info: () => {},
      warn: (fields: unknown, message?: unknown) => void warned.push({ fields, message }),
      error: () => {},
    };
    try {
      const { kernel } = makeKernel(
        ws,
        { maxOwners: 2, idleMs: 0 },
        {
          stopOwner: (owner) =>
            owner === stateOwner("alice") ? cleanup.promise : Promise.resolve(),
        },
        0,
        recording,
      );
      const alice = await kernel.acquireOwner("alice");
      alice.release();

      let closed = false;
      const closing = kernel.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);

      cleanup.reject(new Error("cleanup failed"));
      await expect(closing).resolves.toBeUndefined();
      expect(
        warned.some(
          ({ fields, message }) =>
            message === "best_effort_failed" &&
            (fields as { operation?: string }).operation === "retire kernel owner" &&
            String((fields as { cause?: string }).cause).includes(
              "failed to retire owner 'alice' cleanly",
            ),
        ),
      ).toBe(true);
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it("starts durable memory recovery only after the host releases boot", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-own-"));
    const { kernel, startedMemoryOwners } = makeKernel(ws);
    const defaultOwner = ownerFromWorkspace(ws);

    kernel.forOwner("alice");
    kernel.forOwner("alice");
    kernel.forOwner("bob");

    expect(startedMemoryOwners).toEqual([]);

    kernel.startMemoryRecovery();
    kernel.startMemoryRecovery();
    expect(startedMemoryOwners).toEqual([
      stateOwner(defaultOwner),
      stateOwner("alice"),
      stateOwner("bob"),
    ]);

    kernel.forOwner("charlie");
    expect(startedMemoryOwners).toEqual([
      stateOwner(defaultOwner),
      stateOwner("alice"),
      stateOwner("bob"),
      stateOwner("charlie"),
    ]);
    await kernel.close();
  });

  it("owns the memory factory lifecycle in lower-level composition", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-own-"));
    const { kernel, memoryStops } = makeKernel(ws);

    await kernel.close();
    await kernel.close();

    expect(memoryStops()).toBe(1);
  });

  it("does not recreate owner services after kernel shutdown", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-own-"));
    const { kernel } = makeKernel(ws, { idleMs: 0 });

    await kernel.close();

    expect(() => kernel.forOwner("late")).toThrow(/closing/);
    await expect(kernel.acquireOwner("late")).rejects.toMatchObject({ code: "unavailable" });
  });

  it("honours an explicit defaultOwner", () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-own-"));
    const env = loadEnv({ CLARVIS_LOG_LEVEL: "silent" });
    const kernel = createInProcessKernel({
      deps: {
        env,
        llm: new MockLLM({ script: [{ text: "ok" }] }),
        connections: createConnectionManager({
          workspace: ws,
          factory: defaultMCPClientFactory,
          connectTimeoutMs: 2000,
          callTimeoutMs: 2000,
        }),
        traceStore: createMemoryTraceStore(),
        workspaceRoot: ws,
        capabilities: [],
      },
      workspaceRoot: ws,
      ...kernelIdentity(ws),
      configStore: seededConfig(),
      globalConfigDir: join(ws, "global"),
      defaultOwner: "tenant-7",
    });
    expect(kernel.runs).toBe(kernel.forOwner("tenant-7").runs);
    expect(kernel.runs).not.toBe(kernel.forOwner(ownerFromWorkspace(ws)).runs);
  });

  it("rejects a blank forOwner call with a clear error instead of a raw TypeError from deep inside session-service construction", () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-own-"));
    const { kernel } = makeKernel(ws);

    expect(() => kernel.forOwner("")).toThrow(/InProcessKernel\.forOwner.*non-empty/);
    expect(() => kernel.forOwner("   ")).toThrow(/InProcessKernel\.forOwner.*non-empty/);
  });

  it("rejects a blank defaultOwner at construction, before any service is built", () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-own-"));
    const env = loadEnv({ CLARVIS_LOG_LEVEL: "silent" });
    const build = () =>
      createInProcessKernel({
        deps: {
          env,
          llm: new MockLLM({ script: [{ text: "ok" }] }),
          connections: createConnectionManager({
            workspace: ws,
            factory: defaultMCPClientFactory,
            connectTimeoutMs: 2000,
            callTimeoutMs: 2000,
          }),
          traceStore: createMemoryTraceStore(),
          workspaceRoot: ws,
          capabilities: [],
        },
        workspaceRoot: ws,
        ...kernelIdentity(ws),
        configStore: seededConfig(),
        globalConfigDir: join(ws, "global"),
        defaultOwner: "",
      });
    expect(build).toThrow(/non-empty/);
  });

  it("rejects multi-owner construction without an owner-aware plan factory", () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-own-"));
    const env = loadEnv({ CLARVIS_LOG_LEVEL: "silent" });
    expect(() =>
      createInProcessKernel({
        deps: {
          env,
          llm: new MockLLM({ script: [{ text: "ok" }] }),
          connections: createConnectionManager({
            workspace: ws,
            factory: defaultMCPClientFactory,
            connectTimeoutMs: 2000,
            callTimeoutMs: 2000,
          }),
          traceStore: createMemoryTraceStore(),
          workspaceRoot: ws,
          capabilities: [],
        },
        workspaceRoot: ws,
        ...kernelIdentity(ws),
        configStore: seededConfig(),
        ownershipMode: "multi",
      }),
    ).toThrow(/multi-owner.*planFactory/);
  });

  it("declares owner scope for plans and memory in explicit multi-owner mode", () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-own-"));
    const { deps } = makeKernel(ws);
    const multi = createInProcessKernel({
      deps,
      workspaceRoot: ws,
      ...kernelIdentity(ws),
      configStore: seededConfig(),
      ownershipMode: "multi",
      planFactory: planFactoryFor(
        memoizeByOwner((owner: string) =>
          createPlanStore({
            repository: createFilePlanRepository({
              workspaceRoot: ws,
              root: join(ws, ".clarvis", "owners", owner, "plans"),
            }),
          }),
        ),
      ),
    });
    expect(multi.scopePolicy.plans).toBe("owner");
    expect(multi.scopePolicy.memory).toBe("owner");
  });
});
