import { promises as fs } from "node:fs";
import { ToolError, fsError } from "../errors.ts";
import { applyOpsAtomic, withFileLocks, type FileOp } from "../lib/atomic.ts";
import { listFiles, readFileOptions } from "../lib/files.ts";
import { resolvePath, displayPath } from "../lib/paths.ts";
import { reencode } from "../lib/text.ts";
import { unifiedDiff } from "../lib/unified-diff.ts";
import { readTextBuffer } from "../lib/textfile.ts";
import { createScanBudget } from "../lib/scan-budget.ts";
import type { RuntimeConfig } from "../config.ts";
import type { ToolDef } from "./types.ts";

/** One file's pending replacement: its display path, match count, original and
 * replaced content, and the re-encoded bytes to write. */
interface Changed {
  rel: string;
  count: number;
  before: string;
  after: string;
  text: string;
}

/**
 * Compile the user pattern into a global {@link RegExp} with the requested
 * flags.
 *
 * @param multiline - adds the `m` and `s` flags so a match can span lines and
 *   `.` matches newlines.
 * @param ignoreCase - adds the `i` flag.
 * @returns the compiled regex (always global).
 * @throws {@link ToolError} `invalid_input` when `pattern` is not a valid regex.
 */
function buildRegex(pattern: string, ignoreCase: boolean, multiline: boolean): RegExp {
  let flags = "g";
  if (multiline) flags += "ms";
  if (ignoreCase) flags += "i";
  try {
    return new RegExp(pattern, flags);
  } catch (err) {
    throw new ToolError("invalid_input", `Invalid regex: ${(err as Error).message}`, { pattern });
  }
}

/**
 * Resolve the set of files the replacement will scan.
 *
 * @param pathArg - a file or directory to scope to; defaults to the workspace
 *   root (`.`) when omitted.
 * @param glob - a glob filtering files within a directory scope; a bare pattern
 *   without `/` is expanded to `**\/<glob>` so it matches at any depth.
 * @param config - the resolved server configuration.
 * @returns the sorted absolute paths to scan: just the single file when
 *   `pathArg` names one, otherwise the directory walk honoring `.gitignore`, or
 *   an empty list when the scope is neither a file nor a directory.
 * @throws a {@link fsError}-mapped {@link ToolError} when the scope path cannot
 *   be stat'd (e.g. it does not exist).
 */
async function scopeFiles(
  pathArg: string | undefined,
  glob: string | undefined,
  config: RuntimeConfig,
): Promise<string[]> {
  const root = resolvePath(
    pathArg ?? ".",
    config.workspaceRoot,
    config.confineToWorkspace,
    config.temporaryRoots,
    config.logger,
  );
  let stat;
  try {
    stat = await fs.stat(root);
  } catch (err) {
    throw fsError(err as NodeJS.ErrnoException, pathArg ?? ".");
  }
  if (stat.isFile()) return [root];
  if (!stat.isDirectory()) return [];
  const pattern = glob ? (glob.includes("/") ? glob : `**/${glob}`) : "**/*";
  const listing = await listFiles(root, config.workspaceRoot, {
    pattern,
    respectGitignore: true,
    maxEntries: config.maxTraversalEntries,
  });
  if (listing.truncated) {
    throw new ToolError(
      "too_large",
      `replacement scope exceeds the ${String(config.maxTraversalEntries)}-entry traversal limit; nothing was written`,
      { limit: config.maxTraversalEntries },
    );
  }
  listing.files.sort();
  return listing.files;
}

/**
 * The `replace` {@link ToolDef}: regex find-and-replace across the workspace,
 * preview-first and applied atomically.
 *
 * @remarks
 * The handler requires at least one of `path`/`glob` to scope the work
 * ({@link scopeFiles}) and rejects a pattern that matches the empty string so it
 * never inserts between every character. Binary, oversized, and ignored files
 * are skipped, and a file whose content is unchanged by the substitution is not
 * counted. With `dry_run` (the default) it returns the match counts and a
 * unified-diff preview and writes nothing; with `dry_run: false` all edits are
 * committed together via {@link applyOpsAtomic} under {@link withFileLocks}, so
 * every file succeeds or none do, each keeping its original line endings. A run
 * that changes nothing returns `"(no matches)"`. `replacement` honors the
 * standard `$1`..`$9`, `$&`, and `$$` substitution syntax of `String.replace`.
 *
 * There is no ripgrep path here in any deployment, so the pattern is always
 * applied in process — once per file, which is what makes a catastrophically
 * backtracking pattern able to freeze the host for the length of the whole
 * scope. The applications are therefore charged against
 * `config.regexScanBudgetMs` (see
 * {@link "../lib/scan-budget.js" | createScanBudget}), and exhausting it fails
 * the call with `timeout` before the next file is read. It fails rather than
 * applying what it has: a partial codemod would break the all-or-none contract
 * above, and is worse than a refused one.
 */
