import { promises as fs } from "node:fs";
import { ToolError, fsError } from "../errors.ts";
import { readFileOptions } from "../lib/files.ts";
import { resolvePath, displayPath } from "../lib/paths.ts";
import { writeAtomic, withFileLock } from "../lib/atomic.ts";
import { readTextFile } from "../lib/textfile.ts";
import { unifiedDiff } from "../lib/unified-diff.ts";
import type { ToolDef } from "./types.ts";

/**
 * The `write_file` {@link ToolDef}: create a new file or completely overwrite an
 * existing one with the caller's `content`, byte-for-byte (no trailing newline
 * added or stripped), creating any missing parent directories.
 *
 * @remarks
 * The write runs under a per-file lock ({@link withFileLock}) and is atomic
 * ({@link writeAtomic}: tmp file then `rename`), so a concurrent reader never
 * sees a half-written file. When the target already existed and its prior bytes
 * decoded as UTF-8, the result carries a unified diff (old vs new) in
 * `meta.diff`; a binary or oversized prior file is still overwritten without a
 * diff. Every other read failure aborts, especially a post-open `path_escape`,
 * which must never be downgraded into "no diff". The text result reports the
 * byte count and whether the file was created or overwritten. The handler throws a
 * {@link ToolError} with code `not_a_file` when `path` names a directory, and
 * maps any other filesystem failure through {@link fsError}.
 */
export const writeFile: ToolDef = {
  name: "write_file",
  description:
    "Create or completely overwrite a file with `content`, creating missing parent directories. " +
    "Writes `content` verbatim (no trailing newline added or stripped). Use ONLY to create a new " +
    "file or fully replace one; to change part of an existing file use edit_file or multi_edit so " +
    "you do not lose the rest.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Destination file. Relative to workspace root or absolute (~ is not expanded). An " +
          "existing file is overwritten; missing parent directories are created.",
      },
      content: {
        type: "string",
        description: "Full file content. Replaces any existing content in its entirety.",
      },
    },
    required: ["path", "content"],
  },
  async handler(args, config) {
    const relPath = args.path as string;
    const target = resolvePath(
      relPath,
      config.workspaceRoot,
      config.confineToWorkspace,
      config.temporaryRoots,
      config.logger,
    );
    const content = args.content as string;

    return withFileLock(target, async () => {
      let existed = false;
      try {
        const stat = await fs.stat(target);
        if (stat.isDirectory()) {
          throw new ToolError("not_a_file", `Path is a directory: ${relPath}`, { path: relPath });
        }
        existed = true;
      } catch (err) {
        if (err instanceof ToolError) throw err;
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "ENOENT") throw fsError(e, relPath);
      }

      let before: string | undefined;
      if (existed) {
        try {
          const prior = await readTextFile(
            target,
            relPath,
            config.maxFileBytes,
            readFileOptions(config),
          );
          if (prior.encoding === "utf8") before = prior.content;
        } catch (err) {
          if (
            !(err instanceof ToolError) ||
            (err.code !== "is_binary" && err.code !== "too_large")
          ) {
            throw err;
          }
        }
      }

      try {
        await writeAtomic(target, content);
      } catch (err) {
        if (err instanceof ToolError) throw err;
        throw fsError(err as NodeJS.ErrnoException, relPath);
      }

      const bytes = Buffer.byteLength(content, "utf8");
      const rel = displayPath(target, config.workspaceRoot);
      const text = `Wrote ${bytes} bytes to ${rel} (${existed ? "overwritten" : "created"}).`;
      const diff =
        before !== undefined
          ? unifiedDiff(rel, before, content, config.maxDiffInputBytes)
          : undefined;
      return diff ? { content: text, meta: { diff } } : { content: text };
    });
  },
};
