/**
 * The `---` YAML frontmatter fence shared by `@clarvis/skills`' `SKILL.md`
 * reader and `@clarvis/loop`'s agent-definition reader.
 *
 * @remarks Both had an independent, byte-identical copy of the fence regex and
 * of the BOM/whitespace normalization in front of it, with error handling that
 * had already diverged - `@clarvis/skills` always throws on an unterminated
 * fence, `@clarvis/loop` throws only in its `"strict"` mode. Splitting is the
 * half they genuinely share, so only the split lives here: this module finds
 * the fence and hands back text. **Parsing and validation stay with the
 * caller**, which is what keeps this package's only external dependency `zod`
 * and adds no Node builtin to it — a YAML parser here would cost both.
 *
 * `@clarvis/plan`'s `splitDocument` is deliberately **not** a caller. It is a
 * different contract, not a copy: it requires a fence, requires the
 * frontmatter to parse to a mapping, and strips neither a BOM nor leading
 * whitespace - because a plan file without frontmatter must be an *error*, and
 * folding it in here would give it this module's "no fence means no
 * frontmatter" reading and produce the silently empty plan the repository
 * guidance forbids.
 */

/**
 * The fence pattern: an opening `---` line, a lazily matched frontmatter block,
 * a closing `---` line, and everything after it.
 *
 * @remarks Not globally flagged, so it carries no `lastIndex` state between
 * calls. The frontmatter group is lazy, so the *first* `---` line closes the
 * fence and a later `---` in the body is body text.
 */
const FRONTMATTER_FENCE_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * The byte-order mark, written as an escape: a literal BOM codepoint in a
 * source file is forbidden repository-wide.
 */
const LEADING_BOM_RE = /^\uFEFF/;

/**
 * The outcome of {@link splitFrontmatterFence}: a complete fence, no fence at
 * all, or an opening fence that never closes.
 *
 * @remarks `unterminated` is reported rather than thrown because the two
 * callers disagree about it - one always rejects such a file, the other
 * rejects it only in strict mode - and that disagreement is policy, not
 * splitting.
 */
export type FrontmatterFence =
  /** A closing fence was found: `frontmatter` is the text between the two `---` lines (unparsed, untrimmed), `body` everything after the closing fence. */
  | { readonly kind: "fenced"; readonly frontmatter: string; readonly body: string }
  /** The text does not open a fence at all; `body` is the untouched input. */
  | { readonly kind: "absent"; readonly body: string }
  /** The text opens with `---` but no closing fence follows; `body` is the untouched input. */
  | { readonly kind: "unterminated"; readonly body: string };

/**
 * Split a markdown file into its YAML frontmatter text and its body, without
 * parsing either.
 *
 * @param raw - the full file contents.
 * @returns a {@link FrontmatterFence}. On `"fenced"`, `frontmatter` is the raw
 *   text between the fences - it is *not* YAML-parsed, trimmed or validated,
 *   and it is the empty string for an empty block. On `"absent"` and
 *   `"unterminated"`, `body` is `raw` exactly as given, with the BOM and the
 *   leading whitespace still on it: there was no frontmatter to strip, so the
 *   file is reported unmodified.
 *
 * @remarks A leading BOM and any leading whitespace are removed before the
 *   fence is looked for, so a file saved with either still parses. Both LF and
 *   CRLF fences are recognized; line endings *inside* `frontmatter` and `body`
 *   are left alone.
 *
 *   Two `---` lines with nothing between them report `"unterminated"`, not an
 *   empty block: the closing fence must be preceded by a newline the opening
 *   fence did not already consume. An empty frontmatter block is written as
 *   `---`, a blank line, `---`.
 *
 *   Never throws - every input maps to one of the three outcomes, and what a
 *   missing or unterminated fence *means* is the caller's to decide.
 */
export function splitFrontmatterFence(raw: string): FrontmatterFence {
  const text = raw.replace(LEADING_BOM_RE, "").trimStart();
  const match = FRONTMATTER_FENCE_RE.exec(text);
  if (match === null) {
    if (text.startsWith("---")) return { kind: "unterminated", body: raw };
    return { kind: "absent", body: raw };
  }
  return { kind: "fenced", frontmatter: match[1] ?? "", body: match[2] ?? "" };
}
