import { resolvePath, displayPath } from "../lib/paths.ts";
import { bound } from "../lib/output.ts";
import { countNewlines } from "../lib/text.ts";
import { grepSearch, type Match } from "../lib/rg.ts";
import type { RuntimeConfig } from "../config.ts";
import type { ToolDef } from "./types.ts";

/** The three renderings `grep` supports; the value of the `output_mode` arg. */
type OutputMode = "content" | "files_with_matches" | "count";

/** The pagination window plus the before/after context sizes threaded through
 * formatting. `before`/`after` are always 0 outside `content` mode. */
interface ContextOpts {
  before: number;
  after: number;
  offset: number;
  headLimit: number | undefined;
}

/**
 * A rendered page and the unit counts that drive the pagination footer, where a
 * "unit" is a file (`files_with_matches`/`count`) or a match anchor (`content`).
 */
interface Formatted {
  /** The formatted page text (before byte-bounding). */
  rendered: string;
  /** Total units matched across the whole search, before paging. */
  unitTotal: number;
  /** Units included on this page. */
  shownUnits: number;
}

/**
 * The `grep` tool: a regular-expression content search over the workspace,
 * implemented by {@link grepSearch} with ripgrep and byte-bounded JS engines.
 * Honors `.gitignore` and skips binary files. Renders in one of three
 * {@link OutputMode}s and pages results by result-`offset` plus optional
 * `head_limit`.
 *
 * @remarks
 * `bounded: true` - the handler returns already-clamped text, so the dispatcher
 * does not re-truncate it. An empty search yields `(no matches)` (a success, not
 * an error). Context flags (`context`/`before_context`/`after_context`) apply in
 * `content` mode only; `offset` is a 0-based result offset, not a line offset.
 * When the underlying scan hits its output cap, the result carries an explicit
 * "search incomplete" warning rather than silently returning a partial set (see
 * {@link composeResult}). Confined directory searches always run in process so
 * every file is opened and revalidated by Clarvis; ripgrep remains available
 * for a descriptor snapshot of one file and for explicitly unconfined
 * directory searches. The in-process path stops once the pattern has spent
 * `config.regexScanBudgetMs` of regular-expression time, and says so in a
 * distinct warning naming the pattern as the cause.
 */
export const grep: ToolDef = {
  name: "grep",
  description:
    "Search file CONTENTS by regular expression, recursively. Confined directory searches use a " +
    "bounded JavaScript scanner so each file stays tied to the workspace; single-file searches " +
    "may use ripgrep over an already-open snapshot. Use this to find where text or a symbol " +
    "appears — do NOT read whole files with read_file to look for a string. .gitignore and binary " +
    "files are skipped. No matches returns `(no matches)` — a success, not an error. Output is " +
    "byte-bounded from the head, so an oversized result loses its tail, not its middle — narrow the " +
    "pattern or set head_limit rather than paging through a broad match.",
  bounded: true,
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "Regular expression. Two engines read these and the pattern does not choose between " +
          "them: a confined directory search uses JavaScript RegExp, a single-file or explicitly " +
          "unconfined search uses ripgrep/Rust. Rejected by ripgrep: lookaround, backreferences, " +
          "`[[]`, and octal, `\\cX` or otherwise unrecognised `\\<letter>` escapes. Rejected by " +
          "JavaScript: `(?P<name>)`, an unscoped `(?i)`, possessive quantifiers. Read DIFFERENTLY " +
          "by the two, with no error either way: `\\A`, `\\z`, `\\p{...}`, `\\x{...}`, " +
          "`\\u{...}`, `[[:alpha:]]`, `[]]`, `\\<`/`\\>`, and `&&`/`--` inside a class; also " +
          "`\\d`/`\\w`/`\\b` and case folding, which are ASCII to JavaScript and Unicode to " +
          "ripgrep. Spellings both accept: `^`/`$` for `\\A`/`\\z`, `(?<name>)` for " +
          "`(?P<name>)`, `(?i:...)` for `(?i)`, `[\\]]` for `[]]`, `\\[` for `[[]`. Escape " +
          "regex metacharacters to match them literally.",
      },
      path: {
        type: "string",
        description:
          "File or directory to search. Relative to workspace root or absolute. Default: " +
          "workspace root.",
      },
      glob: {
        type: "string",
        description: 'Restrict the search to files matching this glob, e.g. "*.ts".',
      },
      output_mode: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
        default: "files_with_matches",
        description:
          'What to return: "files_with_matches" (default) lists matching file paths; "content" ' +
          'lists matching lines as path:line:text; "count" lists path:match_count per file.',
      },
      ignore_case: {
        type: "boolean",
        default: false,
        description: "Case-insensitive matching. Default false.",
      },
      multiline: {
        type: "boolean",
        default: false,
        description:
          "Match across line boundaries. When true, `.` also matches newlines and `^`/`$` anchor " +
          "at line boundaries, so one match may span multiple lines. Applies in all output modes. " +
          "Default false.",
      },
      context: {
        type: "integer",
        minimum: 0,
        default: 0,
        description:
          "Lines of context on BOTH sides of each match (shorthand for before_context and " +
          "after_context). Applies to content mode only. Default 0.",
      },
      before_context: {
        type: "integer",
        minimum: 0,
        description:
          "Lines of context BEFORE each match (ripgrep -B); overrides `context` for the before " +
          "side. Content mode only.",
      },
      after_context: {
        type: "integer",
        minimum: 0,
        description:
          "Lines of context AFTER each match (ripgrep -A); overrides `context` for the after " +
          "side. Content mode only.",
      },
      head_limit: {
        type: "integer",
        minimum: 0,
        description:
          "Max number of results to return — files in files_with_matches/count modes, matches in " +
          "content mode. Omit for unlimited (output is still byte-bounded). Page by re-running " +
          "with offset advanced per the footer.",
      },
      offset: {
        type: "integer",
        minimum: 0,
        default: 0,
        description:
          "Number of leading results to skip (0-based). Re-run with a higher offset to page. " +
          "Note: this is a result offset, not read_file's 1-based line offset.",
      },
    },
    required: ["pattern"],
  },
  async handler(args, config) {
    const mode = args.output_mode as OutputMode;
    const ctx = mode === "content" ? (args.context as number) : 0;
    const before = mode === "content" ? ((args.before_context as number | undefined) ?? ctx) : 0;
    const after = mode === "content" ? ((args.after_context as number | undefined) ?? ctx) : 0;
    const offset = args.offset as number;
    const headLimit = (args.head_limit as number | undefined) || undefined;
    const multiline = args.multiline as boolean;

    const searchRoot = resolvePath(
      (args.path as string | undefined) ?? ".",
      config.workspaceRoot,
      config.confineToWorkspace,
      config.temporaryRoots,
      config.logger,
    );

    const { matches, truncated, budgetExhausted, walkCapped } = await grepSearch(
      {
        pattern: args.pattern as string,
        searchRoot,
        glob: args.glob as string | undefined,
        ignoreCase: args.ignore_case as boolean,
        before,
        after,
        multiline,
      },
      config,
    );

    const { rendered, unitTotal, shownUnits } = format(matches, mode, config, {
      before,
      after,
      offset,
      headLimit,
    });

    return composeResult(rendered, config, {
      truncated,
      budgetExhausted,
      walkCapped,
      unitTotal,
      shownUnits,
      offset,
    });
  },
};

