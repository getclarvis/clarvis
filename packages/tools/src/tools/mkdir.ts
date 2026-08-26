import { promises as fs } from "node:fs";
import { ToolError, fsError } from "../errors.ts";
import { resolvePath, displayPath } from "../lib/paths.ts";
import type { ToolDef } from "./types.ts";

/**
 * The `mkdir` tool: create a directory and any missing parents (like
 * `mkdir -p`), confined to the workspace.
 *
 * @remarks
 * Idempotent - creating an already-existing directory succeeds and reports so.
 * When the path already exists as a file (rather than a directory), the
 * underlying `EEXIST` is surfaced as a `not_a_file` {@link ToolError}. Because
 * `write_file` already creates parent directories for a file, this tool is only
 * needed to materialize an empty directory. The handler returns a
 * human-readable summary distinguishing a freshly created directory from one
 * that already existed (Node's `mkdir` returns the first created path, or
 * `undefined` when nothing was created).
 */
export const mkdir: ToolDef = {
  name: "mkdir",
  description:
    "Create a directory, including any missing parent directories (like `mkdir -p`). Idempotent: " +
    "succeeds if the directory already exists. Fails if the path already exists as a file. " +
    "write_file already creates parents for a file, so use this only to create an empty directory.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Directory to create. Relative to workspace root or absolute (~ is not expanded). " +
          "Missing parent directories are created.",
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

    let firstCreated: string | undefined;
    try {
      firstCreated = await fs.mkdir(target, { recursive: true });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "EEXIST") {
        throw new ToolError("not_a_file", `Path exists and is not a directory: ${rel}`, {
          path: rel,
        });
      }
      throw fsError(e, rel);
    }

    const disp = displayPath(target, config.workspaceRoot);
    return firstCreated === undefined
      ? `Directory already exists: ${disp}.`
      : `Created directory ${disp}.`;
  },
};
