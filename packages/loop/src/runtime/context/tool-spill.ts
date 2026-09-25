import { sanitizeErrorMessage } from "@clarvis/capability";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  ensureWorkspaceLocalDir,
  FILE_MODE,
  workspaceStatePaths,
  type WorkspaceStatePaths,
} from "@clarvis/paths";

import type { Logger } from "@clarvis/capability";

/**
 * Persists an oversized tool result and reports where the model can read it.
 *
 * @param text - the untruncated tool result.
 * @returns the absolute path of the spilled file, or `undefined` when the write
 *   failed.
 */
export type ToolSpill = (text: string) => Promise<string | undefined>;

/**
 * Build the run's tool-result spill port.
 *
 * @param workspaceRoot - the workspace whose state directory receives the file.
 * @param logger - optional sink for a failed write.
 * @returns a {@link ToolSpill} that never throws and never rejects.
 * @remarks The port exists so {@link import("./context-compaction.ts").LiveContext}
 *   can stay synchronous and I/O-free — it receives a resolved path, not the
 *   ability to write one. `workspaceRoot` is bound once per run, where it is
 *   already known, rather than being threaded into the loop's config object.
 *
 *   A failure degrades to the marker without a path rather than failing the run,
 *   preserving the run when one oversized tool result cannot be retained in full.
 *
 *   The file sits in the workspace's *state* tree under the user's global root,
 *   so it is outside the working tree and cannot be committed by accident. The
 *   model still reads it back: `read_file` admits only this exact
 *   generic spill file in the current workspace's local state. The returned
 *   path is absolute for that reason.
 */
export function createToolSpill(
  workspaceRoot: string | WorkspaceStatePaths,
  logger?: Logger,
): ToolSpill {
  const paths =
    typeof workspaceRoot === "string" ? workspaceStatePaths(workspaceRoot) : workspaceRoot;
  return async (text: string): Promise<string | undefined> => {
    const absPath = paths.toolOutputSpill(randomBytes(4).toString("hex"));
    try {
      ensureWorkspaceLocalDir(paths);
      await writeFile(absPath, text, { encoding: "utf8", mode: FILE_MODE });
      return absPath.split(path.sep).join("/");
    } catch (err) {
      logger?.warn(
        {
          event: "tool.spill_failed",
          path: sanitizeErrorMessage(absPath),
          err: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
        },
        "could not spill an oversized tool result; its middle is unrecoverable",
      );
      return undefined;
    }
  };
}
