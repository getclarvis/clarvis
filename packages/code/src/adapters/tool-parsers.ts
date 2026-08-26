/** A `shell` tool call's result, parsed from its JSON envelope (or a fallback raw shape). */
export interface BashResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  signal: string | null;
  timedOut: boolean;
  parsed: boolean;
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

interface MonitorEntry {
  id: string;
  command: string;
  running: boolean;
}
/**
 * A `monitor` tool call's JSON result, either a `monitor_list` snapshot
 * (`isList: true`) or a single monitor's status/output.
 */
export interface MonitorParsed {
  isList: boolean;
  monitors: MonitorEntry[];
  id: string | null;
  command: string | null;
  running: boolean | null;
  ready: boolean | null;
  exitCode: number | null;
  hasExitCode: boolean;
  stopped: boolean | null;
  output: string;
}

/** Normalize a JSON value to a strict tri-state boolean: `true`, `false`, or `null` for anything else. */
const triBool = (v: unknown): boolean | null => (v === true ? true : v === false ? false : null);

/**
 * Parse a `monitor` tool call's result/error text into a {@link MonitorParsed}.
 *
 * @returns `undefined` if neither `result` nor `error` is a JSON object.
 */
export function parseMonitor(result: string, error: string | null): MonitorParsed | undefined {
  const j = tryJson(result) ?? (error ? tryJson(error) : undefined);
  if (!j || !isMonitorPayload(j)) return undefined;
  if (Array.isArray(j.monitors)) {
    const monitors: MonitorEntry[] = j.monitors
      .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
      .map((m) => ({
        id: String(m.id ?? ""),
        command: String(m.command ?? ""),
        running: m.running === true,
      }));
    return {
      isList: true,
      monitors,
      id: null,
      command: null,
      running: null,
      ready: null,
      exitCode: null,
      hasExitCode: false,
      stopped: null,
      output: "",
    };
  }
  return {
    isList: false,
    monitors: [],
    id: typeof j.id === "string" ? j.id : null,
    command: typeof j.command === "string" ? j.command : null,
    running: triBool(j.running),
    ready: triBool(j.ready),
    exitCode: typeof j.exit_code === "number" ? j.exit_code : null,
    hasExitCode: "exit_code" in j,
    stopped: triBool(j.stopped),
    output: typeof j.output === "string" ? j.output : "",
  };
}

/** The fields a real monitor payload may carry; one of them must be present. */
const MONITOR_PAYLOAD_KEYS = [
  "monitors",
  "id",
  "command",
  "running",
  "ready",
  "exit_code",
  "stopped",
  "output",
] as const;

/**
 * Whether a parsed JSON object is a monitor payload at all.
 *
 * @remarks The same distinction {@link parseBash} draws, for the same reason: a
 *   `ToolError` such as `{"error":"monitor_not_found","message":"…"}` parses
 *   cleanly and then satisfies none of the field reads, yielding a status with
 *   every field null. The renderer painted a bare `○ monitor <id>` and dropped
 *   the message entirely, so polling or stopping an unknown id reported nothing
 *   at all about what went wrong. Returning `undefined` instead falls through to
 *   `renderGeneric`, which prints the error once.
 */
function isMonitorPayload(j: Record<string, unknown>): boolean {
  return MONITOR_PAYLOAD_KEYS.some((k) => j[k] !== undefined);
}
