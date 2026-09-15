const ALLOWED_CONTROL = new Set([0x09, 0x0a]);

const INVISIBLE = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]);

const IRREGULAR_SPACE = new Set([
  0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
  0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

const hex = (code) => `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;

const labelFor = (code) => {
  if (code === 0) return `${hex(code)} NUL — git reads the whole file as binary`;
  if (code < 0x20 || code === 0x7f) return `${hex(code)} control character`;
  if (code >= 0x80 && code <= 0x9f) return `${hex(code)} C1 control character`;
  if (code === 0xfeff) return `${hex(code)} byte-order mark`;
  if (INVISIBLE.has(code)) return `${hex(code)} zero-width character`;
  return `${hex(code)} irregular whitespace`;
};

/**
 * Report every character a source or documentation file must never contain literally.
 *
 * @param text - the file's decoded contents.
 * @param options - `allowInvisible` keeps the byte-order mark, zero-width characters and irregular
 * whitespace legal, which source needs (`@clarvis/tools` carries a literal BOM constant) and
 * documentation does not.
 * @returns one finding per offending character, with 1-indexed line and column.
 */
export function findDangerousCharacters(text, { allowInvisible = false } = {}) {
  const findings = [];
  let line = 1;
  let column = 1;

  for (const character of text) {
    const code = character.codePointAt(0);
    if (code === 0x0a) {
      line += 1;
      column = 1;
      continue;
    }

    const isControl =
      (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) &&
      !ALLOWED_CONTROL.has(code);
    const isInvisible = INVISIBLE.has(code) || IRREGULAR_SPACE.has(code);

    if (isControl || (isInvisible && !allowInvisible)) {
      findings.push({ line, column, code, label: labelFor(code) });
    }
    column += 1;
  }

  return findings;
}

const MARKDOWN_LINK = /\]\(\s*(<[^>]*>|[^)\s]+)\s*(?:"[^"]*")?\)/g;
const BARE_SPEC_PATH = /(?<![\w/.-])specs\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.md/g;
const URL_SPAN = /\b(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|data:|urn:)[^\s<>"'`]+/gi;
const FILE_EXTENSION =
  "(?:jsonl|json|tsx|mts|cts|jsx|mjs|cjs|toml|yaml|yml|mdx|vue|java|ts|js|sh|ps1|md|svg|rs|go|py|cs)";
const SOURCE_FILE = String.raw`(?:\.{1,2}\/)?(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+\.${FILE_EXTENSION}`;
const ROOT_FILE = String.raw`(?:AGENTS\.md|README\.md|SECURITY\.md|CHANGELOG\.md|package\.json|bunfig\.toml|mise\.toml|bun\.lock|tsconfig(?:\.[A-Za-z0-9_-]+)?\.json|eslint\.config\.base\.js|\.gitattributes|\.gitignore|\.prettierignore|\.dockerignore|Dockerfile|Containerfile|Makefile)`;
const EXTENSIONLESS_REPOSITORY_PATH = String.raw`(?:\.githooks\/[A-Za-z0-9_.@/+-]+|(?:packages|tooling|third-party)\/(?:[A-Za-z0-9_.@+-]+\/)*(?:Dockerfile|Containerfile|Makefile))`;
const REFERENCE_FILE = `(?:${SOURCE_FILE}|${EXTENSIONLESS_REPOSITORY_PATH}|${ROOT_FILE})`;
const LINE_QUALIFIED_REFERENCE = new RegExp(
  `(?<![A-Za-z0-9_./:@+-])(${REFERENCE_FILE})(?::\\s*\\d+(?:[-\\u2013]\\d+)?(?:\\s*,\\s*:?\\s*\\d+(?:[-\\u2013]\\d+)?)*|#L\\d+(?:-L?\\d+)?)\\b`,
  "g",
);
const STANDALONE_LINE_QUALIFIER =
  /`:\s*\d+(?:[-\u2013]:?\s*\d+)?(?:\s*,\s*:?\s*\d+(?:[-\u2013]:?\s*\d+)?)*`/g;
const AMBIENT_LINE_QUALIFIER =
  /\(\s*:\s*\d+(?:[-\u2013]\d+)?(?:\s*,\s*:?\s*\d+(?:[-\u2013]\d+)?)*\s*\)/g;
const PROSE_LINE_QUALIFIER = /\blines?\s+\d+(?![\d.])(?:\s*(?:[-\u2013]|,|and)\s*\d+)*(?![\d.])/gi;
const CONTEXTUAL_LINE_QUALIFIER =
  /\b(?:imports?|exports?|comments?|definitions?|statements?|branches?|calls?|rules?)\s+(?:at|on)\s+\d+(?:\s*[-\u2013]\s*\d+)?\b/gi;
const PARENTHETICAL_LINE_QUALIFIER =
  /(?<![A-Za-z0-9_])\(\s*(?:referenced|defined|declared|implemented|called|used|imports?|exports?)(?:\s+at)?\s+`?\d+(?:\s*[-\u2013]\s*\d+)?`?\s*\)/gi;
const MONTH_NAME =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
const CALENDAR_DATE = new RegExp(
  `\\b(?:(?:19|20)\\d{2}[-/](?:0?[1-9]|1[0-2])[-/](?:0?[1-9]|[12]\\d|3[01])|(?:0?[1-9]|[12]\\d|3[01])/(?:0?[1-9]|1[0-2])/(?:19|20)\\d{2}|${MONTH_NAME}\\s+(?:[12]?\\d|3[01])(?:st|nd|rd|th)?,?\\s+(?:19|20)\\d{2}|(?:[12]?\\d|3[01])(?:st|nd|rd|th)?\\s+${MONTH_NAME}\\s+(?:19|20)\\d{2}|${MONTH_NAME}\\s+(?:19|20)\\d{2})\\b`,
  "gi",
);
const SOURCE_SIZE_REFERENCE =
  /(?:\b(?:\d[\d,_]*|one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand)\s+(?:lines?\s+of\s+(?:source|code)|(?:source|code)\s+lines?)\b|\b(?:[Ss]ource|[Cc]ode)\s+(?:has|contains|totals?|is|was)\s+(?:\d[\d,_]*|one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand)\s+lines?\b|\bLOC\b|`src`\s+lines\b)/g;
const REPOSITORY_FILE_REFERENCE = new RegExp(
  `(?<![A-Za-z0-9_./@+-])((?:packages|specs|tooling|\\.github|\\.agents|third-party)\\/[A-Za-z0-9_./@+-]+\\.${FILE_EXTENSION}|${EXTENSIONLESS_REPOSITORY_PATH})(?![A-Za-z0-9_])`,
  "g",
);

const lineOf = (text, index) => {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text[cursor] === "\n") line += 1;
  }
  return line;
};

