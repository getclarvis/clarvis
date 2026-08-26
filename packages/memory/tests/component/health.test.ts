import { beforeEach, describe, expect, test } from "bun:test";

import { health, type MemoryHealthCode } from "../../src/health.ts";
import { createMemory } from "../../src/index.ts";
import { reindex } from "../../src/reindex.ts";
import { MemoryStorageLimitError } from "../../src/storage-limits.ts";
import { createInMemoryMemoryStore } from "../../src/testing.ts";
import type { MemoryStore } from "../../src/types.ts";
import type { Memory } from "../../src/memory-contract.ts";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

const doc = (body: string, front = "description: a real summary\n"): string =>
  `---\n${front}---\n# Title\n\n${body}\n`;

/** Codes present in a report, for concise assertions. */
const codes = (report: { findings: { code: MemoryHealthCode }[] }): MemoryHealthCode[] =>
  report.findings.map((f) => f.code);

describe("health", () => {
  let store: MemoryStore;

  beforeEach(() => {
    // A real epoch clock: the default is a monotonic counter, which would make
    // every document look decades stale.
    store = createInMemoryMemoryStore({ clock: () => NOW });
  });

  const inspect = (over: Partial<Parameters<typeof health>[0]> = {}) =>
    health({ tx: store, now: NOW, ...over });

  test("reports nothing wrong with a settled tree", async () => {
    await store.write("infra/bun/MEMORY.md", doc("Bun is pinned via mise."));
    await reindex(store);

    const report = await inspect();

    expect(report.findings).toEqual([]);
    expect(report.counts).toEqual({ error: 0, warning: 0, info: 0 });
    expect(report.totals.documents).toBe(3);
  });

  test("says nothing about an empty tree", async () => {
    expect((await inspect()).findings).toEqual([]);
  });

  test("notices a missing root profile", async () => {
    await store.write("infra/bun/MEMORY.md", doc("body"));
    expect(codes(await inspect())).toContain("missing_profile");
  });

  test("notices a topic with sub-topics but no index", async () => {
    await store.write("PROFILE.md", doc("root"));
    await store.write("infra/bun/MEMORY.md", doc("body"));
    expect(codes(await inspect())).toContain("missing_topic_index");
  });

  test("detects navigation drift by asking the reindexer", async () => {
    // Asking rather than reimplementing means this can never disagree with
    // what a real pass would actually do.
    await store.write("infra/bun/MEMORY.md", doc("body"));
    await reindex(store);
    await store.write("infra/deploy/MEMORY.md", doc("added behind the index's back"));

    expect(codes(await inspect())).toContain("stale_navigation");
  });

  test("reports a document with an unclosed frontmatter block", async () => {
    await store.write("PROFILE.md", doc("root"));
    await store.write("misc/a/MEMORY.md", "---\ndescription: half written\n# never closed");

    const found = (await inspect()).findings.find((f) => f.code === "invalid_frontmatter");

    expect(found?.path).toBe("misc/a/MEMORY.md");
    expect(found?.suggested_action).toContain("---");
  });

  test("reports a missing description", async () => {
    await store.write("PROFILE.md", doc("root"));
    await store.write("misc/a/MEMORY.md", "---\ndescription:\n---\n# T\nbody");
    expect(codes(await inspect())).toContain("missing_description");
  });

  test("reports an unrecognized authority value and preserves it", async () => {
    await store.write("PROFILE.md", doc("root"));
    await store.write("misc/a/MEMORY.md", doc("body", "description: d\nauthority: gospel\n"));

    const found = (await inspect()).findings.find((f) => f.code === "invalid_authority");

    expect(found?.message).toContain("gospel");
    expect(await store.read("misc/a/MEMORY.md")).toContain("authority: gospel");
  });

  test("reports a frontmatter key this package does not read", async () => {
    await store.write("PROFILE.md", doc("root"));
    await store.write("misc/a/MEMORY.md", doc("body", "description: d\nowner: evandro\n"));

    const found = (await inspect()).findings.find((f) => f.code === "unknown_frontmatter_key");

    expect(found?.message).toContain("owner");
    expect(found?.suggested_action).toContain("preserved");
  });

  test("reports a document with no content beyond its chrome", async () => {
    await store.write("PROFILE.md", doc("root"));
    await store.write("misc/a/MEMORY.md", "---\ndescription: d\n---\n# Only a heading\n");
    expect(codes(await inspect())).toContain("empty_document");
  });

  test("reports an oversized document", async () => {
    await store.write("PROFILE.md", doc("root"));
    await store.write("misc/a/MEMORY.md", doc("x".repeat(50_000)));
    expect(codes(await inspect({ config: { maxDocumentChars: 1000 } }))).toContain(
      "document_too_large",
    );
  });

  test("treats staleness as an exact function of the clock it was given", async () => {
    const clocked = createInMemoryMemoryStore({ clock: () => NOW - 100 * DAY });
    await clocked.write("PROFILE.md", doc("root"));
    await clocked.write("misc/a/MEMORY.md", doc("body"));

    const notYet = await health({ tx: clocked, now: NOW, config: { staleDays: 100 } });
    const past = await health({ tx: clocked, now: NOW + DAY, config: { staleDays: 100 } });

    expect(codes(notYet)).not.toContain("stale_document");
    expect(codes(past)).toContain("stale_document");
  });

  test("is deterministic: same tree and same clock, same report", async () => {
    await store.write("misc/a/MEMORY.md", "---\ndescription:\n---\n# T\n");
    await store.write("misc/b/MEMORY.md", doc("body", "description: d\nowner: x\n"));

    expect(await inspect()).toEqual(await inspect());
  });

  test("orders errors before warnings before information", async () => {
    await store.write("misc/a/MEMORY.md", "---\ndescription:\n---\n# T\n");
    await store.write("misc/b/MEMORY.md", doc("body", "description: d\nowner: x\n"));

    const severities = (await inspect()).findings.map((f) => f.severity);

    const rank = { error: 0, warning: 1, info: 2 };
    for (let i = 1; i < severities.length; i++) {
      expect(rank[severities[i]!]).toBeGreaterThanOrEqual(rank[severities[i - 1]!]);
    }
  });

  test("never writes, even to a store whose writes throw", async () => {
    await store.write("misc/a/MEMORY.md", doc("body"));
    const readOnly = {
      list: () => store.list(),
      read: (p: string) => store.read(p),
    };

    const report = await health({ tx: readOnly, now: NOW });

    expect(report.generated_at).toBe(NOW);
  });

  test("keeps errors when truncating an overflowing report", async () => {
    await store.write("misc/a/MEMORY.md", doc("body"));
    for (let i = 0; i < 40; i++) {
      await store.write(`misc/d${String(i)}/MEMORY.md`, doc("body", "description: d\nq: 1\n"));
    }

    const report = await inspect({ config: { maxFindings: 5 } });

    expect(report.truncated).toBe(true);
    expect(report.findings).toHaveLength(5);
    expect(report.findings[0]?.severity).toBe("error");
  });

  test("reports job codes as skipped when there is no queue to read", async () => {
    await store.write("PROFILE.md", doc("root"));
    const report = await inspect();
    expect(report.skipped_codes).toEqual(["failed_index_job", "stuck_index_job"]);
  });

  test("an incomplete catalog skips tree conclusions instead of reporting a partial wiki", async () => {
    const report = await health({
      tx: {
        list: async () => {
          throw new MemoryStorageLimitError({
            kind: "corpus",
            identifier: "test tree",
            actual: 8,
            maximum: 7,
          });
        },
        read: async () => {
          throw new Error("health must not read a partial catalog");
        },
      },
      now: NOW,
    });

    expect(report.findings).toEqual([]);
    expect(report.totals.documents).toBe(0);
    expect(report.truncated).toBe(true);
    expect(report.skipped_codes).toContain("missing_profile");
    expect(report.skipped_codes).toContain("stale_navigation");
    expect(report.skipped_codes).toContain("invalid_frontmatter");
    expect(report.skipped_codes).toContain("failed_index_job");
  });

  test("surfaces a failed index job with its reason", async () => {
    const memory: Memory = createMemory({ store });
    await memory.enqueue({
      run_id: "exec_1",
      workspace: "/ws",
      status: "completed",
      started_at: 0,
      ended_at: 1,
      task: "do a thing",
      tool_calls: [],
    });
    await store.exclusive(async (tx) => {
      const claimed = await tx.jobs.claim(0, { ms: 1, owner: "w" });
      await tx.jobs.fail(
        "exec_1",
        0,
        { phase: "generate", error: "provider unreachable" },
        { state: "failed" },
        { owner: "w", token: claimed?.lease_token ?? "missing-claim-token" },
      );
    });

    const report = await health({ tx: store, now: NOW, jobs: store.jobs });
    const found = report.findings.find((f) => f.code === "failed_index_job");

    expect(found?.path).toBe("exec_1");
    expect(found?.message).toContain("provider unreachable");
    expect(report.totals.failed_jobs).toBe(1);
    expect(report.skipped_codes).toEqual([]);
  });

  test("reports recovery, generated descriptions, and overlong descriptions together", async () => {
    await store.write("PROFILE.md", doc("root"));
    await store.write(
      "infra/TOPIC.md",
      doc("topic body", "description: Infra operational knowledge\n"),
    );
    await store.write("infra/long/MEMORY.md", doc("detail", `description: ${"x".repeat(121)}\n`));

    const report = await inspect({ recoveryRequired: true });

    expect(codes(report)).toContain("recovery_required");
    expect(codes(report)).toContain("placeholder_description");
    expect(codes(report)).toContain("description_too_long");
  });

  test("reports bounded truncation and typed oversized reads without failing health", async () => {
    await store.write("PROFILE.md", doc("root"));
    await store.write("misc/a/MEMORY.md", doc("body"));
    const summaries = await store.list();

    const truncated = await health({
      tx: {
        list: async () => summaries,
        read: (path) => store.read(path),
        readBounded: async (path) => ({ text: (await store.read(path))!, truncated: true }),
      },
      now: NOW,
    });
    expect(
      truncated.findings.filter((finding) => finding.code === "document_too_large"),
    ).toHaveLength(summaries.length);

    const oversized = await health({
      tx: {
        list: async () => summaries,
        read: (path) => store.read(path),
        readBounded: async (path) => {
          throw new MemoryStorageLimitError({
            kind: "document",
            identifier: path,
            actual: 20,
            maximum: 10,
          });
        },
      },
      now: NOW,
    });
    expect(codes(oversized)).toContain("document_too_large");
  });

  test("reports an expired-looking running job as stuck", async () => {
    const memory: Memory = createMemory({ store });
    await memory.enqueue({
      run_id: "exec_stuck",
      workspace: "/ws",
      status: "completed",
      started_at: 0,
      ended_at: 1,
      task: "do a thing",
      tool_calls: [],
    });
    await store.exclusive(async (tx) => {
      await tx.jobs.claim(0, { ms: 1, owner: "worker" });
    });

    const report = await health({ tx: store, now: NOW, jobs: store.jobs });

    expect(codes(report)).toContain("stuck_index_job");
  });

  test("marks content checks incomplete once the aggregate corpus bound is exhausted", async () => {
    const summaries = Array.from({ length: 18 }, (_, index) => ({
      path: `bulk/d${String(index)}/MEMORY.md`,
      kind: "memory" as const,
      description: "bulk document",
      tags: [],
      updated_at: NOW,
    }));
    const raw = `---\ndescription: bulk document\n---\n# Bulk\n${"x".repeat(2_000_000)}`;
    let firstRead = true;
    const report = await health({
      tx: {
        list: async () => summaries,
        read: async () => raw,
        readBounded: async () => {
          if (firstRead) {
            firstRead = false;
            throw new MemoryStorageLimitError({
              kind: "corpus",
              identifier: "reindex probe",
              actual: 2,
              maximum: 1,
            });
          }
          return { text: raw, truncated: false };
        },
      },
      now: NOW,
      config: { maxPerCode: 1 },
    });

    expect(report.truncated).toBeTrue();
    expect(report.skipped_codes).toContain("invalid_frontmatter");
    expect(report.skipped_codes).toContain("unknown_frontmatter_key");
  });
});

