/**
 * Ranked lexical lookup over the memory tree.
 *
 * `grep` answers "where does this literal text appear"; this answers "which
 * documents best address this question". They are different jobs and both are
 * kept: grep stays exact and line-oriented for navigation and debugging, while
 * this ranks whole documents and is what an agent should reach for first.
 *
 * There is deliberately no persistent index. The corpus is a workspace's wiki —
 * tens of documents — and the tree is the source of truth; a derived index
 * would add an invalidation surface and a staleness bug class to a subsystem
 * whose selling point is being deterministic and stateless. Measure before
 * adding one, and key any cache on the cheap fingerprint `list()` already
 * yields (path plus `updated_at`), never on `version()`, which re-reads and
 * hashes every document and so costs more than the scan it would protect.
 */
import { parseFrontmatter } from "./frontmatter.ts";
import { compareMemoryPaths, memoryDocKind } from "./paths.ts";
import {
  buildStats,
  QUERY_FIELDS,
  scoreDoc,
  type MemoryQueryField,
  type ScoredDoc,
} from "./text/bm25.ts";
import { tokenCounts, tokenList, tokenizeQuery } from "./text/tokenize.ts";
import { extractTitle } from "./tree.ts";
import { MEMORY_STORAGE_LIMITS } from "./storage-limits.ts";
import type { DocKind, MemoryAuthority, MemoryTx } from "./types.ts";

export type { MemoryQueryField } from "./text/bm25.ts";
export { QUERY_FIELDS } from "./text/bm25.ts";

/** What to search for. */
export interface MemoryQueryInput {
  /** Free text. Normalized, stopword-filtered and length-capped. */
  query: string;
  /** Maximum hits to return. */
  limit?: number;
  /** Restrict to documents under this path prefix (e.g. `infra/`). */
  prefix?: string;
  /** Restrict to these document kinds. */
  kinds?: readonly DocKind[];
  /** Include a body excerpt per hit. Defaults to true. */
  include_snippets?: boolean;
}

/** One ranked document. */
export interface MemoryQueryHit {
  path: string;
  kind: DocKind;
  /** First `#` heading, else the humanized directory name. */
  title: string;
  description: string;
  tags: string[];
  /**
   * Relevance, higher is better.
   *
   * @remarks Comparable only within one result set. It is not a percentage and
   * not stable across queries or corpus sizes; never render it as one.
   */
  score: number;
  /** Fields that contributed at least one term, in canonical order. */
  matched_fields: MemoryQueryField[];
  /** Highest-scoring body excerpt; empty when snippets are off or nothing matched. */
  snippet: string;
  /** 1-based body line the snippet starts at; null when there is none. */
  snippet_line: number | null;
  updated_at: number;
  pinned: boolean;
  authority: MemoryAuthority;
}

/** The full result of one query. */
export interface MemoryQueryResult {
  hits: MemoryQueryHit[];
  /**
   * Documents whose body was read and scored.
   *
   * @remarks Bounded by the corpus-byte budget, so it can be smaller than
   *   {@link MemoryQueryResult.listed}; a query carrying no searchable terms
   *   reads nothing and reports `0`. It used to carry `listed`'s meaning on that
   *   one path and this one everywhere else, which made the number impossible to
   *   compare across two queries.
   */
  scanned: number;
  /**
   * Documents left after prefix and kind filtering, and after the document cap.
   *
   * @remarks The denominator {@link MemoryQueryResult.scanned} is a fraction of:
   *   what the query was *allowed* to look at, before any byte budget applied.
   */
  listed: number;
  /** The terms actually searched for; empty means the query carried no signal. */
  terms: string[];
  /** Whether the query was cut to fit its caps. */
  truncated: boolean;
  /** Which independent safety budget cut the query, absent when none did. */
  truncation_reasons?: string[];
}

/** Tunable bounds for one query. */
export interface MemoryQueryConfig {
  limit: number;
  maxLimit: number;
  snippetChars: number;
  snippetLines: number;
  maxDocuments: number;
  maxCorpusBytes: number;
  maxDocumentBytes: number;
}