export const replace: ToolDef = {
  name: "replace",
  description:
    "Regex replacement scoped by path and/or glob (at least one required). Preview counts and " +
    "diffs first with dry_run:true, the default; false applies all edits atomically, preserving " +
    "line endings. Directory scans respect ignore rules; binary and oversized files are skipped.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "Regular expression to match (JavaScript regex syntax). Escape metacharacters.",
      },
      replacement: {
        type: "string",
        description:
          "Replacement text. `$1`..`$9` insert capture groups, `$&` the whole match; `$$` is a literal `$`.",
      },
      path: {
        type: "string",
        description:
          "File or directory to scope the replacement to. Relative to workspace root or absolute " +
          "(~ is not expanded). A directory is walked honoring ignore rules.",
      },
      glob: {
        type: "string",
        description:
          "Glob filtering which files under the scope are edited (e.g. `**/*.ts`). A bare pattern " +
          "without `/` matches in any directory. Required only when path is omitted; optional for a directory.",
      },
      ignore_case: { type: "boolean", description: "Case-insensitive matching (regex `i` flag)." },
      multiline: {
        type: "boolean",
        description:
          "Treat the file as one string so a pattern can span lines and `.` matches newlines " +
          "(regex `m`+`s` flags).",
      },
      dry_run: {
        type: "boolean",
        default: true,
        description:
          "When true (the default), only preview: report counts and a diff without writing. Set " +
          "false to apply the edits.",
      },
    },
    required: ["pattern", "replacement"],
  },
  async handler(args, config) {
    const pattern = args.pattern as string;
    const replacement = args.replacement as string;
    const pathArg = typeof args.path === "string" && args.path.length > 0 ? args.path : undefined;
    const glob = typeof args.glob === "string" && args.glob.length > 0 ? args.glob : undefined;
    const dryRun = args.dry_run !== false;

    if (pathArg === undefined && glob === undefined) {
      throw new ToolError("invalid_input", "Provide `path` or `glob` to scope the replacement.");
    }

    const re = buildRegex(pattern, args.ignore_case === true, args.multiline === true);
    if (new RegExp(pattern).test("")) {
      throw new ToolError(
        "invalid_input",
        "pattern matches the empty string; refusing to insert the replacement between every character.",
        { pattern },
      );
    }

    const files = await scopeFiles(pathArg, glob, config);

    const ops: FileOp[] = [];
    const changed: Changed[] = [];
    let totalReplacements = 0;
    let scanned = 0;
    let mutationBytes = 0;

    const scanBudget = createScanBudget(config.regexScanBudgetMs);
    const readOptions = readFileOptions(config);

    for (const file of files) {
      if (scanBudget.exhausted()) {
        throw new ToolError(
          "timeout",
          `pattern exhausted the ${config.regexScanBudgetMs}ms regex time budget after ${scanned} file(s); ` +
            "nothing was written. Nested quantifiers such as `(a+)+` backtrack catastrophically on " +
            "non-matching text — simplify the pattern, or narrow `path`/`glob`, and re-run.",
          { pattern, scanned },
        );
      }
      const decoded = await readTextBuffer(file, config.maxFileBytes, readOptions);
      if (!decoded) continue;
      scanned++;
      const matches = scanBudget.charge(() => decoded.content.match(re));
      if (!matches) continue;
      const after = scanBudget.charge(() => decoded.content.replace(re, replacement));
      if (after === decoded.content) continue;
      const rel = displayPath(file, config.workspaceRoot);
      const text = reencode(after, decoded);
      mutationBytes += Buffer.byteLength(text, "utf8");
      if (mutationBytes > config.maxMutationBytes) {
        throw new ToolError(
          "too_large",
          `replacement transaction exceeds the ${String(config.maxMutationBytes)}-byte aggregate limit; nothing was written`,
          { size: mutationBytes, limit: config.maxMutationBytes },
        );
      }
      ops.push({ type: "modify", path: file, content: text });
      changed.push({ rel, count: matches.length, before: decoded.content, after, text });
      totalReplacements += matches.length;
    }

    if (changed.length === 0) return "(no matches)";

    if (dryRun) {
      const head = `${totalReplacements} replacement(s) across ${changed.length} file(s); ${scanned} scanned (dry run — pass dry_run: false to apply)`;
      const diffs = changed
        .map((c) => unifiedDiff(c.rel, c.before, c.after, config.maxDiffInputBytes))
        .filter((d): d is string => d !== undefined);
      return [head, "", ...diffs].join("\n");
    }

    try {
      await withFileLocks(
        ops.map((o) => o.path),
        () => applyOpsAtomic(ops),
      );
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError("io_error", `Failed to apply replacement: ${(err as Error).message}`);
    }

    const summary = changed.map(
      (c) => `  M ${c.rel} (${c.count} replacement${c.count === 1 ? "" : "s"})`,
    );
    const content =
      `Replaced ${totalReplacements} occurrence(s) in ${changed.length} file(s):\n` +
      summary.join("\n");
    const diff = changed
      .map((c) => unifiedDiff(c.rel, c.before, c.after, config.maxDiffInputBytes))
      .filter((d): d is string => d !== undefined)
      .join("\n");
    return diff ? { content, meta: { diff } } : { content };
  },
};
