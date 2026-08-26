/**
 * The recoverable mutation journal.
 *
 * One indexer response can rewrite a leaf, its ancestor topics and the profile.
 * Applying those one at a time is not safe: a crash part-way leaves a `PROFILE`
 * that describes a change which never reached its leaf, and the next indexer
 * pass reads that lie back as context. So a batch stages every operation,
 * records what it intends, applies, and only then commits.
 *
 * This module holds the record shape and the **pure** recovery decision. The
 * I/O lives in the backend, so the rule that decides whether an interrupted
 * batch rolls back, rolls forward, or must not be touched at all is testable
 * without a filesystem.
 */
import type { MemoryRevisionSource } from "./revisions.ts";

/** Current journal format. A record written by a newer version is not touched. */
export const JOURNAL_VERSION = 1;

/** Work a batch performs after its tree writes land, replayable by recovery. */
export interface MemoryBatchCommit {
  /** Mark this run id indexed once the tree mutation is durable. */
  mark_indexed?: string;
}

/** One staged operation, with the digests that let recovery reason about it. */
export interface MemoryJournalOp {
  op: "write" | "delete";
  /** Document path relative to the memory root. */
  path: string;
  /** Digest the document carried before the batch; null when it did not exist. */
  expected_digest: string | null;
  /** Digest the document should carry after the batch; null for a delete. */
  next_digest: string | null;
  /** Revision holding the pre-image, or null when there was nothing to capture. */
  revision_id: string | null;
  /**
   * Pre-image carried inline for an op that records no revision.
   *
   * @remarks Derived writes — the deterministic navigation restitch — are kept
   * out of a document's history so link-block churn does not bury real
   * changes, but rollback still has to restore them exactly. The journal is
   * swept the moment a batch commits, so this costs nothing durably.
   */
  previous_body?: string;
}

/** The full intent of one batch, written before any tree byte moves. */
export interface MemoryJournalRecord {
  version: number;
  batch_id: string;
  at: number;
  source: MemoryRevisionSource;
  ops: MemoryJournalOp[];
  /**
   * Declared rather than closured, so recovery can finish a batch's follow-up
   * work without knowing anything about who created it.
   */
  commit: MemoryBatchCommit;
}

/** Which marker files an interrupted batch left behind. */
export interface MemoryJournalMarkers {
  /** Every tree write landed; the batch is past its point of no return. */
  applied: boolean;
  /** The batch finished entirely and is only awaiting cleanup. */
  committed: boolean;
}

/** What recovery did, or refused to do, with one interrupted batch. */
export type MemoryRecoveryOutcome =
  /** Already complete; only the directory needed removing. */
  | "swept"
  /** Writes had landed, so the declared commit work was replayed. */
  | "rolled_forward"
  /** Writes had not all landed, so the tree was returned to its prior state. */
  | "rolled_back"
  /** The tree no longer matches the journal; a human must decide. */
  | "required";

/** One batch's recovery result. */
export interface MemoryRecoveryEntry {
  batch_id: string;
  outcome: MemoryRecoveryOutcome;
  /** Documents the batch touched. */
  paths: string[];
  /** Why recovery stopped, set only for `required`. */
  reason?: string;
}

/** The result of one recovery pass. */
export interface MemoryRecoveryReport {
  entries: MemoryRecoveryEntry[];
  /**
   * True when at least one batch needs a human decision. While set, the store
   * refuses further batches but keeps serving reads.
   */
  required: boolean;
}

/**
 * Decide what to do with an interrupted batch.
 *
 * @param markers - which marker files the batch left behind.
 * @param record - the batch's declared intent.
 * @param current - the digest each touched path carries now, `null` when the
 *   document is absent.
 * @returns the outcome, plus a reason when recovery refuses to act.
 * @remarks The `applied` marker is the single bit that splits the policy. Past
 *   it every write landed and the model's work is correct, so the batch rolls
 *   *forward* — rolling back would discard a good result and force another
 *   inference call. Before it the batch may be half-applied, so it rolls
 *   *back*.
 *
 *   Rollback is permitted only when every touched path sits at either its
 *   expected or its next digest. That is deliberately weaker than "everything
 *   still matches expected" — which would be a no-op precisely in the
 *   mid-apply case recovery exists for — and still strong enough to prove no
 *   third party edited the tree while the batch was interrupted. A path at any
 *   third digest means a human edited it, and their bytes are never
 *   overwritten: the batch is reported as `required` instead.
 */
export function decideRecovery(args: {
  markers: MemoryJournalMarkers;
  record: MemoryJournalRecord;
  current: ReadonlyMap<string, string | null>;
}): { outcome: MemoryRecoveryOutcome; reason?: string } {
  const { markers, record, current } = args;

  if (record.version > JOURNAL_VERSION) {
    return {
      outcome: "required",
      reason: `journal written by a newer version (${String(record.version)})`,
    };
  }
  if (markers.committed) return { outcome: "swept" };
  if (markers.applied) return { outcome: "rolled_forward" };

  for (const op of record.ops) {
    const now = current.get(op.path) ?? null;
    if (now === op.expected_digest || now === op.next_digest) continue;
    return {
      outcome: "required",
      reason: `${op.path} was modified outside the store while a batch was interrupted`,
    };
  }
  for (const op of record.ops) {
    const now = current.get(op.path) ?? null;
    if (now === op.expected_digest) continue;
    if (op.expected_digest !== null && op.revision_id === null && op.previous_body === undefined) {
      return { outcome: "required", reason: `${op.path} has no stored pre-image to restore` };
    }
  }
  return { outcome: "rolled_back" };
}

/**
 * Raised when the store will not mutate until an operator resolves a batch it
 * could not recover on its own.
 *
 * @remarks Reads stay available — the wiki still renders and diagnostics still
 * explain the situation. Only mutation is frozen.
 */
export class MemoryRecoveryRequiredError extends Error {
  /** Stable machine-readable discriminator. */
  readonly code = "memory_recovery_required";

  /** The batch awaiting a decision. */
  readonly batchId: string;

  constructor(batchId: string, reason: string) {
    super(`memory: recovery required for batch ${batchId}: ${reason}`);
    this.name = "MemoryRecoveryRequiredError";
    this.batchId = batchId;
  }
}