const splitAnchor = (target) => {
  const hash = target.indexOf("#");
  if (hash < 0) return { path: target, anchor: undefined };
  return { path: target.slice(0, hash), anchor: target.slice(hash + 1) || undefined };
};

const urlSpansOf = (text) =>
  [...text.matchAll(URL_SPAN)].map((match) => {
    const start = match.index ?? 0;
    return [start, start + match[0].length];
  });

const insideAnySpan = (index, spans) => spans.some(([start, end]) => index >= start && index < end);

/**
 * Find source references that encode a line number or range.
 *
 * Documentation references are stable repository paths, optionally accompanied by a symbol or test
 * name in prose. Line-qualified paths, ambient numeric shorthand and prose numeric qualifiers are
 * deliberately rejected because unrelated edits make them stale. Absolute URL spans are excluded,
 * so an immutable upstream link may retain its own fragment or query syntax.
 *
 * @param text - the source or documentation file's contents.
 * @returns one finding per forbidden reference, with its written form and 1-indexed source line.
 */
export function extractLineQualifiedReferences(text) {
  const findings = [];
  const seen = new Set();
  const urlSpans = urlSpansOf(text);
  const push = (raw, index, path) => {
    if (insideAnySpan(index, urlSpans)) return;
    const line = lineOf(text, index);
    const key = `${String(line)}:${raw}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ raw, path, line });
  };

  for (const match of text.matchAll(LINE_QUALIFIED_REFERENCE)) {
    push(match[0], match.index ?? 0, match[1]);
  }
  for (const match of text.matchAll(STANDALONE_LINE_QUALIFIER)) {
    push(match[0], match.index ?? 0, undefined);
  }
  for (const match of text.matchAll(AMBIENT_LINE_QUALIFIER)) {
    push(match[0], match.index ?? 0, undefined);
  }
  for (const match of text.matchAll(PROSE_LINE_QUALIFIER)) {
    push(match[0], match.index ?? 0, undefined);
  }
  for (const match of text.matchAll(CONTEXTUAL_LINE_QUALIFIER)) {
    push(match[0], match.index ?? 0, undefined);
  }
  for (const match of text.matchAll(PARENTHETICAL_LINE_QUALIFIER)) {
    push(match[0], match.index ?? 0, undefined);
  }
  return findings;
}

/**
 * Find literal calendar dates in a specification.
 *
 * Specifications describe the current contract. Change chronology belongs in `CHANGELOG.md`; a
 * date-shaped data example can use a semantic placeholder instead of freezing one historical day.
 *
 * @param text - the specification's contents.
 * @returns one finding per calendar date, with its written form and 1-indexed source line.
 */
export function extractCalendarDates(text) {
  return [...text.matchAll(CALENDAR_DATE)].map((match) => ({
    raw: match[0],
    line: lineOf(text, match.index ?? 0),
  }));
}

/**
 * Find claims about the quantity of source-code lines in a specification.
 *
 * Behavioral line limits, wire formats and coverage ratios remain valid contracts. Inventory-style
 * source-size figures are rejected because they drift without describing product behavior.
 *
 * @param text - the specification's contents.
 * @returns one finding per source-size claim, with its written form and 1-indexed source line.
 */
export function extractSourceSizeReferences(text) {
  return [...text.matchAll(SOURCE_SIZE_REFERENCE)].map((match) => ({
    raw: match[0],
    line: lineOf(text, match.index ?? 0),
  }));
}

/**
 * Extract explicit repository-root file references from documentation.
 *
 * The recognized roots are the trees whose paths this repository owns. Relative Markdown links are
 * validated separately by {@link extractDocumentLinks}; bare basenames remain contextual prose and
 * are not guessed against the filesystem.
 *
 * @param text - the documentation file's contents.
 * @returns one entry per unique file reference and source line.
 */
export function extractRepositoryFileReferences(text) {
  const references = [];
  const seen = new Set();
  const urlSpans = urlSpansOf(text);
  for (const match of text.matchAll(REPOSITORY_FILE_REFERENCE)) {
    const index = match.index ?? 0;
    if (insideAnySpan(index, urlSpans)) continue;
    const path = match[1];
    const line = lineOf(text, index);
    const key = `${String(line)}:${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    references.push({ path, line });
  }
  return references;
}

/**
 * Report an explicit repository-root file reference that no longer resolves.
 *
 * @param reference - an entry from {@link extractRepositoryFileReferences}.
 * @param citingFile - the repository-relative path holding the reference.
 * @param tree - an object exposing `exists(path)` for repository-relative paths.
 * @returns a human-readable failure, or `undefined` when the target exists.
 */
export function resolveRepositoryFileReference(reference, citingFile, tree) {
  if (tree.exists(reference.path)) return undefined;
  return `${citingFile}:${String(reference.line)} → ${reference.path} (no such file)`;
}

/**
 * Extract every link to a Markdown document, in both spellings the corpus uses.
 *
 * Markdown `[text](path.md#anchor)` links are collected from Markdown files only; a bare
 * repository-root `specs/…/x.md` path is collected everywhere, because source TSDoc cites specs that
 * way and those citations rot exactly as silently.
 *
 * @param text - the file's contents.
 * @param file - the repository-relative path the text came from, used to pick the spellings.
 * @returns one entry per link, carrying the path as written, its anchor and its line.
 */
export function extractDocumentLinks(text, file) {
  const links = [];
  const seen = new Set();

  const push = (raw, index) => {
    const { path, anchor } = splitAnchor(raw.replace(/^<|>$/g, "").trim());
    if (!path.endsWith(".md")) return;
    if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return;
    const line = lineOf(text, index);
    const key = `${String(line)}:${path}:${anchor ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ raw, path, anchor, line, relative: !path.startsWith("specs/") });
  };

  const spans = [];
  if (file.endsWith(".md")) {
    for (const match of text.matchAll(MARKDOWN_LINK)) {
      const index = match.index ?? 0;
      spans.push([index, index + match[0].length]);
      push(match[1], index);
    }
  }
  for (const match of text.matchAll(BARE_SPEC_PATH)) {
    const index = match.index ?? 0;
    if (spans.some(([start, end]) => index >= start && index < end)) continue;
    push(match[0], index);
  }

  return links;
}

/**
 * Derive the fragment identifiers a Markdown document exposes, using GitHub's heading slug rules.
 *
 * @param markdown - the document's contents.
 * @returns the set of anchors, including the `-1`/`-2` suffixes GitHub appends to repeated headings.
 */
export function headingSlugs(markdown) {
  const slugs = new Set();
  const counts = new Map();
  let fenced = false;

  for (const raw of markdown.split("\n")) {
    if (/^\s{0,3}(?:```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(raw);
    if (!heading) continue;

    const base = heading[1]
      .replace(/`/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_~]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N} _-]/gu, "")
      .trim()
      .replace(/ /g, "-");
    if (!base) continue;

    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    slugs.add(seen === 0 ? base : `${base}-${String(seen)}`);
  }

  return slugs;
}

/**
 * Resolve one extracted link against the tree and describe how it fails, if it does.
 *
 * @param link - an entry from {@link extractDocumentLinks}.
 * @param file - the repository-relative path holding the link.
 * @param tree - `exists(path)` and `anchorsOf(path)`, both taking repository-relative paths.
 * @returns a human-readable failure, or `undefined` when the link resolves.
 */
export function resolveLink(link, file, tree) {
  const target = link.relative ? tree.join(file, link.path) : link.path;

  if (!tree.exists(target)) {
    return `${file}:${String(link.line)} → ${link.path} (no such file)`;
  }
  if (link.anchor === undefined) return undefined;
  if (!tree.anchorsOf(target).has(link.anchor)) {
    return `${file}:${String(link.line)} → ${link.path}#${link.anchor} (no such heading in ${target})`;
  }
  return undefined;
}
