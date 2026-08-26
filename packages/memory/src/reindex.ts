/**
 * Deterministic, stateless contents-section reindex.
 *
 * The navigation between wiki documents (which TOPIC links which MEMORY) is not
 * hand-maintained by the model — it is regenerated from the tree structure and
 * each document's frontmatter `description:`. No checksum, no cached index: a
 * pass reads the current tree and rewrites the `## Contents` section of every
 * index file to match. So a human can hand-edit memory freely; as long as the
 * frontmatter `description:` is present, the next reindex wires it in.
 *
 * Invariants it maintains:
 *  - the root has a `PROFILE.md`; every directory with child directories has a
 *    `TOPIC.md` (scaffolded if missing);
 *  - each index file's `## Contents` section lists its immediate child
 *    directories, linking each to that child's own index
 *    (`TOPIC.md`) or leaf (`MEMORY.md`), annotated with the child's description.
 * Prose outside the managed section is never touched.
 *
 * The pass is split into {@link planReindex} (pure computation over a read-only
 * view) and {@link reindex} (plan, then write). Splitting it lets a caller ask
 * "is the navigation stale?" without mutating anything — health diagnostics do
 * exactly that, so drift is detected by the reindexer itself rather than by a
 * second, divergent implementation.
 */
import { levelEnabled, NOOP_LOGGER, type Logger } from "@clarvis/capability";

import { parseFrontmatter, serializeDoc } from "./frontmatter.ts";
import {
  analyze,
  baseOf,
  DESCRIPTION_MAX_CHARS,
  defaultDescription,
  indexFileFor,
  isGeneratedPlaceholder,
  PROFILE_DESCRIPTION,
  selfFileFor,
  titleFromDir,
  type TreeShape,
} from "./tree.ts";
import {
  assertMemoryPayloadBytes,
  assertMemoryStorageCount,
  MEMORY_STORAGE_LIMITS,
} from "./storage-limits.ts";
import type { MemoryTx } from "./types.ts";

/** Opening HTML marker delimiting the reindex-managed link block in a document. */
export const BLOCK_BEGIN = "<!-- reindex:begin -->";
/** Closing HTML marker delimiting the reindex-managed link block in a document. */
export const BLOCK_END = "<!-- reindex:end -->";
const EMPTY_BLOCK_NOTE = "_(no entries yet)_";
const CONTENTS_HEADING = "## Contents";

type TreeStore = Pick<MemoryTx, "read" | "write" | "list">;

/** The read-only surface {@link planReindex} needs. */
type TreeReader = Pick<MemoryTx, "read" | "list">;

/**
 * Cap a description to {@link DESCRIPTION_MAX_CHARS}, marking a cut with an
 * ellipsis.
 *
 * @param description - the candidate description.
 * @returns `description` unchanged when within the cap, otherwise its prefix
 *   with a trailing `…`.
 */
function capDescription(description: string): string {
  if (description.length <= DESCRIPTION_MAX_CHARS) return description;
  return `${description.slice(0, DESCRIPTION_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * Derive a useful topic summary from the documents directly below `dir`. A
 * one-child topic inherits that child's description; broader topics combine
 * their child summaries into a compact frontmatter line.
 *
 * @param dir - the directory whose index description to derive (`""` = root).
 * @param shape - the analyzed tree.
 * @param memo - recursion cache keyed by directory; supplied on recursive calls.
 * @returns the root's fixed profile description, an existing human-authored
 *   description if present, or a synthesized-and-capped one.
 * @remarks Only descends into an existing generated placeholder
 *   ({@link isGeneratedPlaceholder}); a real hand-written description wins and
 *   stops the recursion. Result is capped to `DESCRIPTION_MAX_CHARS`.
 */
function derivedDescription(
  dir: string,
  shape: TreeShape,
  memo = new Map<string, string>(),
): string {
  if (dir === "") return PROFILE_DESCRIPTION;
  const cached = memo.get(dir);
  if (cached !== undefined) return cached;

  const current = shape.description.get(indexFileFor(dir)) ?? "";
  if (!isGeneratedPlaceholder(current, dir)) {
    memo.set(dir, current);
    return current;
  }

  const children = [...(shape.children.get(dir) ?? [])].sort((a, b) => a.localeCompare(b));
  const descriptions = children
    .map((child) => {
      const self = selfFileFor(child, shape);
      if (self.path.endsWith("/TOPIC.md")) return derivedDescription(child, shape, memo);
      return self.description.trim();
    })
    .filter((description) => description !== "");
  const derived =
    descriptions.length === 0
      ? defaultDescription(dir)
      : descriptions.length === 1
        ? (descriptions[0] as string)
        : `${titleFromDir(dir)}: ${descriptions.join("; ")}`;
  const capped = capDescription(derived);
  memo.set(dir, capped);
  return capped;
}

function introFor(dir: string): string {
  return dir === ""
    ? "Durable workspace knowledge, organized by topic. Follow the links below to drill down."
    : `Durable knowledge about ${baseOf(dir)}.`;
}

/**
 * Replace (or append) the managed Contents section inside a document, leaving
 * all other sections untouched.
 *
 * @param raw - the document's current raw markdown.
 * @param linksText - the freshly generated link list to install.
 * @returns the updated markdown.
 * @remarks Prefers an existing `<!-- reindex:begin -->…<!-- reindex:end -->`
 *   block; otherwise fills an existing `## Contents` heading (up to the next
 *   `##`); otherwise appends a new `## Contents` section at the end.
 */
