import { describe, expect, it, vi } from "bun:test";

import type { RunSnapshot } from "../../src/index.ts";

import type { MemoryIngestNotice } from "../../src/ingest.ts";
import { createMemoryFactory as createProductionMemoryFactory } from "../../src/factory.ts";
import { createInMemoryMemoryStore } from "../../src/testing.ts";
import { ScriptedLLM as MockLLM } from "../helpers/capability.ts";
import { fakeIndexerRuntime } from "../helpers/indexer-runtime.ts";
import type { LLMProvider, Logger } from "@clarvis/capability";

function makeFactoryDeps(over: { llm?: MockLLM } = {}) {
  const llm = over.llm ?? new MockLLM({ script: [{ text: "[]" }, { text: "[]" }] });
  const warn = vi.fn();
  const logger: Logger = { debug: vi.fn(), warn, info: vi.fn(), error: vi.fn() };
  return { llm, warn, logger };
}

function signal(): { promise: Promise<void>; fire(): void } {
  let fire!: () => void;
  const promise = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { promise, fire };
}

function noticeSignal(): {
  promise: Promise<MemoryIngestNotice>;
  publish(notice: MemoryIngestNotice): void;
} {
  let publish!: (notice: MemoryIngestNotice) => void;
  const promise = new Promise<MemoryIngestNotice>((resolve) => {
    publish = resolve;
  });
  return { promise, publish };
}

function tempWorkspace(): string {
  return "/workspace";
}

/** A representative finished run for the indexer. */
function run(): RunSnapshot {
  return {
    run_id: "exec_a",
    workspace: "/ws",
    status: "completed",
    started_at: 1,
    ended_at: 2,
    task: "release the tools package",
    tool_calls: [
      {
        tool_name: "shell",
        arguments: { command: "bun test" },
        result_excerpt: "ok",
        error: null,
        started_at: 1,
        ended_at: 2,
      },
    ],
  };
}

const CONFIG = { enabled: true };

/** Factory orchestration owns no filesystem behavior; every test supplies the
 * process-local store unless it explicitly provides a narrower fake. */
const createMemoryFactory = (
  opts: Parameters<typeof createProductionMemoryFactory>[0],
): ReturnType<typeof createProductionMemoryFactory> =>
  createProductionMemoryFactory({
    ...opts,
    storeFor: opts.storeFor ?? (() => createInMemoryMemoryStore()),
  });

