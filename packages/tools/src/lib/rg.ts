import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ToolError, fsError } from "../errors.ts";
import { isBinary } from "../lib/binary.ts";
import { listFiles, readFileOptions, readRawFile, type FileListing } from "../lib/files.ts";
import { decodeText, splitLines, type DecodedText } from "../lib/text.ts";
import { readTextBuffer } from "../lib/textfile.ts";
import { createScanBudget } from "../lib/scan-budget.ts";
import type { RuntimeConfig } from "../config.ts";
import { resolveCommand } from "@clarvis/paths";

/** A single grep request over a file or directory tree. */
export interface GrepParams {
  /** The regular expression to search for. */
  pattern: string;
  /** Absolute path of the file or directory to search. */
  searchRoot: string;
  /** Optional glob to restrict which files are searched; a bare name without a
   * slash is treated as `**\/<name>`. Ignored when {@link GrepParams.searchRoot}
   * is a single file. */
  glob?: string;
  /** Case-insensitive matching when true. */
  ignoreCase: boolean;
  /** Number of leading context lines to include per match. */
  before: number;
  /** Number of trailing context lines to include per match. */
  after: number;
  /** Enable multiline (dot-all) matching so a pattern may span lines. */
  multiline: boolean;
}

/** One emitted line: a match or a surrounding context line. */
export interface Match {
  /** Absolute path of the file the line came from. */
  file: string;
  /** One-based line number of {@link Match.text} within the file. */
  lineNumber: number;
  /** The line text with any trailing newline stripped; a multiline match spans
   * several joined lines. */
  text: string;
  /** Whether this line matched the pattern or is adjacent context. */
  kind: "match" | "context";
}

interface RgEvent {
  type?: string;
  data?: {
    path?: { text?: string };
    line_number?: number;
    lines?: { text?: string };
  };
}

/** The lines a grep produced plus whether output was cut off by a budget. */
export interface GrepResult {
  /** Matches and context lines, ordered by file then line. */
  matches: Match[];
  /** True when a size budget stopped collection before the search finished. */
  truncated: boolean;
  /**
   * True when the in-process scanner stopped because the pattern exhausted its
   * regex time budget, leaving lines or files unscanned.
   *
   * @remarks
   * Always accompanied by {@link GrepResult.truncated}, so a caller that only
   * knows about the size cap still reports the search as incomplete. Never set
   * on the ripgrep path, which is linear-time and out of process.
   */
  budgetExhausted: boolean;
  /**
   * True when the directory walk stopped at `maxTraversalEntries`, leaving whole
   * files unvisited.
   *
   * @remarks Distinct from {@link GrepResult.truncated}, which reports the
   *   *output* cap: the two have opposite remedies, since narrowing the pattern
   *   does nothing about a walk that never reached the file. Always accompanied
   *   by `truncated`, so a caller that knows only the size cap still reports the
   *   search as incomplete. Never set on the ripgrep path or a single-file
   *   search, neither of which walks a tree.
   */
  walkCapped: boolean;
}

/**
 * How much larger ripgrep's raw JSON stream may grow than the output cap it will
 * be rendered into, before the child is killed.
 *
 * @remarks A ratio rather than a byte figure, because the thing being bounded is
 * an *encoding* of the same matches: every match arrives as a JSON object with
 * its path, line number, byte offsets and submatch spans repeated around a line
 * of text that is often shorter than its own envelope. So the raw stream is a
 * multiple of the rendered output, and the multiple is what has to be allowed
 * for.
 *
 * The direction that matters is the one where being wrong is silent: too small
 * and the child is killed on a search that would have rendered comfortably
 * inside `maxOutputBytes`, reporting a truncated result for a query that was
 * never too large. Too large only costs transient memory on a search already
 * headed for truncation. Hence a generous factor rather than a tight estimate.
 */
const RG_JSON_OVERHEAD = 8;

