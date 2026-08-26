import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { MockLLM, MockLLMScriptStep } from "@clarvis/loop/testing";

import { createFileMemory, createMemory } from "../../src/index.ts";
import type { Memory } from "../../src/memory-contract.ts";
import { createInMemoryMemoryStore, createTestClock } from "../../src/testing.ts";
import type { MemoryStore } from "../../src/types.ts";
import { doc, run, toolCall } from "../helpers/fixtures.ts";
import { makeRoot } from "../helpers/fs.ts";
import { editStep, fakeIndexerRuntime, writeStep } from "../helpers/indexer-runtime.ts";

describe("createFileMemory — seed", () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let memory: Memory;

  beforeEach(async () => {
    ({ root, cleanup } = await makeRoot());
    memory = createFileMemory({ root });
  });
  afterEach(() => cleanup());

  test("returns null when there is no PROFILE to inject", async () => {
    expect(await memory.seed("anything")).toBeNull();
  });

  test("returns raw PROFILE seed content once a leaf is indexed", async () => {
    await memory.store.write(
      "infra/bun/MEMORY.md",
      "---\ndescription: pinned via mise\n---\n# Bun",
    );
    await memory.reindex();
    const seed = await memory.seed("set up the build");
    expect(seed).not.toBeNull();
    expect(seed).not.toContain("<memory>");
    expect(seed).toContain("[infra](infra/TOPIC.md)");
    expect(seed).not.toContain("reindex:begin");
  });

  test("uses one injected clock for durable queue timestamps and live lease timing", async () => {
    const legacy = createFileMemory({ root, clock: () => 123 });
    expect((await legacy.enqueue(run({ run_id: "legacy-clock" }))).enqueued_at).toBe(123);

    const clock = createTestClock(500);
    const live = createFileMemory({ root, clock });
    expect((await live.enqueue(run({ run_id: "live-clock" }))).enqueued_at).toBe(500);
  });

  test("delegates query, health, job listing, and retry through the facade", async () => {
    await memory.store.write("infra/bun/MEMORY.md", doc("bun", "# Bun\n\nPinned with mise."));
    await memory.reindex();
    await memory.enqueue(run({ run_id: "facade-job" }));

    expect((await memory.query({ query: "mise" })).hits[0]?.path).toBe("infra/bun/MEMORY.md");
    expect((await memory.health()).totals.documents).toBe(3);
    expect((await memory.jobs()).map((job) => job.run_id)).toContain("facade-job");
    expect(await memory.retryJob("facade-job")).toBeNull();
  });

  test("reindexes through a caller-supplied transaction without taking a nested exclusive lock", async () => {
    const backing = createInMemoryMemoryStore();
    let exclusiveCalls = 0;
    const store: MemoryStore = {
      ...backing,
      exclusive(fn) {
        exclusiveCalls += 1;
        return backing.exclusive(fn);
      },
    };
    const facade = createMemory({ store });
    await backing.write("infra/bun/MEMORY.md", doc("bun", "# Bun"));

    const changed = await facade.reindex(backing);

    expect(changed).toContain("PROFILE.md");
    expect(exclusiveCalls).toBe(0);
  });

  test("bounds an oversized snapshot before the facade enqueues it", async () => {
    const calls = Array.from({ length: 510 }, (_, index) =>
      toolCall({ tool_name: `tool-${String(index)}` }),
    );

    await memory.enqueue(run({ run_id: "bounded-facade-job", tool_calls: calls }));

    const [stored] = await memory.jobs();
    expect(stored?.snapshot?.tool_calls.length).toBe(500);
  });
});

