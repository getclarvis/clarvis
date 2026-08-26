/**
 * Revision identity and provenance.
 *
 * A revision records **the body a change replaced**, not the body it installed.
 * The current body always lives in the tree, so storing the pre-image keeps
 * exactly one copy of every superseded byte and makes a `delete` revision
 * self-sufficient: its stored body *is* the deleted document, which is why
 * there is no separate trash area. It also makes restore read the way users
 * expect — "undo what this change did".
 */
import { createHash, randomBytes } from "node:crypto";

/** What caused a document to change. */
export type MemoryRevisionSource =
  /** The autonomous per-run indexer. */
  | { kind: "indexer"; run_id: string }
  /** A model-facing tool (`write_memory`, `edit_memory`, `delete_memory`). */
  | { kind: "tool"; tool: string };

/** One recorded change to one document. */
export interface MemoryRevision {
  /**
   * Time-sortable unique id.
   *
   * @remarks Lexicographic order matches chronological order, so a directory
   * listing sorts into history order without reading any metadata.
   */
  id: string;
  /** The document this revision belongs to, relative to the memory root. */
  path: string;
  /** When the change was applied (epoch ms). */
  at: number;
  /** Whether the change wrote or deleted the document. */
  op: "write" | "delete";
  /** Digest of the body this change **installed**; absent for a delete. */
  digest?: string;
  /**
   * Digest of the body this change **replaced** — that is, of the stored
   * pre-image. Absent when the document did not exist beforehand, in which
   * case there is no stored body and the revision cannot be restored.
   */
  previous_digest?: string;
  /** Byte length of the stored pre-image; 0 when there is none. */
  bytes: number;
  /** What caused the change. */
  source: MemoryRevisionSource;
  /** The batch this revision was committed with. */
  batch_id: string;
  /**
   * True when the replaced body did not match what the previous revision
   * installed — i.e. the tree was edited outside the store in between.
   *
   * @remarks Records the fact without obstructing anything: hand-editing the
   * wiki is a supported workflow, and this is how history stays honest about it.
   */
  external_edit?: boolean;
}

/**
 * Digest a document body.
 *
 * @param content - the raw markdown.
 * @returns its SHA-256 as lowercase hex.
 */
export function digestBody(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Mint a time-sortable revision id.
 *
 * @param at - the revision's timestamp (epoch ms).
 * @returns an id whose lexicographic order matches chronological order.
 * @remarks The base-36 timestamp is zero-padded so ids stay comparable as
 *   plain strings, and a random suffix keeps two revisions minted in the same
 *   millisecond distinct.
 */
export function newRevisionId(at: number): string {
  return `${Math.max(0, Math.trunc(at)).toString(36).padStart(9, "0")}-${randomBytes(4).toString("hex")}`;
}

/**
 * Order revisions newest-first.
 *
 * @param a - one revision.
 * @param b - the other.
 * @returns a comparator result placing the more recent revision first, falling
 *   back to the id so the order is total and stable.
 */
export function compareRevisionsNewestFirst(a: MemoryRevision, b: MemoryRevision): number {
  if (a.at !== b.at) return b.at - a.at;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}
