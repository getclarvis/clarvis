import { ToolError } from "../errors.ts";
import { readFileOptions } from "../lib/files.ts";
import { resolvePath, displayPath } from "../lib/paths.ts";
import { writeAtomic, withFileLock } from "../lib/atomic.ts";
import { reencode } from "../lib/text.ts";
import { readTextFile } from "../lib/textfile.ts";
import { findCascadeMatch, scanLineBlocks, trimEnds } from "../lib/match-cascade.ts";
import { unifiedDiff } from "../lib/unified-diff.ts";
import type { RuntimeConfig } from "../config.ts";
import type { ToolDef } from "./types.ts";
import type { ToolResult } from "./content.ts";

/**
 * Read a text file under an exclusive lock, apply `transform` to its decoded
 * UTF-8 content, and write the result back atomically in the file's original
 * encoding. The shared core behind {@link editFile} and {@link multiEdit}.
 *
 * @param target - absolute, already-resolved path of the file to edit.
 * @param relPath - the caller-facing path, echoed in error messages.
 * @param config - the resolved server configuration (`maxFileBytes`,
 *   `workspaceRoot`).
 * @param transform - maps the current content to its replacement; invoked once,
 *   inside the lock. Its own throws (e.g. from {@link applyEdit}) propagate.
 * @param message - builds the success line from the file's display path.
 * @returns a {@link ToolResult} whose text is `message(rel)`, with a unified
 *   diff of the change in `meta.diff`.
 * @throws {@link ToolError} with code `is_binary` when the file does not decode
 *   as UTF-8, since rewriting it would corrupt the non-text bytes.
 * @remarks The write preserves the file's original line endings and BOM via
 *   {@link reencode}; only the content is changed.
 */
export async function editFileLocked(
  target: string,
  relPath: string,
  config: RuntimeConfig,
  transform: (content: string) => string,
  message: (rel: string) => string,
): Promise<ToolResult> {
  return withFileLock(target, async () => {
    const decoded = await readTextFile(
      target,
      relPath,
      config.maxFileBytes,
      readFileOptions(config),
    );
    if (decoded.encoding !== "utf8") {
      throw new ToolError(
        "is_binary",
        `Editing ${decoded.encoding} files is not supported (the file would be rewritten as ` +
          `UTF-8): ${relPath}`,
        { path: relPath, encoding: decoded.encoding },
      );
    }
    const newText = transform(decoded.content);
    await writeAtomic(target, reencode(newText, decoded));
    const rel = displayPath(target, config.workspaceRoot);
    const content = message(rel);
    const diff = unifiedDiff(rel, decoded.content, newText, config.maxDiffInputBytes);
    return diff ? { content, meta: { diff } } : { content };
  });
}

/** A single literal find/replace request applied by {@link applyEdit}. */
export interface EditSpec {
  /** Exact text to find, matched byte-for-byte (not a regex). */
  old_string: string;
  /** Replacement text; may be empty to delete the matched text. */
  new_string: string;
  /** When true, replace every occurrence instead of requiring a unique match. */
  replace_all?: boolean;
}

/**
 * Count the non-overlapping occurrences of `needle` in `haystack`.
 *
 * @returns the occurrence count, or 0 when `needle` is empty.
 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * List the 1-based line numbers where `needle` begins, for reporting an
 * ambiguous match.
 *
 * @param cap - stop after this many occurrences (default 20).
 * @returns the starting line of each of the first `cap` occurrences.
 */
function occurrenceLines(text: string, needle: string, cap = 20): number[] {
  const lines: number[] = [];
  let idx = text.indexOf(needle);
  while (idx !== -1 && lines.length < cap) {
    lines.push(text.slice(0, idx).split("\n").length);
    idx = text.indexOf(needle, idx + needle.length);
  }
  return lines;
}

