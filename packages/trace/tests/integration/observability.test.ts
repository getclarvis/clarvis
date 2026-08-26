import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonTraceStore, type JournalingTraceStore } from "@clarvis/trace";
import { acquireLocalLeaseSync, ownerSegment } from "@clarvis/paths";
import { makeExecutionRecord } from "../helpers/execution-record.ts";
import {
  JOURNAL_OWNER,
  JOURNAL_STARTED_AT as STARTED_AT,
  journalHeader as header,
  leadIteration,
} from "../helpers/journal-fixtures.ts";
import { eventsNamed, oneEvent, recordingLogger, type LogRecord } from "../helpers/logger.ts";

const OWNER = "alice";

let dir: string;
let records: LogRecord[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarvis-trace-log-"));
  records = [];
});
afterEach(() => {
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

function open(over: Record<string, unknown> = {}): JournalingTraceStore {
  return createJsonTraceStore({ dir, logger: recordingLogger(records), ...over });
}

function ownerDir(owner: string): string {
  return join(dir, ownerSegment(owner));
}

function recordPath(owner: string, id: string, startedAt: number): string {
  return join(ownerDir(owner), `${startedAt}.${ownerSegment(id)}.json`);
}

function sidecarPath(owner: string, id: string, startedAt: number): string {
  return join(ownerDir(owner), `${startedAt}.${ownerSegment(id)}.summary`);
}

function makeStale(path: string): void {
  const old = new Date(Date.now() - 7_200_000);
  utimesSync(path, old, old);
}

describe("json-trace-store — a refused insert", () => {
  it("reports the phase a conflicting id failed in", async () => {
    const store = open();
    await store.insert(makeExecutionRecord({ id: "dup", owner_key_name: OWNER, started_at: 10 }));
    records.length = 0;

    await expect(
      store.insert(makeExecutionRecord({ id: "dup", owner_key_name: OWNER, started_at: 20 })),
    ).rejects.toThrow();

    const failed = oneEvent(records, "trace.insert_failed");
    expect(failed.level).toBe("error");
    expect(failed.fields).toMatchObject({
      execution_id: "dup",
      owner_key_name: OWNER,
      phase: "lease",
    });
    expect(failed.fields.cause).toBeString();
  });

  it("reports a body the store refused to write as a write-phase failure", async () => {
    const store = open({ maxRecordBytes: 1 });

    await expect(
      store.insert(makeExecutionRecord({ id: "huge", owner_key_name: OWNER, started_at: 30 })),
    ).rejects.toThrow();

    expect(oneEvent(records, "trace.insert_failed").fields).toMatchObject({
      execution_id: "huge",
      phase: "write",
    });
  });

  it("reports a live deletion as a generation-phase failure", async () => {
    const seg = ownerSegment(OWNER);
    mkdirSync(join(dir, ".locks"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dir, ".locks", `${seg}.delete-generation`),
      JSON.stringify({ version: 1, state: "deleting", generation: "g1" }),
    );
    const held = acquireLocalLeaseSync(join(dir, ".locks", `${seg}.delete-lease`), { staleMs: 0 });
    expect(held).not.toBeNull();
    const store = open();

    try {
      await expect(
        store.insert(makeExecutionRecord({ id: "blocked", owner_key_name: OWNER, started_at: 40 })),
      ).rejects.toThrow();
    } finally {
      held!.release();
    }

    expect(oneEvent(records, "trace.insert_failed").fields).toMatchObject({
      execution_id: "blocked",
      phase: "generation",
    });
  });

  it("names the deleted owner when a write is rolled back mid-insert", async () => {
    const store = open();
    const startedAt = 50;
    const finalPath = recordPath(OWNER, "straddler", startedAt);
    const statePath = join(dir, ".locks", `${ownerSegment(OWNER)}.delete-generation`);
    let flipped = false;
    const flip = async (): Promise<void> => {
      for (let attempt = 0; attempt < 20_000 && !flipped; attempt += 1) {
        if (existsSync(finalPath)) {
          writeFileSync(
            statePath,
            JSON.stringify({ version: 1, state: "deleting", generation: "g2" }),
          );
          flipped = true;
          return;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    };

    const inserting = store.insert(
      makeExecutionRecord({ id: "straddler", owner_key_name: OWNER, started_at: startedAt }),
    );
    const [outcome] = await Promise.all([
      inserting.then(() => "ok" as const).catch(() => "no"),
      flip(),
    ]);

    expect(flipped).toBe(true);
    expect(outcome).toBe("no");
    const aborted = oneEvent(records, "trace.insert_aborted_deleted_owner");
    expect(aborted.level).toBe("warn");
    expect(aborted.fields).toMatchObject({
      execution_id: "straddler",
      owner_key_name: OWNER,
      generation: "",
    });
    expect(oneEvent(records, "trace.insert_failed").fields.phase).toBe("generation");
    expect(existsSync(finalPath)).toBe(false);
  });
});

describe("json-trace-store — a listing that silently under-returns", () => {
  it("names a corrupt record dropped from an owner page", async () => {
    const store = open();
    await store.insert(
      makeExecutionRecord({ id: "rotten", owner_key_name: OWNER, started_at: 100 }),
    );
    rmSync(sidecarPath(OWNER, "rotten", 100));
    writeFileSync(recordPath(OWNER, "rotten", 100), "{ not json");
    records.length = 0;

    expect(store.list(OWNER, 10, 0)).toEqual({ items: [], total: 1 });

    const dropped = oneEvent(records, "trace.record_unreadable");
    expect(dropped.level).toBe("warn");
    expect(dropped.fields).toMatchObject({
      owner_key_name: OWNER,
      reason: "corrupt",
      path: recordPath(OWNER, "rotten", 100),
    });
  });

  it("names an oversized record dropped from both listings", async () => {
    const seeded = open();
    await seeded.insert(makeExecutionRecord({ id: "fat", owner_key_name: OWNER, started_at: 110 }));
    rmSync(sidecarPath(OWNER, "fat", 110));
    records.length = 0;
    const bounded = open({ maxRecordBytes: 1 });

    expect(bounded.list(OWNER, 10, 0)).toEqual({ items: [], total: 1 });
    expect(bounded.listAcrossOwners!(10, 0)).toEqual({ items: [], total: 1 });

    const dropped = eventsNamed(records, "trace.record_unreadable");
    expect(dropped).toHaveLength(2);
    for (const row of dropped) {
      expect(row.fields).toMatchObject({
        reason: "too_large",
        path: recordPath(OWNER, "fat", 110),
      });
    }
  });

  it("names a corrupt record dropped from the cross-owner page", async () => {
    const store = open();
    await store.insert(
      makeExecutionRecord({ id: "rotten", owner_key_name: OWNER, started_at: 120 }),
    );
    rmSync(sidecarPath(OWNER, "rotten", 120));
    writeFileSync(recordPath(OWNER, "rotten", 120), "{ not json");
    records.length = 0;

    expect(store.listAcrossOwners!(10, 0)).toEqual({ items: [], total: 1 });

    expect(oneEvent(records, "trace.record_unreadable").fields).toMatchObject({
      owner_key_name: ownerSegment(OWNER),
      reason: "corrupt",
    });
  });
});

describe("json-trace-store — a listing optimization that was lost", () => {
  it("reports a sidecar too large to write", async () => {
    const store = open({ maxSummaryBytes: 1 });

    await store.insert(makeExecutionRecord({ id: "wide", owner_key_name: OWNER, started_at: 200 }));

    const lost = oneEvent(records, "trace.sidecar_write_failed");
    expect(lost.level).toBe("debug");
    expect(lost.fields).toMatchObject({ owner_key_name: OWNER, filename: "200.wide.json" });
    expect(lost.fields.cause).toContain("exceeds");
  });

  it("reports a sidecar the filesystem refused", async () => {
    mkdirSync(sidecarPath(OWNER, "blocked", 210), { recursive: true });
    const store = open();

    await store.insert(
      makeExecutionRecord({ id: "blocked", owner_key_name: OWNER, started_at: 210 }),
    );

    expect(oneEvent(records, "trace.sidecar_write_failed").fields.filename).toBe(
      "210.blocked.json",
    );
  });
});

describe("json-trace-store — an owner index that stopped fitting", () => {
  it("names the owner an LRU eviction dropped", async () => {
    const store = open({ maxOwnerIndexes: 1 });

    await store.insert(makeExecutionRecord({ id: "a", owner_key_name: "alice", started_at: 300 }));
    await store.insert(makeExecutionRecord({ id: "b", owner_key_name: "bob", started_at: 310 }));

    const evicted = eventsNamed(records, "trace.owner_index_evicted");
    expect(evicted.map((r) => r.fields.reason)).toContain("lru");
    expect(evicted.some((r) => r.fields.owner_key_name === "alice")).toBe(true);
  });

  it("names an owner past the per-index entry cap", async () => {
    const store = open({ maxOwnerIndexEntries: 1 });

    await store.insert(makeExecutionRecord({ id: "one", owner_key_name: OWNER, started_at: 320 }));
    await store.insert(makeExecutionRecord({ id: "two", owner_key_name: OWNER, started_at: 330 }));

    expect(oneEvent(records, "trace.owner_index_evicted").fields).toMatchObject({
      owner_key_name: OWNER,
      reason: "entry_cap",
    });
  });

  it("allocates nothing for the eviction line when debug is off", async () => {
    const quiet: LogRecord[] = [];
    const store = createJsonTraceStore({
      dir,
      maxOwnerIndexEntries: 1,
      logger: recordingLogger(quiet, "info"),
    });

    await store.insert(makeExecutionRecord({ id: "one", owner_key_name: OWNER, started_at: 340 }));
    await store.insert(makeExecutionRecord({ id: "two", owner_key_name: OWNER, started_at: 350 }));

    expect(eventsNamed(quiet, "trace.owner_index_evicted")).toEqual([]);
  });
});

describe("json-trace-store — what crash recovery could not do", () => {
  function orphan(store: JournalingTraceStore, id: string, lines: string[] = []): string {
    const journal = store.openJournal({ header: header(id) });
    journal.append(leadIteration(1, 1, 1));
    journal.close();
    const path = join(dir, ownerSegment(JOURNAL_OWNER), `${STARTED_AT}.${ownerSegment(id)}.jsonl`);
    for (const line of lines) writeFileSync(path, `${line}\n`, { flag: "a" });
    makeStale(path);
    return path;
  }

  it("always reports how the pass ended", async () => {
    const store = open();

    const report = await store.recoverOrphans();

    expect(report).toEqual({
      recovered: 0,
      examined: 0,
      quarantined: 0,
      degraded: 0,
      exhausted: false,
    });
    const done = oneEvent(records, "trace.recovery_completed");
    expect(done.level).toBe("info");
    expect(done.fields).toMatchObject(report);
  });

  it("counts a journal it could set aside, and says where", async () => {
    const store = open();
    const path = orphan(store, "exec-bad");
    writeFileSync(path, "{ truncated\n");
    makeStale(path);

    const report = await store.recoverOrphans();

    expect(report).toMatchObject({ recovered: 0, examined: 1, quarantined: 1, exhausted: false });
    const set = oneEvent(records, "trace.journal_quarantined");
    expect(set.level).toBe("warn");
    expect(set.fields).toMatchObject({ path, reason: "bad_header", renamed: true });
    expect(set.fields.size_bytes).toBeGreaterThan(0);
  });

  it("says when the quarantine rename itself failed", async () => {
    const store = open();
    const path = orphan(store, "exec-stuck");
    writeFileSync(path, "{ truncated\n");
    makeStale(path);
    chmodSync(ownerDir(JOURNAL_OWNER), 0o500);

    let report;
    try {
      report = await store.recoverOrphans();
    } finally {
      chmodSync(ownerDir(JOURNAL_OWNER), 0o700);
    }

    expect(report.quarantined).toBe(1);
    expect(oneEvent(records, "trace.journal_quarantined").fields.renamed).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  it("reports an oversized journal by its size, without reading it", async () => {
    const store = open();
    const path = orphan(store, "exec-huge");
    truncateSync(path, 32 * 1024 * 1024 + 1);
    makeStale(path);

    await store.recoverOrphans();

    expect(oneEvent(records, "trace.journal_quarantined").fields).toMatchObject({
      reason: "oversized",
      size_bytes: 32 * 1024 * 1024 + 1,
      renamed: true,
    });
  });

  it("says a recovered run is incomplete, and how", async () => {
    const store = open();
    const path = orphan(store, "exec-torn", ["not json at all"]);
    writeFileSync(
      path,
      `${JSON.stringify({
        type: "tool_call_started",
        agent: "lead",
        call_id: "c1",
        iteration_ref: 1,
        started_at: STARTED_AT,
        mcp_name: "fs",
        tool_name: "write",
        arguments: {},
      })}\n`,
      { flag: "a" },
    );
    makeStale(path);

    const report = await store.recoverOrphans();

    expect(report).toMatchObject({ recovered: 1, degraded: 1 });
    const damaged = oneEvent(records, "trace.journal_recovery_degraded");
    expect(damaged.level).toBe("warn");
    expect(damaged.fields).toMatchObject({
      execution_id: "exec-torn",
      skipped_lines: 1,
      synthesized_tool_calls: 1,
    });
    expect(damaged.fields.events).toBe(3);
  });

  it("stays quiet about a journal that recovered intact", async () => {
    const store = open();
    orphan(store, "exec-clean");

    const report = await store.recoverOrphans();

    expect(report).toMatchObject({ recovered: 1, degraded: 0 });
    expect(eventsNamed(records, "trace.journal_recovery_degraded")).toEqual([]);
  });

  it("names the scan budget that stopped the pass", async () => {
    const seeded = open();
    orphan(seeded, "exec-backlog");
    for (let index = 0; index < 8; index += 1) {
      mkdirSync(join(dir, `filler-${String(index)}`), { recursive: true });
    }
    records.length = 0;
    const limited = open({ maxRecoveryScanEntries: 1 });

    const report = await limited.recoverOrphans();

    expect(report.exhausted).toBe(true);
    expect(oneEvent(records, "trace.recovery_budget_exhausted").fields).toMatchObject({
      limit: "scan_entries",
      examined: 0,
      recovered: 0,
    });
    expect(oneEvent(records, "trace.recovery_completed").fields.exhausted).toBe(true);
  });

  it("names the byte budget that stopped the pass", async () => {
    const store = open();
    const seg = ownerSegment(JOURNAL_OWNER);
    mkdirSync(join(dir, seg), { recursive: true, mode: 0o700 });
    for (const [index, size] of [32 * 1024 * 1024, 32 * 1024 * 1024, 64].entries()) {
      const path = join(dir, seg, `${STARTED_AT + index}.${ownerSegment(`big-${index}`)}.jsonl`);
      writeFileSync(path, "not-a-header\n");
      truncateSync(path, size);
      makeStale(path);
    }

    const report = await store.recoverOrphans();

    expect(report.exhausted).toBe(true);
    expect(oneEvent(records, "trace.recovery_budget_exhausted").fields).toMatchObject({
      limit: "total_bytes",
    });
  });

  it("names the journal budget that stopped the pass", async () => {
    const store = open();
    for (const owner of ["one", "two", "three"]) {
      const seg = ownerSegment(`owner-${owner}`);
      mkdirSync(join(dir, seg), { recursive: true, mode: 0o700 });
      for (let index = 0; index < 50; index += 1) {
        const path = join(dir, seg, `${STARTED_AT + index}.${ownerSegment("j")}.jsonl`);
        writeFileSync(path, "not-a-header\n");
        makeStale(path);
      }
    }

    const report = await store.recoverOrphans();

    expect(report.examined).toBe(100);
    expect(report.exhausted).toBe(true);
    expect(oneEvent(records, "trace.recovery_budget_exhausted").fields).toMatchObject({
      limit: "journals",
      examined: 100,
    });
  });
});

describe("json-trace-store — what a cleanup pass removed", () => {
  it("splits records, journals, leases and temp orphans into the caller's counters", async () => {
    const store = open();
    await store.insert(makeExecutionRecord({ id: "old", owner_key_name: OWNER, started_at: 1 }));
    const journal = store.openJournal({ header: header("exec-swept") });
    journal.append(leadIteration(1, 1, 1));
    journal.close();
    mkdirSync(join(dir, ".locks"), { recursive: true, mode: 0o700 });
    const stale = join(dir, ".locks", `${ownerSegment(OWNER)}.stale.lock`);
    writeFileSync(stale, JSON.stringify({ pid: 1, host: "nowhere" }));
    const old = new Date(Date.now() - 7_200_000);
    utimesSync(stale, old, old);

    const counters = { records: 0, journals: 0, leases: 0, tmp: 0 };
    const deleted = store.cleanup(Date.now(), 100, counters);

    expect(counters.records).toBe(1);
    expect(counters.journals).toBe(1);
    expect(counters.leases).toBe(1);
    expect(deleted).toBe(counters.records + counters.journals + counters.leases + counters.tmp);
  });
});