/** Query bounds used when a caller supplies none. */
export const DEFAULT_QUERY_CONFIG: MemoryQueryConfig = {
  limit: 5,
  maxLimit: 20,
  snippetChars: 400,
  snippetLines: 5,
  maxDocuments: 1_000,
  maxCorpusBytes: 32 * 1024 * 1024,
  maxDocumentBytes: 512 * 1024,
};

/** Widest and narrowest the metadata adjustment may scale a score. */
const BOOST_MAX = 1.25;
const BOOST_MIN = 0.8;

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = value !== undefined && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(maximum, Math.max(minimum, resolved));
}

/**
 * Bounded metadata adjustment, applied only to documents that already matched.
 *
 * @param doc - the document's pinned flag and authority.
 * @returns a multiplier clamped to `[BOOST_MIN, BOOST_MAX]`.
 * @remarks Multiplicative, not additive: BM25 scores have no fixed range, so an
 * additive nudge would need recalibrating for every corpus size while a
 * multiplier's guarantee is scale-free. Two properties follow, and both are
 * tested:
 *
 * 1. Metadata can never surface an irrelevant document — a non-matching
 *    document scores zero, and zero times any multiplier is still zero.
 * 2. Metadata can only reorder near-equals. A document wins on metadata alone
 *    only when its lexical score is at least `BOOST_MIN / BOOST_MAX` — 64% — of
 *    its rival's. Half as relevant can never win on being pinned.
 *
 * Recency is deliberately absent here and lives in the tie-break instead: as a
 * multiplier it would let fresh, irrelevant documents creep up the list.
 */
function metadataBoost(doc: { pinned: boolean; authority: MemoryAuthority }): number {
  let boost = 1;
  if (doc.pinned) boost += 0.15;
  if (doc.authority === "confirmed") boost += 0.1;
  else if (doc.authority === "contested") boost -= 0.1;
  return Math.min(BOOST_MAX, Math.max(BOOST_MIN, boost));
}

/** Rank a kind for tie-breaking: detail beats compilation. */
function kindRank(kind: DocKind): number {
  return kind === "memory" ? 2 : kind === "topic" ? 1 : 0;
}

/** Rank an authority for tie-breaking. */
function authorityRank(authority: MemoryAuthority): number {
  return authority === "confirmed" ? 2 : authority === "observed" ? 1 : 0;
}

/** One document, prepared for scoring. */
interface Candidate {
  doc: ScoredDoc;
  hit: Omit<MemoryQueryHit, "score" | "matched_fields" | "snippet" | "snippet_line">;
  body: string;
}

function queryFieldCounts(
  text: string,
  wanted: ReadonlySet<string>,
): { counts: Map<string, number>; length: number } {
  const counts = new Map<string, number>();
  const tokens = tokenList(text);
  for (const token of tokens) {
    if (wanted.has(token)) counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return { counts, length: tokens.length };
}

function capUtf8(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean; bytes: number } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, truncated: false, bytes };
  const buffer = Buffer.from(text, "utf8");
  let end = maxBytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return { text: buffer.subarray(0, end).toString("utf8"), truncated: true, bytes: end };
}

/**
 * Pick the body excerpt that best covers the query.
 *
 * @param body - the document body.
 * @param terms - the query terms.
 * @param config - snippet bounds.
 * @returns the excerpt and its 1-based starting line, or an empty excerpt when
 *   no body line matched.
 * @remarks Chooses the window of consecutive lines containing the most distinct
 * query terms, so an excerpt shows why the document matched rather than merely
 * where it starts. Ellipsis is added only when the excerpt is not the beginning.
 */
