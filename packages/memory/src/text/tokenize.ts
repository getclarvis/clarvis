/**
 * Unicode-aware lexical tokenization — the one text primitive behind
 * `grep_memories`' keyword branch, the indexer's relevance ranking and the BM25
 * query ranker.
 *
 * The pipeline is deliberately short and locale-independent: cap the input,
 * NFKC-normalize, lowercase, fold Latin diacritics, then split on runs of
 * letters, numbers, combining marks and `_`. There is no stemming — `memória`
 * and `memórias` stay distinct, which is correct for both supported languages
 * and leaves frequency handling to BM25's IDF.
 */

/**
 * A token is a run of letters, numbers, combining marks or `_`.
 *
 * @remarks `\p{M}` is in the class on purpose: `"İ".toLowerCase()` yields `i`
 * followed by U+0307 COMBINING DOT ABOVE and NFKC does not recompose it, so a
 * class without marks would split `i̇stanbul` into `i` and `stanbul`. `_` keeps
 * identifiers such as `bun_test` whole. Used only through `matchAll`, which
 * clones the pattern, so this shared instance's `lastIndex` is never written.
 */
const TOKEN_PATTERN = /[\p{L}\p{N}\p{M}_]+/gu;

/**
 * Combining marks whose base character is ASCII — i.e. Latin diacritics.
 *
 * @remarks The lookbehind is what makes folding safe. Stripping every `\p{M}`
 * would destroy scripts where marks are phonemic (a Devanagari matra changes
 * the word), so only marks sitting on an ASCII letter or digit are removed.
 */
const LATIN_MARKS = /(?<=[a-z0-9])\p{M}+/gu;

/** Shortest token kept by default. */
export const DEFAULT_MIN_LENGTH = 2;

/** Characters of a user query read before tokenizing. */
export const QUERY_MAX_CHARS = 512;

/** Tokens a user query may contribute. */
export const QUERY_MAX_TOKENS = 64;

/** Characters of a document body read before tokenizing. */
export const DOC_MAX_CHARS = 200_000;

/** Tokens a single document may contribute. */
export const DOC_MAX_TOKENS = 20_000;

/**
 * English function words, dropped before scoring.
 *
 * @remarks Deliberately covers 2-character words, because
 * {@link DEFAULT_MIN_LENGTH} of 2 admits short tokens so that genuine terms
 * (`ci`, `db`, `ui`, `go`, `qa`, `s3`, `id`) survive; the stopword list is what
 * keeps that from also admitting `is`, `to` and `on`.
 */
const EN_STOPWORDS =
  "a about after all also am an and any are as at be been before being but by can could did " +
  "do does doing each for from had has have he her here him his how if in into is it its " +
  "just may me might more most must my no nor not of off on only or other our out over own " +
  "same shall she should so some such than that the their them then there these they this " +
  "those through to too under up us very was we were what when where which while who whom " +
  "whose why will with would you your";

/** Portuguese function words, dropped before scoring. */
const PT_STOPWORDS =
  "ao aos as com como da das de dele dela deles delas depois do dos e ela elas ele eles em " +
  "entre era essa esse esta este eu foi ha isso isto ja la lhe mais mas me mesmo meu minha " +
  "muito na nao nas nem no nos nossa nosso num numa os ou para pela pelas pelo pelos por " +
  "qual quando que quem sao se sem ser seu sua tambem te tem ter teu tua um uma voce";

/**
 * The default stopword set: English plus Portuguese function words.
 *
 * @remarks Entries are stored **already folded** (`nao`, `sao`, `ja`), because
 * {@link tokenList} folds Latin diacritics before consulting the set. A caller
 * supplying its own set must fold likewise.
 */
export const DEFAULT_STOPWORDS: ReadonlySet<string> = new Set(
  `${EN_STOPWORDS} ${PT_STOPWORDS}`.split(" "),
);

/** Knobs shared by every tokenizing entry point. */
export interface TokenizeOptions {
  /** Shortest token kept. Defaults to {@link DEFAULT_MIN_LENGTH}. */
  minLength?: number;
  /** Hard cap on tokens produced; scanning stops there. Defaults to {@link DOC_MAX_TOKENS}. */
  maxTokens?: number;
  /** Hard cap on input characters read. Defaults to {@link DOC_MAX_CHARS}. */
  maxChars?: number;
  /** Words to drop. Defaults to {@link DEFAULT_STOPWORDS}. */
  stopwords?: ReadonlySet<string>;
}