/**
 * Search a file or directory tree for a regex, preferring the `rg` binary and
 * falling back to an in-process scanner.
 *
 * @param params - the pattern, root, and match options; see {@link GrepParams}.
 * @param config - server limits (max file/output bytes, workspace root, whether
 *   ripgrep is available and gitignore handling).
 * @returns the matched lines with the `truncated` and `budgetExhausted` flags;
 *   see {@link GrepResult}.
 * @throws {@link ToolError} with `io_error` if `rg` cannot be spawned, or
 *   `invalid_input` for a ripgrep usage error or an unparseable regex in the
 *   in-process path.
 * @remarks Returns empty (never throws) when {@link GrepParams.searchRoot} is a
 *   single file that is over the size limit or detected as binary. Output is
 *   capped at `config.maxOutputBytes`; the ripgrep path allows a larger raw JSON
 *   stream (by {@link RG_JSON_OVERHEAD}) before killing the child and reporting
 *   `truncated`. The `.git` directory is always excluded. A confined directory
 *   always uses the in-process scanner even when ripgrep is installed: the JS
 *   walker opens and validates each file, whereas handing a mutable directory
 *   pathname to a subprocess would reopen the parent-link TOCTOU window.
 *
 *   The in-process path additionally spends at most
 *   `config.regexScanBudgetMs` of regular-expression time (see
 *   {@link "./scan-budget.js" | createScanBudget}); exhausting it stops the scan
 *   with both flags set rather than letting a catastrophically backtracking
 *   pattern run for the whole scope. The ripgrep path is unbudgeted because it
 *   is linear-time and runs out of process.
 */
export async function grepSearch(params: GrepParams, config: RuntimeConfig): Promise<GrepResult> {
  let stat;
  try {
    stat = await fs.stat(params.searchRoot);
  } catch (err) {
    throw fsError(err as NodeJS.ErrnoException, params.searchRoot);
  }

  const isDir = stat.isDirectory();
  let singleFile: Buffer | undefined;

  if (!isDir) {
    if (!stat.isFile()) {
      return { matches: [], truncated: false, budgetExhausted: false, walkCapped: false };
    }
    try {
      singleFile = await readRawFile(
        params.searchRoot,
        params.searchRoot,
        config.maxFileBytes,
        undefined,
        readFileOptions(config),
      );
      if (isBinary(singleFile)) {
        return { matches: [], truncated: false, budgetExhausted: false, walkCapped: false };
      }
    } catch (err) {
      if (err instanceof ToolError && err.code === "path_escape") throw err;
      return { matches: [], truncated: false, budgetExhausted: false, walkCapped: false };
    }
  }

  const useRipgrep = config.ripgrepAvailable && (!isDir || !config.confineToWorkspace);
  config.logger.debug(
    {
      event: "tools.grep_path",
      engine: useRipgrep ? "ripgrep" : "in_process",
      is_dir: isDir,
      confined: config.confineToWorkspace,
    },
    "a grep chose its engine; the two do not share regex semantics, so which one ran decides what a pattern means",
  );
  return useRipgrep
    ? ripgrepSearch(params, isDir, config, singleFile)
    : inProcessSearch(
        params,
        config,
        isDir,
        singleFile === undefined ? undefined : decodeText(singleFile),
      );
}

/**
 * Run ripgrep over a directory or an already-bounded single-file snapshot.
 *
 * @param params - the normalized search request.
 * @param isDir - whether the search root is a directory.
 * @param config - output/file ceilings and host capability flags.
 * @param singleFile - descriptor-bound bytes when the target is one file.
 * @returns parsed matches plus truncation state.
 * @remarks A single file is searched through stdin so ripgrep never reopens its
 *   pathname after validation; reopening would reintroduce a TOCTOU window and
 *   could also let a replacement FIFO park the child indefinitely.
 */
function ripgrepSearch(
  params: GrepParams,
  isDir: boolean,
  config: RuntimeConfig,
  singleFile?: Buffer,
): Promise<GrepResult> {
  const args = ["--no-config", "--json", "--hidden", "-g", "!.git"];
  args.push("--max-filesize", String(config.maxFileBytes));
  if (params.ignoreCase) args.push("-i");
  if (params.multiline) args.push("--multiline", "--multiline-dotall");
  if (params.before > 0) args.push("-B", String(params.before));
  if (params.after > 0) args.push("-A", String(params.after));

  let cwd: string;
  let searchArg: string;
  if (isDir) {
    cwd = params.searchRoot;
    searchArg = ".";
    if (params.glob) args.push("-g", params.glob);
  } else {
    cwd = path.dirname(params.searchRoot);
    searchArg = "-";
  }
  args.push("--", params.pattern, searchArg);

  if (singleFile !== undefined) {
    return ripgrepSnapshotSearch(params, config, args, cwd, singleFile);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(resolveCommand("rg"), args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd,
    });
    let out = "";
    let errOut = "";
    let truncated = false;
    const streamCap = config.maxOutputBytes * RG_JSON_OVERHEAD;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      if (truncated) return;
      out += d;
      if (out.length > streamCap) {
        truncated = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (d) => (errOut += d));
    child.on("error", (e) => reject(new ToolError("io_error", `Failed to run rg: ${e.message}`)));
    child.on("close", (code) => {
      const matches = parseRipgrepMatches(out, (filePath) => path.resolve(cwd, filePath));

      if (matches.length === 0 && code === 2 && !truncated) {
        reject(
          new ToolError("invalid_input", `ripgrep error: ${errOut.trim()}`, {
            pattern: params.pattern,
          }),
        );
        return;
      }
      resolve({ matches, truncated, budgetExhausted: false, walkCapped: false });
    });
  });
}

