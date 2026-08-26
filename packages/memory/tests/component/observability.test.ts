/**
 * The operator-facing events `@clarvis/memory` emits.
 *
 * The index queue is durable and drains in the background, so none of what it
 * decides is observable from a run: a blocked workspace, a retry, a give-up and
 * — most expensively — a pass that fell back to indexing from a digest instead
 * of continuing the run it indexes all used to happen in total silence. Each
 * case below pins one of those decisions.
 */
import { describe, expect, it } from "bun:test";
import { createRateLimiter } from "@clarvis/capability";

import { DEFAULT_BUDGETS } from "../../src/config.ts";
import { drainIndexJobs } from "../../src/drain.ts";
import { indexRun } from "../../src/indexer/run.ts";
import { MemoryRecoveryRequiredError } from "../../src/journal.ts";
import { createMcpMemoryProvider } from "../../src/mcp-provider.ts";
import { planReindex } from "../../src/reindex.ts";
import { createInMemoryMemoryStore, createTestClock } from "../../src/testing.ts";
import type { IndexerRuntime, MemoryStore } from "../../src/types.ts";
import { captureWorkspaceState } from "../../src/workspace-state.ts";
import { doc, run } from "../helpers/fixtures.ts";
import { fakeIndexerRuntime, writeStep } from "../helpers/indexer-runtime.ts";
import { recordingLogger } from "../helpers/recording-logger.ts";

/** A store holding one queued job for `runId`. */
async function storeWithJob(runId: string): Promise<MemoryStore> {
  const store = createInMemoryMemoryStore();
  await store.exclusive((tx) =>
    tx.jobs.enqueue({
      run_id: runId,
      snapshot: run({ run_id: runId }),
      at: 1,
      provider_key: "wiki:local",
    }),
  );
  return store;
}

/** A pass that closes the pyramid, so the drain records a completed job. */
function closingIndexer(): () => IndexerRuntime {
  return () =>
    fakeIndexerRuntime([
      writeStep("infra/bun/MEMORY.md", doc("bun", "# Bun\nUse bun test.")),
      writeStep("infra/TOPIC.md", doc("infra", "# Infra")),
      writeStep("PROFILE.md", doc("profile", "# Profile")),
      { text: "done" },
    ]).runtime;
}

