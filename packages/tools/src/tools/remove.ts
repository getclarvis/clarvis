import { fs } from "../lib/environment-fs.ts";
import path from "node:path";
import { fsyncDir } from "@clarvis/paths";
import { ToolError, fsError } from "../errors.ts";
import { resolveFileToolPath, displayPath } from "../lib/paths.ts";
import { withFileLock, applyOpsAtomic } from "../lib/atomic.ts";
import type { ToolDef } from "./types.ts";

/**
 * The `remove` tool: delete one file, symlink entry, empty directory, or recursive tree.
 *
 * @remarks
 * A nonempty tree requires `recursive: true`.
 * The target is `lstat`-ed (not followed) before any delete; a missing path
 * fails with `not_found` via {@link fsError}. All variants hold
 * {@link withFileLock}. Files and symlink entries use {@link applyOpsAtomic};
 * directory removals report a partial outcome
 * when a deletion has landed but durability or completion is uncertain.
 */
export const remove: ToolDef = {
  atomicMutation: true,
  name: "remove",
  description:
    "Delete ONE file, symlink entry, or empty directory. With recursive:true, delete a directory tree. Fails with not_found " +
    "if the path does not exist. Refuses to follow a symlink to its destination.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "File or empty directory to delete. Relative to workspace root or absolute (~ is not expanded).",
      },
      recursive: {
        type: "boolean",
        description: "Remove a directory tree. Defaults to false.",
      },
    },
    required: ["path"],
  },
  async handler(args, config) {
    const rel = args.path as string;
    const target = resolveFileToolPath(rel, config);
    const recursive = args.recursive === true;

    return withFileLock(target, async () => {
      let stat;
      try {
        stat = await fs.lstat(target);
      } catch (err) {
        throw fsError(err as NodeJS.ErrnoException, rel);
      }
      if (recursive && !stat.isDirectory())
        throw new ToolError("invalid_input", "Recursive cleanup requires a directory.", {
          path: rel,
        });
      if (stat.isDirectory()) {
        if (recursive) {
          try {
            await fs.rm(target, { recursive: true, force: false });
          } catch (error) {
            throw fsError(error as NodeJS.ErrnoException, rel);
          }
          try {
            await fsyncDir(path.dirname(target));
          } catch {
            throw new ToolError(
              "commit_partial",
              "Tree was removed but durability could not be confirmed.",
            );
          }
          return `Removed tree ${displayPath(target, config.workspaceRoot)}.`;
        }
        try {
          const directory = await fs.opendir(target);
          try {
            if ((await directory.read()) !== null)
              throw new ToolError("invalid_input", `Directory is not empty: ${rel}`, { path: rel });
          } finally {
            await directory.close();
          }
        } catch (error) {
          if (error instanceof ToolError) throw error;
          throw fsError(error as NodeJS.ErrnoException, rel);
        }
        const commit = async (): Promise<void> => {
          try {
            await fs.rmdir(target);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOTEMPTY")
              throw new ToolError("invalid_input", `Directory is not empty: ${rel}`, { path: rel });
            throw fsError(error as NodeJS.ErrnoException, rel);
          }
          try {
            await fsyncDir(path.dirname(target));
          } catch {
            throw new ToolError(
              "commit_partial",
              `Directory was removed but durability could not be confirmed: ${rel}`,
              { path: rel },
            );
          }
        };
        await commit();
        return `Removed empty directory ${displayPath(target, config.workspaceRoot)}.`;
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
