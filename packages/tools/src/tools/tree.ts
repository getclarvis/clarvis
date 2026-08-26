import { promises as fs } from "node:fs";
import path from "node:path";
import { fsError } from "../errors.ts";
import { resolvePath, displayPath } from "../lib/paths.ts";
import { mapLimit, statDirectory, STAT_CONCURRENCY } from "../lib/files.ts";
import { loadIgnore, type Matcher } from "../lib/ignore.ts";
import type { RuntimeConfig } from "../config.ts";
import type { ToolDef } from "./types.ts";

/** One directory entry gathered by {@link readEntries}: its name, whether it is
 * a directory or a symlink, and (for regular files) its byte size. */
interface Entry {
  name: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
}

interface ReadEntriesResult {
  entries: Entry[];
  /** True when one additional directory entry proved this level exceeded its cap. */
  truncated: boolean;
}

/**
 * Read one directory level into sorted {@link Entry} records, applying the
 * ignore matcher and resolving file sizes.
 *
 * @remarks
 * Symlinks are recorded as symlinks (never followed) with `size` 0; directories
 * carry `size` 0; a regular file whose `stat` fails degrades to `size` 0 rather
 * than throwing. Ignored paths (per `ig`, matched on the workspace-relative
 * path) are dropped. Entries are sorted directories-first, then by name. Sizing
 * is bounded by {@link STAT_CONCURRENCY}. At most
 * `config.maxTraversalEntries` entries are retained, while one additional
 * entry is consumed only to distinguish an exact-cap directory from a
 * truncated one.
 */
async function readEntries(
  dir: string,
  config: RuntimeConfig,
  ig: Matcher | null,
): Promise<ReadEntriesResult> {
  const dirents = [];
  let truncated = false;
  try {
    const handle = await fs.opendir(dir);
    try {
      for await (const entry of handle) {
        if (dirents.length >= config.maxTraversalEntries) {
          truncated = true;
          break;
        }
        dirents.push(entry);
      }
    } finally {
      await Promise.resolve(handle.close()).catch(() => undefined);
    }
  } catch (err) {
    throw fsError(err as NodeJS.ErrnoException, displayPath(dir, config.workspaceRoot));
  }

  const mapped = await mapLimit(dirents, STAT_CONCURRENCY, async (d) => {
    const abs = path.join(dir, d.name);
    if (ig && ig.ignores(path.relative(config.workspaceRoot, abs))) return null;
    const isSymlink = d.isSymbolicLink();
    if (isSymlink) return { name: d.name, isDir: false, isSymlink: true, size: 0 };
    if (d.isDirectory()) return { name: d.name, isDir: true, isSymlink: false, size: 0 };
    let size: number;
    try {
      size = (await fs.stat(abs)).size;
    } catch {
      size = 0;
    }
    return { name: d.name, isDir: false, isSymlink: false, size };
  });

  const entries = mapped.filter((e): e is Entry => e !== null);
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return { entries, truncated };
}

/** Render one {@link Entry} as its tree label: a directory as `name/`, a
 * symlink as `name@`, and a regular file as `name\t<size>`. */
function renderLabel(e: Entry): string {
  if (e.isDir) return `${e.name}/`;
  if (e.isSymlink) return `${e.name}@`;
  return `${e.name}\t${e.size}`;
}

/** Levels descended when the caller names no depth. */
const DEFAULT_TREE_DEPTH = 4;

/**
 * The deepest a caller may ask `tree` to descend.
 *
 * @remarks Not a performance bound — the entry cap and gitignore filter do that
 * work — but a bound on a *rendering*. Each level adds indentation to every line
 * below it, so a deep tree spends the result's width on prefix rather than on
 * names, and the listing stops being readable well before it stops being
 * producible. Twenty is past the depth of any source tree this is meant to
 * survey, so it functions as a refusal of absurd input rather than as a limit
 * a real call meets.
 */
const MAX_TREE_DEPTH = 20;

/**
 * Recursively append the box-drawing tree rendering of `dir` into `out`.
 *
 * @remarks
 * `prefix` is the accumulated indentation for the current level and `depth` is
 * the 1-based level of `dir` below the root. A directory is descended only while
 * `maxDepth` is `undefined` or `depth < maxDepth`; symlinked directories are
 * listed but never traversed (they arrive as `isSymlink`, not `isDir`). The last
 * child of a level uses the corner connector and blank continuation padding
 * while earlier children use the tee connector and a vertical bar, so the
 * branches align.
 *
 * `budget` carries two distinct flags. `exhausted` means the global entry or
 * output-byte cap is spent and no further line can be rendered anywhere, so it
 * ends the whole walk. `truncated` means only that the output is incomplete and
 * should say so. A single level reporting itself capped sets `truncated` alone:
 * {@link readEntries} counts raw dirents *before* the ignore matcher runs, so a
 * directory of 60k build artifacts that `.gitignore` filters down to nothing
 * reports truncation while the entry budget is barely touched. Promoting that to
 * a global stop silently discarded every later sibling and the rest of the tree.
 */