/**
 * Slice `items` to one page: skip `offset` leading entries, then keep at most
 * `headLimit` (or the remainder when `headLimit` is undefined).
 *
 * @param items - the full ordered result set.
 * @param offset - number of leading entries to skip (0-based).
 * @param headLimit - maximum entries to keep, or undefined for unlimited.
 * @returns the requested page.
 */
function paginate<T>(items: T[], offset: number, headLimit: number | undefined): T[] {
  const end = headLimit === undefined ? items.length : offset + headLimit;
  return items.slice(offset, end);
}

/**
 * Render {@link grepSearch} matches for the requested {@link OutputMode}: a
 * sorted, deduplicated file list (`files_with_matches`), per-file `path:count`
 * lines (`count`), or `path:line:text` rows with context (`content`, delegated
 * to {@link formatContent}).
 *
 * @param matches - the raw match and context rows from the search.
 * @param mode - which rendering to produce.
 * @param config - server configuration, used for display-path shortening.
 * @param opts - pagination and context window.
 * @returns the rendered page plus the total and shown unit counts that
 *   {@link composeResult} uses to build the pagination footer.
 * @remarks A "unit" is a file in `files_with_matches`/`count` and a match anchor
 *   in `content`; `context` rows never count as units.
 */
function format(
  matches: Match[],
  mode: OutputMode,
  config: RuntimeConfig,
  opts: ContextOpts,
): Formatted {
  if (matches.length === 0) return { rendered: "(no matches)", unitTotal: 0, shownUnits: 0 };

  if (mode === "files_with_matches") {
    const files = [
      ...new Set(
        matches
          .filter((m) => m.kind === "match")
          .map((m) => displayPath(m.file, config.workspaceRoot)),
      ),
    ].sort();
    const page = paginate(files, opts.offset, opts.headLimit);
    return { rendered: page.join("\n"), unitTotal: files.length, shownUnits: page.length };
  }

  if (mode === "count") {
    const counts = new Map<string, number>();
    for (const m of matches) {
      if (m.kind !== "match") continue;
      const f = displayPath(m.file, config.workspaceRoot);
      counts.set(f, (counts.get(f) ?? 0) + 1);
    }
    const entries = [...counts.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([f, c]) => `${f}:${c}`);
    const page = paginate(entries, opts.offset, opts.headLimit);
    return { rendered: page.join("\n"), unitTotal: entries.length, shownUnits: page.length };
  }

  return formatContent(matches, config, opts);
}