describe("memory.job.blocked", () => {
  it("says a due job found no indexer model, so the learning is only waiting", async () => {
    const store = await storeWithJob("no-model");
    const log = recordingLogger();

    const report = await drainIndexJobs({
      store,
      budgets: DEFAULT_BUDGETS,
      now: 10,
      owner: "worker",
      logger: log.logger,
    });

    expect(report.blocked).toBe(1);
    const blocked = log.one("memory.job.blocked");
    expect(blocked.level).toBe("info");
    expect(blocked.fields).toMatchObject({ run_id: "no-model", reason: "no_indexer" });
  });

  it("says a steady blocked state once, however often the queue is drained", async () => {
    const store = await storeWithJob("stuck");
    const log = recordingLogger();
    const admitBlocked = createRateLimiter();

    for (let pass = 0; pass < 20; pass += 1) {
      const report = await drainIndexJobs({
        store,
        budgets: DEFAULT_BUDGETS,
        now: 10,
        owner: "worker",
        logger: log.logger,
        admitBlocked,
      });
      expect(report.blocked).toBe(1);
    }

    expect(log.of("memory.job.blocked")).toHaveLength(1);
  });

  it("keys the limiter by run and reason, so a second stuck run is not swallowed", async () => {
    const log = recordingLogger();
    const admitBlocked = createRateLimiter();
    const common = { budgets: DEFAULT_BUDGETS, now: 10, owner: "worker", logger: log.logger };

    for (const runId of ["stuck-a", "stuck-b"]) {
      await drainIndexJobs({ store: await storeWithJob(runId), ...common, admitBlocked });
    }

    expect(log.of("memory.job.blocked").map((entry) => entry.fields.run_id)).toEqual([
      "stuck-a",
      "stuck-b",
    ]);
  });

  it("distinguishes a claim another worker took over from a workspace with no model", async () => {
    const store = await storeWithJob("stolen");
    const log = recordingLogger();
    const runtime = closingIndexer();
    const real = store.exclusive.bind(store);
    let settling = false;
    const fenced: MemoryStore = {
      ...store,
      exclusive: async (fn) => {
        if (!settling) return real(fn);
        return real(async (tx) => {
          const jobs = { ...tx.jobs, complete: async () => false };
          return fn({ ...tx, jobs } as typeof tx);
        });
      },
    };
    const report = await drainIndexJobs({
      store: fenced,
      indexer: () => {
        settling = false;
        const resolved = runtime();
        settling = true;
        return Promise.resolve(resolved);
      },
      budgets: DEFAULT_BUDGETS,
      now: 10,
      owner: "worker",
      logger: log.logger,
    });

    expect(report.blocked).toBe(1);
    expect(log.of("memory.job.blocked").at(-1)!.fields.reason).toBe("lease_lost");
  });

  it("keeps a second reason for the same run out of the first one's window", async () => {
    const store = await storeWithJob("two-reasons");
    const log = recordingLogger();
    const admitBlocked = createRateLimiter();
    const common = {
      budgets: DEFAULT_BUDGETS,
      now: 10,
      owner: "worker",
      logger: log.logger,
      admitBlocked,
    };

    await drainIndexJobs({ store, ...common });
    const real = store.exclusive.bind(store);
    let settling = false;
    const fenced: MemoryStore = {
      ...store,
      exclusive: async (fn) => {
        if (!settling) return real(fn);
        return real(async (tx) => {
          const jobs = { ...tx.jobs, complete: async () => false };
          return fn({ ...tx, jobs } as typeof tx);
        });
      },
    };
    const runtime = closingIndexer();
    await drainIndexJobs({
      store: fenced,
      indexer: () => {
        settling = false;
        const resolved = runtime();
        settling = true;
        return Promise.resolve(resolved);
      },
      ...common,
    });

    expect(log.of("memory.job.blocked").map((entry) => entry.fields.reason)).toEqual([
      "no_indexer",
      "lease_lost",
    ]);
  });

  it("refunds a claim and stops when the tree is frozen awaiting recovery", async () => {
    const store = await storeWithJob("frozen");
    const log = recordingLogger();
    const real = store.exclusive.bind(store);
    let calls = 0;
    const frozen: MemoryStore = {
      ...store,
      exclusive: (fn) => {
        calls += 1;
        if (calls === 2) throw new MemoryRecoveryRequiredError("b-1", "a human edited mid-batch");
        return real(fn);
      },
    };

    const report = await drainIndexJobs({
      store: frozen,
      indexer: () => Promise.resolve(closingIndexer()()),
      budgets: DEFAULT_BUDGETS,
      now: 10,
      owner: "worker",
      logger: log.logger,
    });

    expect(report.blocked).toBe(1);
    expect(log.of("memory.job.blocked").at(-1)!.fields.reason).toBe("recovery");
    expect(await store.jobs.get("frozen")).toMatchObject({ state: "pending" });
  });

  it("reports a shutdown as blocked rather than as the job's failure", async () => {
    const store = await storeWithJob("cancelled");
    const log = recordingLogger();
    const controller = new AbortController();

    const report = await drainIndexJobs({
      store,
      indexer: () =>
        fakeIndexerRuntime([
          {
            get toolCalls(): never {
              controller.abort();
              throw new Error("cancelled mid-pass");
            },
          } as never,
        ]).runtime,
      budgets: DEFAULT_BUDGETS,
      now: 10,
      owner: "worker",
      signal: controller.signal,
      logger: log.logger,
    });

    expect(report.blocked).toBe(1);
    expect(log.of("memory.job.blocked").at(-1)!.fields.reason).toBe("shutdown");
  });
});

describe("memory.job.converged", () => {
  it("names the guard that settled a job without a model call", async () => {
    const store = await storeWithJob("already");
    await store.exclusive((tx) => tx.markIndexed("already"));
    const log = recordingLogger();

    const report = await drainIndexJobs({
      store,
      indexer: () => Promise.resolve(closingIndexer()()),
      budgets: DEFAULT_BUDGETS,
      now: 10,
      owner: "worker",
      logger: log.logger,
    });

    expect(report.completed).toBe(1);
    const converged = log.one("memory.job.converged");
    expect(converged.level).toBe("debug");
    expect(converged.fields).toMatchObject({ run_id: "already", note: "already-indexed" });
  });
});

