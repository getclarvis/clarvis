import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  mkdirSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  createJsonTraceStore,
  MAX_TRACE_RECOVERY_JOURNAL_BYTES,
  MAX_TRACE_RECOVERY_SCAN_ENTRIES,
  type JournalingTraceStore,
} from "@clarvis/trace";
import { createRunJournal, JOURNAL_VERSION } from "@clarvis/trace";
import { ownerSegment } from "@clarvis/paths";
import type { TraceEvent } from "@clarvis/capability";
import type { Logger } from "@clarvis/capability";
import { makeExecutionRecord } from "../helpers/execution-record.ts";
import {
  JOURNAL_OWNER as OWNER,
  JOURNAL_STARTED_AT as STARTED_AT,
  journalHeader as header,
  leadIteration,
} from "../helpers/journal-fixtures.ts";

const request = makeExecutionRecord({ id: "x", owner_key_name: OWNER }).request;

let dir: string;
let store: JournalingTraceStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarvis-journal-"));
  store = createJsonTraceStore({ dir });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function journalPath(id: string, startedAt = STARTED_AT): string {
  return join(dir, ownerSegment(OWNER), `${startedAt}.${ownerSegment(id)}.jsonl`);
}

function recordPath(id: string, startedAt = STARTED_AT): string {
  return join(dir, ownerSegment(OWNER), `${startedAt}.${ownerSegment(id)}.json`);
}

/** Ages a file past the store's one-hour orphan grace so recovery will consider it. */
function makeStale(path: string): void {
  const old = new Date(Date.now() - 7_200_000);
  utimesSync(path, old, old);
}

describe("createRunJournal", () => {
  it("writes a versioned header line and one line per appended event", () => {
    const path = join(dir, "solo.jsonl");
    const journal = createRunJournal({ path, header: header("exec-1") });
    journal.append(leadIteration(1, 10, 2));
    journal.append(null);
    journal.close();

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const parsedHeader = JSON.parse(lines[0]!) as { v: number; id: string };
    expect(parsedHeader.v).toBe(JOURNAL_VERSION);
    expect(parsedHeader.id).toBe("exec-1");
    expect((JSON.parse(lines[1]!) as TraceEvent).type).toBe("lead_iteration");
  });

  it("sanitizes the request it stamps into the header", () => {
    const path = join(dir, "secret.jsonl");
    const withSecret = {
      ...request,
      messages: [{ role: "user" as const, content: "key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA" }],
    };
    const journal = createRunJournal({
      path,
      header: { id: "exec-s", owner_key_name: OWNER, started_at: STARTED_AT, request: withSecret },
    });
    journal.close();
    expect(readFileSync(path, "utf8")).not.toContain("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA");
  });

  it("sanitizes and stamps host metadata beside the request", () => {
    const path = join(dir, "extension-profile.jsonl");
    const journal = createRunJournal({
      path,
      header: {
        ...header("exec-extension-profile"),
        host_metadata: {
          extension_profile: {
            id: "workspace:research",
            fingerprint: `sha256:${"a".repeat(64)}`,
          },
          token: "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA",
        },
      },
    });
    journal.close();
    const persisted = JSON.parse(readFileSync(path, "utf8")) as {
      host_metadata: Record<string, unknown>;
    };
    expect(persisted.host_metadata.extension_profile).toEqual({
      id: "workspace:research",
      fingerprint: `sha256:${"a".repeat(64)}`,
    });
    expect(JSON.stringify(persisted.host_metadata)).not.toContain(
      "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA",
    );
  });

  it("discard() removes the file", () => {
    const path = join(dir, "gone.jsonl");
    const journal = createRunJournal({ path, header: header("exec-2") });
    journal.discard();
    expect(existsSync(path)).toBe(false);
  });

  it("survives an unopenable path, logs once, and never throws", () => {
    const warnings: unknown[] = [];
    const logger = {
      warn: (o: unknown) => void warnings.push(o),
    } as unknown as Logger;
    const journal = createRunJournal({
      path: join(dir, "no-such-dir", "a.jsonl"),
      header: header("exec-3"),
      logger,
    });
    expect(() => {
      journal.append(leadIteration(1, 1, 1));
      journal.append(leadIteration(2, 1, 1));
      journal.close();
      journal.discard();
    }).not.toThrow();
    expect(warnings).toHaveLength(1);
  });

  it("ignores an append after close without logging a failure", () => {
    const warnings: unknown[] = [];
    const logger = {
      warn: (o: unknown) => void warnings.push(o),
    } as unknown as Logger;
    const path = join(dir, "closes.jsonl");
    const journal = createRunJournal({ path, header: header("exec-4"), logger });
    journal.close();
    journal.append(leadIteration(1, 1, 1));

    expect(warnings).toHaveLength(0);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
  });

  /**
   * The contract that matters most: a journal failure mid-run must disable the
   * journal, not propagate. A value `JSON.stringify` refuses (a BigInt) reaches
   * the same failure path a write error would, with the descriptor already open.
   */
  it("disables itself on a mid-run append failure and stays quiet after", () => {
    const warnings: unknown[] = [];
    const logger = {
      warn: (o: unknown) => void warnings.push(o),
    } as unknown as Logger;
    const path = join(dir, "poison.jsonl");
    const journal = createRunJournal({ path, header: header("exec-p"), logger });

    const unserializable = { type: "lead_iteration", iteration: 1n } as unknown as TraceEvent;
    expect(() => journal.append(unserializable)).not.toThrow();
    expect(warnings).toHaveLength(1);

    journal.append(leadIteration(2, 1, 1));
    expect(warnings).toHaveLength(1);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);

    expect(() => journal.close()).not.toThrow();
  });

  it("refuses to reopen an existing journal path", () => {
    const warnings: unknown[] = [];
    const logger = {
      warn: (o: unknown) => void warnings.push(o),
    } as unknown as Logger;
    const path = join(dir, "taken.jsonl");
    writeFileSync(path, "occupied\n");
    const journal = createRunJournal({ path, header: header("exec-5"), logger });
    journal.append(leadIteration(1, 1, 1));

    expect(warnings).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toBe("occupied\n");
  });
});

