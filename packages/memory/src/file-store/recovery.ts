import { NOOP_LOGGER, type Logger } from "@clarvis/capability";

import {
  decideRecovery,
  MemoryRecoveryRequiredError,
  type MemoryBatchCommit,
  type MemoryJournalRecord,
  type MemoryRecoveryEntry,
  type MemoryRecoveryReport,
} from "../journal.ts";
import { digestBody } from "../revisions.ts";
import { MemoryStorageLimitError } from "../storage-limits.ts";
import type { MemoryRevisionReader, MemoryTx } from "../types.ts";

interface RecoveryJournal {
  listBatchIds(): Promise<string[]>;
  read(batchId: string): Promise<MemoryJournalRecord | null>;
  markerExists(batchId: string, marker: "applied" | "commit"): Promise<boolean>;
  sweep(batchId: string): Promise<void>;
}

export interface RecoveryCoordinator {
  recover(): Promise<MemoryRecoveryReport>;
  recoverOnce(): Promise<void>;
  assertWritable(): void;
}

export function createRecoveryCoordinator(options: {
  init: () => Promise<void>;
  journal: RecoveryJournal;
  tree: MemoryTx;
  revisions: MemoryRevisionReader;
  runCommit: (commit: MemoryBatchCommit) => Promise<void>;
  logger?: Logger;
}): RecoveryCoordinator {
  const logger = options.logger ?? NOOP_LOGGER;
  let blocked: { batchId: string; reason: string } | null = null;
  let recovered = false;

  /**
   * Report what the one automatic recovery pass did to the tree.
   *
   * @param report - the pass's own report, which {@link RecoveryCoordinator.recoverOnce}
   *   otherwise discards.
   * @remarks Emitted only when a batch was actually seen. Roll-forward and
   *   roll-back both rewrite documents the user can open, and until now they
   *   left no record anywhere that they had happened — the wiki simply differed
   *   from what the last run wrote. Counts and batch ids only: a journal record
   *   carries document bodies.
   */
  function reportRecovery(report: MemoryRecoveryReport): void {
    if (report.entries.length === 0) return;
    let rolledForward = 0;
    let rolledBack = 0;
    let swept = 0;
    for (const entry of report.entries) {
      if (entry.outcome === "rolled_forward") rolledForward += 1;
      else if (entry.outcome === "rolled_back") rolledBack += 1;
      else if (entry.outcome === "swept") swept += 1;
    }
    logger.warn(
      {
        event: "memory.recovery.applied",
        batches: report.entries.length,
        rolled_forward: rolledForward,
        rolled_back: rolledBack,
        swept,
        required: report.required,
        ...(blocked !== null ? { blocked_batch_id: blocked.batchId } : {}),
      },
      report.required
        ? "an interrupted memory batch could not be recovered; the tree is frozen against writes until it is resolved"
        : "an interrupted memory batch was recovered on open; documents it names differ from what the run that wrote them left behind",
    );
  }

  async function recover(): Promise<MemoryRecoveryReport> {
    await options.init();
    const entries: MemoryRecoveryEntry[] = [];
    let batchIds: string[];
    try {
      batchIds = await options.journal.listBatchIds();
    } catch (error) {
      if (!(error instanceof MemoryStorageLimitError)) throw error;
      const batchId = "<journal-scan>";
      const reason = `journal scan exceeds storage limit: ${error.message}`;
      blocked ??= { batchId, reason };
      return {
        entries: [{ batch_id: batchId, outcome: "required", paths: [], reason }],
        required: true,
      };
    }
    for (const batchId of batchIds) {
      let record: MemoryJournalRecord | null;
      try {
        record = await options.journal.read(batchId);
      } catch (error) {
        if (!(error instanceof MemoryStorageLimitError)) throw error;
        const reason = `journal exceeds storage limit: ${error.message}`;
        blocked ??= { batchId, reason };
        entries.push({ batch_id: batchId, outcome: "required", paths: [], reason });
        continue;
      }
      if (record === null) {
        await options.journal.sweep(batchId);
        entries.push({ batch_id: batchId, outcome: "swept", paths: [] });
        continue;
      }

      const current = new Map<string, string | null>();
      let readFailure: string | undefined;
      for (const operation of record.ops) {
        try {
          const body = await options.tree.read(operation.path);
          current.set(operation.path, body === null ? null : digestBody(body));
        } catch (error) {
          if (!(error instanceof MemoryStorageLimitError)) throw error;
          readFailure = `${operation.path} exceeds the document storage limit`;
          break;
        }
      }
      const paths = record.ops.map((operation) => operation.path);
      if (readFailure !== undefined) {
        blocked ??= { batchId, reason: readFailure };
        entries.push({ batch_id: batchId, outcome: "required", paths, reason: readFailure });
        continue;
      }
      const decision = decideRecovery({
        markers: {
          applied: await options.journal.markerExists(batchId, "applied"),
          committed: await options.journal.markerExists(batchId, "commit"),
        },
        record,
        current,
      });
      if (decision.outcome === "required") {
        blocked = { batchId, reason: decision.reason ?? "unrecoverable batch" };
        entries.push({
          batch_id: batchId,
          outcome: "required",
          paths,
          ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
        });
        continue;
      }
      if (decision.outcome === "rolled_forward") await options.runCommit(record.commit);
      if (decision.outcome === "rolled_back") {
        const restoration: Array<
          { op: "delete"; path: string } | { op: "write"; path: string; body: string }
        > = [];
        let restoreFailure: string | undefined;
        for (const operation of record.ops) {
          if ((current.get(operation.path) ?? null) === operation.expected_digest) continue;
          if (operation.expected_digest === null) {
            restoration.push({ op: "delete", path: operation.path });
          } else {
            let body: string | null;
            try {
              body =
                operation.revision_id !== null
                  ? await options.revisions.read(operation.path, operation.revision_id)
                  : (operation.previous_body ?? null);
            } catch (error) {
              if (!(error instanceof MemoryStorageLimitError)) throw error;
              body = null;
            }
            if (body === null || digestBody(body) !== operation.expected_digest) {
              restoreFailure = `${operation.path} has no valid bounded pre-image to restore`;
              break;
            }
            restoration.push({ op: "write", path: operation.path, body });
          }
        }
        if (restoreFailure !== undefined) {
          blocked ??= { batchId, reason: restoreFailure };
          entries.push({
            batch_id: batchId,
            outcome: "required",
            paths,
            reason: restoreFailure,
          });
          continue;
        }
        for (const operation of restoration) {
          if (operation.op === "delete") await options.tree.delete(operation.path);
          else await options.tree.write(operation.path, operation.body);
        }
      }
      await options.journal.sweep(batchId);
      entries.push({ batch_id: batchId, outcome: decision.outcome, paths });
    }
    return { entries, required: blocked !== null };
  }

  return {
    recover,
    async recoverOnce() {
      if (recovered) return;
      recovered = true;
      reportRecovery(await recover());
    },
    assertWritable() {
      if (blocked !== null) throw new MemoryRecoveryRequiredError(blocked.batchId, blocked.reason);
    },
  };
}