describe("createMemoryFactory", () => {
  it("returns undefined when settings are absent, disabled, or throw", () => {
    const { llm, logger, warn } = makeFactoryDeps();
    const off = createMemoryFactory({
      llm,
      workspaceRoot: "/ws",
      logger,
      loadSettings: () => undefined,
    });
    expect(off.forOwner("o")).toBeUndefined();

    const disabled = createMemoryFactory({
      llm,
      workspaceRoot: "/ws",
      logger,
      loadSettings: () => ({ config: { ...CONFIG, enabled: false }, defaultModel: "p/m" }),
    });
    expect(disabled.forOwner("o")).toBeUndefined();

    const throwing = createMemoryFactory({
      llm,
      workspaceRoot: "/ws",
      logger,
      loadSettings: () => {
        throw new Error("bad settings");
      },
    });
    expect(throwing.forOwner("o")).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "memory.settings.unreadable", cause: "bad settings" }),
      expect.any(String),
    );
  });

  it("requires a model: no memory.model and no default_model → undefined with one warning", () => {
    const { llm, logger, warn } = makeFactoryDeps();
    const factory = createMemoryFactory({
      llm,
      workspaceRoot: "/ws",
      logger,
      loadSettings: () => ({ config: CONFIG }),
    });
    expect(factory.forOwner("o")).toBeUndefined();
    expect(factory.forOwner("o")).toBeUndefined();
    const noModelWarns = warn.mock.calls.filter(
      (c) => (c[0] as { event?: string }).event === "memory.model.absent",
    );
    expect(noModelWarns).toHaveLength(1);
  });

  it("refuses an undeclared non-built-in model provider and warns only once", async () => {
    const { llm, logger, warn } = makeFactoryDeps();
    const factory = createMemoryFactory({
      llm,
      workspaceRoot: "/ws",
      logger,
      runDeps: () => fakeIndexerRuntime([{ text: "unused" }]).runtime.deps,
      loadSettings: () => ({ config: CONFIG, defaultModel: "custom/model" }),
    });

    const memory = factory.forOwner("o")!;
    expect((await memory.index(run())).note).toBe("no-indexer");
    expect((await memory.index(run())).note).toBe("no-indexer");
    expect(
      warn.mock.calls.filter(
        (call) => (call[0] as { event?: string }).event === "memory.provider.undeclared",
      ),
    ).toHaveLength(1);
  });

  it("without runDeps the indexer cannot run, and the wiki stays fully usable", async () => {
    // A model alone is no longer enough: a pass IS a run, so it also needs the
    // engine deps. Missing them costs the workspace its learning, never its
    // memory — the tools are all there and the queue keeps the run.
    const { llm, logger } = makeFactoryDeps();
    const factory = createMemoryFactory({
      llm,
      workspaceRoot: tempWorkspace(),
      logger,
      loadSettings: () => ({
        config: CONFIG,
        defaultModel: "anthropic/claude-cheap",
        providers: [{ name: "anthropic", kind: "anthropic" as const, api_key_env: "K" }],
      }),
    });
    const memory = factory.forOwner("evandro");
    expect(memory).toBeDefined();

    const toolNames = memory!.tools.map((t) => t.name);
    expect(toolNames).toContain("read_memory");
    expect(toolNames).toContain("write_memory");
    expect(toolNames).not.toContain("get_runs");

    const report = await memory!.index(run());
    expect(report.skipped).toBe(true);
    expect(report.note).toBe("no-indexer");
    expect(llm.calls).toHaveLength(0);
  });

  it("carries the resolved model and providers into the pass it runs", async () => {
    const { llm, logger } = makeFactoryDeps();
    const { runtime } = fakeIndexerRuntime([{ text: "nothing durable" }]);
    const factory = createMemoryFactory({
      llm,
      workspaceRoot: tempWorkspace(),
      logger,
      runDeps: () => runtime.deps,
      loadSettings: () => ({
        config: CONFIG,
        defaultModel: "anthropic/claude-cheap",
        providers: [{ name: "anthropic", kind: "anthropic" as const, api_key_env: "K" }],
      }),
    });

    const report = await factory.forOwner("evandro")!.index(run());

    expect(report.skipped).toBe(true);
    expect(report.note).toBe("nothing-to-record");
    const passLlm = runtime.deps.llm as unknown as { calls: { model: string }[] };
    expect(passLlm.calls[0]?.model).toBe("claude-cheap");
  });

  it("subscribeToRun delivers a translated notice once the real worker drains the job", async () => {
    const { llm, logger } = makeFactoryDeps();
    const { runtime } = fakeIndexerRuntime(
      Array.from({ length: 8 }, () => ({ text: "nothing durable" })),
    );
    const factory = createMemoryFactory({
      llm,
      workspaceRoot: tempWorkspace(),
      logger,
      runDeps: () => runtime.deps,
      loadSettings: () => ({ config: CONFIG, defaultModel: "anthropic/cheap" }),
    });
    const memory = factory.forOwner("o")!;
    const snapshot = run();
    const notices: MemoryIngestNotice[] = [];
    const settled = noticeSignal();
    const unsubscribe = factory.subscribeToRun("o", snapshot.run_id, (notice) => {
      notices.push(notice);
      settled.publish(notice);
    });

    try {
      await memory.enqueue(snapshot);
      factory.poke("o");

      await expect(settled.promise).resolves.toMatchObject({
        execution_id: snapshot.run_id,
        phase: "done",
      });
      expect(notices).toHaveLength(1);
    } finally {
      unsubscribe();
      await factory.stop();
    }
  });

  it("drains independent workers for every activated owner", async () => {
    const { llm, logger } = makeFactoryDeps();
    const { runtime } = fakeIndexerRuntime(
      Array.from({ length: 16 }, () => ({ text: "nothing durable" })),
    );
    const stores = new Map([
      ["alice", createInMemoryMemoryStore()],
      ["bob", createInMemoryMemoryStore()],
    ]);
    const factory = createMemoryFactory({
      llm,
      workspaceRoot: tempWorkspace(),
      logger,
      runDeps: () => runtime.deps,
      loadSettings: () => ({ config: CONFIG, defaultModel: "anthropic/cheap" }),
      storeFor: (owner) => stores.get(owner)!,
    });
    const alice = factory.forOwner("alice")!;
    const bob = factory.forOwner("bob")!;
    const aliceSettled = noticeSignal();
    const bobSettled = noticeSignal();
    const unsubscribeAlice = factory.subscribeToRun("alice", "alice-run", (notice) =>
      aliceSettled.publish(notice),
    );
    const unsubscribeBob = factory.subscribeToRun("bob", "bob-run", (notice) =>
      bobSettled.publish(notice),
    );
    const aliceProvider = await factory.providerFor!("alice");
    const bobProvider = await factory.providerFor!("bob");
    if (aliceProvider === undefined || !aliceProvider.ok) throw new Error("alice provider missing");
    if (bobProvider === undefined || !bobProvider.ok) throw new Error("bob provider missing");
    try {
      await alice.enqueue({ ...run(), run_id: "alice-run" }, { providerKey: aliceProvider.key });
      await bob.enqueue({ ...run(), run_id: "bob-run" }, { providerKey: bobProvider.key });

      factory.start("alice");
      factory.start("bob");

      await Promise.all([aliceSettled.promise, bobSettled.promise]);
      expect((await alice.jobs())[0]?.state).toBe("completed");
      expect((await bob.jobs())[0]?.state).toBe("completed");
    } finally {
      unsubscribeAlice();
      unsubscribeBob();
      await factory.stop();
    }
  });

  it("stop is concurrent and idempotent across owners, clears leases, and prevents restart", async () => {
    const { llm, logger } = makeFactoryDeps();
    const { runtime } = fakeIndexerRuntime([]);
    const stores = new Map([
      ["alice", createInMemoryMemoryStore()],
      ["bob", createInMemoryMemoryStore()],
    ]);
    let calls = 0;
    let aborted = 0;
    const bothCallsStarted = signal();
    const bothCallsAborted = signal();
    let releaseAbort!: () => void;
    const abortGate = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });
    const blockingLlm: LLMProvider = {
      call(params) {
        calls += 1;
        if (calls === 2) bothCallsStarted.fire();
        return new Promise((_, reject) => {
          const onAbort = (): void => {
            aborted += 1;
            if (aborted === 2) bothCallsAborted.fire();
            void abortGate.then(() => reject(new Error("stopped")));
          };
          if (params.signal?.aborted) onAbort();
          else params.signal?.addEventListener("abort", onAbort, { once: true });
        });
      },
    };
    const deps = { ...runtime.deps, llm: blockingLlm };
    const factory = createMemoryFactory({
      llm,
      workspaceRoot: tempWorkspace(),
      logger,
      runDeps: () => deps,
      loadSettings: () => ({ config: CONFIG, defaultModel: "anthropic/cheap" }),
      storeFor: (owner) => stores.get(owner)!,
    });
    const alice = factory.forOwner("alice")!;
    const bob = factory.forOwner("bob")!;
    const aliceProvider = await factory.providerFor!("alice");
    const bobProvider = await factory.providerFor!("bob");
    if (aliceProvider === undefined || !aliceProvider.ok) throw new Error("alice provider missing");
    if (bobProvider === undefined || !bobProvider.ok) throw new Error("bob provider missing");
    await alice.enqueue({ ...run(), run_id: "alice-run" }, { providerKey: aliceProvider.key });
    await bob.enqueue({ ...run(), run_id: "bob-run" }, { providerKey: bobProvider.key });
    const unsubscribeAlice = factory.subscribeToRun("alice", "never-settles", () => undefined);
    const unsubscribeBob = factory.subscribeToRun("bob", "never-settles", () => undefined);

    let abortReleased = false;
    try {
      factory.start("alice");
      factory.start("bob");
      await bothCallsStarted.promise;
      expect(await stores.get("alice")!.jobs.get("alice-run")).toMatchObject({
        state: "running",
      });
      expect((await stores.get("bob")!.jobs.get("bob-run"))?.state).toBe("running");
      expect(calls).toBe(2);

      const firstStop = factory.stop();
      let concurrentStopSettled = false;
      const concurrentStop = factory.stop().then(() => {
        concurrentStopSettled = true;
      });
      await bothCallsAborted.promise;
      expect(aborted).toBe(2);
      expect(concurrentStopSettled).toBe(false);

      releaseAbort();
      abortReleased = true;
      await Promise.all([firstStop, concurrentStop, factory.stop()]);
      for (const [owner, runId] of [
        ["alice", "alice-run"],
        ["bob", "bob-run"],
      ] as const) {
        const job = await stores.get(owner)!.jobs.get(runId);
        expect(job).toMatchObject({ state: "pending", attempts: 0 });
        expect(job?.lease_owner).toBeUndefined();
        expect(job?.lease_until).toBeUndefined();
      }

      factory.start("alice");
      factory.poke("bob");
      factory.subscribeToRun("alice", "after-stop", () => undefined)();
      await Promise.resolve();
      await Promise.resolve();
      expect(calls).toBe(2);
      expect((await stores.get("alice")!.jobs.get("alice-run"))?.state).toBe("pending");
      expect((await stores.get("bob")!.jobs.get("bob-run"))?.state).toBe("pending");
      expect(() => unsubscribeAlice()).not.toThrow();
      expect(() => unsubscribeBob()).not.toThrow();
    } finally {
      if (!abortReleased) releaseAbort();
      unsubscribeAlice();
      unsubscribeBob();
      await factory.stop();
    }
  });

  it("caches per owner + settings signature and rebuilds when settings change", () => {
    const { llm, logger } = makeFactoryDeps();
    let model = "anthropic/cheap-1";
    const factory = createMemoryFactory({
      llm,
      workspaceRoot: "/ws",
      logger,
      loadSettings: () => ({ config: { ...CONFIG, model } }),
    });
    const a = factory.forOwner("o1");
    expect(factory.forOwner("o1")).toBe(a);
    const b = factory.forOwner("o2");
    expect(b).not.toBe(a);

    model = "anthropic/cheap-2";
    expect(factory.forOwner("o1")).not.toBe(a);
  });

  describe("forOwnerControlPlane", () => {
    it("resolves with no model, so an enabled workspace stays browsable", () => {
      // The run path must still refuse — a run that cannot learn must not
      // pretend it can — but the wiki itself is readable without an indexer.
      const { llm, logger } = makeFactoryDeps();
      const factory = createMemoryFactory({
        llm,
        workspaceRoot: tempWorkspace(),
        logger,
        loadSettings: () => ({ config: CONFIG }),
      });

      expect(factory.forOwner("o")).toBeUndefined();
      const memory = factory.forOwnerControlPlane("o");
      expect(memory).toBeDefined();
      expect(memory!.tools.map((t) => t.name)).toContain("read_memory");
    });

    it("reports an unavailable indexer as skipped rather than failing", async () => {
      const { llm, logger } = makeFactoryDeps();
      const factory = createMemoryFactory({
        llm,
        workspaceRoot: tempWorkspace(),
        logger,
        loadSettings: () => ({ config: CONFIG }),
      });

      const report = await factory.forOwnerControlPlane("o")!.index(run());
      expect(report.skipped).toBe(true);
      expect(report.note).toBe("no-indexer");
      expect(llm.calls).toHaveLength(0);
    });

    it("shares one instance with forOwner when a model does resolve", () => {
      // Two instances over the same tree would have independent exclusion.
      const { llm, logger } = makeFactoryDeps();
      const factory = createMemoryFactory({
        llm,
        workspaceRoot: tempWorkspace(),
        logger,
        loadSettings: () => ({ config: CONFIG, defaultModel: "anthropic/cheap" }),
      });

      const forRun = factory.forOwner("o");
      expect(factory.forOwnerControlPlane("o")).toBe(forRun);
    });

    it("still refuses when memory is absent or switched off", () => {
      const { llm, logger } = makeFactoryDeps();
      const off = createMemoryFactory({
        llm,
        workspaceRoot: "/ws",
        logger,
        loadSettings: () => undefined,
      });
      expect(off.forOwnerControlPlane("o")).toBeUndefined();

      const disabled = createMemoryFactory({
        llm,
        workspaceRoot: "/ws",
        logger,
        loadSettings: () => ({ config: { ...CONFIG, enabled: false }, defaultModel: "p/m" }),
      });
      expect(disabled.forOwnerControlPlane("o")).toBeUndefined();
    });

    it("shares the store with the run instance, so both exclude each other", async () => {
      const { llm, logger } = makeFactoryDeps();
      const factory = createMemoryFactory({
        llm,
        workspaceRoot: tempWorkspace(),
        logger,
        loadSettings: () => ({ config: CONFIG }),
      });

      const control = factory.forOwnerControlPlane("o")!;
      await control.store.write("infra/bun/MEMORY.md", "---\ndescription: d\n---\nbody\n");
      expect(await factory.forOwnerControlPlane("o")!.store.read("infra/bun/MEMORY.md")).toContain(
        "body",
      );
    });
  });
});

