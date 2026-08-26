/**
 * Cheap, vector-free ranking by token overlap.
 *
 * Tokenization itself lives in `./text/tokenize.ts`; this module only scores.
 * It **has no production caller**: it used to be the selector behind the
 * indexer's "which existing documents are relevant to this run" decision, over
 * path, description and tags but never a body — so the one component that
 * decides which document to *rewrite* ranked without reading any of them, and
 * wrote near-duplicates beside the leaves it should have updated. The indexer
 * now shares `./query.ts`'s BM25 ranker with the `query_memories` tool.
 *
 * What is kept, and why: `query.test.ts` scores the two rankers against the
 * same corpus, so this is the baseline that keeps that comparison honest. Do
 * not reintroduce it as a ranker — overlap counting deliberately does not
 * penalize long keys, and has no notion of field weight.
 */
import { compareMemoryPaths } from "./paths.ts";
import { overlapScore, tokenize } from "./text/tokenize.ts";

/**
 * Rank items by lexical overlap of their key against a free-text query, keeping
 * only those that share at least one token.
 *
 * @param items - the candidates to rank.
 * @param query - the free-text query, tokenized once.
 * @param keyOf - projects each item to the text scored against the query.
 * @param limit - maximum number of items to return.
 * @returns the highest-scoring items, descending by overlap, with zero-overlap
 *   items dropped and the result truncated to `limit`; an empty array when the
 *   query has no significant tokens.
 * @remarks Ties break on the item's key with `compareMemoryPaths`, so the order
 *   is fully determined by the inputs rather than by the caller's insertion
 *   order — two stores holding the same documents rank them identically.
 */
export function rankByOverlap<T>(
  items: T[],
  query: string,
  keyOf: (item: T) => string,
  limit: number,
): T[] {
  const q = tokenize(query);
  if (q.size === 0) return [];
  return items
    .map((item) => {
      const key = keyOf(item);
      return { item, key, score: overlapScore(q, tokenize(key)) };
    })
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score || compareMemoryPaths(a.key, b.key))
    .slice(0, limit)
    .map((e) => e.item);
}