describe("TraceStore.recoverOrphans", () => {
  it("recovers a stale orphan once and is idempotent", async () => {
    const journal = store.openJournal({ header: header("exec-o") });
    journal.append(leadIteration(1, 42, 7));
    journal.close();
    makeStale(journalPath("exec-o"));

    expect((await store.recoverOrphans()).recovered).toBe(1);

    const restored = store.getById(OWNER, "exec-o");
    expect(restored?.status).toBe("interrupted");
    expect(restored?.total_input_tokens).toBe(42);
    expect(restored?.final_context).toBeUndefined();
    expect(restored?.recovery).toBeUndefined();

    expect((await store.recoverOrphans()).recovered).toBe(0);
    expect(existsSync(journalPath("exec-o"))).toBe(false);
  });

  it("persists how much of a damaged journal was lost, so the record says it is partial", async () => {
    const journal = store.openJournal({ header: header("exec-torn") });
    journal.append(leadIteration(1, 42, 7));
    journal.append({
      type: "tool_call_started",
      agent: "lead",
      call_id: "c1",
      iteration_ref: 1,
      started_at: STARTED_AT,
      mcp_name: "fs",
      tool_name: "write",
      arguments: {},
    });
    journal.close();
    const path = journalPath("exec-torn");
    writeFileSync(path, "not json at all\n", { flag: "a" });
    makeStale(path);

    expect((await store.recoverOrphans()).recovered).toBe(1);

    const restored = store.getById(OWNER, "exec-torn");
    expect(restored?.recovery).toEqual({ skipped_lines: 1, synthesized_tool_calls: 1 });
    expect(JSON.parse(readFileSync(recordPath("exec-torn"), "utf8")).recovery).toEqual({
      skipped_lines: 1,
      synthesized_tool_calls: 1,
    });
  });

  it("skips a journal whose run is still live", async () => {
    const journal = store.openJournal({ header: header("exec-live") });
    journal.append(leadIteration(1, 1, 1));
    makeStale(journalPath("exec-live"));

    expect((await store.recoverOrphans()).recovered).toBe(0);
    journal.close();
  });

  it("skips a journal younger than the orphan grace", async () => {
    const journal = store.openJournal({ header: header("exec-young") });
    journal.append(leadIteration(1, 1, 1));
    journal.close();

    expect((await store.recoverOrphans()).recovered).toBe(0);
    expect(existsSync(journalPath("exec-young"))).toBe(true);
  });

  it("skips a journal whose record already exists", async () => {
    const journal = store.openJournal({ header: header("exec-dup") });
    journal.append(leadIteration(1, 1, 1));
    journal.close();
    makeStale(journalPath("exec-dup"));
    await store.insert(
      makeExecutionRecord({ id: "exec-dup", owner_key_name: OWNER, started_at: STARTED_AT }),
    );

    expect((await store.recoverOrphans()).recovered).toBe(0);
    expect(store.getById(OWNER, "exec-dup")?.status).toBe("completed");
  });

  it("quarantines a corrupt header instead of deleting it", async () => {
    const journal = store.openJournal({ header: header("exec-bad") });
    journal.close();
    const path = journalPath("exec-bad");
    writeFileSync(path, "{ truncated");
    makeStale(path);

    expect((await store.recoverOrphans()).recovered).toBe(0);
    expect(existsSync(path)).toBe(false);
    const names = readdirSync(join(dir, ownerSegment(OWNER)));
    expect(names.some((n) => n.endsWith(".jsonl.corrupt"))).toBe(true);
  });

  it("quarantines an oversized sparse journal before reading its body", async () => {
    const journal = store.openJournal({ header: header("exec-oversized") });
    journal.close();
    const path = journalPath("exec-oversized");
    truncateSync(path, MAX_TRACE_RECOVERY_JOURNAL_BYTES + 1);
    makeStale(path);

    expect((await store.recoverOrphans()).recovered).toBe(0);
    expect(existsSync(path)).toBe(false);
    const names = readdirSync(join(dir, ownerSegment(OWNER)));
    expect(names.some((name) => name.endsWith(".jsonl.oversized"))).toBe(true);
  });

  it("repairs an unsettled tool call while recovering", async () => {
    const journal = store.openJournal({ header: header("exec-tool") });
    journal.append({
      type: "tool_call_started",
      agent: "lead",
      call_id: "c9",
      iteration_ref: 1,
      started_at: STARTED_AT,
      mcp_name: "fs",
      tool_name: "write",
      arguments: {},
    });
    journal.close();
    makeStale(journalPath("exec-tool"));

    expect((await store.recoverOrphans()).recovered).toBe(1);
    const events = store.getById(OWNER, "exec-tool")?.trace.events ?? [];
    const settled = events.filter((e) => e.type === "tool_call");
    expect(settled).toHaveLength(1);
    expect((settled[0] as Extract<TraceEvent, { type: "tool_call" }>).error).toContain(
      "was not completed",
    );
  });

  it("returns 0 when the store has never been written to", async () => {
    expect((await store.recoverOrphans()).recovered).toBe(0);
  });

  it("bounds root-directory examination and leaves the backlog intact for a later pass", async () => {
    for (let index = 0; index < 16; index += 1) {
      mkdirSync(join(dir, `budget-owner-${String(index).padStart(2, "0")}`), { recursive: true });
    }
    // Select the filesystem iterator's actual final entry rather than assuming
    // lexical or insertion order (ext4 hash order differs from both).
    const backlogOwner = readdirSync(dir).at(-1)!;
    const path = join(dir, backlogOwner, `${STARTED_AT}.${ownerSegment("exec-budget")}.jsonl`);
    const journal = createRunJournal({
      path,
      header: { ...header("exec-budget"), owner_key_name: backlogOwner },
    });
    journal.append(leadIteration(1, 5, 1));
    journal.close();
    makeStale(path);
    const limited = createJsonTraceStore({ dir, maxRecoveryScanEntries: 1 });

    expect((await limited.recoverOrphans()).recovered).toBe(0);
    expect(existsSync(path)).toBe(true);

    const laterPass = createJsonTraceStore({
      dir,
      maxRecoveryScanEntries: MAX_TRACE_RECOVERY_SCAN_ENTRIES,
    });
    expect((await laterPass.recoverOrphans()).recovered).toBe(1);
    expect(laterPass.getById(backlogOwner, "exec-budget")?.total_input_tokens).toBe(5);
    expect(existsSync(path)).toBe(false);
  });
});