/**
 * Search a bounded single-file snapshot through ripgrep's stdin.
 *
 * Bun's Node-compatible `child_process` currently closes a piped stdin before
 * queued writes reach the child. Its native subprocess API accepts the complete
 * immutable snapshot at spawn time, preserving the descriptor-bound read while
 * still streaming stdout under the same raw-output ceiling as directory scans.
 */
async function ripgrepSnapshotSearch(
  params: GrepParams,
  config: RuntimeConfig,
  args: string[],
  cwd: string,
  snapshot: Buffer,
): Promise<GrepResult> {
  const spawnSnapshot = () =>
    Bun.spawn([resolveCommand("rg"), ...args], {
      cwd,
      stdin: new Blob([new Uint8Array(snapshot)]),
      stdout: "pipe",
      stderr: "pipe",
    });
  let child: ReturnType<typeof spawnSnapshot>;
  try {
    child = spawnSnapshot();
  } catch (error) {
    throw new ToolError(
      "io_error",
      `Failed to run rg: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  const streamCap = config.maxOutputBytes * RG_JSON_OVERHEAD;
  let rawBytes = 0;
  let out = "";
  let truncated = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    rawBytes += value.byteLength;
    if (rawBytes > streamCap) {
      truncated = true;
      child.kill("SIGKILL");
      break;
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();

  const [code, errOut] = await Promise.all([child.exited, stderr]);
  const matches = parseRipgrepMatches(out, () => params.searchRoot);
  if (matches.length === 0 && code === 2 && !truncated) {
    throw new ToolError("invalid_input", `ripgrep error: ${errOut.trim()}`, {
      pattern: params.pattern,
    });
  }
  return { matches, truncated, budgetExhausted: false, walkCapped: false };
}

function parseRipgrepMatches(out: string, resolveFile: (filePath: string) => string): Match[] {
  const matches: Match[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    let evt: RgEvent;
    try {
      evt = JSON.parse(line) as RgEvent;
    } catch {
      continue;
    }
    if (evt.type !== "match" && evt.type !== "context") continue;
    const filePath = evt.data?.path?.text;
    const lineNumber = evt.data?.line_number;
    if (filePath === undefined || lineNumber === undefined) continue;
    matches.push({
      file: resolveFile(filePath),
      lineNumber,
      text: stripNewline(evt.data?.lines?.text ?? ""),
      kind: evt.type,
    });
  }
  return matches;
}

async function inProcessSearch(
  params: GrepParams,
  config: RuntimeConfig,
  isDir: boolean,
  singleFile?: DecodedText,
): Promise<GrepResult> {
  const listing = isDir
    ? await gatherFiles(params, config)
    : { files: [params.searchRoot], truncated: false };
  const files = listing.files;
  let re: RegExp;
  const flags = params.multiline
    ? params.ignoreCase
      ? "gmsi"
      : "gms"
    : params.ignoreCase
      ? "i"
      : "";
  try {
    re = new RegExp(params.pattern, flags);
  } catch (err) {
    throw new ToolError("invalid_input", `Invalid regex: ${(err as Error).message}`, {
      pattern: params.pattern,
    });
  }
  const matches: Match[] = [];
  const budget = config.maxOutputBytes;
  const scanBudget = createScanBudget(config.regexScanBudgetMs);
  const readOptions = readFileOptions(config);
  let used = 0;
  let truncated = false;
  let budgetExhausted = false;

  for (const file of files) {
    if (truncated) break;
    if (scanBudget.exhausted()) {
      truncated = true;
      budgetExhausted = true;
      break;
    }
    const decoded =
      singleFile !== undefined && !isDir
        ? singleFile
        : await readTextBuffer(file, config.maxFileBytes, readOptions);
    if (!decoded) continue;

    const lines = splitLines(decoded.content);

    if (params.multiline) {
      used += scanBudget.charge(() =>
        emitMultiline(matches, file, decoded.content, lines, re, params),
      );
    } else {
      const hitRows = new Set<number>();
      for (let i = 0; i < lines.length; i++) {
        if (scanBudget.exhausted()) {
          truncated = true;
          budgetExhausted = true;
          break;
        }
        if (scanBudget.charge(() => re.test(lines[i] ?? ""))) hitRows.add(i);
      }
      if (hitRows.size === 0) continue;

      if (params.before > 0 || params.after > 0) {
        const emit = new Map<number, "match" | "context">();
        for (const row of hitRows) emit.set(row, "match");
        for (const row of hitRows) {
          for (let d = 1; d <= params.before; d++) {
            if (row - d >= 0 && !emit.has(row - d)) emit.set(row - d, "context");
          }
          for (let d = 1; d <= params.after; d++) {
            if (row + d < lines.length && !emit.has(row + d)) emit.set(row + d, "context");
          }
        }
        for (const row of [...emit.keys()].sort((a, b) => a - b)) {
          const text = lines[row] ?? "";
          matches.push({ file, lineNumber: row + 1, text, kind: emit.get(row) ?? "match" });
          used += Buffer.byteLength(text, "utf8");
        }
      } else {
        for (const row of [...hitRows].sort((a, b) => a - b)) {
          const text = lines[row] ?? "";
          matches.push({ file, lineNumber: row + 1, text, kind: "match" });
          used += Buffer.byteLength(text, "utf8");
        }
      }
    }

    if (used > budget) truncated = true;
  }
  return {
    matches,
    truncated: truncated || listing.truncated,
    budgetExhausted,
    walkCapped: listing.truncated,
  };
}

function emitMultiline(
  matches: Match[],
  file: string,
  content: string,
  lines: string[],
  re: RegExp,
  params: GrepParams,
): number {
  const nl: number[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 0x0a) nl.push(i);
  }
  const lineOf = (off: number): number => {
    let lo = 0;
    let hi = nl.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((nl[mid] ?? 0) < off) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const matchedLines = new Set<number>();
  const multiLines = new Set<number>();
  for (const m of content.matchAll(re)) {
    const t = m[0];
    if (t.length === 0) continue;
    const startIdx = m.index ?? 0;
    const s = lineOf(startIdx);
    let e = lineOf(startIdx + t.length - 1);
    if (e >= lines.length) e = lines.length - 1;
    for (let L = s; L <= e; L++) {
      matchedLines.add(L);
      if (e > s) multiLines.add(L);
    }
  }
  if (matchedLines.size === 0) return 0;

  const runs: { start: number; end: number; hasMulti: boolean }[] = [];
  for (const L of [...matchedLines].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last && L === last.end + 1) {
      last.end = L;
      if (multiLines.has(L)) last.hasMulti = true;
    } else {
      runs.push({ start: L, end: L, hasMulti: multiLines.has(L) });
    }
  }

  const emit = new Map<number, "match" | "context">();
  const anchorEnd = new Map<number, number>();
  for (const r of runs) {
    if (r.hasMulti) {
      emit.set(r.start, "match");
      anchorEnd.set(r.start, r.end);
    } else {
      for (let L = r.start; L <= r.end; L++) {
        emit.set(L, "match");
        anchorEnd.set(L, L);
      }
    }
  }

  if (params.before > 0 || params.after > 0) {
    for (const [start, end] of anchorEnd) {
      for (let d = 1; d <= params.before; d++) {
        const r = start - d;
        if (r >= 0 && !matchedLines.has(r) && !emit.has(r)) emit.set(r, "context");
      }
      for (let d = 1; d <= params.after; d++) {
        const r = end + d;
        if (r < lines.length && !matchedLines.has(r) && !emit.has(r)) emit.set(r, "context");
      }
    }
  }

  let used = 0;
  for (const row of [...emit.keys()].sort((a, b) => a - b)) {
    const kind = emit.get(row) ?? "match";
    const end = kind === "match" ? (anchorEnd.get(row) ?? row) : row;
    const text = lines.slice(row, end + 1).join("\n");
    matches.push({ file, lineNumber: row + 1, text, kind });
    used += Buffer.byteLength(text, "utf8");
  }
  return used;
}

async function gatherFiles(params: GrepParams, config: RuntimeConfig): Promise<FileListing> {
  const pattern = params.glob
    ? params.glob.includes("/")
      ? params.glob
      : `**/${params.glob}`
    : "**/*";
  const listing = await listFiles(params.searchRoot, config.workspaceRoot, {
    pattern,
    respectGitignore: true,
    maxEntries: config.maxTraversalEntries,
  });
  listing.files.sort();
  return listing;
}

function stripNewline(s: string): string {
  return s.replace(/\r?\n$/, "");
}