/**
 * Build a human-readable hint appended to a `no_match` error, explaining the
 * likely reason `needle` was not found.
 *
 * @returns a leading-space sentence when a cause is detected - `needle` still
 *   carries read_file's line-number prefixes, or the text is present but with
 *   different leading/trailing whitespace (naming up to five candidate lines) -
 *   otherwise the empty string.
 */
function diagnoseNoMatch(text: string, needle: string): string {
  if (needle === "") return "";
  const destripped = needle
    .split("\n")
    .map((l) => l.replace(/^\s*\d+\t/, ""))
    .join("\n");
  if (destripped !== needle && destripped !== "" && text.includes(destripped)) {
    return (
      " It looks like old_string still contains read_file's line-number prefixes " +
      '(e.g. "   12\\t"): drop them so old_string is only the file\'s own text.'
    );
  }

  const hay = text.split("\n");
  const need = needle.split("\n").map(trimEnds);
  const hits = scanLineBlocks(hay, need, (a, b) => trimEnds(a) === b, 6).map((i) => i + 1);
  if (hits.length > 0) {
    const shown = hits.slice(0, 5).join(", ");
    const where =
      hits.length === 1 ? `line ${shown}` : `lines ${shown}${hits.length > 5 ? ", …" : ""}`;
    return (
      ` The text is present at ${where} but its leading/trailing whitespace differs from ` +
      "old_string. Re-read that region with read_file and copy the indentation verbatim."
    );
  }
  return "";
}

/**
 * Apply a single {@link EditSpec} to `text`, resolving the match exactly first
 * and falling back to a whitespace-tolerant search when appropriate.
 *
 * @param text - the current file content.
 * @param spec - the literal replacement to apply.
 * @returns the transformed `text`, the `count` of occurrences replaced, and
 *   `fuzzy` - true only when no exact match existed but a whitespace-tolerant
 *   cascade ({@link findCascadeMatch}) matched a single region.
 * @throws {@link ToolError} `invalid_input` when `old_string` equals
 *   `new_string`; `no_match` when `old_string` is absent (message extended with
 *   {@link diagnoseNoMatch}); `ambiguous_match` when it occurs more than once
 *   without `replace_all`, or when the fuzzy cascade matches several regions.
 * @remarks The fuzzy fallback is only attempted for a single-match request that
 *   missed exactly; with `replace_all` every exact occurrence is replaced and no
 *   fuzzy search runs.
 */
export function applyEdit(
  text: string,
  spec: EditSpec,
): { text: string; count: number; fuzzy: boolean } {
  if (spec.old_string === spec.new_string) {
    throw new ToolError(
      "invalid_input",
      "old_string and new_string are identical — nothing to change.",
    );
  }
  const count = countOccurrences(text, spec.old_string);
  if (count === 0) {
    if (!spec.replace_all) {
      const m = findCascadeMatch(text, spec.old_string);
      if (m && m.spans.length === 1) {
        const { start, end } = m.spans[0]!;
        return {
          text: text.slice(0, start) + spec.new_string + text.slice(end),
          count: 1,
          fuzzy: true,
        };
      }
      if (m) {
        const lines = m.spans.map((s) => text.slice(0, s.start).split("\n").length);
        throw new ToolError(
          "ambiguous_match",
          `old_string was not found exactly; after whitespace-tolerant matching it matched ` +
            `${m.spans.length} regions (at lines ${lines.join(", ")}); it must be unique. Add ` +
            "surrounding lines, or correct the whitespace so it matches one region exactly.",
          { lines },
        );
      }
    }
    throw new ToolError(
      "no_match",
      "old_string not found. It must match the file byte-for-byte (whitespace, " +
        "indentation, and line breaks included) and must NOT include the line-number " +
        "prefixes shown by read_file. Re-read the exact region and copy the text verbatim." +
        diagnoseNoMatch(text, spec.old_string),
    );
  }
  if (count > 1 && !spec.replace_all) {
    const lines = occurrenceLines(text, spec.old_string);
    const at =
      lines.length > 0
        ? ` (at line${lines.length === 1 ? "" : "s"} ${lines.join(", ")}${count > lines.length ? ", …" : ""})`
        : "";
    throw new ToolError(
      "ambiguous_match",
      `old_string matched ${count} times${at}; it must be unique. Add surrounding lines to ` +
        "make the match unique, or pass replace_all: true to replace every occurrence.",
    );
  }
  if (spec.replace_all) {
    return { text: text.split(spec.old_string).join(spec.new_string), count, fuzzy: false };
  }
  const idx = text.indexOf(spec.old_string);
  return {
    text: text.slice(0, idx) + spec.new_string + text.slice(idx + spec.old_string.length),
    count: 1,
    fuzzy: false,
  };
}