describe("journals and the record namespace", () => {
  it("stays invisible to list, getById and the owner index", async () => {
    await store.insert(
      makeExecutionRecord({ id: "real", owner_key_name: OWNER, started_at: STARTED_AT }),
    );
    const journal = store.openJournal({ header: header("exec-hidden") });
    journal.append(leadIteration(1, 1, 1));

    expect(store.list(OWNER, 50, 0).total).toBe(1);
    expect(store.getById(OWNER, "exec-hidden")).toBeNull();
    expect(store.existsForOwner(OWNER, "exec-hidden")).toBe(false);
    journal.discard();
    expect(existsSync(journalPath("exec-hidden"))).toBe(false);
  });

  it("cleanup sweeps a stale orphan journal but spares a live one", () => {
    const stale = store.openJournal({ header: header("exec-stale") });
    stale.close();
    makeStale(journalPath("exec-stale"));

    const live = store.openJournal({ header: header("exec-open", STARTED_AT + 1) });
    makeStale(journalPath("exec-open", STARTED_AT + 1));

    expect(store.cleanup(Date.now(), 50)).toBe(1);
    expect(existsSync(journalPath("exec-stale"))).toBe(false);
    expect(existsSync(journalPath("exec-open", STARTED_AT + 1))).toBe(true);
    live.close();
  });
});

