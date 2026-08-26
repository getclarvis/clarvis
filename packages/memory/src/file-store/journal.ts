import { promises as fs } from "node:fs";
import { bestEffortFileStore } from "./tasks.ts";
import * as path from "node:path";

import { writeFileDurable } from "@clarvis/paths";

import { readUtf8FileBounded, scanDirectoryBounded } from "../bounded-io.ts";
import type { MemoryJournalRecord } from "../journal.ts";
import {
  assertMemoryPayloadBytes,
  assertMemoryStorageCount,
  MEMORY_STORAGE_LIMITS,
} from "../storage-limits.ts";

const RECORD = "prepare.json";
const APPLIED = "applied";
const COMMITTED = "commit";

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** Admit only the fields recovery dereferences; corrupt records remain untouched by it. */
function isJournalRecord(value: unknown, batchId: string): value is MemoryJournalRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.batch_id !== batchId ||
    typeof record.version !== "number" ||
    typeof record.at !== "number" ||
    record.source === null ||
    typeof record.source !== "object" ||
    record.commit === null ||
    typeof record.commit !== "object" ||
    !Array.isArray(record.ops)
  ) {
    return false;
  }
  const markIndexed = (record.commit as Record<string, unknown>).mark_indexed;
  if (markIndexed !== undefined && typeof markIndexed !== "string") return false;
  return record.ops.every((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const operation = value as Record<string, unknown>;
    return (
      (operation.op === "write" || operation.op === "delete") &&
      typeof operation.path === "string" &&
      isStringOrNull(operation.expected_digest) &&
      isStringOrNull(operation.next_digest) &&
      isStringOrNull(operation.revision_id) &&
      (operation.previous_body === undefined || typeof operation.previous_body === "string")
    );
  });
}

export function createJournalRepository(options: {
  machineryRoot: string;
  init: () => Promise<void>;
}) {
  const root = path.join(options.machineryRoot, ".journal");
  const dirFor = (batchId: string): string => path.join(root, batchId);

  const marker = (batchId: string, name: string): Promise<void> =>
    writeFileDurable(path.join(dirFor(batchId), name), "");

  return {
    async listBatchIds(): Promise<string[]> {
      await options.init();
      const ids: string[] = [];
      const scan = await scanDirectoryBounded(root, MEMORY_STORAGE_LIMITS.scanEntries, (entry) => {
        if (entry.isDirectory()) ids.push(entry.name);
      });
      if (scan.truncated) {
        assertMemoryStorageCount(
          "entries",
          root,
          scan.inspected,
          MEMORY_STORAGE_LIMITS.scanEntries,
        );
      }
      return ids.sort();
    },
    async read(batchId: string): Promise<MemoryJournalRecord | null> {
      const raw = await readUtf8FileBounded(path.join(dirFor(batchId), RECORD), {
        maxBytes: MEMORY_STORAGE_LIMITS.metadataBytes,
        kind: "metadata",
      });
      if (raw === null) return null;
      let record: unknown;
      try {
        record = JSON.parse(raw.text);
      } catch {
        return null;
      }
      if (!isJournalRecord(record, batchId)) return null;
      // This is a valid record outside the supported recovery working set, not
      // corrupt JSON that may be swept. Keep it as operator-visible evidence.
      assertMemoryStorageCount(
        "batch operations",
        batchId,
        record.ops.length,
        MEMORY_STORAGE_LIMITS.batchOperations,
      );
      return record;
    },
    async write(record: MemoryJournalRecord): Promise<void> {
      assertMemoryStorageCount(
        "batch operations",
        record.batch_id,
        record.ops.length,
        MEMORY_STORAGE_LIMITS.batchOperations,
      );
      const serialized = JSON.stringify(record);
      assertMemoryPayloadBytes(
        "metadata",
        `journal:${record.batch_id}`,
        serialized,
        MEMORY_STORAGE_LIMITS.metadataBytes,
      );
      await fs.mkdir(dirFor(record.batch_id), { recursive: true, mode: 0o700 });
      await writeFileDurable(path.join(dirFor(record.batch_id), RECORD), serialized);
    },
    markApplied: (batchId: string) => marker(batchId, APPLIED),
    markCommitted: (batchId: string) => marker(batchId, COMMITTED),
    async markerExists(batchId: string, markerName: "applied" | "commit"): Promise<boolean> {
      try {
        return (await fs.stat(path.join(dirFor(batchId), markerName))).isFile();
      } catch {
        return false;
      }
    },
    async sweep(batchId: string): Promise<void> {
      await bestEffortFileStore("memory_journal_sweep", () =>
        fs.rm(dirFor(batchId), { recursive: true, force: true }),
      );
    },
  };
}
