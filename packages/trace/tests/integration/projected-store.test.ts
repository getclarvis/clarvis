import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistenceError } from "@clarvis/capability";
import type { TraceEvent } from "@clarvis/capability";
import { createJsonTraceStore, projectTraceStoreWrites } from "@clarvis/trace";
import type { TraceWriteProjection } from "@clarvis/trace";
import { createMemoryTraceStore } from "../../src/testing.ts";
import { makeExecutionRecord } from "../helpers/execution-record.ts";
import { journalHeader, leadIteration, JOURNAL_OWNER } from "../helpers/journal-fixtures.ts";
import { recordingLogger, type LogRecord } from "../helpers/logger.ts";

const sentinel = "PRIVATE_CASE_SENTINEL";
const safe = makeExecutionRecord({ id: "case", owner_key_name: JOURNAL_OWNER });
const safeEvent = leadIteration(1, 2, 3);
const projection: TraceWriteProjection = {
  header: (header) => ({
    visibility: header.visibility,
    id: header.id,
    owner_key_name: header.owner_key_name,
    started_at: header.started_at,
    request: safe.request,
  }),
  event: () => safeEvent,
  record: () => safe,
  context: () => [],
};

test("every payload-bearing write reaches disk only after its projection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clarvis-projected-store-"));
  try {
    const physical = createJsonTraceStore({ dir });
    const store = projectTraceStoreWrites(physical, projection);
    const raw = makeExecutionRecord({
      id: "case",
      owner_key_name: JOURNAL_OWNER,
      request: { ...safe.request, messages: [{ role: "user", content: sentinel }] },
      response: { status: "completed", usage: safe.response.usage, result: sentinel },
      trace: { events: [{ ...safeEvent, response: sentinel } as TraceEvent] },
      capability_state: { private: sentinel },
      host_metadata: { private: sentinel },
    });
    const journal = store.openJournal!({
      header: {
        ...journalHeader(raw.id),
        request: raw.request,
        host_metadata: { private: sentinel },
      },
    });
    journal.append(raw.trace.events[0]!);
    journal.append(null);
    journal.close();
    await store.insert(raw);
    await store.replaceFinalContext(JOURNAL_OWNER, raw.id, [
      {
        message: { role: "user", content: sentinel },
        evictable: true,
        summary: false,
        canonical: true,
      },
    ]);
    expect(store.getById(JOURNAL_OWNER, raw.id)?.final_context).toEqual([]);
    expect(store.getById(JOURNAL_OWNER, raw.id)?.request).toEqual(safe.request);
    expect(store.list(JOURNAL_OWNER, 10, 0).total).toBe(1);
    expect(store.listAcrossOwners!(10, 0).total).toBe(1);
    expect(store.existsForOwner(JOURNAL_OWNER, raw.id)).toBe(true);
    const bodies = readdirSync(join(dir, JOURNAL_OWNER))
      .filter((file) => /\.(json|jsonl)$/.test(file))
      .map((file) => readFileSync(join(dir, JOURNAL_OWNER, file), "utf8"));
    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(body).not.toContain(sentinel);
    expect(raw.request.messages[0]!.content).toBe(sentinel);
    expect(store.deleteById(JOURNAL_OWNER, raw.id)).toBe(true);
    journal.discard();
    expect(store.deleteOwner(JOURNAL_OWNER)).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("header projection fails before creating a journal and never leaks exception prose", () => {
  const dir = mkdtempSync(join(tmpdir(), "clarvis-projected-header-"));
  try {
    const store = projectTraceStoreWrites(createJsonTraceStore({ dir }), {
      ...projection,
      header() {
        throw new Error(sentinel);
      },
    });
    expect(() => store.openJournal!({ header: journalHeader("case") })).toThrow(
      "Trace write projection failed.",
    );
    expect(readdirSync(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("record and replacement projection errors reject without a raw write", async () => {
  const physical = createMemoryTraceStore();
  const store = projectTraceStoreWrites(physical, {
    ...projection,
    record() {
      throw new Error(sentinel);
    },
    context() {
      throw new Error(sentinel);
    },
  });
  await expect(store.insert(safe)).rejects.toBeInstanceOf(PersistenceError);
  expect(physical.existsForOwner(JOURNAL_OWNER, safe.id)).toBe(false);
  await physical.insert(safe);
  await expect(store.replaceFinalContext(JOURNAL_OWNER, safe.id, [])).rejects.toThrow(
    "Trace write projection failed.",
  );
  expect(physical.getById(JOURNAL_OWNER, safe.id)?.final_context).toBeUndefined();
  expect(typeof store.openJournal).toBe("undefined");
  expect(typeof store.recoverOrphans).toBe("undefined");
});

test("a failed event projection disables its journal once without raw fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clarvis-projected-event-"));
  const logs: LogRecord[] = [];
  try {
    let calls = 0;
    const store = projectTraceStoreWrites(createJsonTraceStore({ dir }), {
      ...projection,
      event() {
        calls++;
        throw new Error(sentinel);
      },
    });
    const journal = store.openJournal!({
      header: journalHeader("case"),
      logger: recordingLogger(logs),
    });
    journal.append(safeEvent);
    journal.append(safeEvent);
    expect(calls).toBe(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.fields.event).toBe("trace.journal_projection_failed");
    expect(JSON.stringify(logs)).not.toContain(sentinel);
    const path = join(dir, JOURNAL_OWNER, `${safe.started_at}.case.jsonl`);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
    await store.insert(safe);
    journal.discard();
    expect(store.getById(JOURNAL_OWNER, "case")).not.toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recovery sees only the already-projected orphan journal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clarvis-projected-recovery-"));
  try {
    const store = projectTraceStoreWrites(createJsonTraceStore({ dir }), projection);
    const journal = store.openJournal!({
      header: {
        ...journalHeader("orphan"),
        request: { ...safe.request, messages: [{ role: "user", content: sentinel }] },
      },
    });
    journal.append({ ...safeEvent, response: sentinel } as TraceEvent);
    journal.close();
    const path = join(dir, JOURNAL_OWNER, `${safe.started_at}.orphan.jsonl`);
    const age = new Date(Date.now() - 7_200_000);
    utimesSync(path, age, age);
    await store.recoverOrphans!();
    const recovered = store.getById(JOURNAL_OWNER, "orphan");
    expect(recovered?.status).toBe("interrupted");
    expect(JSON.stringify(recovered)).not.toContain(sentinel);
    expect(recovered?.request).toEqual(safe.request);
    expect(recovered?.trace.events).toEqual([safeEvent]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