function writeContents(raw: string, linksText: string): string {
  const b = raw.indexOf(BLOCK_BEGIN);
  const e = raw.indexOf(BLOCK_END);
  if (b >= 0 && e > b) {
    return raw.slice(0, b) + linksText + raw.slice(e + BLOCK_END.length);
  }

  const heading = /^## Contents[ \t]*$/m.exec(raw);
  if (heading?.index !== undefined) {
    const sectionStart = heading.index + heading[0].length;
    const remainder = raw.slice(sectionStart);
    const nextHeading = /\n## [^\n]+/.exec(remainder);
    const sectionEnd =
      nextHeading?.index === undefined ? raw.length : sectionStart + nextHeading.index;
    const suffix = raw.slice(sectionEnd);
    return `${raw.slice(0, sectionStart)}\n\n${linksText}\n${suffix.replace(/^\n+/, "\n")}`;
  }
  return `${raw.trimEnd()}\n\n${CONTENTS_HEADING}\n\n${linksText}\n`;
}

/** Generated index files always carry a useful one-line description. This also
 * repairs the blank description emitted by the first wiki implementation. */
function ensureDescription(raw: string, dir: string, description: string): string {
  const parsed = parseFrontmatter(raw);
  if (!isGeneratedPlaceholder(parsed.frontmatter.description, dir)) return raw;
  return serializeDoc({ ...parsed.frontmatter, description }, parsed.body);
}

/** Upgrade the old empty scaffold (`# title` immediately followed by
 * `## Contents`) without disturbing a human-written introduction. */
