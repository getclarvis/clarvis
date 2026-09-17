import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonTraceStore, createTraceVisibilityView, JOURNAL_VERSION } from "@clarvis/trace";
import { createMemoryTraceStore } from "../../src/testing.ts";
import { makeExecutionRecord } from "../helpers/execution-record.ts";
import { journalHeader, JOURNAL_OWNER, JOURNAL_STARTED_AT } from "../helpers/journal-fixtures.ts";

test("unclassified sidecars fall back to classified records, and legacy bodies are refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clarvis-visibility-record-"));
  try {
    const store = createJsonTraceStore({ dir });
    const record = makeExecutionRecord({
      id: "internal",
      owner_key_name: JOURNAL_OWNER,
      visibility: "internal",
    });
    await store.insert(record);
    const stem = join(dir, JOURNAL_OWNER, `${record.started_at}.${record.id}`);
    const summary = JSON.parse(readFileSync(`${stem}.summary`, "utf8")) as Record<string, unknown>;
    delete summary.visibility;
    writeFileSync(`${stem}.summary`, JSON.stringify(summary));
    expect(store.list(JOURNAL_OWNER, 10, 0).items[0]?.visibility).toBe("internal");
    const publicView = createTraceVisibilityView(store, "public");
    expect(publicView.list(JOURNAL_OWNER, 10, 0)).toEqual({ items: [], total: 0 });
    expect(publicView.getById(JOURNAL_OWNER, record.id)).toBeNull();
    expect(publicView.deleteById(JOURNAL_OWNER, record.id)).toBe(false);
    const body = JSON.parse(readFileSync(`${stem}.json`, "utf8")) as Record<string, unknown>;
    delete body.visibility;
    writeFileSync(`${stem}.json`, JSON.stringify(body));
    expect(() => store.getById(JOURNAL_OWNER, record.id)).toThrow("Execution visibility");
    expect(store.list(JOURNAL_OWNER, 10, 0).items).toEqual([]);
    expect(publicView.list(JOURNAL_OWNER, 10, 0)).toEqual({ items: [], total: 0 });
    expect(publicView.getById(JOURNAL_OWNER, record.id)).toBeNull();
    expect(store.deleteOwner(JOURNAL_OWNER)).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("views reject unsupported backends instead of filtering an already-paged result", () => {
  expect(() =>
    createTraceVisibilityView(
      { ...createMemoryTraceStore(), visibilityQueries: undefined },
      "public",
    ),
  ).toThrow("Trace backend does not support visibility queries.");
});

test("internal journals recover through shared maintenance and remain hidden", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clarvis-internal-recovery-"));
  try {
    const physical = createJsonTraceStore({ dir });
    const publicView = createTraceVisibilityView(physical, "public");
    const internalView = createTraceVisibilityView(physical, "internal");
    expect(() => internalView.openJournal!({ header: journalHeader("wrong") })).toThrow(
      "store view",
    );
    const journal = internalView.openJournal!({
      header: { ...journalHeader("hidden"), visibility: "internal" },
    });
    journal.close();
    const path = join(dir, JOURNAL_OWNER, `${JOURNAL_STARTED_AT}.hidden.jsonl`);
    const age = new Date(Date.now() - 7_200_000);
    utimesSync(path, age, age);
    expect(await publicView.recoverOrphans!()).toMatchObject({ recovered: 1 });
    expect(publicView.getById(JOURNAL_OWNER, "hidden")).toBeNull();
    expect(publicView.list(JOURNAL_OWNER, 10, 0)).toEqual({ items: [], total: 0 });
    expect(internalView.getById(JOURNAL_OWNER, "hidden")).toMatchObject({
      visibility: "internal",
      status: "interrupted",
    });
    expect(publicView.existsForOwner(JOURNAL_OWNER, "hidden")).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each([
  { v: 1, visibility: undefined },
  { v: JOURNAL_VERSION, visibility: undefined },
  { v: JOURNAL_VERSION, visibility: "unknown" },
])("quarantines an unclassified orphan %j without public recovery", async (fields) => {
  const dir = mkdtempSync(join(tmpdir(), "clarvis-visibility-journal-"));
  try {
    const store = createJsonTraceStore({ dir });
    const journal = store.openJournal({ header: journalHeader("invalid") });
    journal.close();
    const path = join(dir, JOURNAL_OWNER, `${JOURNAL_STARTED_AT}.invalid.jsonl`);
    writeFileSync(path, JSON.stringify({ ...journalHeader("invalid"), ...fields }) + "\n");
    const age = new Date(Date.now() - 7_200_000);
    utimesSync(path, age, age);
    expect(await store.recoverOrphans()).toMatchObject({ recovered: 0, quarantined: 1 });
    expect(existsSync(`${path}.corrupt`)).toBe(true);
    expect(store.getById(JOURNAL_OWNER, "invalid")).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
