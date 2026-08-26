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
const LINE_CITATION_START =
  /(?<![A-Za-z0-9_./:@+-])`?((?:\.{1,2}\/)?(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+):(\d+)/g;
const SHORTHAND_LINE_RANGE =
  /(?<![A-Za-z0-9_])`?:(\d+)`?[ \t]*[-\u2013][ \t]*`?:?(\d+)`?(?![A-Za-z0-9_])/g;

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

const repositoryTarget = (path) => {
  const segments = path.split("/");
  if (path.startsWith("/") || segments.includes("..")) return undefined;
  const target = segments.filter((segment) => segment !== ".").join("/");
  return target || undefined;
};

/**
 * Count the addressable lines in a text file without inventing a line after its final newline.
 *
 * @param text - the file's decoded contents.
 * @returns zero for an empty file, otherwise the number of addressable source lines.
 */
export function countLines(text) {
  if (text.length === 0) return 0;
  let lines = 0;
  for (const character of text) {
    if (character === "\n") lines += 1;
  }
  return text.endsWith("\n") ? lines : lines + 1;
}

/**
 * Extract explicit repository-path line citations such as `packages/x/src/y.ts:12-18,24` or the
 * prose-oriented `` `packages/x/src/y.ts:12`–`:18` `` spelling.
 *
 * URL spans are excluded before matching, so a local-looking query or fragment inside an absolute
 * URL cannot become a source citation. Whether the path names a real repository file is deliberately
 * left to {@link resolveLineCitation}; examples are useful prose and must not fail merely because
 * their illustrative target does not exist.
 *
 * @param text - the source or documentation file's contents.
 * @returns citations with their written path, cited ranges and location in the citing file.
 */
export function extractLineCitations(text) {
  const citations = [];
  const seen = new Set();
  const urlSpans = [...text.matchAll(URL_SPAN)].map((match) => {
    const start = match.index ?? 0;
    return [start, start + match[0].length];
  });
  const insideUrl = (index) => urlSpans.some(([start, end]) => index >= start && index < end);
  let cursor = 0;
  let line = 1;

  const horizontalEnd = (from) => {
    let end = from;
    while (text[end] === " " || text[end] === "\t") end += 1;
    return end;
  };
  const closingTickEnd = (from) => (text[from] === "`" ? from + 1 : from);
  const lineTokenAt = (from) => {
    let start = horizontalEnd(from);
    if (text[start] === "`") start += 1;
    if (text[start] === ":") start += 1;
    const digitStart = start;
    while (/[0-9]/.test(text[start] ?? "")) start += 1;
    if (start === digitStart || /[A-Za-z0-9_]/.test(text[start] ?? "")) return undefined;
    const raw = text.slice(digitStart, start);
    return { raw, value: BigInt(raw), afterDigits: start };
  };
  const rangeEndAt = (from) => {
    let end = horizontalEnd(closingTickEnd(from));
    if (text[end] !== "-" && text[end] !== "–") return undefined;
    end = horizontalEnd(end + 1);
    const endpoint = lineTokenAt(end);
    if (endpoint === undefined) return undefined;
    return { endpoint, cursor: closingTickEnd(endpoint.afterDigits) };
  };
  const listItemAt = (from) => {
    const end = horizontalEnd(closingTickEnd(from));
    if (text[end] !== ",") return undefined;
    const endpoint = lineTokenAt(end + 1);
    if (endpoint === undefined) return undefined;
    const rangeEnd = rangeEndAt(endpoint.afterDigits);
    if (rangeEnd !== undefined) {
      return {
        range: {
          raw: `${endpoint.raw}-${rangeEnd.endpoint.raw}`,
          start: endpoint.value,
          end: rangeEnd.endpoint.value,
        },
        cursor: rangeEnd.cursor,
      };
    }
    return {
      range: { raw: endpoint.raw, start: endpoint.value, end: endpoint.value },
      cursor: closingTickEnd(endpoint.afterDigits),
    };
  };
  const tableCellEnd = (from, limit) => {
    for (let end = from; end < limit; end += 1) {
      if (text[end] === "|" && text[end - 1] !== "\\") return end;
    }
    return limit;
  };

  const starts = [...text.matchAll(LINE_CITATION_START)].filter((match) => {
    const index = match.index ?? 0;
    const afterStart = index + match[0].length;
    return !insideUrl(index) && !/[A-Za-z0-9_]/.test(text[afterStart] ?? "");
  });

  for (const [matchIndex, match] of starts.entries()) {
    const index = match.index ?? 0;
    while (cursor < index) {
      if (text[cursor] === "\n") line += 1;
      cursor += 1;
    }

    const path = match[1];
    const startRaw = match[2];
    const afterStart = index + match[0].length;

    const start = BigInt(startRaw);
    const rangeEnd = rangeEndAt(afterStart);
    const ranges = [
      rangeEnd === undefined
        ? { raw: startRaw, start, end: start }
        : {
            raw: `${startRaw}-${rangeEnd.endpoint.raw}`,
            start,
            end: rangeEnd.endpoint.value,
          },
    ];
    let citationEnd = rangeEnd === undefined ? closingTickEnd(afterStart) : rangeEnd.cursor;
    for (;;) {
      const item = listItemAt(citationEnd);
      if (item === undefined) break;
      ranges.push(item.range);
      citationEnd = item.cursor;
    }

    const newline = text.indexOf("\n", citationEnd);
    const nextCitation = starts[matchIndex + 1]?.index ?? text.length;
    const sameLineEnd = Math.min(newline < 0 ? text.length : newline, nextCitation);
    const detachedEnd = tableCellEnd(citationEnd, sameLineEnd);
    const detached = text.slice(citationEnd, detachedEnd);
    for (const shorthand of detached.matchAll(SHORTHAND_LINE_RANGE)) {
      const shorthandIndex = citationEnd + (shorthand.index ?? 0);
      if (insideUrl(shorthandIndex)) continue;
      const shorthandStart = shorthand[1];
      const shorthandEnd = shorthand[2];
      ranges.push({
        raw: `${shorthandStart}-${shorthandEnd}`,
        start: BigInt(shorthandStart),
        end: BigInt(shorthandEnd),
      });
    }
    const key = `${String(line)}:${path}:${ranges.map((range) => range.raw).join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({ path, ranges, line });
  }

  return citations;
}

/**
 * Resolve one source citation and report inverted or out-of-bounds line ranges.
 *
 * Only an existing, readable repository-relative file is authoritative. Targets resolve from the
 * repository root, never from the citing document: contextual spellings such as `tests/x.ts` remain
 * ignored unless that exact root-relative path exists. Nonexistent examples, absolute paths and paths
 * that traverse above the repository are ignored.
 *
 * @param citation - an entry from {@link extractLineCitations}.
 * @param citingFile - the repository-relative path holding the citation, used only in diagnostics.
 * @param tree - `exists(path)` and `lineCountOf(path)`, both taking repository-relative paths.
 * @returns one human-readable failure per invalid range, or an empty array when it is valid/ignored.
 */
export function resolveLineCitation(citation, citingFile, tree) {
  const target = repositoryTarget(citation.path);
  if (target === undefined || !tree.exists(target)) return [];
  const total = tree.lineCountOf(target);
  if (total === undefined) return [];

  const lastLine = BigInt(total);
  const failures = [];
  for (const range of citation.ranges) {
    const label = `${target}:${range.raw}`;
    if (range.start > range.end) {
      failures.push(`${citingFile}:${String(citation.line)} → ${label} (inverted line range)`);
      continue;
    }
    if (range.start < 1n || range.end > lastLine) {
      const bounds =
        total === 0 ? "target file is empty" : `outside target's 1-${String(total)} line bounds`;
      failures.push(`${citingFile}:${String(citation.line)} → ${label} (${bounds})`);
    }
  }
  return failures;
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
