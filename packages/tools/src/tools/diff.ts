import { createTwoFilesPatch } from "diff";
import { readFileOptions } from "../lib/files.ts";
import { resolvePath, displayPath } from "../lib/paths.ts";
import { readTextFile } from "../lib/textfile.ts";
import type { ToolDef } from "./types.ts";
import { ToolError } from "../errors.ts";
import { DEFAULT_DIFF_TIMEOUT_MS } from "../lib/unified-diff.ts";

/**
 * The `diff` tool: a unified diff between two UTF-8 text files in the workspace,
 * without needing git.
 *
 * @remarks
 * Both `from` (left) and `to` (right) are read via {@link readTextFile}, which
 * rejects binary or oversized files (over `config.maxFileBytes`) and normalizes
 * line endings, so the comparison never trips on CRLF differences. Identical
 * content short-circuits to `(no differences)`; otherwise the result is a
 * standard unified diff (`--- from`, `+++ to`, `@@` hunks) with 3 lines of
 * context, using the workspace-relative display paths as the file labels.
 */
export const diffTool: ToolDef = {
  name: "diff",
  description:
    "Unified diff between two UTF-8 text files in the workspace, without needing git. Both paths are " +
    "read and compared; the result is a standard unified diff (`--- from`, `+++ to`, `@@` hunks). " +
    "Identical content yields `(no differences)`. Line endings are normalized before comparison. " +
    "Binary or oversized files are rejected.",
  inputSchema: {
    type: "object",
    properties: {
      from: {
        type: "string",
        description:
          "The original (left) file. Relative to workspace root or absolute (~ is not expanded).",
      },
      to: {
        type: "string",
        description:
          "The changed (right) file. Relative to workspace root or absolute (~ is not expanded).",
      },
    },
    required: ["from", "to"],
  },
  async handler(args, config) {
    const fromRel = args.from as string;
    const toRel = args.to as string;
    const fromTarget = resolvePath(
      fromRel,
      config.workspaceRoot,
      config.confineToWorkspace,
      config.temporaryRoots,
      config.logger,
    );
    const toTarget = resolvePath(
      toRel,
      config.workspaceRoot,
      config.confineToWorkspace,
      config.temporaryRoots,
      config.logger,
    );
    const options = readFileOptions(config);
    const fromContent = (await readTextFile(fromTarget, fromRel, config.maxFileBytes, options))
      .content;
    const toContent = (await readTextFile(toTarget, toRel, config.maxFileBytes, options)).content;

    if (fromContent === toContent) return "(no differences)";

    const combinedBytes =
      Buffer.byteLength(fromContent, "utf8") + Buffer.byteLength(toContent, "utf8");
    if (combinedBytes > config.maxDiffInputBytes) {
      throw new ToolError(
        "too_large",
        `Diff input is ${String(combinedBytes)} bytes, exceeding the ${String(config.maxDiffInputBytes)}-byte limit.`,
        { size: combinedBytes, limit: config.maxDiffInputBytes },
      );
    }

    const fromName = displayPath(fromTarget, config.workspaceRoot);
    const toName = displayPath(toTarget, config.workspaceRoot);
    const patch = createTwoFilesPatch(
      fromName,
      toName,
      fromContent,
      toContent,
      undefined,
      undefined,
      {
        context: 3,
        timeout: DEFAULT_DIFF_TIMEOUT_MS,
      },
    );
    if (patch === undefined) {
      throw new ToolError(
        "timeout",
        `Diff computation exceeded the ${String(DEFAULT_DIFF_TIMEOUT_MS)}ms time limit.`,
      );
    }
    return patch;
  },
};
