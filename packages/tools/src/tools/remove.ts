import { fs } from "../lib/environment-fs.ts";
import path from "node:path";
import { configurationRoots, fsyncDir } from "@clarvis/paths";
import { ToolError, fsError } from "../errors.ts";
import {
  resolveFileToolPath,
  displayPath,
  assertOutsideRoots,
  isWithinRoots,
} from "../lib/paths.ts";
import { withFileLock, applyOpsAtomic } from "../lib/atomic.ts";
import { scanSmallTree } from "../lib/small-tree.ts";
import type { ToolDef } from "./types.ts";

/**
 * The `remove` tool: delete one file, symlink entry, empty directory, or reviewed small tree.
 *
 * @remarks
 * A bounded nonempty tree requires `recursive: true` and a mutation review channel.
 * The target is `lstat`-ed (not followed) before any delete; a missing path
 * fails with `not_found` via {@link fsError}. All variants hold
 * {@link withFileLock}. Files and symlink entries use {@link applyOpsAtomic};
 * directory removals use their reviewed commits and report a partial outcome
 * when a deletion has landed but durability or completion is uncertain.
 */
export const remove: ToolDef = {
  atomicMutation: true,
  name: "remove",
  description:
    "Delete ONE file, symlink entry, or empty directory. With recursive:true, delete a bounded " +
    "ordinary workspace tree after explicit review of every target. Fails with not_found " +
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
        description:
          "Remove a small ordinary directory tree after effect review. Defaults to false.",
      },
    },
    required: ["path"],
  },
  async handler(args, config) {
    const rel = args.path as string;
    const target = resolveFileToolPath(rel, config);
    let recursive = args.recursive === true;

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
        if (target === config.workspaceRoot || config.temporaryRoots.includes(target))
          throw new ToolError("denied", `Cannot remove an execution root: ${rel}`, { path: rel });
        if (recursive) {
          let directory;
          try {
            directory = await fs.opendir(target);
          } catch (error) {
            throw fsError(error as NodeJS.ErrnoException, rel);
          }
          try {
            recursive = (await directory.read()) !== null;
          } finally {
            await directory.close();
          }
        }
        if (recursive) {
          if (config.reviewMutation === undefined)
            throw new ToolError(
              "approval_unavailable",
              "Recursive cleanup requires a review channel.",
            );
          const selected = config.workspaceRoot;
          const local = path.relative(selected, target);
          if (
            local === "" ||
            local === ".." ||
            path.isAbsolute(local) ||
            local.startsWith(`..${path.sep}`) ||
            !isWithinRoots(target, [selected])
          )
            throw new ToolError("denied", "Recursive cleanup requires a workspace tree.");
          const protectedRoots = [
            ...Object.values(
              config.configurationRoots ??
                configurationRoots({ workspaceRoot: config.workspaceRoot }),
            ),
            ...config.skillExecutionRoots,
            ...config.gitMetadataPaths,
            config.stateRoot,
          ];
          assertOutsideRoots(target, protectedRoots, rel, { rejectAncestors: true });
          let current = target;
          while (current !== selected) {
            const entry = await fs.lstat(current);
            if (entry.isSymbolicLink())
              throw new ToolError("denied", "Recursive cleanup refuses symlinked path components.");
            current = path.dirname(current);
          }
          const snapshot = scanSmallTree(target);
          const operation = {
            type: "rmtree" as const,
            path: target,
            treeEntries: snapshot.entries,
            treeRevision: snapshot.revision,
          };
          const commit = async (): Promise<void> => {
            let current;
            try {
              current = scanSmallTree(target);
            } catch (error) {
              if (error instanceof ToolError && error.code === "not_found")
                throw new ToolError("revision_conflict", "Directory tree changed during review.");
              throw error;
            }
            if (
              current.revision !== snapshot.revision ||
              JSON.stringify(current.entries) !== JSON.stringify(snapshot.entries)
            )
              throw new ToolError("revision_conflict", "Directory tree changed during review.");
            try {
              await fs.rm(target, { recursive: true, force: false });
            } catch (error) {
              const unchanged = (() => {
                try {
                  return scanSmallTree(target).revision === snapshot.revision;
                } catch {
                  return false;
                }
              })();
              if (!unchanged)
                throw new ToolError(
                  "commit_partial",
                  "Recursive cleanup may have removed some entries.",
                );
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
          };
          await config.reviewMutation([operation], commit);
          return `Removed reviewed tree ${displayPath(target, config.workspaceRoot)} (${snapshot.entries.length} entries).`;
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
        if (config.reviewMutation !== undefined)
          await config.reviewMutation([{ type: "rmdir", path: target }], commit);
        else await commit();
        return `Removed empty directory ${displayPath(target, config.workspaceRoot)}.`;
      }

      try {
        await applyOpsAtomic([{ type: "delete", path: target }], config.reviewMutation);
      } catch (err) {
        if (err instanceof ToolError) throw err;
        throw fsError(err as NodeJS.ErrnoException, rel);
      }
      return `Removed ${displayPath(target, config.workspaceRoot)}.`;
    });
  },
};