describe("memory factory — per-owner persistence", () => {
  const settings = (model: string) => ({
    config: { enabled: true, model } as never,
    providers: [{ name: "anthropic", kind: "anthropic" }] as never,
  });

  it("gives each owner its own store when the host supplies storeFor", () => {
    const { llm, logger } = makeFactoryDeps();
    const calls: string[] = [];
    const factory = createMemoryFactory({
      llm,
      logger,
      workspaceRoot: tempWorkspace(),
      loadSettings: () => settings("anthropic/x"),
      storeFor: (owner) => {
        calls.push(owner);
        return { marker: owner } as never;
      },
    });

    expect(factory.forOwner("alice")!.store).not.toBe(factory.forOwner("bob")!.store);
    expect(calls).toEqual(["alice", "bob"]);
  });

  it("rebuilds the facade on a settings change but never a second store over one tree", () => {
    const { llm, logger } = makeFactoryDeps();
    const calls: string[] = [];
    let model = "anthropic/x";
    const factory = createMemoryFactory({
      llm,
      logger,
      workspaceRoot: tempWorkspace(),
      loadSettings: () => settings(model),
      storeFor: (owner) => {
        calls.push(owner);
        return { marker: owner } as never;
      },
    });

    const first = factory.forOwner("alice");
    model = "anthropic/y";
    const second = factory.forOwner("alice");

    expect(second).not.toBe(first);
    expect(second!.store).toBe(first!.store);
    expect(calls).toEqual(["alice"]);
  });

  it("stopOwner evicts only that owner's facades and store", async () => {
    const { llm, logger } = makeFactoryDeps();
    const calls: string[] = [];
    const factory = createMemoryFactory({
      llm,
      logger,
      workspaceRoot: tempWorkspace(),
      loadSettings: () => settings("anthropic/x"),
      storeFor: (owner) => {
        calls.push(owner);
        return { marker: owner } as never;
      },
    });
    const alice = factory.forOwner("alice")!;
    const bob = factory.forOwner("bob")!;

    await factory.stopOwner!("alice");

    expect(factory.forOwner("alice")).not.toBe(alice);
    expect(factory.forOwner("alice")!.store).not.toBe(alice.store);
    expect(factory.forOwner("bob")).toBe(bob);
    expect(calls).toEqual(["alice", "bob", "alice"]);
  });
});