describe("pinned content in practice", () => {
  test("a tool refuses to overwrite or delete it, and says why", async () => {
    const store = createInMemoryMemoryStore({ clock: () => NOW });
    const memory = createMemory({ store });
    const pinnedDoc = doc("owner's own words", "description: d\npinned: true\n");
    await store.write("infra/bun/MEMORY.md", pinnedDoc);

    const write = await memory.tools
      .find((t) => t.name === "write_memory")!
      .execute({ path: "infra/bun/MEMORY.md", content: doc("replaced") });
    const remove = await memory.tools
      .find((t) => t.name === "delete_memory")!
      .execute({ path: "infra/bun/MEMORY.md" });

    expect(write.isError).toBe(true);
    expect(write.text).toContain("pinned");
    expect(remove.isError).toBe(true);
    expect(await store.read("infra/bun/MEMORY.md")).toBe(pinnedDoc);
  });

  test("a targeted edit still works", async () => {
    const store = createInMemoryMemoryStore();
    const memory = createMemory({ store });
    await store.write(
      "infra/bun/MEMORY.md",
      doc("pinned to 1.0", "description: d\npinned: true\n"),
    );

    const res = await memory.tools
      .find((t) => t.name === "edit_memory")!
      .execute({ path: "infra/bun/MEMORY.md", old_string: "1.0", new_string: "1.3.14" });

    expect(res.isError).toBe(false);
    expect(await store.read("infra/bun/MEMORY.md")).toContain("1.3.14");
  });
});
