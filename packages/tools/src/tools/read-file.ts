import { ToolError } from "../errors.ts";
import { readFileOptions } from "../lib/files.ts";
import { resolvePath } from "../lib/paths.ts";
import { renderNumberedSlice } from "../lib/render-lines.ts";
import { splitLines } from "../lib/text.ts";
import { readTextFile } from "../lib/textfile.ts";
import type { ToolDef } from "./types.ts";

const DEFAULT_LIMIT = 2000;

/**
 * The `read_file` tool: read a UTF-8 text file and return it with 1-indexed
 * `cat -n`-style line-number prefixes, paging a long file in windows of at most
 * {@link DEFAULT_LIMIT} lines.
 *
 * @remarks
 * The handler resolves `path` against the workspace root (see
 * {@link resolvePath}) and reads through {@link readTextFile}, which rejects
 * binary files and enforces `config.maxFileBytes`. An empty file yields the
 * literal `(empty file)`. `offset` is 1-indexed: a positive value must be `<=`
 * the file's line count, a negative value counts from the end (`-10` reads the
 * last 10 lines), and `0` is rejected as invalid. The returned slice is further
 * clamped to `config.maxOutputBytes`, so fewer than `limit` lines may come back;
 * when more lines remain a footer names the next `offset` to continue from. This
 * tool is {@link ToolDef.bounded | bounded} - it manages its own output size and
 * the dispatcher must not re-clamp it.
 * @throws {@link ToolError} with code `invalid_input` when `offset` is `0` or a
 *   positive `offset` exceeds the file's line count; other failures (missing,
 *   binary, or oversized file) surface from {@link readTextFile}.
 */
export const readFile: ToolDef = {
  name: "read_file",
  description:
    "Read a UTF-8 text file, returned with 1-indexed line-number prefixes (like `cat -n`). Reads " +
    "up to 2000 lines from `offset`; if more remain, a footer gives the next `offset` to continue " +
    "from. NEVER use to search large files for a string — use grep. If you do not know the path, " +
    "use glob or list_dir first. Binary files are rejected. Output is byte-bounded from the head, so " +
    "an oversized result loses its tail, not its middle — page with `offset` rather than pulling a " +
    "huge file in one call.",
  bounded: true,
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File to read. Relative to workspace root or absolute (~ is not expanded).",
      },
      offset: {
        type: "integer",
        description:
          "1-indexed first line to read. Default 1. A negative value counts from the end (e.g. " +
          "-10 reads the last 10 lines); 0 is invalid. A positive offset must be <= the file's " +
          "line count.",
      },
      limit: {
        type: "integer",
        minimum: 0,
        description:
          "Max number of lines to return. Default 2000. Page through a long file by repeating " +
          "with offset advanced per the footer.",
      },
    },
    required: ["path"],
  },
  async handler(args, config) {
    const relPath = args.path as string;
    const target = resolvePath(
      relPath,
      config.workspaceRoot,
      config.confineToWorkspace,
      [config.stateRoot, ...config.temporaryRoots],
      config.logger,
    );
    const offset = (args.offset as number | undefined) ?? 1;
    const limit = (args.limit as number | undefined) || DEFAULT_LIMIT;

    const text = (
      await readTextFile(
        target,
        relPath,
        config.maxFileBytes,
        readFileOptions(config, [config.stateRoot]),
      )
    ).content;

    if (text === "") return "(empty file)";
    const lines = splitLines(text);
    const total = lines.length;

    if (offset === 0) {
      throw new ToolError(
        "invalid_input",
        "offset must be non-zero: use a positive 1-indexed line, or a negative tail offset.",
        { path: relPath },
      );
    }
    let start1: number;
    if (offset < 0) {
      start1 = Math.max(1, total + offset + 1);
    } else {
      if (total > 0 && offset > total) {
        throw new ToolError(
          "invalid_input",
          `offset ${offset} exceeds file line count ${total}; read from offset 1..${total}`,
          { path: relPath, line_count: total },
        );
      }
      start1 = offset;
    }

    const start = start1 - 1;
    const hardEnd = Math.min(total, start + limit);
    const { body, shownLines } = renderNumberedSlice(lines, start, hardEnd, config.maxOutputBytes);
    const end = start + shownLines;

    if (end < total) {
      const footer = `[... ${shownLines} of ${total} lines shown; continue with offset=${end + 1} ...]`;
      return body === "" ? footer : `${body}\n${footer}`;
    }
    return body;
  },
};