describe("journal file permissions", () => {
  it("creates the journal owner-only", () => {
    const journal = store.openJournal({ header: header("exec-perm") });
    journal.close();
    expect(statSync(journalPath("exec-perm")).mode & 0o777).toBe(0o600);
  });
});

describe("journals vs the retention sweep", () => {
  /**
   * REGRESSION: `cleanup` used to age journals on the same one-hour orphan
   * grace that makes them *eligible for recovery*, so a boot sweep deleted
   * exactly the set `recoverOrphans` exists to read — silently disabling crash
   * recovery for any operator who configured a TTL.
   */
  it("does not sweep a recoverable journal just because it passed the orphan grace", () => {
    const recent = Date.now() - 7_200_000;
    const journal = store.openJournal({ header: header("exec-recoverable", recent) });
    journal.append(leadIteration(1, 1, 1));
    journal.close();
    makeStale(journalPath("exec-recoverable", recent));

    expect(store.cleanup(Date.now() - 86_400_000, 50)).toBe(0);
    expect(existsSync(journalPath("exec-recoverable", recent))).toBe(true);
  });

  it("still sweeps a journal older than the retention cutoff", () => {
    const ancient = STARTED_AT - 400 * 86_400_000;
    const journal = store.openJournal({ header: header("exec-ancient", ancient) });
    journal.close();

    expect(store.cleanup(Date.now() - 86_400_000, 50)).toBe(1);
    expect(existsSync(journalPath("exec-ancient", ancient))).toBe(false);
  });
});

describe("recoverOrphans — a journal whose writer is still alive", () => {
  /**
   * The in-process live-set only covers journals this process opened. A sibling
   * process sharing the trace dir would otherwise fold a live-but-parked run
   * into an `interrupted` record and delete its journal, and the real run would
   * then fail to persist at all with an id conflict.
   */
  it("skips a journal claimed by a different, running process on this host", async () => {
    const path = journalPath("exec-alive");
    mkdirSync(join(dir, ownerSegment(OWNER)), { recursive: true });
    const head = JSON.stringify({
      ...header("exec-alive"),
      v: JOURNAL_VERSION,
      writer: { pid: process.ppid, host: hostname() },
    });
    writeFileSync(path, `${head}\n${JSON.stringify(leadIteration(1, 1, 1))}\n`);
    makeStale(path);

    expect((await store.recoverOrphans()).recovered).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it("recovers one whose writer is gone", async () => {
    const path = journalPath("exec-dead-writer");
    const head = JSON.stringify({
      ...header("exec-dead-writer"),
      v: JOURNAL_VERSION,
      writer: { pid: 2_147_483_646, host: hostname() },
    });
    mkdirSync(join(dir, ownerSegment(OWNER)), { recursive: true });
    writeFileSync(path, `${head}\n${JSON.stringify(leadIteration(1, 9, 1))}\n`);
    makeStale(path);

    expect((await store.recoverOrphans()).recovered).toBe(1);
    expect(store.getById(OWNER, "exec-dead-writer")?.total_input_tokens).toBe(9);
  });
});
