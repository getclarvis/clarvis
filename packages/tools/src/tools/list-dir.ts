import { promises as fs } from "node:fs";
import path from "node:path";
import { fsError } from "../errors.ts";
import { resolvePath } from "../lib/paths.ts";
import { mapLimit, statDirectory, STAT_CONCURRENCY } from "../lib/files.ts";
import type { ToolDef } from "./types.ts";

/**
 * The `list_dir` tool: list one directory's immediate entries (non-recursive),
 * directories first and then files, one per line.
 *
 * @remarks
 * `path` defaults to the workspace root (`.`). The target is confirmed to be a
 * directory by {@link statDirectory} before its entries are read. Each entry is
 * stat-resolved with bounded concurrency ({@link STAT_CONCURRENCY}) to classify
 * it and size regular files; a symlink is followed to decide whether it points
 * at a directory, and any per-entry stat failure demotes it to a non-directory.
 * Entries sort directories-before-files then by name; a directory is rendered as
 * `name/` and a file as `name<TAB>size`. Dotfiles are included and `.gitignore`
 * is not consulted. An empty directory yields `(empty directory)`.
 * @throws {@link ToolError} translated by {@link fsError} when the target is not
 *   a directory or cannot be read.
 */
export const listDir: ToolDef = {
  name: "list_dir",
  description:
    "List the immediate entries of one directory (non-recursive). Directories first, then files; " +
    "directories end with `/` and files show a byte size. Includes dotfiles; does NOT apply " +
    ".gitignore. To match files by pattern across subdirectories use glob; to search file contents " +
    "use grep.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Directory to list. Relative to workspace root or absolute. Default: workspace root.",
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

    await statDirectory(target, rel);

    const entries = [];
    let truncated = false;
    try {
      const dir = await fs.opendir(target);
      try {
        for await (const entry of dir) {
          if (entries.length >= config.maxTraversalEntries) {
            truncated = true;
            break;
          }
          entries.push(entry);
        }
      } finally {
        await Promise.resolve(dir.close()).catch(() => undefined);
      }
    } catch (err) {
      throw fsError(err as NodeJS.ErrnoException, rel);
    }

    const items = await mapLimit(entries, STAT_CONCURRENCY, async (e) => {
      let isDir = e.isDirectory();
      let size = 0;
      if (!isDir || e.isSymbolicLink()) {
        try {
          const st = await fs.stat(path.join(target, e.name));
          isDir = st.isDirectory();
          size = st.size;
        } catch {
          isDir = false;
        }
      }
      return { name: e.name, isDir, size };
    });

    items.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });

    if (items.length === 0) return "(empty directory)";
    const rendered = items
      .map((it) => (it.isDir ? `${it.name}/` : `${it.name}\t${it.size}`))
      .join("\n");
    return truncated
      ? `${rendered}\n[listing incomplete: stopped at ${String(config.maxTraversalEntries)} entries]`
      : rendered;
  },
};
