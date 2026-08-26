/**
 * A stable reference block prepended to the summarizer's system prompt so the
 * summary stays grounded (e.g. the task or plan): a `label` and its `body`.
 *
 * @remarks At most one contribution per agent may provide an anchor; the engine
 * owns the summarization that consumes it.
 */
export interface CompactionAnchor {
  label: string;
  body: string;
}
