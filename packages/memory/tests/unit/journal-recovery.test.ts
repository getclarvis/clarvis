import { describe, expect, test } from "bun:test";

import { decideRecovery, type MemoryJournalRecord } from "../../src/journal.ts";

const LEAF = "infra/bun/MEMORY.md";

/**
 * Build a journal record by hand, as a crashed process would have left one.
 *
 * A "crash" for the file backend is simply constructing this state on disk and
 * then opening a fresh store over the same root: that exercises the reopen
 * invariant directly, with no fault-injection hook in production code.
 */
function record(partial: Partial<MemoryJournalRecord> = {}): MemoryJournalRecord {
  return {
    version: 1,
    batch_id: "b1",
    at: 1_700_000_000_000,
    source: { kind: "indexer", run_id: "run-1" },
    ops: [],
    commit: {},
    ...partial,
  };
}

describe("decideRecovery", () => {
  const base = record({
    ops: [
      {
        op: "write",
        path: LEAF,
        expected_digest: "old",
        next_digest: "new",
        revision_id: "rev-1",
      },
    ],
  });

  test("sweeps a batch that already committed", () => {
    expect(
      decideRecovery({
        markers: { applied: true, committed: true },
        record: base,
        current: new Map([[LEAF, "new"]]),
      }).outcome,
    ).toBe("swept");
  });

  test("rolls forward past the applied marker rather than discarding good work", () => {
    // Every write landed; only the follow-up work was interrupted. Rolling
    // back here would throw away a correct result and pay for another model call.
    expect(
      decideRecovery({
        markers: { applied: true, committed: false },
        record: base,
        current: new Map([[LEAF, "new"]]),
      }).outcome,
    ).toBe("rolled_forward");
  });

  test("rolls back when no write had landed", () => {
    expect(
      decideRecovery({
        markers: { applied: false, committed: false },
        record: base,
        current: new Map([[LEAF, "old"]]),
      }).outcome,
    ).toBe("rolled_back");
  });

  test("rolls back mid-apply, which is the case it exists for", () => {
    // "every digest still matches expected" would make recovery a no-op exactly
    // here; accepting expected-or-next is what makes a half-applied batch
    // recoverable while still proving nobody else touched the tree.
    const two = record({
      ops: [
        {
          op: "write",
          path: "a/b/MEMORY.md",
          expected_digest: "oldA",
          next_digest: "newA",
          revision_id: "r1",
        },
        {
          op: "write",
          path: "c/d/MEMORY.md",
          expected_digest: "oldB",
          next_digest: "newB",
          revision_id: "r2",
        },
      ],
    });
    expect(
      decideRecovery({
        markers: { applied: false, committed: false },
        record: two,
        current: new Map([
          ["a/b/MEMORY.md", "newA"],
          ["c/d/MEMORY.md", "oldB"],
        ]),
      }).outcome,
    ).toBe("rolled_back");
  });

  test("refuses when a human edited a touched document meanwhile", () => {
    const decision = decideRecovery({
      markers: { applied: false, committed: false },
      record: base,
      current: new Map([[LEAF, "a-third-digest"]]),
    });
    expect(decision.outcome).toBe("required");
    expect(decision.reason).toContain("modified outside the store");
  });

  test("refuses a journal written by a newer version", () => {
    expect(
      decideRecovery({
        markers: { applied: false, committed: false },
        record: record({ version: 99 }),
        current: new Map(),
      }).outcome,
    ).toBe("required");
  });

  test("refuses to roll back an op whose pre-image was never captured", () => {
    const orphan = record({
      ops: [
        { op: "write", path: LEAF, expected_digest: "old", next_digest: "new", revision_id: null },
      ],
    });
    expect(
      decideRecovery({
        markers: { applied: false, committed: false },
        record: orphan,
        current: new Map([[LEAF, "new"]]),
      }).outcome,
    ).toBe("required");
  });

  test("accepts a derived op whose pre-image rides in the journal", () => {
    const derived = record({
      ops: [
        {
          op: "write",
          path: "PROFILE.md",
          expected_digest: "old",
          next_digest: "new",
          revision_id: null,
          previous_body: "the old profile\n",
        },
      ],
    });
    expect(
      decideRecovery({
        markers: { applied: false, committed: false },
        record: derived,
        current: new Map([["PROFILE.md", "new"]]),
      }).outcome,
    ).toBe("rolled_back");
  });
});