/**
 * The `edit_file` {@link ToolDef}: replace one literal occurrence of
 * `old_string` with `new_string` in an existing text file, or every occurrence
 * when `replace_all` is set.
 *
 * @remarks
 * Runs {@link applyEdit} inside {@link editFileLocked}, so the whole edit is
 * serialized per file and written atomically in the file's original encoding.
 * When {@link applyEdit} reports a fuzzy (whitespace-tolerant) match, the
 * success message warns that the region was replaced verbatim and should be
 * re-read to verify indentation. Failures surface as {@link ToolError}s from
 * {@link applyEdit} (`no_match`, `ambiguous_match`, `invalid_input`) or from
 * {@link editFileLocked} (`is_binary`).
 */
export const editFile: ToolDef = {
  name: "edit_file",
  description:
    "Replace one exact occurrence of `old_string` with `new_string` in a file. `old_string` is " +
    "matched LITERALLY (not a regex), exactly as read_file shows the text — including whitespace, " +
    "indentation, and line breaks — but WITHOUT read_file's line-number/tab prefixes. The match " +
    "MUST be unique: if it appears more than once the call fails (`ambiguous_match`) unless " +
    "`replace_all` is set; if not found it fails (`no_match`). On failure, re-read the region and " +
    "copy more surrounding lines verbatim, or set replace_all. For several edits to ONE file use " +
    "multi_edit; to change MANY files use apply_patch.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "File to edit. Relative to workspace root or absolute. Must already exist and be text " +
          "(binary is rejected).",
      },
      old_string: {
        type: "string",
        minLength: 1,
        description:
          "Exact text to find. Copy it verbatim from read_file output with the line-number/tab " +
          "prefix removed; whitespace, indentation, and newlines must match. Not a regex.",
      },
      new_string: {
        type: "string",
        description:
          "Replacement text. May be empty to delete the matched text. Must differ from old_string.",
      },
      replace_all: {
        type: "boolean",
        default: false,
        description:
          "Replace every occurrence instead of requiring a single unique match. Default false.",
      },
    },
    required: ["path", "old_string", "new_string"],
  },
  async handler(args, config) {
    const target = resolvePath(
      args.path as string,
      config.workspaceRoot,
      config.confineToWorkspace,
      config.temporaryRoots,
      config.logger,
    );
    let count = 0;
    let fuzzy = false;
    return editFileLocked(
      target,
      args.path as string,
      config,
      (content) => {
        const r = applyEdit(content, {
          old_string: args.old_string as string,
          new_string: args.new_string as string,
          replace_all: args.replace_all as boolean,
        });
        count = r.count;
        fuzzy = r.fuzzy;
        return r.text;
      },
      (rel) =>
        fuzzy
          ? `Replaced 1 occurrence in ${rel} (matched after a whitespace-tolerant search; the ` +
            "matched region — including its leading indentation — was replaced by new_string " +
            "verbatim, so re-read the file to verify the indentation is correct)."
          : `Replaced ${count} ${count === 1 ? "occurrence" : "occurrences"} in ${rel}.`,
    );
  },
};