describe("createMemoryFactory — providerFor", () => {
  const factoryOf = (
    config: Record<string, unknown>,
    over: {
      workspaceRoot?: string;
      serverPort?: Parameters<typeof createMemoryFactory>[0]["serverPort"];
    } = {},
  ) => {
    const { llm, logger } = makeFactoryDeps();
    return createMemoryFactory({
      llm,
      logger,
      workspaceRoot: over.workspaceRoot ?? tempWorkspace(),
      loadSettings: () => ({ config: config as never, providers: [] }),
      ...(over.serverPort !== undefined ? { serverPort: over.serverPort } : {}),
    });
  };

  it("treats settings failures as an unavailable provider", async () => {
    const { llm, logger } = makeFactoryDeps();
    const factory = createMemoryFactory({
      llm,
      logger,
      workspaceRoot: "/ws",
      loadSettings: () => {
        throw new Error("bad settings");
      },
    });

    await expect(factory.providerFor!("owner")).resolves.toBeUndefined();
  });

  it("is undefined when memory is off, the same signal forOwnerControlPlane gives", async () => {
    const { llm, logger } = makeFactoryDeps();
    const off = createMemoryFactory({
      llm,
      logger,
      workspaceRoot: tempWorkspace(),
      loadSettings: () => undefined,
    });
    await expect(off.providerFor!("o")).resolves.toBeUndefined();
  });

  it("is undefined when memory is explicitly disabled", async () => {
    await expect(factoryOf({ enabled: false }).providerFor!("o")).resolves.toBeUndefined();
  });

  it("defaults to the built-in wiki when no provider is declared", async () => {
    const res = await factoryOf(CONFIG).providerFor!("o");
    expect(res?.ok).toBe(true);
    if (res?.ok) expect(res.provider.kind).toBe("wiki");
  });

  it("resolves a declared file provider, and never builds the wiki for it", async () => {
    const ws = tempWorkspace();
    const res = await factoryOf(
      { enabled: true, provider: { kind: "file", paths: ["DOCTRINE.md"] } },
      { workspaceRoot: ws },
    ).providerFor!("o");
    expect(res?.ok).toBe(true);
    if (res?.ok) {
      expect(res.provider.kind).toBe("file");
      expect(res.provider.writeTools).toBeUndefined();
    }
  });

  it("reports an mcp declaration unavailable when the host wired no server port", async () => {
    const res = await factoryOf({
      enabled: true,
      provider: {
        kind: "mcp",
        server: "acme",
        tools: {
          list_memories: "a",
          read_memory: "b",
          grep_memories: "c",
          query_memories: "d",
        },
      },
    }).providerFor!("o");
    expect(res?.ok).toBe(false);
    if (res !== undefined && !res.ok) {
      expect(res.failure.reason).toContain("cannot reach tool servers");
    }
  });

  it("hands an mcp provider the host's port when there is one", async () => {
    const calls: string[] = [];
    const res = await factoryOf(
      {
        enabled: true,
        provider: {
          kind: "mcp",
          server: "acme",
          tools: {
            list_memories: "kb_list",
            read_memory: "kb_get",
            grep_memories: "kb_grep",
            query_memories: "kb_search",
          },
        },
      },
      {
        serverPort: {
          forOwner: (owner) => ({
            callTool: (server, tool) => {
              calls.push(`${owner}:${server}:${tool}`);
              return Promise.resolve({ text: "", isError: false });
            },
          }),
        },
      },
    ).providerFor!("o");
    expect(res?.ok).toBe(true);
    if (res?.ok) await res.provider.readTools[0]!.execute({});
    expect(calls).toEqual(["o:acme:kb_list"]);
  });
});