/**
 * Render `content` mode: `path:line:text` for matches and `path-line-text` for
 * context lines, grouped by file then line number, with `--` separators between
 * non-adjacent context blocks.
 *
 * @param matches - match and context rows from the search.
 * @param config - server configuration, used for display-path shortening.
 * @param opts - pagination plus the before/after context window.
 * @returns the rendered rows with `unitTotal`/`shownUnits` counted over match
 *   anchors only.
 * @remarks Pagination is applied to match anchors, then each anchor's own
 *   context window is re-expanded so a paged-in match keeps its surrounding
 *   lines. A multiline match reserves `countNewlines(text)` extra lines before
 *   its `after` context begins, so context does not overlap the match body.
 */
function formatContent(matches: Match[], config: RuntimeConfig, opts: ContextOpts): Formatted {
  const rows = matches
    .map((m) => ({ ...m, f: displayPath(m.file, config.workspaceRoot) }))
    .sort((a, b) => (a.f < b.f ? -1 : a.f > b.f ? 1 : a.lineNumber - b.lineNumber));

  const anchors = rows.filter((r) => r.kind === "match");
  const pageAnchors = paginate(anchors, opts.offset, opts.headLimit);

  const keep = new Set<string>();
  for (const a of pageAnchors) {
    const endLine = a.lineNumber + countNewlines(a.text);
    keep.add(`${a.f}\0${a.lineNumber}`);
    for (let d = 1; d <= opts.before; d++) keep.add(`${a.f}\0${a.lineNumber - d}`);
    for (let d = 1; d <= opts.after; d++) keep.add(`${a.f}\0${endLine + d}`);
  }

  const hasContext = opts.before > 0 || opts.after > 0;
  const out: string[] = [];
  let prevFile: string | null = null;
  let prevLine = -2;
  for (const r of rows) {
    if (!keep.has(`${r.f}\0${r.lineNumber}`)) continue;
    if (hasContext && prevFile !== null && (r.f !== prevFile || r.lineNumber > prevLine + 1)) {
      if (out.length > 0) out.push("--");
    }
    const sep = r.kind === "match" ? ":" : "-";
    out.push(`${r.f}${sep}${r.lineNumber}${sep}${r.text}`);
    prevFile = r.f;
    prevLine = r.lineNumber + countNewlines(r.text);
  }
  return { rendered: out.join("\n"), unitTotal: anchors.length, shownUnits: pageAnchors.length };
}

/**
 * Wrap the rendered page with byte-bounding and a status footer: an "incomplete
 * search" warning when the scan was truncated, an empty-page notice when
 * `offset` is past the end, a "page cut" note when the page itself exceeds
 * `maxOutputBytes`, or a "call again with offset=..." hint when more units
 * remain.
 *
 * @param rendered - the already-formatted page body.
 * @param config - server configuration; `maxOutputBytes` caps the output.
 * @param state - the search's `truncated`, `budgetExhausted` and `walkCapped` flags plus the
 *   unit totals and current `offset` that determine which footer applies.
 * @returns the bounded page with at most one appended footer line.
 * @remarks A truncated scan always reports incompleteness even when the page is
 *   non-empty, because unscanned files may hold further matches. The two causes
 *   get different warnings: the output cap means the answer was too large, while
 *   an exhausted regex budget means the *pattern* was too expensive, and telling
 *   a model to narrow its pattern for the former would be the opposite of the
 *   advice it needs.
 */
function composeResult(
  rendered: string,
  config: RuntimeConfig,
  state: {
    truncated: boolean;
    budgetExhausted: boolean;
    walkCapped: boolean;
    unitTotal: number;
    shownUnits: number;
    offset: number;
  },
): string {
  const { truncated, budgetExhausted, walkCapped, unitTotal, shownUnits, offset } = state;
  const bounded = bound(rendered, config.maxOutputBytes);

  if (truncated) {
    const warning = budgetExhausted
      ? "[... search incomplete: the pattern exhausted the regex time budget, so some lines and " +
        "files were never scanned. Nested quantifiers such as `(a+)+` or `(a|a)+` backtrack " +
        "catastrophically on non-matching text. Simplify the pattern, or narrow the path or " +
        "glob, for complete results. ...]"
      : walkCapped
        ? "[... search incomplete: the directory walk hit its entry cap, so whole files were never " +
          "opened. Narrowing the pattern will not help — search a narrower path, or set a glob, " +
          "for complete results. ...]"
        : "[... search incomplete: the scan hit its output cap; some matching files were not " +
          "scanned. Narrow the pattern, path, or glob for complete results. ...]";
    if (unitTotal === 0) return warning;
    return `${bounded}\n${warning}`;
  }

  if (unitTotal === 0) return bounded;

  if (offset >= unitTotal) {
    return `(no results at offset ${offset}; ${unitTotal} total)`;
  }

  if (Buffer.byteLength(rendered, "utf8") > config.maxOutputBytes) {
    return `${bounded}\n[... page exceeded ${config.maxOutputBytes} bytes and was cut; set or reduce head_limit to page in smaller chunks ...]`;
  }

  const nextOffset = offset + shownUnits;
  if (nextOffset < unitTotal) {
    return `${bounded}\n[... showing ${offset}..${nextOffset} of ${unitTotal}; call again with offset=${nextOffset} for more ...]`;
  }

  return bounded;
}
