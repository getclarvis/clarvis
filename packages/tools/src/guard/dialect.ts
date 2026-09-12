import type { ShellFlavor } from "../lib/platform.ts";
import type { ShellAnalysisIssue } from "./types.ts";

/**
 * A word produced by a dialect's tokenizer: its unquoted `text`, and whether it
 * carried a wildcard metacharacter outside quotes (`glob`).
 */
export interface Token {
  text: string;
  glob: boolean;
}

/**
 * What one {@link Token} contributes to the analyzed `paths`.
 *
 * @remarks
 * `opaque` is the member the guard depends on. It marks a token the dialect
 * recognizes as *addressing something* but cannot pin down statically - a
 * `~user` reference, an upward-traversing glob, a provider-qualified name like
 * `HKLM:`, a drive-relative `C:` that resolves against that drive's current
 * directory. It contributes no path **and** forces the whole command
 * undecidable, so it can never be confused with `none`, which means "this token
 * is not a filesystem operand at all". Collapsing the two would let a token the
 * analyzer failed to understand look identical to one it understood as
 * harmless.
 */
export type PathCandidate =
  | { kind: "none" }
  | { kind: "path"; value: string }
  | { kind: "prefix"; value: string }
  | { kind: "opaque" };

/**
 * The front end of one shell syntax.
 *
 * @remarks
 * A dialect supplies lexing and static-safety judgement only. The shared driver
 * {@link analyzeShell} owns every invariant the guard relies on - path
 * deduplication, the `undecidable` fold, `Segment` construction - so those
 * cannot be reimplemented, and misimplemented, per dialect.
 *
 * A single grammar covering both shells is unsound, because the same characters
 * carry opposite meanings: a backtick is command substitution in POSIX sh and
 * the escape character in PowerShell, and `&` backgrounds a process in one and
 * is the call operator in the other. Treating the backtick as substitution makes
 * nearly every legitimate PowerShell command undecidable; treating it as an
 * escape loses POSIX command substitution and allows something dangerous.
 */
export interface ShellDialect {
  /** Diagnostic identity. The driver must never branch on this. */
  readonly flavor: ShellFlavor;

  /**
   * Split a command line at top-level statement and pipeline separators.
   *
   * @returns the trimmed, non-empty `segments`, and `balanced`, which is `false`
   *   when a quote, escape, here-string, paren or brace is left open at end of
   *   input. Empty and whitespace-only segments must be dropped, so a segment
   *   that survives always had source text behind it.
   */
  split(command: string): { segments: string[]; balanced: boolean };

  /** Tokenize one segment into words, flagging unquoted wildcards. */
  tokenize(segment: string): Token[];

  /**
   * Whether a segment is free of constructs whose effect cannot be decided
   * statically. Receives the raw segment rather than the tokens, so it can
   * reason about quoting and command position.
   */
  decidable(segment: string): boolean;

  /** Structured causes; older dialects conservatively fall back to tokenizer_gap. */
  analysisIssues?(segment: string): Array<Omit<ShellAnalysisIssue, "segmentIndex">>;

  /**
   * Reduce a token list to the real argv, recording any stripped prefix
   * assignments.
   *
   * @remarks Returning an empty `argv` *and* empty `envAssignments` for a
   *   non-empty segment is what {@link analyzeShell} treats as a tokenizer
   *   failure, and it forces the command undecidable. A segment that is only
   *   `NAME=value` assignments is not a failure: it recorded the bindings.
   */
  normalize(tokens: string[]): { argv: string[]; envAssignments: string[] };

  /**
   * Optional rewrite of split sources used for tokenization, decidability and
   * path extraction. {@link Segment.command} stays the original source.
   *
   * @remarks The driver must not branch on {@link ShellDialect.flavor}; a dialect
   *   that can bind sequential literal assignments implements this, others omit it.
   */
  analyzeSources?(command: string, sources: string[]): string[];

  /**
   * Classify one token as a path operand.
   *
   * @remarks Owns redirect-prefix stripping, wildcard-prefix reduction and the
   *   dialect's path-shape heuristic, because all three differ per shell: the
   *   separator is `/` or `\`, PowerShell has `*>` but no `<` redirect and no
   *   `{}` brace expansion, and `C:\…` / `\\server\share` are path shapes POSIX
   *   has no notion of.
   */
  pathCandidate(token: Token): PathCandidate;
}
