/** A `shell` tool call's result, parsed from its JSON envelope (or a fallback raw shape). */
export interface BashResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  signal: string | null;
  timedOut: boolean;
  parsed: boolean;
  running?: boolean;
  sessionId?: string;
}

/** Parse `s` as a JSON object, returning `undefined` for anything else (non-JSON, array, primitive). */
function tryJson(s: string): Record<string, unknown> | undefined {
  try {
    const j = JSON.parse(s);
    return j && typeof j === "object" && !Array.isArray(j)
      ? (j as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse a `shell` tool call's result/error text into a {@link BashResult}.
 *
 * @param result - the tool's `result` text.
 * @param error - the tool's `error` text, tried as a fallback JSON source.
 * @returns the parsed fields with `parsed: true`, or the raw text as `stdout`
 *   with `parsed: false` when neither `result` nor `error` is a JSON object.
 * @remarks A call that failed before the shell ever ran has **no** envelope to
 *   parse, and the engine reports the same sentence as both the result the model
 *   was handed and the error — so echoing `result` into `stdout` alongside
 *   `error` in `stderr` printed it twice, once in body text and once in red.
 *   That is what a truncated tool payload, a rejected argument schema and a
 *   guard denial all looked like. When the two texts are the same string there
 *   is only one thing to say, and it belongs in `stderr`.
 *
 *   **Being JSON is not the same as being a shell envelope.** A `ToolError`
 *   serializes as `{"error":"denied","message":"…"}`, which parses cleanly and
 *   then satisfies none of the field reads below — yielding a `parsed: true`
 *   envelope with an empty `stdout`, an empty `stderr` and no exit code. The
 *   renderer's success path then printed the status word `done` and no body, so
 *   a guard denial read as a command that ran and produced no output: the error
 *   text appeared *zero* times, where the defect this function was written for
 *   showed it twice. {@link isShellEnvelope} is what keeps the two apart.
 */
export function parseBash(result: string, error: string | null): BashResult {
  const j = tryJson(result) ?? (error ? tryJson(error) : undefined);
  if (j && isShellEnvelope(j)) {
    return {
      exitCode: typeof j.exit_code === "number" ? j.exit_code : null,
      stdout: typeof j.stdout === "string" ? j.stdout : "",
      stderr: typeof j.stderr === "string" ? j.stderr : "",
      signal: typeof j.signal === "string" ? j.signal : null,
      timedOut: j.timed_out === true,
      parsed: true,
      ...(j.running === true ? { running: true } : {}),
      ...(typeof j.session_id === "string" ? { sessionId: j.session_id } : {}),
    };
  }
  const message = j ? errorText(j) : undefined;
  if (message !== undefined)
    return {
      exitCode: null,
      stdout: "",
      stderr: message,
      signal: null,
      timedOut: false,
      parsed: false,
    };
  return {
    exitCode: null,
    stdout: error !== null && result === error ? "" : result,
    stderr: error ?? "",
    signal: null,
    timedOut: false,
    parsed: false,
  };
}

/** The five fields a real `shell` envelope may carry; one of them must be present. */
const SHELL_ENVELOPE_KEYS = ["exit_code", "stdout", "stderr", "signal", "timed_out"] as const;

/**
 * Whether a parsed JSON object is a `shell` result envelope at all.
 *
 * @remarks Presence, not validity: an envelope reporting a plain success is
 *   `{"exit_code":0,"stdout":"","stderr":""}`, so requiring a *non-empty* field
 *   would misread it. What must be rejected is an object carrying none of these
 *   keys, which is every error payload the engine produces when a call never
 *   reached a shell.
 */
function isShellEnvelope(j: Record<string, unknown>): boolean {
  return SHELL_ENVELOPE_KEYS.some((k) => j[k] !== undefined);
}

/**
 * The human-readable sentence inside a non-envelope JSON error payload.
 *
 * @returns the payload's `message`, else its `error`, else `undefined` when the
 *   object carries neither and so says nothing worth showing.
 */
function errorText(j: Record<string, unknown>): string | undefined {
  const message = typeof j.message === "string" ? j.message.trim() : "";
  const code = typeof j.error === "string" ? j.error.trim() : "";
  if (message && code && message !== code) return `${code}: ${message}`;
  return message || code || undefined;
}

/**
 * Produce a human-readable collapsed summary for a structured or plain tool error.
 *
 * @remarks Recognized `{ error, message }` envelopes keep both stable code and
 * message while dropping their JSON syntax. Unknown JSON and plain diagnostic
 * text remain intact so presentation never invents a more specific failure.
 */
export function toolErrorSummaryText(error: string): string {
  const value = error.trim();
  const parsed = tryJson(value);
  if (parsed !== undefined) {
    const code = typeof parsed.error === "string" ? parsed.error.trim() : "";
    const message = typeof parsed.message === "string" ? parsed.message.trim() : "";
    if (code || message) {
      const label = humanizeErrorCode(code);
      if (!message || message.toLowerCase() === code.toLowerCase()) return label;
      return label ? `${label}: ${message}` : message;
    }
    return value;
  }
  const coded = /^([a-z][a-z0-9_]*)\s*:\s*(.+)$/s.exec(value);
  if (coded) return `${humanizeErrorCode(coded[1]!)}: ${coded[2]!.trim()}`;
  return value.length > 0 ? value[0]!.toUpperCase() + value.slice(1) : value;
}

function humanizeErrorCode(code: string): string {
  const words = code.replaceAll("_", " ");
  return words.length > 0 ? words[0]!.toUpperCase() + words.slice(1) : "";
}

/** A `read_file` tool call's result, split into its numbered content and any trailing notes. */
export interface ReadFileParsed {
  firstLine: number | null;
  content: string;
  notes: string[];
}

/**
 * Parse a `read_file` result's `cat -n`-style output: lines prefixed with a
 * tab-terminated line number become `content`; any other non-blank line is
 * collected as a note.
 */
export function parseReadFile(result: string): ReadFileParsed {
  const rows: string[] = [];
  const notes: string[] = [];
  let firstLine: number | null = null;
  for (const line of result.split("\n")) {
    const tab = line.indexOf("\t");
    const head = tab > 0 ? line.slice(0, tab).trim() : "";
    if (tab > 0 && /^\d+$/.test(head)) {
      if (firstLine === null) firstLine = Number(head);
      rows.push(line.slice(tab + 1));
    } else if (line.length > 0) {
      notes.push(line);
    }
  }
  return { firstLine, content: rows.join("\n"), notes };
}

interface GrepRow {
  line: number | null;
  text: string;
  match: boolean;
}
/** All matched/context rows for one file in a `grep` tool call's result. */
export interface GrepGroup {
  path: string;
  rows: GrepRow[];
}

/**
 * Parse a `grep` tool call's `path:line:text` / `path-line-text` output into
 * per-file groups, splitting groups on `--` separators; a continuation line
 * (no `path:line:` prefix) is appended to the previous row's text.
 */
export function parseGrepContent(result: string): { groups: GrepGroup[]; noMatches: boolean } {
  if (result.trim() === "(no matches)" || result.trim().length === 0) {
    return { groups: [], noMatches: true };
  }
  const groups: GrepGroup[] = [];
  let current: GrepGroup | undefined;
  const push = (path: string, row: GrepRow): void => {
    if (!current || current.path !== path) {
      current = { path, rows: [] };
      groups.push(current);
    }
    current.rows.push(row);
  };
  for (const line of result.split("\n")) {
    if (line === "--") {
      current = undefined;
      continue;
    }
    const m = /^(.+?):(\d+):([\s\S]*)$/.exec(line);
    if (m) {
      push(m[1]!, { line: Number(m[2]), text: m[3]!, match: true });
      continue;
    }
    const c = /^(.+?)-(\d+)-([\s\S]*)$/.exec(line);
    if (c) {
      push(c[1]!, { line: Number(c[2]), text: c[3]!, match: false });
      continue;
    }
    if (current && current.rows.length > 0) {
      current.rows[current.rows.length - 1]!.text += "\n" + line;
    }
  }
  return { groups, noMatches: false };
}

/** Split a `glob`-style tool result into its non-empty path lines, or `[]` for "(no matches)". */
export function parsePathList(result: string): string[] {
  if (result.trim() === "(no matches)" || result.trim().length === 0) return [];
  return result.split("\n").filter((l) => l.trim().length > 0);
}

/** One old/new text pair, as passed to an `edit`/`patch` tool call. */
export interface Edit {
  oldText: string;
  newText: string;
}

/**
 * Recover the {@link Edit} list from a tool call's raw arguments, supporting
 * both the multi-edit `edits: [...]` shape and the single-edit
 * `old_string`/`new_string` shape.
 */
export function editsFromArgs(args: Record<string, unknown>): Edit[] {
  if (Array.isArray(args.edits)) {
    return args.edits
      .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
      .map((e) => ({ oldText: String(e.old_string ?? ""), newText: String(e.new_string ?? "") }));
  }
  if (typeof args.old_string === "string" || typeof args.new_string === "string") {
    return [{ oldText: String(args.old_string ?? ""), newText: String(args.new_string ?? "") }];
  }
  return [];
}

/**
 * Render a list of {@link Edit}s as a unified diff for display, when the tool
 * call itself carried no diff.
 *
 * @remarks The hunk header's line counts are a display approximation
 *   (`@@ -1,N +1,M @@` for every edit), not a real diff computation.
 */
export function synthesizeUnifiedDiff(path: string, edits: Edit[]): string {
  const p = path.length > 0 ? path : "file";
  let out = `--- a/${p}\n+++ b/${p}\n`;
  for (const e of edits) {
    const oldLines = e.oldText.length > 0 ? e.oldText.split("\n") : [];
    const newLines = e.newText.length > 0 ? e.newText.split("\n") : [];
    out += `@@ -1,${oldLines.length} +1,${newLines.length} @@\n`;
    for (const l of oldLines) out += `-${l}\n`;
    for (const l of newLines) out += `+${l}\n`;
  }
  return out;
}

/** Parse an arbitrary tool result as a JSON object, or `undefined` if it isn't one. */
export function parseJsonObject(result: string): Record<string, unknown> | undefined {
  return tryJson(result);
}

/** One file's section of a `read_files` (batch read) tool call's result. */
export interface ReadFilesSection {
  path: string;
  error: string | null;
  body: string;
}

/**
 * Parse a `read_files` tool call's `==> path <==` banner-delimited output into
 * per-file sections, recognizing a trailing `... more file(s) not shown` note.
 */
export function parseReadFiles(result: string): {
  sections: ReadFilesSection[];
  note: string | null;
} {
  const sections: ReadFilesSection[] = [];
  let note: string | null = null;
  let current: ReadFilesSection | undefined;
  let bodyLines: string[] = [];
  const flush = (): void => {
    if (current) {
      current.body = bodyLines.join("\n").replace(/^\n+|\n+$/g, "");
      sections.push(current);
    }
    bodyLines = [];
  };
  for (const line of result.split("\n")) {
    const h = /^==> (.*) <==$/.exec(line);
    if (h) {
      flush();
      const inner = h[1]!;
      const em = /^(.+?) — ([a-z_]+): (.+)$/.exec(inner);
      current = em
        ? { path: em[1]!, error: `${em[2]}: ${em[3]}`, body: "" }
        : { path: inner, error: null, body: "" };
      continue;
    }
    if (/more file\(s\) not shown/.test(line)) {
      note = line.trim();
      continue;
    }
    if (current) bodyLines.push(line);
  }
  flush();
  return { sections, note };
}

export interface ShellSessionParsed {
  isList: boolean;
  sessions: Array<{ id: string; running: boolean; exitCode: number | null }>;
  id: string | null;
  running: boolean | null;
  ready: boolean | null;
  exitCode: number | null;
  stopped: boolean | null;
  stdout: string;
  stderr: string;
}

/** Read a bounded shell-session result without mistaking a typed error for status. */
export function parseShellSession(
  result: string,
  error: string | null,
): ShellSessionParsed | undefined {
  const j = tryJson(result) ?? (error ? tryJson(error) : undefined);
  if (!j || typeof j.error === "string") return undefined;
  if (!Array.isArray(j.sessions) && typeof j.session_id !== "string") return undefined;
  const triBool = (value: unknown): boolean | null =>
    value === true ? true : value === false ? false : null;
  return {
    isList: Array.isArray(j.sessions),
    sessions: Array.isArray(j.sessions)
      ? j.sessions
          .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
          .map((entry) => ({
            id: typeof entry.session_id === "string" ? entry.session_id : "",
            running: entry.running === true,
            exitCode: typeof entry.exit_code === "number" ? entry.exit_code : null,
          }))
      : [],
    id: typeof j.session_id === "string" ? j.session_id : null,
    running: triBool(j.running),
    ready: triBool(j.ready),
    exitCode: typeof j.exit_code === "number" ? j.exit_code : null,
    stopped: triBool(j.stopped),
    stdout: typeof j.stdout === "string" ? j.stdout : "",
    stderr: typeof j.stderr === "string" ? j.stderr : "",
  };
}