async function walk(
  dir: string,
  prefix: string,
  depth: number,
  maxDepth: number | undefined,
  config: RuntimeConfig,
  ig: Matcher | null,
  out: string[],
  budget: { entries: number; bytes: number; truncated: boolean; exhausted: boolean },
): Promise<void> {
  if (budget.exhausted) return;
  const listing = await readEntries(dir, config, ig);
  const entries = listing.entries;
  for (let i = 0; i < entries.length; i++) {
    if (budget.exhausted) return;
    const e = entries[i]!;
    const last = i === entries.length - 1;
    const line = prefix + (last ? "└── " : "├── ") + renderLabel(e);
    const bytes = Buffer.byteLength(line, "utf8") + 1;
    if (
      budget.entries >= config.maxTraversalEntries ||
      budget.bytes + bytes > config.maxOutputBytes
    ) {
      budget.truncated = true;
      budget.exhausted = true;
      return;
    }
    out.push(line);
    budget.entries += 1;
    budget.bytes += bytes;
    if (e.isDir && (maxDepth === undefined || depth < maxDepth)) {
      await walk(
        path.join(dir, e.name),
        prefix + (last ? "    " : "│   "),
        depth + 1,
        maxDepth,
        config,
        ig,
        out,
        budget,
      );
    }
  }
  if (listing.truncated) budget.truncated = true;
}

/**
 * The `tree` tool: print a directory as an indented box-drawing tree, confined
 * to the workspace.
 *
 * @remarks
 * The root defaults to the workspace root. `depth` bounds how many levels are
 * descended below the root; `0` or omitted means the default
 * ({@link DEFAULT_TREE_DEPTH}, 4) and any request is clamped to
 * {@link MAX_TREE_DEPTH} (20). With `respect_gitignore` true (default), a
 * `.gitignore` matcher plus the `.git/` directory are skipped. Directories end
 * with `/`, symlinks with `@`, and files show a byte size; symlinked
 * directories are listed but not traversed. The target must be a directory
 * (enforced by {@link statDirectory}); an empty tree renders `(no entries)`. The
 * def sets no {@link ToolDef.bounded} flag, so the dispatcher truncates the
 * output to its byte limit.
 */
export const tree: ToolDef = {
  name: "tree",
  description:
    "Print a directory as an indented tree (directories end with `/`, symlinks with `@`, files " +
    "show a byte size). Recurses up to `depth` levels (default 4) unless a larger `depth` is given; " +
    "by default skips paths ignored by .gitignore and the .git/ directory. Symlinked directories are " +
    "listed but not traversed. Output is byte-bounded. Use list_dir for one level, glob to match files by pattern.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Root directory of the tree. Relative to workspace root or absolute. Default: " +
          "workspace root.",
      },
      depth: {
        type: "integer",
        minimum: 0,
        description: "Maximum levels to descend below the root. 0 or omit for the default (4).",
      },
      respect_gitignore: {
        type: "boolean",
        default: true,
        description:
          "When true (default), skip files ignored by .gitignore and the .git/ directory.",
      },
    },
    required: [],
  },
  async handler(args, config) {
    const rel = (args.path as string | undefined) ?? ".";
    const target = resolvePath(
      rel,
      config.workspaceRoot,
      config.confineToWorkspace,
      config.temporaryRoots,
      config.logger,
    );
    const requestedDepth = (args.depth as number | undefined) || DEFAULT_TREE_DEPTH;
    const maxDepth = Math.min(requestedDepth, MAX_TREE_DEPTH);
    const respectGitignore = args.respect_gitignore as boolean;

    await statDirectory(target, rel);

    const ig = respectGitignore ? loadIgnore(config.workspaceRoot) : null;
    const out: string[] = [displayPath(target, config.workspaceRoot)];
    const budget = {
      entries: 0,
      bytes: Buffer.byteLength(out[0]!, "utf8") + 1,
      truncated: false,
      exhausted: false,
    };
    await walk(target, "", 1, maxDepth, config, ig, out, budget);
    if (out.length === 1) out.push("(no entries)");
    if (budget.exhausted) {
      out.push(
        `[tree incomplete: stopped at ${String(budget.entries)} entries or ${String(config.maxOutputBytes)} output bytes]`,
      );
    } else if (budget.truncated) {
      out.push(
        `[tree incomplete: a directory held more than ${String(config.maxTraversalEntries)} entries and was listed in part]`,
      );
    }
    return out.join("\n");
  },
};
