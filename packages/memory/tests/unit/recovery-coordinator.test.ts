import { describe, expect, test } from "bun:test";

import { createRecoveryCoordinator } from "../../src/file-store/recovery.ts";
import { digestBody } from "../../src/revisions.ts";
import { MemoryStorageLimitError } from "../../src/storage-limits.ts";
import type { MemoryJournalRecord } from "../../src/journal.ts";

const limitError = (identifier: string) =>
  new MemoryStorageLimitError({ kind: "metadata", identifier, actual: 2, maximum: 1 });

const record = (batchId: string, path: string, expected: string | null, next: string) =>
  ({
    version: 1,
    batch_id: batchId,
    at: 1,
    source: { kind: "indexer", run_id: "run" },
    ops: [
      {
        op: "write",
        path,
        expected_digest: expected,
        next_digest: next,
        revision_id: expected === null ? null : "rev",
      },
    ],
    commit: {},
  }) satisfies MemoryJournalRecord;

describe("recovery coordinator bounds", () => {
  test("freezes writes when the journal catalog itself exceeds its bound", async () => {
    const coordinator = createRecoveryCoordinator({
      init: async () => {},
      journal: {
        listBatchIds: async () => {
          throw limitError("journal catalog");
        },
        read: async () => null,
        markerExists: async () => false,
        sweep: async () => {},
      },
      tree: {} as never,
      revisions: {} as never,
      runCommit: async () => {},
    });

    expect((await coordinator.recover()).required).toBeTrue();
    expect(() => coordinator.assertWritable()).toThrow(/journal-scan/);
  });

  test("continues past oversized records and documents while sweeping an absent record", async () => {
    const swept: string[] = [];
    const treeRecord = record("tree", "too-large/MEMORY.md", "old", "new");
    const coordinator = createRecoveryCoordinator({
      init: async () => {},
      journal: {
        listBatchIds: async () => ["record", "missing", "tree"],
        read: async (batchId) => {
          if (batchId === "record") throw limitError("record");
          if (batchId === "missing") return null;
          return treeRecord;
        },
        markerExists: async () => false,
        sweep: async (batchId) => {
          swept.push(batchId);
        },
      },
      tree: {
        read: async () => {
          throw limitError("document");
        },
      } as never,
      revisions: {} as never,
      runCommit: async () => {},
    });

    const report = await coordinator.recover();

    expect(report.entries.map((entry) => entry.outcome)).toEqual(["required", "swept", "required"]);
    expect(swept).toEqual(["missing"]);
  });

  test("rolls forward, rolls back a created file, and rejects an unreadable pre-image", async () => {
    const created = record("created", "new/MEMORY.md", null, digestBody("new body"));
    const forward = record("forward", "done/MEMORY.md", "old", digestBody("done body"));
    const unreadable = record("unreadable", "old/MEMORY.md", "old", digestBody("changed"));
    const deleted: string[] = [];
    const committed: unknown[] = [];
    const swept: string[] = [];
    const coordinator = createRecoveryCoordinator({
      init: async () => {},
      journal: {
        listBatchIds: async () => ["created", "forward", "unreadable"],
        read: async (batchId) =>
          batchId === "created" ? created : batchId === "forward" ? forward : unreadable,
        markerExists: async (batchId, marker) => batchId === "forward" && marker === "applied",
        sweep: async (batchId) => {
          swept.push(batchId);
        },
      },
      tree: {
        read: async (path: string) =>
          path === "new/MEMORY.md"
            ? "new body"
            : path === "done/MEMORY.md"
              ? "done body"
              : "changed",
        delete: async (path: string) => {
          deleted.push(path);
        },
      } as never,
      revisions: {
        read: async () => {
          throw limitError("revision");
        },
      } as never,
      runCommit: async (commit) => {
        committed.push(commit);
      },
    });

    const report = await coordinator.recover();

    expect(report.entries.map((entry) => entry.outcome)).toEqual([
      "rolled_back",
      "rolled_forward",
      "required",
    ]);
    expect(deleted).toEqual(["new/MEMORY.md"]);
    expect(committed).toHaveLength(1);
    expect(swept).toEqual(["created", "forward"]);
  });
});