describe("memory.index.failed and memory.index.gave_up", () => {
  it("names the phase, the budget it is spending, and when the retry is due", async () => {
    const store = await storeWithJob("transient");
    const log = recordingLogger();

    await drainIndexJobs({
      store,
      indexer: () =>
        Promise.resolve(fakeIndexerRuntime([{ throw: new Error("provider down") }]).runtime),
      budgets: DEFAULT_BUDGETS,
      now: 1_000,
      owner: "worker",
      logger: log.logger,
    });

    const failed = log.one("memory.index.failed");
    expect(failed.level).toBe("warn");
    expect(failed.fields).toMatchObject({
      run_id: "transient",
      phase: "generate",
      terminal: false,
      attempts: 1,
      max_attempts: 5,
      next_state: "retry_wait",
    });
    expect(failed.fields.not_before as number).toBeGreaterThanOrEqual(1_000);
    expect(failed.fields.indexer_run_id).toBeString();
    expect(log.of("memory.index.gave_up")).toHaveLength(0);
  });

  it("escalates to error, with the phases it burned its budget on, once it gives up", async () => {
    const store = await storeWithJob("doomed");
    const log = recordingLogger();
    const clock = createTestClock(1_000);

    for (let attempt = 0; attempt < 5; attempt++) {
      await drainIndexJobs({
        store,
        indexer: () =>
          Promise.resolve(
            fakeIndexerRuntime([{ throw: new Error(`provider down ${String(attempt)}`) }]).runtime,
          ),
        budgets: DEFAULT_BUDGETS,
        clock,
        owner: "worker",
        logger: log.logger,
      });
      await clock.advance(3_600_000);
    }

    const gaveUp = log.one("memory.index.gave_up");
    expect(gaveUp.level).toBe("error");
    expect(gaveUp.fields).toMatchObject({ run_id: "doomed", phase: "generate", attempts: 5 });
    expect(gaveUp.fields.history_phases).toEqual(["generate", "generate", "generate", "generate"]);
    expect(log.of("memory.index.failed").at(-1)!.fields.next_state).toBe("failed");
  });

  it("charges a validate failure against its own, lower budget", async () => {
    const store = await storeWithJob("open-pyramid");
    const log = recordingLogger();

    await drainIndexJobs({
      store,
      indexer: () =>
        Promise.resolve(
          fakeIndexerRuntime([
            writeStep("infra/bun/MEMORY.md", doc("bun", "# Bun")),
            ...Array.from({ length: 30 }, () => ({ text: "done" })),
          ]).runtime,
        ),
      budgets: DEFAULT_BUDGETS,
      now: 1_000,
      owner: "worker",
      logger: log.logger,
    });

    expect(log.one("memory.index.failed").fields).toMatchObject({
      phase: "validate",
      max_attempts: 2,
    });
  });
});

describe("memory.prune", () => {
  it("reports what retention dropped from the queue", async () => {
    const store = await storeWithJob("pruned");
    const log = recordingLogger();

    await drainIndexJobs({
      store,
      budgets: DEFAULT_BUDGETS,
      now: 10,
      owner: "worker",
      logger: log.logger,
    });

    const prune = log.one("memory.prune");
    expect(prune.level).toBe("debug");
    expect(prune.fields).toMatchObject({ removed: 0, kept_failed: 20 });
  });
});

describe("memory.index.pass", () => {
  it("names the isolated pass and the blocker that forced it, and the drain carries it", async () => {
    const store = await storeWithJob("cold");
    const log = recordingLogger();

    const report = await drainIndexJobs({
      store,
      indexer: () => Promise.resolve(closingIndexer()()),
      budgets: DEFAULT_BUDGETS,
      now: 10,
      owner: "worker",
      logger: log.logger,
    });

    const pass = log.one("memory.index.pass");
    expect(pass.level).toBe("info");
    expect(pass.fields).toMatchObject({
      run_id: "cold",
      pass: "isolated",
      continuation_blocker: "no-pass-deps",
      written: 3,
      deleted: 0,
    });
    expect(pass.fields.ms as number).toBeGreaterThanOrEqual(0);
    expect(pass.fields.indexer_run_id).toBeString();
    expect(report.jobs[0]).toMatchObject({
      outcome: "completed",
      continuation_blocker: "no-pass-deps",
    });
  });

  it("reports a pass that never ran the model as written 0", async () => {
    const log = recordingLogger();
    const report = await indexRun({
      run: run({ run_id: "quiet" }),
      store: createInMemoryMemoryStore(),
      budgets: DEFAULT_BUDGETS,
      indexer: fakeIndexerRuntime([{ text: "nothing to record" }]).runtime,
      logger: log.logger,
    });

    expect(report.skipped).toBe(true);
    expect(log.one("memory.index.pass").fields).toMatchObject({ written: 0, deleted: 0 });
  });
});

