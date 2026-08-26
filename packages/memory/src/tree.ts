/**
 * The structural model of the memory tree: path arithmetic, the directory
 * hierarchy a document listing implies, and which file a parent links to for
 * each child.
 *
 * Extracted from the reindex pass so that anything else needing to reason about
 * the pyramid — health diagnostics, ranked query — asks the same code rather
 * than reimplementing it and drifting.
 */
import type { MemoryDoc } from "./types.ts";

/** Frontmatter description of the root `PROFILE.md`, which is always generated. */
export const PROFILE_DESCRIPTION = "Index of durable operational knowledge for this workspace";

/** Longest frontmatter `description:` a generated index file will carry. */
export const DESCRIPTION_MAX_CHARS = 120;

/** POSIX dirname of a relative path; `""` for a top-level file. */
function dirOf(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i < 0 ? "" : relPath.slice(0, i);
}

/**
 * POSIX basename of a relative path.
 *
 * @param relPath - a tree-relative path.
 * @returns the final segment, or the whole string when there is no separator.
 */
export function baseOf(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i < 0 ? relPath : relPath.slice(i + 1);
}

/** Join a directory and a name, tolerating the root's empty directory. */
function joinPath(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

/**
 * The index file that governs a directory.
 *
 * @param dir - the directory (`""` = root).
 * @returns `PROFILE.md` at the root, `<dir>/TOPIC.md` elsewhere.
 */
export function indexFileFor(dir: string): string {
  return joinPath(dir, dir === "" ? "PROFILE.md" : "TOPIC.md");
}

/**
 * A human-facing title for a directory.
 *
 * @param dir - the directory (`""` = root).
 * @returns its capitalized basename, or `"Operational profile"` at the root.
 */
export function titleFromDir(dir: string): string {
  const base = dir === "" ? "Operational profile" : baseOf(dir);
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * The description a directory's index file gets when nothing better is known.
 *
 * @param dir - the directory (`""` = root).
 * @returns the fixed profile description at the root, else a synthesized line.
 */
export function defaultDescription(dir: string): string {
  return dir === "" ? PROFILE_DESCRIPTION : `${titleFromDir(dir)} operational knowledge`;
}

/**
 * Whether a description carries no human intent and may be regenerated.
 *
 * @param description - the current frontmatter description.
 * @param dir - the directory whose index file it belongs to.
 * @returns true when it is blank, the bare directory name, or exactly the
 *   generated {@link defaultDescription} — the three shapes that mean "nobody
 *   has written one yet".
 */
export function isGeneratedPlaceholder(description: string, dir: string): boolean {
  const normalized = description.trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === baseOf(dir).toLowerCase() ||
    normalized === defaultDescription(dir).toLowerCase()
  );
}

/**
 * Whether a path names an index file — a `PROFILE.md` or `TOPIC.md` — as
 * opposed to a `MEMORY.md` leaf.
 *
 * @param relPath - a document path relative to the memory root.
 * @returns true if its basename is `PROFILE.md` or `TOPIC.md`.
 */
export function isIndexFile(relPath: string): boolean {
  const base = baseOf(relPath);
  return base === "PROFILE.md" || base === "TOPIC.md";
}

/** The structural view of the memory tree computed from a document listing. */
export interface TreeShape {
  /** All document paths present. */
  paths: Set<string>;
  /** Description by path (empty string when absent). */
  description: Map<string, string>;
  /** Directory → its immediate child directories that contain any document. */
  children: Map<string, Set<string>>;
}

/**
 * Build a {@link TreeShape} from a document listing.
 *
 * @param docs - all documents in the tree.
 * @returns the analyzed shape: every path and its description, plus the
 *   directory hierarchy — including intermediate directories that hold no file
 *   of their own, which still need an index file.
 */
export function analyze(docs: MemoryDoc[]): TreeShape {
  const paths = new Set<string>();
  const description = new Map<string, string>();
  const children = new Map<string, Set<string>>();
  const addChild = (parent: string, child: string): void => {
    let set = children.get(parent);
    if (!set) children.set(parent, (set = new Set()));
    set.add(child);
  };

  for (const doc of docs) {
    paths.add(doc.path);
    description.set(doc.path, doc.description);
  }
  for (const doc of docs) {
    const dir = dirOf(doc.path);
    let child = dir;
    while (child !== "") {
      const parent = dirOf(child);
      addChild(parent, child);
      child = parent;
    }
    if (!children.has(dir)) children.set(dir, new Set());
  }
  if (!children.has("")) children.set("", new Set());
  return { paths, description, children };
}

/**
 * The file a parent should link to for a child directory, and its description.
 *
 * @param dir - the child directory being linked.
 * @param shape - the analyzed tree.
 * @returns the target link path and that target's description.
 * @remarks A directory with subdirectories is a topic (link its `TOPIC.md`,
 *   scaffolded if absent); otherwise link its `MEMORY.md` when present, else
 *   fall back to `TOPIC.md`.
 */
export function selfFileFor(dir: string, shape: TreeShape): { path: string; description: string } {
  const hasChildren = (shape.children.get(dir)?.size ?? 0) > 0;
  const topic = indexFileFor(dir);
  const memory = joinPath(dir, "MEMORY.md");
  let path: string;
  if (hasChildren || shape.paths.has(topic)) path = topic;
  else if (shape.paths.has(memory)) path = memory;
  else path = topic;
  return { path, description: shape.description.get(path) ?? "" };
}

/** Body lines scanned when looking for a document's heading. */
const TITLE_SCAN_LINES = 20;

/**
 * A document's display title.
 *
 * @param body - the markdown body, frontmatter already stripped.
 * @param relPath - the document's path, used for the fallback.
 * @returns the first ATX `#` heading, else the humanized directory name.
 * @remarks The heading exists in practice — the reindex scaffolds every
 * generated index with one, and the indexer prompt asks for one on every leaf —
 * but a hand-written document may lack it, so the directory name stands in
 * rather than leaving a document title-less. Only the opening lines are
 * scanned, so a heading buried deep in prose is not mistaken for the title.
 */
export function extractTitle(body: string, relPath: string): string {
  const lines = body.split("\n", TITLE_SCAN_LINES);
  for (const line of lines) {
    const heading = /^#\s+(.+?)\s*$/.exec(line);
    if (heading) return heading[1] as string;
  }
  return titleFromDir(dirOf(relPath));
}
