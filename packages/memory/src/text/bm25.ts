/**
 * Field-weighted BM25, dependency-free.
 *
 * Ranking a wiki is not the same problem as ranking web pages: the corpus is
 * tens of documents, not billions, and the useful signal is spread across a
 * path, a title, a one-line description, tags and a body that are each worth
 * different amounts. So this is BM25F — per-field weights pooled before
 * saturation — rather than plain BM25 over a concatenated blob.
 */

/** The scored fields, in canonical order. Drives `matched_fields` output. */
export const QUERY_FIELDS = ["title", "description", "tags", "path", "body"] as const;

/** One scored field of a document. */
export type MemoryQueryField = (typeof QUERY_FIELDS)[number];

/** A document reduced to per-field term frequencies. */
export interface ScoredDoc {
  path: string;
  fields: Record<MemoryQueryField, Map<string, number>>;
  lengths: Record<MemoryQueryField, number>;
}

/** Corpus-wide statistics the score needs. */
export interface CorpusStats {
  /** Number of documents. */
  n: number;
  /** How many documents contain each term. */
  df: Map<string, number>;
  /** Mean length of each field across the corpus. */
  avgLen: Record<MemoryQueryField, number>;
}

/** Per-field weight and length-normalization strength. */
interface FieldParams {
  /** How much a match in this field is worth. */
  w: number;
  /** How hard to penalize a long field: 0 not at all, 1 fully. */
  b: number;
}

/**
 * Field weights.
 *
 * @remarks A title match is the strongest signal a wiki offers — the model
 * writes one per document and it names the subject. `body` is the baseline and
 * takes the strongest length normalization, because a long leaf would otherwise
 * out-score a short, precise topic page purely by having more words.
 */
const FIELD_PARAMS: Record<MemoryQueryField, FieldParams> = {
  title: { w: 3.0, b: 0.4 },
  description: { w: 2.2, b: 0.4 },
  tags: { w: 2.0, b: 0.3 },
  path: { w: 1.4, b: 0.3 },
  body: { w: 1.0, b: 0.75 },
};

/** Term-frequency saturation point. */
const K1 = 1.2;

/**
 * Inverse document frequency, Lucene-style.
 *
 * @param df - documents containing the term.
 * @param n - documents in the corpus.
 * @returns a strictly positive weight.
 * @remarks Textbook BM25's IDF goes *negative* once a term appears in more than
 * half the documents. In a fifteen-document wiki that fires constantly — the
 * workspace's own name is in most pages — and a negative weight means matching
 * a common term actively lowers a score, which is nonsense here. The `1 +`
 * form keeps it positive while still preferring rare terms.
 */
function idf(df: number, n: number): number {
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

/**
 * Score one document against a query.
 *
 * @param doc - the document's per-field term frequencies.
 * @param terms - the distinct query terms.
 * @param stats - corpus statistics.
 * @returns the score and which fields contributed, in canonical field order.
 * @remarks Frequencies are pooled across fields **before** saturation rather
 * than scored per field and summed. Summing would let one short field dominate:
 * a term repeated ten times in `tags` would out-score a document matching
 * strongly across title, description and body together.
 */
export function scoreDoc(
  doc: ScoredDoc,
  terms: readonly string[],
  stats: CorpusStats,
): { score: number; matched: MemoryQueryField[] } {
  let score = 0;
  const matched = new Set<MemoryQueryField>();
  for (const term of terms) {
    const df = stats.df.get(term) ?? 0;
    if (df === 0) continue;
    let pooled = 0;
    for (const field of QUERY_FIELDS) {
      const tf = doc.fields[field].get(term);
      if (tf === undefined) continue;
      matched.add(field);
      const { w, b } = FIELD_PARAMS[field];
      const avg = stats.avgLen[field] || 1;
      pooled += (w * tf) / (1 - b + (b * doc.lengths[field]) / avg);
    }
    if (pooled > 0) score += idf(df, stats.n) * (pooled / (K1 + pooled));
  }
  return { score, matched: QUERY_FIELDS.filter((f) => matched.has(f)) };
}

/**
 * Compute corpus statistics over the scored documents.
 *
 * @param docs - every document in the corpus.
 * @returns document frequencies and mean field lengths.
 */
export function buildStats(docs: readonly ScoredDoc[]): CorpusStats {
  const df = new Map<string, number>();
  const totals: Record<MemoryQueryField, number> = {
    title: 0,
    description: 0,
    tags: 0,
    path: 0,
    body: 0,
  };
  for (const doc of docs) {
    const seen = new Set<string>();
    for (const field of QUERY_FIELDS) {
      totals[field] += doc.lengths[field];
      for (const term of doc.fields[field].keys()) seen.add(term);
    }
    for (const term of seen) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const n = Math.max(1, docs.length);
  return {
    n: docs.length,
    df,
    avgLen: {
      title: totals.title / n,
      description: totals.description / n,
      tags: totals.tags / n,
      path: totals.path / n,
      body: totals.body / n,
    },
  };
}
