import { describe, expect, it } from "bun:test";
import type { RunEvent } from "@clarvis/protocol";
import {
  DEFAULT_INGEST_CLOSE_GRACE_MS,
  DEFAULT_INGEST_CLOSE_MAX_WAIT_MS,
  ingestPendingAfter,
  isIngestPending,
  MAX_INGEST_CLOSE_WAIT_MS,
} from "../../src/runs/memory-ingest-phase.ts";

describe("isIngestPending", () => {
  it("is pending for started and queued, terminal for done/failed/blocked", () => {
    expect(isIngestPending("started")).toBe(true);
    expect(isIngestPending("queued")).toBe(true);
    expect(isIngestPending("done")).toBe(false);
    expect(isIngestPending("failed")).toBe(false);
    expect(isIngestPending("blocked")).toBe(false);
  });

  it("treats an absent or unrecognized phase as not pending", () => {
    expect(isIngestPending(undefined)).toBe(false);
    expect(isIngestPending("some-future-phase")).toBe(false);
  });
});

describe("ingestPendingAfter", () => {
  const memoryIngest = (phase: string): RunEvent =>
    ({ type: "memory_ingest", at: 0, detail: { execution_id: "e1", phase } }) as RunEvent;

  it("returns undefined for a non-memory_ingest event, leaving the caller's flag untouched", () => {
    const other = { type: "run_started", at: 0 } as unknown as RunEvent;
    expect(ingestPendingAfter(other)).toBeUndefined();
  });

  it("delegates to isIngestPending for a memory_ingest event", () => {
    expect(ingestPendingAfter(memoryIngest("queued"))).toBe(true);
    expect(ingestPendingAfter(memoryIngest("done"))).toBe(false);
  });
});

describe("DEFAULT_INGEST_CLOSE_GRACE_MS", () => {
  it("keeps background indexing from retaining a settled run through retry backoff", () => {
    expect(DEFAULT_INGEST_CLOSE_GRACE_MS).toBe(5_000);
    expect(DEFAULT_INGEST_CLOSE_MAX_WAIT_MS).toBe(15_000);
    expect(DEFAULT_INGEST_CLOSE_MAX_WAIT_MS).toBeLessThanOrEqual(MAX_INGEST_CLOSE_WAIT_MS);
  });
});
