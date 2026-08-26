import type { MemoryIngestDetail } from "@clarvis/protocol";

/**
 * Run-progress and memory-notice vocabulary consumed by status presenters and
 * the run host. Kept in core so formatting modules never import adapters.
 */

interface ProgressEventSummary {
  type?: string;
  task_id?: string;
  to?: string;
  reason?: string;
}

/** A single progress update from the run host, ready for status presenters. */
export interface RunProgress {
  label: string;
  /** Structured source of the label, so status wording is composed from data
   * rather than parsed back out of `label`. */
  event?: ProgressEventSummary;
  iteration?: number;
  counter: number;
}

/**
 * Post-run memory index notice (surfaced on the status line).
 * Protocol name re-exported under the package's existing alias.
 */
export type MemoryIngestNotice = MemoryIngestDetail;