/**
 * Apply the shared normalization pipeline: cap, NFKC, lowercase, fold Latin
 * diacritics.
 *
 * @param text - arbitrary input.
 * @param maxChars - characters read before the rest is discarded.
 * @returns the normalized text, ready to split on {@link TOKEN_PATTERN}.
 * @remarks Folding is why `configuracao` — how a Brazilian user actually types
 *   on a US keyboard — finds a document written `configuração`. It is
 *   normalization, not stemming: no morphology is inferred, and because tokens
 *   are only ever scored (snippets come from the original body) the fold is
 *   never user-visible. `toLowerCase`, not `toLocaleLowerCase`, matching the
 *   locale-independence `compareMemoryPaths` already contracts for.
 */
function normalizeForTokens(text: string, maxChars: number): string {
  return text
    .slice(0, maxChars)
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFD")
    .replace(LATIN_MARKS, "")
    .normalize("NFC");
}

/**
 * Split text into its significant terms, in order, keeping duplicates.
 *
 * @param text - arbitrary text (a query, a title, a document body).
 * @param opts - length, cap and stopword overrides; see {@link TokenizeOptions}.
 * @returns the tokens, ordered by position, with repeats preserved — the
 *   term-frequency primitive BM25 needs.
 */
export function tokenList(text: string, opts: TokenizeOptions = {}): string[] {
  const minLength = opts.minLength ?? DEFAULT_MIN_LENGTH;
  const maxTokens = opts.maxTokens ?? DOC_MAX_TOKENS;
  const maxChars = opts.maxChars ?? DOC_MAX_CHARS;
  const stopwords = opts.stopwords ?? DEFAULT_STOPWORDS;
  const out: string[] = [];
  for (const match of normalizeForTokens(text, maxChars).matchAll(TOKEN_PATTERN)) {
    const token = match[0];
    if (token.length < minLength || stopwords.has(token)) continue;
    out.push(token);
    if (out.length >= maxTokens) break;
  }
  return out;
}

/**
 * Count how often each significant term occurs.
 *
 * @param text - arbitrary text.
 * @param opts - see {@link TokenizeOptions}.
 * @returns term frequencies, insertion-ordered by first occurrence.
 */
export function tokenCounts(text: string, opts: TokenizeOptions = {}): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokenList(text, opts)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

/**
 * Reduce text to its distinct significant terms.
 *
 * @param text - arbitrary text.
 * @param opts - see {@link TokenizeOptions}.
 * @returns the set of tokens; a term repeated in the source contributes once,
 *   which is the shape `overlapScore` and the grep keyword branch consume.
 */
export function tokenize(text: string, opts: TokenizeOptions = {}): Set<string> {
  return new Set(tokenList(text, opts));
}

/**
 * Count the tokens two {@link tokenize} sets share.
 *
 * @param a - one token set (by convention the query).
 * @param b - the other (by convention a candidate's key).
 * @returns the number of tokens present in both — a raw overlap count, not a
 *   normalized similarity, so longer keys are not penalized. Use the BM25
 *   ranker where relevance rather than mere co-occurrence matters.
 */
export function overlapScore(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let score = 0;
  for (const token of a) if (b.has(token)) score++;
  return score;
}

/** A user query reduced to the distinct terms actually searched for. */
export interface TokenizedQuery {
  /** Distinct terms, in first-occurrence order; empty when the query carried no signal. */
  terms: string[];
  /** Whether the query exceeded {@link QUERY_MAX_CHARS} or {@link QUERY_MAX_TOKENS}. */
  truncated: boolean;
}

/**
 * Tokenize a user-supplied query under the query caps.
 *
 * @param query - the raw query text.
 * @returns the distinct terms plus whether input was cut, so a caller can tell
 *   the user (or the model) that only part of the query was used.
 * @remarks Terms are deduplicated: a term typed twice must not count twice in a
 *   BM25 sum. The character cap is applied before normalizing because NFKC can
 *   expand (`①②` becomes `12`).
 */
export function tokenizeQuery(query: string): TokenizedQuery {
  const raw = tokenList(query, { maxChars: QUERY_MAX_CHARS, maxTokens: QUERY_MAX_TOKENS });
  return {
    terms: [...new Set(raw)],
    truncated: query.length > QUERY_MAX_CHARS || raw.length >= QUERY_MAX_TOKENS,
  };
}
