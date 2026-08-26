/**
 * The cheap, LLM-free overview of the tree a host UI renders.
 *
 * Pure over an already-fetched listing, so the facade owns the one `list()`
 * call. The counting and "is this described?" predicates are kept as separate
 * helpers — private until a second caller exists — so that a later diagnostics
 * pass can share them rather than recomputing the same answers differently.
 */
import type { MemoryDoc } from "./types.ts";
import type { ReviewDigest } from "./memory-contract.ts";

/** Most-recently-updated documents reported by {@link reviewDigest}. */
const RECENT_LIMIT = 10;

/**
 * Count documents by their place in the pyramid.
 *
 * @param docs - the tree listing.
 * @returns totals; note `documents` counts every file, so it exceeds
 *   `topics + memories` by the one `PROFILE.md` when the root exists.
 */
function summarizeTotals(docs: readonly MemoryDoc[]): ReviewDigest["totals"] {
  let topics = 0;
  let memories = 0;
  for (const doc of docs) {
    if (doc.kind === "topic") topics++;
    else if (doc.kind === "memory") memories++;
  }
  return { documents: docs.length, topics, memories };
}

/**
 * Whether a document is missing the frontmatter description its parents need to
 * list it.
 *
 * @param doc - a document from the tree listing.
 * @returns true when the description is absent or blank.
 */
function isUndescribed(doc: MemoryDoc): boolean {
  return doc.description.trim() === "";
}

/**
 * Build the tree overview.
 *
 * @param docs - the tree listing.
 * @returns totals, the {@link RECENT_LIMIT} most recently updated documents
 *   newest first, and every path missing a description.
 */
export function reviewDigest(docs: readonly MemoryDoc[]): ReviewDigest {
  const recent = [...docs]
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, RECENT_LIMIT)
    .map((d) => ({ path: d.path, description: d.description, updated_at: d.updated_at }));
  return {
    totals: summarizeTotals(docs),
    recent,
    undescribed: docs.filter(isUndescribed).map((d) => d.path),
  };
}
