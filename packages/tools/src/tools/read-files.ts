import { ToolError } from "../errors.ts";
import { readFileOptions } from "../lib/files.ts";
import { bound } from "../lib/output.ts";
import { resolvePath } from "../lib/paths.ts";
import { renderNumberedSlice } from "../lib/render-lines.ts";
import { splitLines } from "../lib/text.ts";
import { readTextFile } from "../lib/textfile.ts";
import type { ToolDef } from "./types.ts";

const MAX_PATHS = 64;

/**
 * The trailing line naming how many paths the budget left unread.
 *
 * @remarks A function rather than a literal at the append site because the loop
 *   has to reserve its bytes *before* filling the section that might be the last
 *   one - appending it afterwards is how the tool used to overrun the very
 *   `maxOutputBytes` its {@link ToolDef.bounded} flag promises it respects.
 */
function omittedNotice(omitted: number): string {
  return `[... ${String(omitted)} more file(s) not shown; call read_files with fewer paths ...]`;
}

/**
 * The per-section line naming how much of one file was shown.
 *
 * @remarks Reserved the same way {@link omittedNotice} is, and for the same
 *   reason: it is appended once the slice has already spent its budget. Its
 *   worst case is `shown === total`, which is what the loop reserves, since the
 *   two counts can never have more digits than the file has lines.
 */
function cappedNotice(shown: number, total: number): string {
  return `\n[... ${String(shown)} of ${String(total)} lines shown; use read_file for the rest ...]`;
}

/**
 * Room held back for {@link bound}'s own truncation marker, which it appends
 * *past* the ceiling it is given.
 */
const TRUNCATION_MARKER_RESERVE = 96;

/**
 * The `read_files` tool: read up to {@link MAX_PATHS} UTF-8 text files in one
 * call, each returned with 1-indexed line-number prefixes under a
 * `==> <path> <==` header.
 *
 * @remarks
 * Files are read in order into a shared `config.maxOutputBytes`
 * budget. A per-entry failure (missing, binary, directory, or oversized) is
 * caught when it is a {@link ToolError} and rendered as an error header line
 * rather than failing the whole call; any other error propagates. A single file
 * that would overflow the remaining budget is truncated with a `use read_file
 * for the rest` note; once the budget is exhausted the remaining paths are
 * dropped and a trailing `more file(s) not shown` line is appended. Sections are
 * joined by blank lines. This tool is {@link ToolDef.bounded | bounded} - it
 * tracks its own output size and the dispatcher must not re-clamp it, so the
 * budget has to hold for the trailing notice as well: while any path remains
 * unread the loop keeps that line's own bytes in reserve, and an error section
 * (whose length comes from a message rather than from a slice budget) is capped
 * like any other output.
 */
export const readFiles: ToolDef = {
  name: "read_files",
  description:
    "Read several UTF-8 text files in one call, each returned with 1-indexed line-number prefixes " +
    "under a `==> <path> <==` header. Use this instead of many read_file calls when you already " +
    "know the paths. A path that is missing, binary, a directory, or too large yields an error line " +
    "for that entry without failing the others. The combined output is capped; later files are " +
    "dropped if the budget runs out — read the biggest ones with read_file instead. Binary files " +
    "are rejected per entry.",
  bounded: true,
  inputSchema: {
    type: "object",
    properties: {
      paths: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: MAX_PATHS,
        description:
          "Files to read, in order. Each relative to workspace root or absolute (~ is not expanded).",
      },
    },
    required: ["paths"],
  },
  async handler(args, config) {
    const paths = args.paths as string[];
    const sections: string[] = [];
    let remaining = config.maxOutputBytes;
    let stoppedAt = -1;

    for (let idx = 0; idx < paths.length; idx++) {
      const rel = paths[idx] as string;
      const reserved =
        idx + 1 < paths.length
          ? Buffer.byteLength(omittedNotice(paths.length - idx - 1), "utf8") + 2
          : 0;
      const room = remaining - reserved;
      if (room <= TRUNCATION_MARKER_RESERVE) {
        stoppedAt = idx;
        break;
      }

      let section: string;
      try {
        const target = resolvePath(
          rel,
          config.workspaceRoot,
          config.confineToWorkspace,
          [config.stateRoot, ...config.temporaryRoots],
          config.logger,
        );
        const text = (
          await readTextFile(
            target,
            rel,
            config.maxFileBytes,
            readFileOptions(config, [config.stateRoot]),
          )
        ).content;
        const header = `==> ${rel} <==`;
        if (text === "") {
          section = `${header}\n(empty file)`;
        } else {
          const lines = splitLines(text);
          const budget =
            room -
            Buffer.byteLength(header, "utf8") -
            1 -
            Buffer.byteLength(cappedNotice(lines.length, lines.length), "utf8");
          if (budget <= 0) {
            stoppedAt = idx;
            break;
          }
          const { body, shownLines, byteCapped } = renderNumberedSlice(
            lines,
            0,
            lines.length,
            budget,
          );
          section = `${header}\n${body}`;
          if (byteCapped) section += cappedNotice(shownLines, lines.length);
        }
      } catch (err) {
        if (!(err instanceof ToolError)) throw err;
        section = bound(
          `==> ${rel} — ${err.code}: ${err.message} <==`,
          room - TRUNCATION_MARKER_RESERVE,
        );
      }

      sections.push(section);
      remaining -= Buffer.byteLength(section, "utf8") + 2;
    }

    if (stoppedAt >= 0) sections.push(omittedNotice(paths.length - stoppedAt));

    return sections.join("\n\n");
  },
};
