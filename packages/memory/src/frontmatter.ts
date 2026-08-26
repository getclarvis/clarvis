/**
 * Tiny, tolerant frontmatter (de)serialization for wiki documents.
 *
 * A document is a small YAML-ish frontmatter block delimited by `---` lines,
 * then the freeform markdown body. We roll our own parser (no YAML dependency)
 * to keep the package a leaf with `zod` as its only runtime dependency. Parsing
 * never throws: a hand-edited file with missing/garbled frontmatter still loads,
 * fields defaulting — so a person can create or edit memory in an editor without
 * corrupting the store, as long as the `description:` line is present for the
 * reindex to pick up.
 *
 * Lines the parser does not recognize are preserved verbatim in
 * {@link DocFrontmatter.extra} and re-emitted in place, so a key this package
 * knows nothing about survives a rewrite instead of being silently dropped.
 */
import type { DocFrontmatter, MemoryAuthority } from "./types.ts";

/** A document split into its parsed {@link DocFrontmatter} and the markdown
 * following it, the result of {@link parseFrontmatter}. */
export interface ParsedDoc {
  frontmatter: DocFrontmatter;
  /** The markdown body after the frontmatter block. */
  body: string;
  /**
   * True when the document opens with `---` but never closes the block.
   *
   * @remarks Such a file has no recoverable frontmatter — its entire text is
   * reported as the body — so a caller that would rewrite it must leave it
   * alone and surface a diagnostic instead. Overwriting would silently discard
   * whatever the author was mid-way through writing.
   */
  unparsable: boolean;
}

/** The authority values this package understands. */
const AUTHORITIES = new Set<string>(["observed", "confirmed", "contested"]);

/** Values accepted as an affirmative boolean scalar. */
const TRUTHY = new Set<string>(["true", "yes", "on", "1"]);

/** Values accepted as a negative boolean scalar. */
const FALSY = new Set<string>(["false", "no", "off", "0"]);

/**
 * Parse an inline `[a, b]` or comma-separated tag list into a string array.
 *
 * @param value - The raw value after `tags:`.
 * @returns The trimmed, unquoted, non-empty tags; an empty array when the value
 * is blank.
 */
function parseTags(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed === "") return [];
  const inner = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return inner
    .split(",")
    .map((t) => t.trim().replace(/^["']|["']$/g, ""))
    .filter((t) => t.length > 0);
}

/**
 * Strip one matching pair of surrounding single or double quotes.
 *
 * @param value - A raw frontmatter scalar.
 * @returns The trimmed value with a symmetric quote pair removed, if present.
 */
function unquote(value: string): string {
  const t = value.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Read a boolean scalar.
 *
 * @param value - the raw value after the key.
 * @returns the boolean, or undefined when the value is not boolean-ish — in
 *   which case the caller keeps the line verbatim rather than guessing.
 */
function parseBoolean(value: string): boolean | undefined {
  const t = unquote(value).toLowerCase();
  if (TRUTHY.has(t)) return true;
  if (FALSY.has(t)) return false;
  return undefined;
}

/** Whether a line continues the previous key rather than starting its own. */
function isContinuation(line: string): boolean {
  return /^\s/.test(line) && line.trim() !== "";
}

/**
 * Split a document into its frontmatter and body, tolerantly.
 *
 * @param markdown - The raw file contents.
 * @returns A {@link ParsedDoc}. `description`, `tags`, `authority` and `pinned`
 * are typed; every other line is preserved verbatim in `extra`; the body is
 * trimmed.
 * @remarks Never throws. A file that does not open with a `---` line yields
 * empty defaults and the whole trimmed input as the body. A file whose block is
 * never closed does the same but sets `unparsable`, so a caller can decline to
 * rewrite it. An `authority:` whose value is not one of the known values, and a
 * `pinned:` whose value is not boolean-ish, are left in `extra` rather than
 * coerced — a diagnostic pass reports them and the author's text survives.
 *
 * Known limitation: a block scalar (`description: >`) is not folded; the
 * indicator becomes the value and the indented lines land in `extra`. Nothing
 * in this system emits one, and the file still round-trips unchanged.
 */
export function parseFrontmatter(markdown: string): ParsedDoc {
  const fm: DocFrontmatter = { description: "", tags: [] };
  const lines = markdown.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: fm, body: markdown.trim(), unparsable: false };
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      close = i;
      break;
    }
  }
  if (close < 0) {
    return { frontmatter: fm, body: markdown.trim(), unparsable: true };
  }

  const extra: string[] = [];
  let blockTags: string[] | null = null;
  for (let i = 1; i < close; i++) {
    const line = lines[i] ?? "";

    if (blockTags !== null && isContinuation(line)) {
      const item = /^\s*-\s*(.*)$/.exec(line);
      if (item) {
        const tag = unquote(item[1] ?? "");
        if (tag !== "") blockTags.push(tag);
        continue;
      }
    }
    blockTags = null;

    const sep = line.indexOf(":");
    if (sep <= 0 || isContinuation(line)) {
      if (line.trim() !== "") extra.push(line);
      continue;
    }
    const key = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1);

    if (key === "description") {
      fm.description = unquote(value);
    } else if (key === "tags") {
      fm.tags = parseTags(value);
      if (value.trim() === "") blockTags = fm.tags;
    } else if (key === "authority" && AUTHORITIES.has(unquote(value).toLowerCase())) {
      fm.authority = unquote(value).toLowerCase() as MemoryAuthority;
    } else if (key === "pinned" && parseBoolean(value) !== undefined) {
      fm.pinned = parseBoolean(value);
    } else {
      extra.push(line);
    }
  }
  if (extra.length > 0) fm.extra = extra;

  return {
    frontmatter: fm,
    body: lines
      .slice(close + 1)
      .join("\n")
      .trim(),
    unparsable: false,
  };
}

/**
 * Read only the frontmatter `description`, the reindex's fast path.
 *
 * @param markdown - The raw file contents.
 * @returns The description, or the empty string when absent (see
 * {@link parseFrontmatter}).
 */
export function readDescription(markdown: string): string {
  return parseFrontmatter(markdown).frontmatter.description;
}

/**
 * Serialize frontmatter + body back into a document.
 *
 * @param frontmatter - Partial frontmatter; a missing `description` serializes as
 * empty and missing optional fields are omitted.
 * @param body - The markdown body (trimmed on output).
 * @returns The document text: a `---`-delimited head followed by the body and a
 * trailing newline.
 * @remarks Key order is fixed — `description`, `tags`, `authority`, `pinned`,
 * then any unrecognized lines verbatim — so re-serializing a document twice is
 * byte-stable. `description` is always emitted (empty if unknown) and flattened
 * to a single line so the file round-trips and the reindex can find it; `tags`
 * are emitted inline (`tags: [a, b]`) only when non-empty; `authority` and
 * `pinned` are emitted exactly when the parser saw them, so a document that
 * declared neither does not acquire them.
 */
export function serializeDoc(frontmatter: Partial<DocFrontmatter>, body: string): string {
  const description = (frontmatter.description ?? "").replace(/\n/g, " ").trim();
  const tags = frontmatter.tags ?? [];
  const head = ["---", `description: ${description}`];
  if (tags.length > 0) head.push(`tags: [${tags.join(", ")}]`);
  if (frontmatter.authority !== undefined) head.push(`authority: ${frontmatter.authority}`);
  if (frontmatter.pinned !== undefined) head.push(`pinned: ${String(frontmatter.pinned)}`);
  head.push(...(frontmatter.extra ?? []));
  head.push("---");
  return `${head.join("\n")}\n\n${body.trim()}\n`;
}
