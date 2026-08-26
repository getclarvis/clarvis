import { promises as fs } from "node:fs";
import { ToolError, fsError } from "../errors.ts";
import { resolvePath, displayPath } from "../lib/paths.ts";
import { withFileLock, applyOpsAtomic } from "../lib/atomic.ts";
import type { ToolDef } from "./types.ts";

/**
 * The `remove` tool: delete a single regular file, confined to the workspace.
 *
 * @remarks
 * A directory is rejected (`not_a_file`) - use shell for recursive directory
 * removal. The target is `lstat`-ed (not followed) to catch a directory before
 * any delete; a missing path fails with `not_found` via {@link fsError}. The
 * delete runs under a per-file lock ({@link withFileLock}) through
 * {@link applyOpsAtomic}, whose symlink guard refuses a symlink target with
 * `invalid_input` (it is never unlinked) and which serializes the delete against
 * concurrent writers of the same path.
 */
export const remove: ToolDef = {
  name: "remove",
  description:
    "Delete ONE file. Operates on regular files only — a directory is rejected; use shell for " +
    "recursive directory removal. Fails with not_found if the path does not exist. Refuses to " +
    "delete through a symlink.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File to delete. Relative to workspace root or absolute (~ is not expanded).",
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

    return withFileLock(target, async () => {
      let stat;
      try {
        stat = await fs.lstat(target);
      } catch (err) {
        throw fsError(err as NodeJS.ErrnoException, rel);
      }
      if (stat.isDirectory()) {
        throw new ToolError("not_a_file", `Path is a directory (files only): ${rel}`, {
          path: rel,
        });
      }

      try {
        await applyOpsAtomic([{ type: "delete", path: target }]);
      } catch (err) {
        if (err instanceof ToolError) throw err;
        throw fsError(err as NodeJS.ErrnoException, rel);
      }
      return `Removed ${displayPath(target, config.workspaceRoot)}.`;
    });
  },
};