describe("memory.seed.provider_failed", () => {
  const mapping = {
    list_memories: "list",
    read_memory: "read",
    grep_memories: "grep",
    query_memories: "query",
  };

  it("says a seed the provider threw on left the run looking like an empty wiki", async () => {
    const log = recordingLogger();
    const provider = createMcpMemoryProvider({
      server: "kb",
      tools: mapping,
      seedTool: "seed",
      port: { callTool: () => Promise.reject(new Error("connection refused")) },
      logger: log.logger,
    });

    expect(await provider.seed("task")).toBeNull();
    const failed = log.one("memory.seed.provider_failed");
    expect(failed.level).toBe("warn");
    expect(failed.fields).toMatchObject({ provider: "mcp" });
    expect(failed.fields.cause).toContain("connection refused");
  });

  it("says the same for a seed tool that answered with an error result", async () => {
    const log = recordingLogger();
    const provider = createMcpMemoryProvider({
      server: "kb",
      tools: mapping,
      seedTool: "seed",
      port: { callTool: () => Promise.resolve({ text: "nope", isError: true }) },
      logger: log.logger,
    });

    expect(await provider.seed()).toBeNull();
    expect(log.one("memory.seed.provider_failed").fields.cause).not.toContain("nope");
  });

  it("says nothing when the provider simply has nothing to seed with", async () => {
    const log = recordingLogger();
    const provider = createMcpMemoryProvider({
      server: "kb",
      tools: mapping,
      seedTool: "seed",
      port: { callTool: () => Promise.resolve({ text: "   ", isError: false }) },
      logger: log.logger,
    });

    expect(await provider.seed()).toBeNull();
    expect(log.of("memory.seed.provider_failed")).toHaveLength(0);
  });
});

describe("memory.document.skipped", () => {
  const store = () => {
    const tree = createInMemoryMemoryStore();
    return tree;
  };

  it("names a document whose open frontmatter took its directory out of the navigation", async () => {
    const tree = store();
    await tree.write("infra/bun/MEMORY.md", doc("bun facts", "# Bun"));
    await tree.write("infra/TOPIC.md", "---\ndescription: infra\n# Infra\n");
    const log = recordingLogger("debug");

    await planReindex(tree, log.logger);

    expect(log.of("memory.document.skipped").map((r) => r.fields)).toContainEqual({
      event: "memory.document.skipped",
      path: "infra/TOPIC.md",
      reason: "open_frontmatter",
    });
  });

  it("names a document that contributed no description to its parent's link list", async () => {
    const tree = store();
    await tree.write("infra/bun/MEMORY.md", "---\ndescription:\n---\n# Bun\n");
    const log = recordingLogger("debug");

    await planReindex(tree, log.logger);

    expect(
      log.of("memory.document.skipped").filter((r) => r.fields.reason === "no_description").length,
    ).toBeGreaterThan(0);
  });

  it("builds no per-document record at all when the logger discards debug", async () => {
    const tree = store();
    await tree.write("infra/bun/MEMORY.md", "---\ndescription:\n---\n# Bun\n");
    const log = recordingLogger("info");

    await planReindex(tree, log.logger);

    expect(log.of("memory.document.skipped")).toHaveLength(0);
  });
});

describe("memory.workspace_state.unavailable", () => {
  it("says why a snapshot carries no branch or commit", async () => {
    const log = recordingLogger("debug");
    expect(await captureWorkspaceState("/definitely/not/a/repo", log.logger)).toBeUndefined();
    const missing = log.one("memory.workspace_state.unavailable");
    expect(missing.level).toBe("debug");
    expect(missing.fields.cause).toBeString();
  });

  it("builds nothing when the logger discards debug", async () => {
    const log = recordingLogger("warn");
    expect(await captureWorkspaceState("/definitely/not/a/repo", log.logger)).toBeUndefined();
    expect(log.of("memory.workspace_state.unavailable")).toHaveLength(0);
  });
});
