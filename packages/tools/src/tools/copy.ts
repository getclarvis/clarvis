import { promises as fs } from "node:fs";
import path from "node:path";
import { fsyncDir, renameWithRetry, tmpPathFor } from "@clarvis/paths";
import { ToolError, fsError } from "../errors.ts";
import { resolvePath, displayPath } from "../lib/paths.ts";
import { withFileLocks, assertNotSymlink, RM_RETRY } from "../lib/atomic.ts";
import type { ToolDef } from "./types.ts";

/**
 * The `copy` tool: atomically copy a single regular file (binary-safe),
 * preserving its permission mode, confined to the workspace.
 *
 * @remarks
 * A directory source is rejected (`not_a_file`) - use shell for directory copies.
 * Source and destination are locked together ({@link withFileLocks}) and both
 * are checked to not be symlinks before any work. The copy refuses when the
 * destination already exists unless `overwrite` is true; a destination that is a
 * directory is always rejected. Atomicity comes from copying into a temp file in
 * the destination directory, chmod-ing it to the source's mode (low 9 bits),
 * then `fs.rename`-ing it into place and fsyncing the directory; the temp file is
 * removed on any failure. Passing the same path for source and destination fails
 * with `invalid_input`. The handler returns a human-readable summary noting when
 * an existing file was overwritten.
 */
export const copy: ToolDef = {
  name: "copy",
  description:
    "Copy ONE file (atomic, binary-safe). Operates on regular files only — a directory source is " +
    "rejected; use shell for directory copies. The source's permission mode is preserved. Refuses " +
    "if `destination` already exists unless `overwrite` is true. Missing parent directories of the " +
    "destination are created. To move (remove the source) use move instead.",
  inputSchema: {
    type: "object",
    properties: {
      source: {
        type: "string",
        description: "File to copy. Relative to workspace root or absolute (~ is not expanded).",
      },
      destination: {
        type: "string",
        description:
          "Copy target. Relative to workspace root or absolute. Missing parent dirs are created.",
      },
      overwrite: {
        type: "boolean",
        default: false,
        description: "When true, replace an existing destination file. Default: false (refuse).",
      },
    },
    required: ["source", "destination"],
  },
  async handler(args, config) {
    const srcRel = args.source as string;
    const dstRel = args.destination as string;
    const overwrite = args.overwrite as boolean;
    const absSrc = resolvePath(
      srcRel,
      config.workspaceRoot,
      config.confineToWorkspace,
      config.temporaryRoots,
      config.logger,
    );
    const absDst = resolvePath(
      dstRel,
      config.workspaceRoot,
      config.confineToWorkspace,
      config.temporaryRoots,
      config.logger,
    );

    if (absSrc === absDst) {
      throw new ToolError("invalid_input", `Source and destination are the same: ${srcRel}`, {
        path: srcRel,
      });
    }

    return withFileLocks([absSrc, absDst], async () => {
      await assertNotSymlink(absSrc);
      await assertNotSymlink(absDst);

      let srcStat;
      try {
        srcStat = await fs.stat(absSrc);
      } catch (err) {
        throw fsError(err as NodeJS.ErrnoException, srcRel);
      }
      if (srcStat.isDirectory()) {
        throw new ToolError("not_a_file", `Source is a directory (files only): ${srcRel}`, {
          path: srcRel,
        });
      }

      let dstExists = false;
      try {
        const dstStat = await fs.stat(absDst);
        dstExists = true;
        if (dstStat.isDirectory()) {
          throw new ToolError("not_a_file", `Destination is a directory: ${dstRel}`, {
            path: dstRel,
          });
        }
      } catch (err) {
        if (err instanceof ToolError) throw err;
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "ENOENT") throw fsError(e, dstRel);
      }
      if (dstExists && !overwrite) {
        throw new ToolError(
          "invalid_input",
          `Destination already exists: ${dstRel} (pass overwrite: true to replace it)`,
          { path: dstRel },
        );
      }

      const dstDir = path.dirname(absDst);
      const tmp = tmpPathFor(absDst);
      try {
        await fs.mkdir(dstDir, { recursive: true });
        await fs.copyFile(absSrc, tmp);
        await fs.chmod(tmp, srcStat.mode & 0o777);
        await renameWithRetry(tmp, absDst);
      } catch (err) {
        await fs.rm(tmp, { force: true, ...RM_RETRY });
        throw fsError(err as NodeJS.ErrnoException, dstRel);
      }
      await fsyncDir(dstDir);

      const from = displayPath(absSrc, config.workspaceRoot);
      const to = displayPath(absDst, config.workspaceRoot);
      return `Copied ${from} → ${to}${dstExists ? " (overwritten)" : ""}.`;
    });
  },
};