describe("createFileMemory — per-run indexer", () => {
  let root: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ root, cleanup } = await makeRoot());
  });
  afterEach(() => cleanup());

  /** A memory whose indexer runs a real pass over `script`. */
  function memoryOver(script: MockLLMScriptStep[]): { memory: Memory; llm: MockLLM } {
    const { runtime, llm } = fakeIndexerRuntime(script);
    return { memory: createFileMemory({ root, indexer: () => runtime }), llm };
  }

  /** The three calls that close a one-topic pyramid, leaf first. */
  function closedPyramid(leafBody: string): MockLLMScriptStep[] {
    return [
      writeStep("infra/bun/MEMORY.md", doc("bun details", leafBody)),
      writeStep("infra/TOPIC.md", doc("infra", "# Infra\n\nBun is pinned through mise.")),
      writeStep("PROFILE.md", doc("Bun workspace", "# Profile\n\nUse Bun through mise.")),
      { text: "recorded" },
    ];
  }

  test("applies the pass's writes and reindexes the tree", async () => {
    const { memory } = memoryOver(closedPyramid("# Bun\n\nmise pins bun to 1.3.11."));

    const report = await memory.index(run({ task: "pin bun" }));

    expect(report.skipped).toBe(false);
    expect(report.written.sort()).toEqual(["PROFILE.md", "infra/TOPIC.md", "infra/bun/MEMORY.md"]);
    expect(report.reindexed).toBe(true);
    expect(await memory.store.read("infra/bun/MEMORY.md")).toContain("1.3.11");
    // The deterministic restitch ran inside each mutation's own batch.
    expect(await memory.store.read("infra/TOPIC.md")).toContain("[bun](bun/MEMORY.md)");
  });

  test("keeps compiled knowledge at PROFILE, TOPIC, and MEMORY pyramid levels", async () => {
    const { memory } = memoryOver(closedPyramid("# Bun\n\nExact command: `mise install`."));
    await memory.index(run({ task: "pin bun" }));

    expect(await memory.store.read("PROFILE.md")).toContain("Use Bun through mise");
    expect(await memory.store.read("infra/TOPIC.md")).toContain("Bun is pinned through mise");
    expect(await memory.store.read("infra/bun/MEMORY.md")).toContain("mise install");
  });

  test("the pass reads the tree rather than being handed it", async () => {
    // The old pass pushed a rendered view of every compilation into the prompt,
    // unbudgeted. It now pulls what it needs, so a large tree costs a pass
    // nothing unless it actually looks.
    const { memory, llm } = memoryOver([
      { toolCalls: [{ name: "query_memories", arguments: { query: "bun" } }] },
      ...closedPyramid("# Bun\n\nmise pins it."),
    ]);
    await memory.store.write("infra/old/MEMORY.md", doc("old", "# Old\n\nirrelevant filler"));

    await memory.index(run({ task: "pin bun" }));

    const firstPrompt = JSON.stringify(llm.calls[0]?.messages ?? []);
    expect(firstPrompt).not.toContain("irrelevant filler");
    expect(llm.calls[0]?.tools?.map((t) => t.wireName)).toContain("query_memories");
  });

  test("edit_memory closes an ancestor, so a fact does not cost a rewrite", async () => {
    // The whole point of the redesign: updating one line of a compiled ancestor
    // is a surgical edit, not a re-emission of the entire document.
    const seeded = createFileMemory({ root });
    await seeded.store.write("PROFILE.md", doc("workspace", "# Profile\n\nBun: unknown version."));
    await seeded.store.write("infra/TOPIC.md", doc("infra", "# Infra\n\nBun: unknown version."));

    const { runtime } = fakeIndexerRuntime([
      writeStep("infra/bun/MEMORY.md", doc("bun", "# Bun\n\nPinned to 1.3.11.")),
      editStep("infra/TOPIC.md", "Bun: unknown version.", "Bun: pinned to 1.3.11."),
      editStep("PROFILE.md", "Bun: unknown version.", "Bun: pinned to 1.3.11."),
      { text: "recorded" },
    ]);
    const indexed = createFileMemory({ root, indexer: () => runtime });

    const report = await indexed.index(run({ task: "pin bun" }));

    expect(report.skipped).toBe(false);
    expect(await indexed.store.read("PROFILE.md")).toContain("pinned to 1.3.11");
    expect(await indexed.store.read("infra/TOPIC.md")).toContain("pinned to 1.3.11");
  });

  test("the write budget refuses the call over max_index_ops rather than truncating", async () => {
    const { runtime, llm } = fakeIndexerRuntime([
      writeStep("a/b/MEMORY.md", doc("a", "# A")),
      writeStep("a/TOPIC.md", doc("a topic", "# A")),
      writeStep("PROFILE.md", doc("p", "# P")),
      writeStep("c/d/MEMORY.md", doc("c", "# C")),
      { text: "stopping here" },
      { text: "stopping here" },
    ]);
    const memory = createFileMemory({
      root,
      indexer: () => runtime,
      budgets: { max_index_ops: 3 },
    });

    await memory.index(run({ task: "record two topics" }));

    // The fourth mutating call is refused with a message, not silently dropped:
    // the model is told, and can still close what it opened.
    expect(await memory.store.read("c/d/MEMORY.md")).toBeNull();
    expect(llm.calls.length).toBeGreaterThan(4);
  });

  test("indexes a run with no tool calls because prompts and answers can be durable", async () => {
    const { memory } = memoryOver(closedPyramid("# Bun\n\nfrom the answer alone"));
    const report = await memory.index(
      run({ task: "explain the layout", tool_calls: [], final_answer: "the layout is X" }),
    );
    expect(report.skipped).toBe(false);
  });

  test("the gate refuses a finalize that leaves the pyramid open", async () => {
    // A PROFILE-only pass IS applied to disk as it goes — writes are no longer
    // all-or-nothing — but the gate will not let the agent stop there.
    const { memory, llm } = memoryOver([
      writeStep("PROFILE.md", doc("p", "# P")),
      { text: "done" },
      writeStep("infra/bun/MEMORY.md", doc("bun", "# Bun")),
      writeStep("infra/TOPIC.md", doc("infra", "# Infra")),
      writeStep("PROFILE.md", doc("p", "# P\n\nwith the leaf")),
      { text: "done" },
    ]);

    const report = await memory.index(run({ task: "record something" }));

    expect(report.skipped).toBe(false);
    // The nudge named what was missing and the pass closed it.
    expect(await memory.store.read("infra/bun/MEMORY.md")).toContain("# Bun");
    expect(llm.calls.length).toBeGreaterThan(2);
  });

  test("a partial pyramid persists but the run is NOT marked indexed", async () => {
    // The atomicity trade, made visible. The old pass applied every op in one
    // all-or-nothing batch; a pass that cannot close now leaves what it wrote on
    // disk, and convergence is the job's retry reading the tree back.
    const { memory } = memoryOver([
      writeStep("infra/bun/MEMORY.md", doc("bun", "# Bun")),
      ...Array.from({ length: 20 }, () => ({ text: "done" })),
    ]);

    const report = await memory.index(run({ run_id: "r-partial", task: "record" }));

    // The gate keeps sending it back until the run's budget stops it, so the
    // note names the run's terminal status rather than the gate's complaint —
    // both are `validate` failures and both leave the job to retry.
    expect(report.note).toContain("index-run-");
    expect(await memory.store.read("infra/bun/MEMORY.md")).toContain("# Bun");
    expect(await memory.store.wasIndexed("r-partial")).toBe(false);
  });

  test("the nudge names the first missing ancestor", async () => {
    const { memory, llm } = memoryOver([
      writeStep("infra/bun/MEMORY.md", doc("bun", "# Bun")),
      writeStep("PROFILE.md", doc("p", "# P")),
      { text: "done" },
      writeStep("infra/TOPIC.md", doc("infra", "# Infra")),
      { text: "done" },
    ]);

    await memory.index(run({ task: "record" }));

    const transcript = JSON.stringify(llm.calls.map((c) => c.messages));
    expect(transcript).toContain("infra/TOPIC.md");
  });

  test("dedupes: a second index of the same run id is a no-op", async () => {
    const { memory } = memoryOver(closedPyramid("# Bun\n\nonce"));
    const first = await memory.index(run({ run_id: "same" }));
    expect(first.skipped).toBe(false);
    const second = await memory.index(run({ run_id: "same" }));
    expect(second.skipped).toBe(true);
    expect(second.note).toBe("already-indexed");
  });

  test("a pass that records nothing leaves the tree untouched but marks the run done", async () => {
    const { memory, llm } = memoryOver([{ text: "nothing durable here" }]);
    const report = await memory.index(run({ run_id: "quiet" }));

    expect(report.skipped).toBe(true);
    expect(report.note).toBe("nothing-to-record");
    expect(report.written).toEqual([]);
    expect(await memory.store.wasIndexed("quiet")).toBe(true);
    // fastAcceptOk short-circuits the gate on an empty ledger, so the cheapest
    // and most common outcome costs exactly one inference.
    expect(llm.calls).toHaveLength(1);
  });

  test("a run that ends in error does not mark the run indexed (so a retry can learn)", async () => {
    const { memory } = memoryOver([{ throw: new Error("provider exploded") }]);
    const report = await memory.index(run({ run_id: "boom" }));

    expect(report.skipped).toBe(false);
    expect(report.note).toContain("index-run");
    expect(await memory.store.wasIndexed("boom")).toBe(false);
  });

  test("index without an indexer runtime is a no-op", async () => {
    const memory = createFileMemory({ root });
    const report = await memory.index(run({}));
    expect(report.skipped).toBe(true);
    expect(report.note).toBe("no-indexer");
  });

  test("a pass reports its own run id, so a failed one is inspectable", async () => {
    const { memory } = memoryOver(closedPyramid("# Bun\n\nwith an id"));
    const report = await memory.index(run({ task: "pin bun" }));
    expect(report.indexer_run_id).toMatch(/^[a-z0-9_-]+$/i);
  });
});

describe("createFileMemory — review", () => {
  test("counts documents by kind and flags undescribed ones", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const memory = createFileMemory({ root });
      await memory.store.write("infra/bun/MEMORY.md", "---\ndescription: bun\n---\n# B");
      await memory.store.write("infra/x/MEMORY.md", "# no description");
      await memory.reindex();
      const review = await memory.review();
      expect(review.totals.memories).toBe(2);
      expect(review.totals.topics).toBeGreaterThanOrEqual(1);
      expect(review.undescribed).toContain("infra/x/MEMORY.md");
      expect(review.recent[0]).toHaveProperty("path");
    } finally {
      await cleanup();
    }
  });
});