function ensureIntro(raw: string, dir: string): string {
  const parsed = parseFrontmatter(raw);
  const body = parsed.body.replace(
    /^(# [^\n]+)\n+(?=## Contents[ \t]*$)/m,
    `$1\n\n${introFor(dir)}\n\n`,
  );
  if (body === parsed.body) return raw;
  return serializeDoc(parsed.frontmatter, body);
}

/** One index file a reindex pass would create or rewrite. */
export interface ReindexChange {
  /** The index file's path relative to the memory root. */
  path: string;
  /** Its current content, or null when the pass would create it. */
  current: string | null;
  /** The content the pass would install. */
  next: string;
}

/**
 * Compute the reindex without writing anything.
 *
 * @param store - the tree's read/list surface.
 * @param logger - where a document dropped from the navigation is reported.
 * @returns one {@link ReindexChange} per index file whose content would
 *   actually change; an empty array means the navigation is already settled.
 * @remarks The pure half of {@link reindex}. A caller that only wants to know
 *   whether navigation has drifted — health diagnostics — asks this and reports
 *   the paths, guaranteeing its answer agrees with what a real pass would do.
 *
 *   An index file whose frontmatter block is left open is skipped entirely: it
 *   cannot be rewritten without discarding whatever the author was mid-way
 *   through, so it is left for a diagnostic pass to report. Its directory's
 *   navigation stays stale until a human closes the block.
 */
export async function planReindex(
  store: TreeReader,
  logger: Logger = NOOP_LOGGER,
): Promise<ReindexChange[]> {
  const docs = await store.list();
  const shape = analyze(docs);
  const changes: ReindexChange[] = [];
  let workingBytes = 0;
  /**
   * Whether a per-document line is worth building at all.
   *
   * @remarks Read once, ahead of the walk, because this loop runs inside
   * `store.exclusive`: every extra allocation here is time the tree lock is
   * held, and the bindings object is built before any backend sees the level.
   */
  const traceSkips = levelEnabled(logger, "debug");
  const skipped = (path: string, reason: string): void => {
    if (!traceSkips) return;
    logger.debug(
      { event: "memory.document.skipped", path, reason },
      "a wiki document contributed nothing to the navigation this pass regenerated",
    );
  };

  const charge = (path: string, content: string): void => {
    const bytes = assertMemoryPayloadBytes(
      "document",
      path,
      content,
      MEMORY_STORAGE_LIMITS.documentBytes,
    );
    workingBytes += bytes;
    assertMemoryStorageCount("corpus", "reindex", workingBytes, MEMORY_STORAGE_LIMITS.corpusBytes);
  };

  const dirsNeedingIndex: string[] = [];
  for (const [dir, kids] of shape.children) {
    if (dir === "" || kids.size > 0) dirsNeedingIndex.push(dir);
  }

  for (const dir of dirsNeedingIndex) {
    shape.description.set(indexFileFor(dir), derivedDescription(dir, shape));
  }

  for (const dir of dirsNeedingIndex) {
    const indexPath = indexFileFor(dir);
    const kids = [...(shape.children.get(dir) ?? [])].sort((a, b) => a.localeCompare(b));

    const links = kids.map((kid) => {
      const self = selfFileFor(kid, shape);
      const rel = self.path.slice(dir === "" ? 0 : dir.length + 1);
      const label = baseOf(kid);
      const desc = self.description.trim();
      if (desc === "") skipped(self.path, "no_description");
      return `- [${label}](${rel})${desc ? ` — ${desc}` : ""}`;
    });
    const linksText = links.length > 0 ? links.join("\n") : EMPTY_BLOCK_NOTE;

    const current = await store.read(indexPath);
    if (current !== null) charge(indexPath, current);
    const description = shape.description.get(indexPath) ?? defaultDescription(dir);
    let next: string;
    if (current === null) {
      const body =
        `# ${titleFromDir(dir)}\n\n${introFor(dir)}\n\n` + `${CONTENTS_HEADING}\n\n${linksText}`;
      next = serializeDoc({ description }, body);
    } else {
      if (parseFrontmatter(current).unparsable) {
        skipped(indexPath, "open_frontmatter");
        continue;
      }
      next = ensureDescription(
        ensureIntro(writeContents(current, linksText), dir),
        dir,
        description,
      );
    }
    if (current === null || next !== current) {
      charge(indexPath, next);
      assertMemoryStorageCount(
        "batch operations",
        "reindex",
        changes.length + 1,
        MEMORY_STORAGE_LIMITS.batchOperations,
      );
      changes.push({ path: indexPath, current, next });
    }
  }

  return changes;
}

/**
 * Deterministically rewrite the navigation of the whole wiki so each index
 * file's managed Contents block lists its immediate children, linked to their
 * own index or leaf and annotated with each child's description.
 *
 * @param store - the tree's read/write/list surface (a {@link MemoryTx}
 *   subset).
 * @param logger - passed through to {@link planReindex}.
 * @returns the relative paths of the index files that were created or changed.
 * @remarks Stateless — no checksum or cache: it reads the current tree and
 *   regenerates the blocks, so hand-edits survive as long as the frontmatter
 *   `description:` is present. Scaffolds a missing `PROFILE.md` at the root and
 *   a `TOPIC.md` in every directory that has child directories; prose outside
 *   the managed block is never touched. A file is written only when its content
 *   actually differs, so a settled tree reports no changes.
 */
export async function reindex(store: TreeStore, logger: Logger = NOOP_LOGGER): Promise<string[]> {
  const changes = await planReindex(store, logger);
  for (const change of changes) await store.write(change.path, change.next);
  return changes.map((change) => change.path);
}