function bestSnippet(
  body: string,
  terms: readonly string[],
  config: MemoryQueryConfig,
): { snippet: string; line: number | null } {
  if (terms.length === 0) return { snippet: "", line: null };
  const lines = body.split("\n");
  const wanted = new Set(terms);
  const perLine = lines.map((line) => {
    const found = new Set<string>();
    for (const token of tokenCounts(line).keys()) if (wanted.has(token)) found.add(token);
    return found;
  });

  let bestStart = -1;
  let bestCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const window = new Set<string>();
    for (let j = i; j < Math.min(lines.length, i + config.snippetLines); j++) {
      for (const t of perLine[j] as Set<string>) window.add(t);
    }
    if (window.size > bestCount) {
      bestCount = window.size;
      bestStart = i;
    }
  }
  if (bestStart < 0 || bestCount === 0) return { snippet: "", line: null };

  const window = lines
    .slice(bestStart, bestStart + config.snippetLines)
    .join("\n")
    .trim();
  const clipped =
    window.length > config.snippetChars ? `${window.slice(0, config.snippetChars - 1)}…` : window;
  return { snippet: bestStart > 0 ? `…${clipped}` : clipped, line: bestStart + 1 };
}

/**
 * Search the tree for the documents most relevant to a question.
 *
 * @param args.tx - the tree's read/list surface.
 * @param args.input - the query and its filters.
 * @param args.config - bounds; defaults to {@link DEFAULT_QUERY_CONFIG}.
 * @returns ranked hits in a total order, plus what was actually searched for.
 * @remarks A query that reduces to no significant terms returns no hits rather
 * than everything — "the of and" is not a request for the whole wiki. Hits
 * are sorted by score rounded to 4 decimal places first, so float jitter must
 * not decide an ordering; ties then fall to pinned, authority, recency, and a
 * detail leaf beating a compilation (`PROFILE.md` is already injected into
 * every run by the seed, so returning it again is mostly redundant); with
 * paths unique, the final tiebreak by path makes the order total.
 */
