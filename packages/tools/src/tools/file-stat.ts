import { promises as fs } from "node:fs";
import { fsError } from "../errors.ts";
import { resolvePath, displayPath } from "../lib/paths.ts";
import { isBinary } from "../lib/binary.ts";
import { sniffImageMime } from "../lib/image.ts";
import { openReadHandle } from "../lib/files.ts";
import type { ToolDef } from "./types.ts";

const HEAD_BYTES = 8192;

function octalMode(mode: number): string {
  return "0" + (mode & 0o777).toString(8).padStart(3, "0");
}

/**
 * The `file_stat` tool: return structured metadata for one path as a JSON
 * string - type, size, mtime (ISO-8601), and octal mode.
 *
 * @remarks
 * The path is inspected with `lstat`, so a symlink is reported as `type:
 * "symlink"` with its `symlink_target` (never followed; a broken `readlink`
 * yields `null`). Directories and non-regular files (`type: "directory"` /
 * `"other"`) stop there. For a regular file the handler additionally reads only
 * the first {@link HEAD_BYTES} bytes from a non-blocking descriptor (no-follow
 * where the host supports it) and uses that descriptor's metadata for the result. This reports `binary`
 * (via {@link isBinary}) and `mime` (via {@link sniffImageMime}, `null` when not
 * a recognized image), so it works even on files too large to read in full and
 * a pathname race cannot mismatch the metadata and head. All results are
 * JSON-stringified with the workspace-relative {@link displayPath}.
 * @throws {@link ToolError} translated from the underlying `errno` by
 *   {@link fsError} when the path cannot be `lstat`-ed or the head slice cannot
 *   be read.
 */
export const fileStat: ToolDef = {
  name: "file_stat",
  description:
    "Return structured metadata for ONE path as a JSON object: type " +
    "(file/directory/symlink/other), size in bytes, mtime (ISO-8601), mode (octal). A symlink is " +
    "reported without being followed, with its target. For a regular file it also reports whether " +
    "the content looks binary and, for an image, its MIME type — reading only a small head slice, " +
    "so it works on files too large to read. Use before read_file to check size/type.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to inspect. Relative to workspace root or absolute (~ is not expanded).",
      },
    },
    required: ["path"],
  },
  async handler(args, config) {
    const rel = args.path as string;
    const target = resolvePath(
      rel,
      config.workspaceRoot,
      config.confineToWorkspace,
      config.temporaryRoots,
      config.logger,
    );

    let lst;
    try {
      lst = await fs.lstat(target);
    } catch (err) {
      throw fsError(err as NodeJS.ErrnoException, rel);
    }

    const disp = displayPath(target, config.workspaceRoot);
    const mtime = lst.mtime.toISOString();
    const mode = octalMode(lst.mode);

    if (lst.isSymbolicLink()) {
      let symlinkTarget: string | null;
      try {
        symlinkTarget = await fs.readlink(target);
      } catch {
        symlinkTarget = null;
      }
      return JSON.stringify({
        path: disp,
        type: "symlink",
        size: lst.size,
        mtime,
        mode,
        symlink_target: symlinkTarget,
      });
    }

    if (lst.isDirectory()) {
      return JSON.stringify({ path: disp, type: "directory", size: lst.size, mtime, mode });
    }

    if (!lst.isFile()) {
      return JSON.stringify({ path: disp, type: "other", size: lst.size, mtime, mode });
    }

    let handle;
    try {
      handle = await openReadHandle(target, true);
    } catch (err) {
      throw fsError(err as NodeJS.ErrnoException, rel);
    }

    try {
      try {
        const opened = await handle.stat();
        const openedMtime = opened.mtime.toISOString();
        const openedMode = octalMode(opened.mode);
        if (opened.isDirectory()) {
          return JSON.stringify({
            path: disp,
            type: "directory",
            size: opened.size,
            mtime: openedMtime,
            mode: openedMode,
          });
        }
        if (!opened.isFile()) {
          return JSON.stringify({
            path: disp,
            type: "other",
            size: opened.size,
            mtime: openedMtime,
            mode: openedMode,
          });
        }

        const buf = Buffer.alloc(Math.min(HEAD_BYTES, opened.size));
        const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
        const head = buf.subarray(0, bytesRead);
        return JSON.stringify({
          path: disp,
          type: "file",
          size: opened.size,
          mtime: openedMtime,
          mode: openedMode,
          binary: isBinary(head),
          mime: sniffImageMime(head),
        });
      } finally {
        await handle.close();
      }
    } catch (err) {
      throw fsError(err as NodeJS.ErrnoException, rel);
    }
  },
};
