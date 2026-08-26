import { sanitizeErrorMessage } from "@clarvis/capability";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { ensureWorkspaceLocalDir, FILE_MODE, workspaceStatePaths } from "@clarvis/paths";

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
 *   matching `boundOrSpill`'s posture in `@clarvis/tools`: losing the middle of
 *   one tool result is a bad outcome, and losing the run over it is a worse one.
 *
 *   The file sits in the workspace's *state* tree under the user's global root,
 *   so it is outside the working tree and cannot be committed by accident. The
 *   model still reads it back: `read_file` and `read_files` admit
 *   `RuntimeConfig.stateRoot` alongside the workspace when confining a path, and
 *   the returned path is absolute for that reason. The shell tool's own spill
 *   depends on the same allowance.
 */
export function createToolSpill(workspaceRoot: string, logger?: Logger): ToolSpill {
  const paths = workspaceStatePaths(workspaceRoot);
  return async (text: string): Promise<string | undefined> => {
    const absPath = paths.toolOutputSpill(randomBytes(4).toString("hex"));
    try {
      ensureWorkspaceLocalDir(workspaceRoot);
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