export async function queryMemory(args: {
  tx: Pick<MemoryTx, "list" | "read" | "readBounded">;
  input: MemoryQueryInput;
  config?: Partial<MemoryQueryConfig>;
}): Promise<MemoryQueryResult> {
  const requested = { ...DEFAULT_QUERY_CONFIG, ...args.config };
  const maxDocuments = boundedInteger(
    requested.maxDocuments,
    DEFAULT_QUERY_CONFIG.maxDocuments,
    1,
    MEMORY_STORAGE_LIMITS.scanEntries,
  );
  const maxLimit = boundedInteger(
    requested.maxLimit,
    DEFAULT_QUERY_CONFIG.maxLimit,
    1,
    maxDocuments,
  );
  const config: MemoryQueryConfig = {
    limit: boundedInteger(requested.limit, DEFAULT_QUERY_CONFIG.limit, 1, maxLimit),
    maxLimit,
    snippetChars: boundedInteger(
      requested.snippetChars,
      DEFAULT_QUERY_CONFIG.snippetChars,
      1,
      MEMORY_STORAGE_LIMITS.prefixBytes,
    ),
    snippetLines: boundedInteger(requested.snippetLines, DEFAULT_QUERY_CONFIG.snippetLines, 1, 100),
    maxDocuments,
    maxCorpusBytes: boundedInteger(
      requested.maxCorpusBytes,
      DEFAULT_QUERY_CONFIG.maxCorpusBytes,
      1,
      MEMORY_STORAGE_LIMITS.corpusBytes,
    ),
    maxDocumentBytes: boundedInteger(
      requested.maxDocumentBytes,
      DEFAULT_QUERY_CONFIG.maxDocumentBytes,
      1,
      MEMORY_STORAGE_LIMITS.documentBytes,
    ),
  };
  const limit = boundedInteger(args.input.limit ?? config.limit, config.limit, 1, config.maxLimit);
  const tokenized = tokenizeQuery(args.input.query);
  const terms = tokenized.terms;
  const truncationReasons: string[] = tokenized.truncated ? ["query"] : [];

  const kinds = args.input.kinds === undefined ? null : new Set(args.input.kinds);
  const filtered = (await args.tx.list()).filter(
    (d) =>
      (args.input.prefix === undefined || d.path.startsWith(args.input.prefix)) &&
      (kinds === null || kinds.has(d.kind)),
  );
  const listed = filtered.slice(0, config.maxDocuments);
  if (filtered.length > listed.length) truncationReasons.push("documents");

  if (terms.length === 0) {
    return {
      hits: [],
      scanned: 0,
      listed: listed.length,
      terms,
      truncated: truncationReasons.length > 0,
      ...(truncationReasons.length > 0 ? { truncation_reasons: truncationReasons } : {}),
    };
  }

  const candidates: Candidate[] = [];
  const wanted = new Set(terms);
  let corpusBytes = 0;
  for (const summary of listed) {
    const bounded = args.tx.readBounded
      ? await args.tx.readBounded(summary.path, config.maxDocumentBytes)
      : await args.tx
          .read(summary.path)
          .then((raw) => (raw === null ? null : capUtf8(raw, config.maxDocumentBytes)));
    if (bounded === null) continue;
    if (bounded.truncated && !truncationReasons.includes("document_bytes")) {
      truncationReasons.push("document_bytes");
    }
    const documentBytes = Buffer.byteLength(bounded.text, "utf8");
    if (corpusBytes + documentBytes > config.maxCorpusBytes) {
      truncationReasons.push("corpus_bytes");
      break;
    }
    corpusBytes += documentBytes;
    const raw = bounded.text;
    const parsed = parseFrontmatter(raw);
    const title = extractTitle(parsed.body, summary.path);
    const analyzed = {
      title: queryFieldCounts(title, wanted),
      description: queryFieldCounts(summary.description, wanted),
      tags: queryFieldCounts(summary.tags.join(" "), wanted),
      path: queryFieldCounts(summary.path.replace(/[/.]/g, " "), wanted),
      body: queryFieldCounts(parsed.body, wanted),
    };
    const fields: Record<MemoryQueryField, Map<string, number>> = {
      title: analyzed.title.counts,
      description: analyzed.description.counts,
      tags: analyzed.tags.counts,
      path: analyzed.path.counts,
      body: analyzed.body.counts,
    };
    const lengths = {} as Record<MemoryQueryField, number>;
    for (const field of QUERY_FIELDS) {
      lengths[field] = analyzed[field].length;
    }
    candidates.push({
      doc: { path: summary.path, fields, lengths },
      body: parsed.body,
      hit: {
        path: summary.path,
        kind: memoryDocKind(summary.path),
        title,
        description: summary.description,
        tags: summary.tags,
        updated_at: summary.updated_at,
        pinned: parsed.frontmatter.pinned === true,
        authority: parsed.frontmatter.authority ?? "observed",
      },
    });
  }

  const stats = buildStats(candidates.map((c) => c.doc));
  const scored = candidates
    .map((candidate) => {
      const { score, matched } = scoreDoc(candidate.doc, terms, stats);
      return { candidate, score: score * metadataBoost(candidate.hit), matched };
    })
    .filter((entry) => entry.score > 0);

  scored.sort((a, b) => {
    const byScore = Number(b.score.toFixed(4)) - Number(a.score.toFixed(4));
    if (byScore !== 0) return byScore;
    const ah = a.candidate.hit;
    const bh = b.candidate.hit;
    if (ah.pinned !== bh.pinned) return ah.pinned ? -1 : 1;
    const byAuthority = authorityRank(bh.authority) - authorityRank(ah.authority);
    if (byAuthority !== 0) return byAuthority;
    if (ah.updated_at !== bh.updated_at) return bh.updated_at - ah.updated_at;
    const byKind = kindRank(bh.kind) - kindRank(ah.kind);
    if (byKind !== 0) return byKind;
    return compareMemoryPaths(ah.path, bh.path);
  });

  const wantSnippets = args.input.include_snippets !== false;
  const hits = scored.slice(0, limit).map((entry) => {
    const excerpt = wantSnippets
      ? bestSnippet(entry.candidate.body, terms, config)
      : { snippet: "", line: null };
    return {
      ...entry.candidate.hit,
      score: Number(entry.score.toFixed(4)),
      matched_fields: entry.matched,
      snippet: excerpt.snippet,
      snippet_line: excerpt.line,
    };
  });

  return {
    hits,
    scanned: candidates.length,
    listed: listed.length,
    terms,
    truncated: truncationReasons.length > 0,
    ...(truncationReasons.length > 0 ? { truncation_reasons: truncationReasons } : {}),
  };
}
