import type { JSX } from "solid-js";
import { createMemo, For, Index, Show } from "solid-js";
import { tokens } from "../../theme/tokens.ts";
import { glyph } from "../../theme/glyphs.ts";
import { filetypeFor, syntaxStyle } from "../../theme/syntax.ts";
import type { NodeStatus } from "../../adapters/store.ts";
import {
  parseBash,
  parseGrepContent,
  parseJsonObject,
  parseMonitor,
  parsePathList,
  parseReadFile,
  parseReadFiles,
} from "../../adapters/tool-parsers.ts";
import {
  diffStats,
  formatStatsChip,
  mutationBody,
  MUTATION_GATE_LINES,
  type DiffStats,
} from "./mutation-gate.ts";
import { toolIdentity } from "../../adapters/tool-identity.ts";
import { moreChip } from "../truncate.ts";
import { StableDiff } from "../../ui/patterns/stable-syntax.tsx";
import { terminalPlainText } from "../../core/terminal-text.ts";

/** The fields a tool result renderer needs from a transcript tool node. */
export interface ToolCallView {
  mcpName: string;
  toolName: string;
  arguments: Record<string, unknown>;
  result: string;
  diff?: string;
  error: string | null;
  status: NodeStatus;
  full?: boolean;
  /** Show an inline mutation body beyond the ordinary line gate without expanding every argument. */
  ungatedMutationBody?: boolean;
  /**
   * Wrap a line too wide for the viewport instead of clipping it.
   *
   * @remarks Unset in the transcript, where a clipped tail costs the reader
   * nothing they cannot recover by opening the full-screen view. Set *by* that
   * view: it is the surface a reader opens because the inline block was not
   * enough room, so clipping there silently discards the only copy they asked
   * for — and a diff's longest line is routinely a minified bundle or a long
   * string literal, exactly the content worth reading whole.
   */
  wrap?: boolean;
  /**
   * Added/removed counts measured on the call's real payload.
   *
   * @remarks `arguments`, `result` and `diff` are the display projection —
   * bounded so a 100 KiB write cannot stall the terminal. That makes them the
   * wrong thing to count: a gate chip derived from them states a fraction of
   * the lines the call actually changed, which is the one number a collapsed
   * mutation exists to report. The host measures the unbounded payload and
   * passes the result here; renderers prefer it and fall back to counting the
   * body only when it is absent.
   */
  mutation?: DiffStats;
}

/** Renders a tool call's result. `full` (unset by default) requests the untruncated body, used by {@link DiffViewer}. */
export type ToolRenderer = (call: ToolCallView) => JSX.Element;

function firstLine(s: string): string {
  const i = s.indexOf("\n");
  return i >= 0 ? s.slice(0, i) + (" " + glyph("ellipsis")) : s;
}
function trimTrailing(s: string): string {
  return s.replace(/\n+$/, "");
}

/**
 * Lines of an ordinary tool result rendered inline before the rest is folded
 * behind a `more` chip.
 *
 * @remarks The transcript is a record of the *conversation*, and a tool result
 * is evidence within it rather than the subject of it — so the default is to
 * show enough to recognise the result and to keep the exchange readable, not to
 * reproduce the output. Nothing is lost: the chip expands, and the full text is
 * in the trace. Mutation tools get their own, much larger allowance
 * ({@link MUTATION_GATE_LINES}), because for those the body *is* the thing being
 * reviewed.
 */
const MAX_BODY_LINES = 10;

function clampLines(s: string, max = MAX_BODY_LINES): { text: string; more: number } {
  const lines = s.split("\n");
  if (lines.length <= max) return { text: s, more: 0 };
  return { text: lines.slice(0, max).join("\n"), more: lines.length - max };
}

function MoreLine(props: { more: number }): JSX.Element {
  return (
    <Show when={props.more > 0}>
      <text fg={tokens.muted}>{moreChip(props.more)}</text>
    </Show>
  );
}

/** Plain text clamped to {@link MAX_BODY_LINES} lines, with a "+N more" line when `full` is unset. */
function ClampedText(props: {
  content: string;
  fg?: string;
  full?: boolean;
  wrap?: boolean;
}): JSX.Element {
  const c = createMemo(() =>
    clampLines(terminalPlainText(props.content), props.full ? Infinity : MAX_BODY_LINES),
  );
  return (
    <box flexDirection="column">
      <text fg={props.fg ?? tokens.fg} wrapMode={props.wrap ? "char" : undefined}>
        {c().text}
      </text>
      <MoreLine more={c().more} />
    </box>
  );
}

/** Syntax-highlighted code clamped to {@link MAX_BODY_LINES} lines, with a "+N more" line when `full` is unset. */
export function ClampedCode(props: {
  content: string;
  filetype: string;
  full?: boolean;
  /**
   * How a line too wide for the viewport is handled.
   *
   * @remarks Defaults to `"none"`, which clips at the right edge — right for a
   * tool result, where the line count is already summarised by
   * {@link MoreLine} and a clipped tail costs the reader nothing they cannot
   * recover by expanding.
   *
   * It is **wrong wherever the text is the thing being decided on**. A command
   * awaiting the guard's approval must be shown whole: clipped at the border
   * with no ellipsis, `… && touch DANGER_MARKER.txt` and `… && rm -rf ~` are
   * the same screen, and both `allow once` and `allow for this session` are one
   * keystroke away. Pass `"char"` there rather than `"word"`, because a shell
   * command's longest token is routinely an unbroken path that word wrapping
   * would still overflow.
   */
  wrap?: "none" | "char" | "word";
}): JSX.Element {
  const c = createMemo(() => clampLines(props.content, props.full ? Infinity : MAX_BODY_LINES));
  return (
    <box flexDirection="column">
      <code
        content={c().text}
        filetype={props.filetype}
        syntaxStyle={syntaxStyle()}
        wrapMode={props.wrap ?? "none"}
      />
      <MoreLine more={c().more} />
    </box>
  );
}

function GateChip(props: { stats: DiffStats }): JSX.Element {
  const chip = createMemo(() => formatStatsChip(props.stats));
  return (
    <text>
      <span style={{ fg: tokens.add }}>{chip().added}</span>
      <Show when={chip().removed.length > 0}>
        <span style={{ fg: tokens.del }}>{chip().removed}</span>
      </Show>
      <span style={{ fg: tokens.muted }}>{chip().tail}</span>
    </text>
  );
}

function oversize(body: string, full?: boolean): boolean {
  return !full && body.length > 0 && body.split("\n").length > MUTATION_GATE_LINES;
}

function mutationBodyExpanded(call: ToolCallView): boolean {
  return call.full === true || call.ungatedMutationBody === true;
}

function gateBody(call: ToolCallView): string {
  return mutationBody({
    mcpName: call.mcpName,
    toolName: call.toolName,
    diff: call.diff,
    args: call.arguments,
  });
}

/**
 * The stats a gate chip should show: the host's measurement of the real payload
 * when it has one, and only otherwise a count of the bounded body.
 */
function gateStats(call: ToolCallView, body: string): DiffStats {
  return call.mutation ?? diffStats(body);
}

/**
 * Renders a `shell` call: its status word, the command, then stdout and stderr.
 *
 * @remarks The status word is not always an exit code. A call that failed
 *   without an envelope to parse — a truncated tool payload, a rejected
 *   argument schema, a guard denial — never reached a shell and has no status
 *   to report, so "done" was a false statement about the very calls a user most
 *   needs to read correctly.
 */
function renderBash(call: ToolCallView): JSX.Element {
  const b = parseBash(call.result, call.error);
  const cmd = String(call.arguments.command ?? "");
  const failedUnparsed = !b.parsed && call.error !== null;
  const exitFg =
    b.exitCode === null
      ? failedUnparsed
        ? tokens.del
        : tokens.muted
      : b.exitCode === 0
        ? tokens.add
        : tokens.del;
  const status = (): string => {
    if (b.exitCode !== null) return `exit ${b.exitCode}`;
    return failedUnparsed ? "failed" : "done";
  };
  return (
    <box flexDirection="column">
      <text>
        <span style={{ fg: exitFg }}>{status()}</span>
        <Show when={b.timedOut}>
          <span style={{ fg: tokens.warn }}>{" " + glyph("separator") + " timed out"}</span>
        </Show>
        <Show when={b.signal}>
          <span style={{ fg: tokens.warn }}>{" " + glyph("separator") + " " + b.signal}</span>
        </Show>
        <Show when={cmd.length > 0}>
          <span style={{ fg: tokens.muted }}>{"  $ " + firstLine(cmd)}</span>
        </Show>
      </text>
      <Show when={b.stdout.trim().length > 0}>
        <ClampedText content={trimTrailing(b.stdout)} full={call.full} wrap={call.wrap} />
      </Show>
      <Show when={b.stderr.trim().length > 0}>
        <ClampedText
          content={trimTrailing(b.stderr)}
          fg={tokens.del}
          full={call.full}
          wrap={call.wrap}
        />
      </Show>
    </box>
  );
}

function renderReadFile(call: ToolCallView): JSX.Element {
  const r = parseReadFile(call.result);
  const path = String(call.arguments.path ?? "");
  const last = r.firstLine !== null ? r.firstLine + r.content.split("\n").length - 1 : null;
  return (
    <box flexDirection="column">
      <Show when={r.firstLine !== null}>
        <text
          fg={tokens.muted}
        >{`${path}  ${glyph("separator")}  lines ${r.firstLine}${glyph("enDash")}${last}`}</text>
      </Show>
      <ClampedCode
        content={r.content}
        filetype={filetypeFor(path)}
        full={call.full}
        wrap={call.wrap ? "char" : undefined}
      />
      <For each={r.notes}>{(n) => <text fg={tokens.muted}>{n}</text>}</For>
    </box>
  );
}

function renderReadFiles(call: ToolCallView): JSX.Element {
  const { sections, note } = parseReadFiles(call.result);
  if (sections.length === 0) return renderGeneric(call);
  return (
    <box flexDirection="column">
      <For each={sections}>
        {(s) => {
          const parsed = parseReadFile(s.body);
          const last =
            parsed.firstLine !== null
              ? parsed.firstLine + parsed.content.split("\n").length - 1
              : null;
          const head = s.error
            ? `  ${glyph("separator")}  ${s.error}`
            : parsed.firstLine !== null
              ? `  ${glyph("separator")}  lines ${parsed.firstLine}${glyph("enDash")}${last}`
              : "";
          return (
            <box flexDirection="column">
              <text fg={s.error ? tokens.del : tokens.accent2}>{s.path + head}</text>
              <Show when={parsed.content.length > 0}>
                <ClampedCode
                  content={parsed.content}
                  filetype={filetypeFor(s.path)}
                  wrap={call.wrap ? "char" : undefined}
                  full={call.full}
                />
              </Show>
              <For each={parsed.notes}>{(n) => <text fg={tokens.muted}>{n}</text>}</For>
            </box>
          );
        }}
      </For>
      <Show when={note !== null}>
        <text fg={tokens.muted}>{note}</text>
      </Show>
    </box>
  );
}

function renderImage(call: ToolCallView): JSX.Element {
  const path = String(call.arguments.path ?? "");
  return (
    <text>
      <span style={{ fg: tokens.accent2 }}>[image]</span>
      <Show when={path.length > 0}>
        <span style={{ fg: tokens.muted }}>{"  " + path}</span>
      </Show>
    </text>
  );
}

function renderGrep(call: ToolCallView): JSX.Element {
  const mode = String(call.arguments.output_mode ?? "files_with_matches");
  if (mode === "content") {
    const { groups, noMatches } = parseGrepContent(call.result);
    if (noMatches) return <text fg={tokens.muted}>(no matches)</text>;
    let budget = call.full ? Infinity : MAX_BODY_LINES;
    let hidden = 0;
    const shown: typeof groups = [];
    for (const g of groups) {
      if (budget <= 0) {
        hidden += g.rows.length;
        continue;
      }
      const rows = g.rows.slice(0, budget);
      hidden += g.rows.length - rows.length;
      budget -= rows.length;
      if (rows.length > 0) shown.push({ ...g, rows });
    }
    return (
      <box flexDirection="column">
        <For each={shown}>
          {(g) => (
            <box flexDirection="column">
              <text fg={tokens.accent2}>{g.path}</text>
              <For each={g.rows}>
                {(row) => (
                  <text>
                    <span style={{ fg: tokens.muted }}>
                      {String(row.line ?? "").padStart(5) + "  "}
                    </span>
                    <span style={{ fg: row.match ? tokens.fg : tokens.muted }}>{row.text}</span>
                  </text>
                )}
              </For>
            </box>
          )}
        </For>
        <MoreLine more={hidden} />
      </box>
    );
  }
  return renderPathList(call);
}

function renderPathList(call: ToolCallView): JSX.Element {
  const paths = parsePathList(call.result);
  if (paths.length === 0) return <text fg={tokens.muted}>(no matches)</text>;
  const shown = call.full ? paths : paths.slice(0, MAX_BODY_LINES);
  return (
    <box flexDirection="column">
      <For each={shown}>{(p) => <text fg={tokens.fg}>{p}</text>}</For>
      <MoreLine more={paths.length - shown.length} />
    </box>
  );
}

function renderWriteFile(call: ToolCallView): JSX.Element {
  const path = String(call.arguments.path ?? "");
  const content = String(call.arguments.content ?? "");
  const body = gateBody(call);
  if (oversize(body, mutationBodyExpanded(call))) {
    const s =
      call.mutation ??
      (call.diff
        ? diffStats(call.diff)
        : { added: content.split("\n").length, removed: 0, lines: content.split("\n").length });
    return (
      <box flexDirection="column">
        <text fg={tokens.muted}>{call.result || `Wrote ${path}`}</text>
        <GateChip stats={s} />
      </box>
    );
  }
  return (
    <box flexDirection="column">
      <text fg={tokens.muted}>{call.result || `Wrote ${path}`}</text>
      <Show
        when={call.diff}
        fallback={
          <code
            content={content}
            filetype={filetypeFor(path)}
            syntaxStyle={syntaxStyle()}
            wrapMode="none"
          />
        }
      >
        <StableDiff
          diff={call.diff!}
          filetype={filetypeFor(path)}
          wrapMode={call.full ? "word" : "none"}
          showLineNumbers
        />
      </Show>
    </box>
  );
}

function renderEdit(call: ToolCallView): JSX.Element {
  const path = String(call.arguments.path ?? "");
  const real = call.diff ? call.diff : undefined;
  const diff = gateBody(call);
  if (oversize(diff, mutationBodyExpanded(call))) {
    return (
      <box flexDirection="column">
        <Show when={!real}>
          <text fg={tokens.muted}>
            {(call.result || "edited") + "  " + glyph("separator") + " (reconstructed)"}
          </text>
        </Show>
        <GateChip stats={gateStats(call, diff)} />
      </box>
    );
  }
  return (
    <box flexDirection="column">
      <Show when={!real}>
        <text fg={tokens.muted}>
          {(call.result || "edited") + "  " + glyph("separator") + " (reconstructed)"}
        </text>
      </Show>
      <StableDiff
        diff={diff}
        filetype={filetypeFor(path)}
        wrapMode={call.full ? "word" : "none"}
        showLineNumbers={real !== undefined}
      />
    </box>
  );
}

/**
 * The file path a unified diff's `+++`/`---` headers name, for choosing a
 * filetype to syntax-highlight it with.
 *
 * @remarks
 * Prefers the `+++` (new-file) path over `---` (old-file), and skips
 * `/dev/null` headers (a pure add or delete) so the other side's path wins.
 */
export function diffHeaderPath(diff: string): string | undefined {
  let fallback: string | undefined;
  for (const line of diff.split("\n")) {
    const m = /^(\+\+\+|---) (.+)$/.exec(line);
    if (!m) continue;
    const p = m[2]!
      .split("\t")[0]!
      .trim()
      .replace(/^[ab]\//, "");
    if (p.length === 0 || p === "/dev/null") continue;
    if (m[1] === "+++") return p;
    fallback ??= p;
  }
  return fallback;
}

interface DiffFileSection {
  path: string | undefined;
  diff: string;
}

function splitDiffFiles(raw: string): { preamble: string; files: DiffFileSection[] } {
  const lines = raw.split("\n");
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.startsWith("--- ") || !(lines[i + 1] ?? "").startsWith("+++ ")) continue;
    let s = i;
    if (s > 0 && /^=+$/.test(lines[s - 1]!)) s -= 1;
    if (s > 0 && lines[s - 1]!.startsWith("Index: ")) s -= 1;
    starts.push(s);
  }
  if (starts.length === 0) return { preamble: "", files: [{ path: undefined, diff: raw }] };
  const preamble = lines.slice(0, starts[0]).join("\n").trim();
  const files = starts.map((s, i) => {
    const body = trimTrailing(lines.slice(s, starts[i + 1] ?? lines.length).join("\n"));
    return { path: diffHeaderPath(body), diff: body };
  });
  return { preamble, files };
}

function firstPathArg(args: Record<string, unknown>): string | undefined {
  for (const key of ["path", "from", "to", "source", "file"]) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function renderApplyPatch(call: ToolCallView): JSX.Element {
  const body = gateBody(call);
  if (oversize(body, mutationBodyExpanded(call))) {
    return (
      <box flexDirection="column">
        <Show when={call.result.length > 0}>
          <text fg={tokens.muted}>{call.result}</text>
        </Show>
        <GateChip stats={gateStats(call, body)} />
      </box>
    );
  }
  return (
    <box flexDirection="column">
      <Show when={call.result.length > 0}>
        <text fg={tokens.muted}>{call.result}</text>
      </Show>
      <StableDiff
        diff={body}
        filetype={filetypeFor(diffHeaderPath(body))}
        wrapMode={call.full ? "word" : "none"}
        showLineNumbers={false}
      />
    </box>
  );
}

/**
 * Renders the `diff`/`replace` tools' result.
 *
 * @remarks
 * `replace` ships the diff via `call.diff` and a human-readable summary via
 * `call.result` — both are shown when present, the summary above the diff.
 */
function renderDiffTool(call: ToolCallView): JSX.Element {
  const flat = call.result.trim();
  if (flat === "(no differences)" || flat === "(no matches)") {
    return <text fg={tokens.muted}>{flat}</text>;
  }
  const raw = trimTrailing(call.diff ?? call.result);
  if (raw.length === 0) return renderGeneric(call);
  if (oversize(raw, mutationBodyExpanded(call))) {
    return (
      <box flexDirection="column">
        <Show when={call.diff && flat.length > 0}>
          <ClampedText content={flat} fg={tokens.muted} />
        </Show>
        <GateChip stats={gateStats(call, raw)} />
      </box>
    );
  }
  const { preamble, files } = splitDiffFiles(raw);
  const fallback = firstPathArg(call.arguments);
  return (
    <box flexDirection="column">
      <Show when={call.diff && flat.length > 0}>
        <ClampedText content={flat} fg={tokens.muted} full={call.full} wrap={call.wrap} />
      </Show>
      <Show when={preamble.length > 0}>
        <text fg={tokens.muted}>{preamble}</text>
      </Show>
      <For each={files}>
        {(f) => (
          <StableDiff
            diff={f.diff}
            filetype={filetypeFor(f.path ?? fallback)}
            wrapMode={call.full ? "word" : "none"}
            showLineNumbers={false}
          />
        )}
      </For>
    </box>
  );
}

function renderMonitor(call: ToolCallView): JSX.Element {
  const m = parseMonitor(call.result, call.error);
  if (!m) return renderGeneric(call);
  if (m.isList) {
    if (m.monitors.length === 0) return <text fg={tokens.muted}>(no monitors)</text>;
    return (
      <box flexDirection="column">
        <For each={m.monitors}>
          {(e) => (
            <text>
              <span style={{ fg: e.running ? tokens.add : tokens.muted }}>
                {e.running ? glyph("dotFull") + " " : glyph("dotEmpty") + " "}
              </span>
              <span style={{ fg: tokens.accent2 }}>{e.id}</span>
              <span style={{ fg: tokens.muted }}>{"  " + firstLine(e.command)}</span>
            </text>
          )}
        </For>
      </box>
    );
  }
  const running = m.running === true;
  const label = m.stopped
    ? "stopped"
    : running
      ? "running"
      : m.running === false
        ? "exited"
        : "monitor";
  return (
    <box flexDirection="column">
      <text>
        <span style={{ fg: running ? tokens.add : tokens.muted }}>
          {(running ? glyph("dotFull") + " " : glyph("dotEmpty") + " ") + label}
        </span>
        <Show when={m.id !== null}>
          <span style={{ fg: tokens.accent2 }}>{"  " + m.id}</span>
        </Show>
        <Show when={m.ready !== null}>
          <span style={{ fg: m.ready ? tokens.add : tokens.warn }}>
            {m.ready
              ? "  " + glyph("separator") + " ready"
              : "  " + glyph("separator") + " not ready"}
          </span>
        </Show>
        <Show when={m.hasExitCode && m.exitCode !== null}>
          <span style={{ fg: m.exitCode === 0 ? tokens.add : tokens.del }}>
            {"  " + glyph("separator") + " exit " + m.exitCode}
          </span>
        </Show>
      </text>
      <Show when={m.output.trim().length > 0}>
        <ClampedText content={trimTrailing(m.output)} full={call.full} wrap={call.wrap} />
      </Show>
    </box>
  );
}

function renderSummary(call: ToolCallView): JSX.Element {
  return <text fg={tokens.fg}>{trimTrailing(call.result) || "(done)"}</text>;
}

/**
 * Renders a tool result parsed as a flat JSON object, one `key  value` line
 * per entry.
 *
 * @remarks
 * Uses Solid's `Index`, not `For`: `Object.entries()` yields fresh `[k, v]`
 * tuples every render with no stable identity to diff on, so rows must key
 * by position instead.
 */
function renderJsonCard(call: ToolCallView): JSX.Element {
  const j = parseJsonObject(call.result);
  if (!j) return renderGeneric(call);
  const entries = Object.entries(j);
  const shown = call.full ? entries : entries.slice(0, MAX_BODY_LINES);
  return (
    <box flexDirection="column">
      <Index each={shown}>
        {(entry) => (
          <text>
            <span style={{ fg: tokens.muted }}>{entry()[0].padEnd(12)}</span>
            <span style={{ fg: tokens.fg }}>
              {typeof entry()[1] === "object" ? JSON.stringify(entry()[1]) : String(entry()[1])}
            </span>
          </text>
        )}
      </Index>
      <MoreLine more={entries.length - shown.length} />
    </box>
  );
}

function renderTree(call: ToolCallView): JSX.Element {
  const body = trimTrailing(call.result);
  if (!body) return <text fg={tokens.muted}>(empty)</text>;
  return <ClampedText content={body} full={call.full} wrap={call.wrap} />;
}

function renderGeneric(call: ToolCallView): JSX.Element {
  const body = trimTrailing(call.result);
  if (!body) return <text fg={tokens.muted}>(no output)</text>;
  if (parseJsonObject(call.result) !== undefined) return renderJsonCard(call);
  return <ClampedText content={body} fg={tokens.muted} full={call.full} wrap={call.wrap} />;
}

function renderMemoryRead(call: ToolCallView): JSX.Element {
  const body = trimTrailing(call.result);
  if (!body) return <text fg={tokens.muted}>(no output)</text>;
  return (
    <ClampedCode
      content={body}
      filetype="markdown"
      full={call.full}
      wrap={call.wrap ? "char" : undefined}
    />
  );
}

function renderMemoryGrep(call: ToolCallView): JSX.Element {
  if (parseGrepContent(call.result).groups.length === 0) return renderGeneric(call);
  return renderGrep({ ...call, arguments: { ...call.arguments, output_mode: "content" } });
}

const byTool: Record<string, ToolRenderer> = {
  shell: renderBash,
  read_file: renderReadFile,
  read_files: renderReadFiles,
  read_image: renderImage,
  grep: renderGrep,
  glob: renderPathList,
  list_dir: renderPathList,
  write_file: renderWriteFile,
  edit_file: renderEdit,
  multi_edit: renderEdit,
  apply_patch: renderApplyPatch,
  diff: renderDiffTool,
  replace: renderDiffTool,
  move: renderSummary,
  copy: renderSummary,
  mkdir: renderSummary,
  remove: renderSummary,
  tree: renderTree,
  file_stat: renderJsonCard,
  monitor_start: renderMonitor,
  monitor_poll: renderMonitor,
  monitor_stop: renderMonitor,
  monitor_list: renderMonitor,
  read_memory: renderMemoryRead,
  list_memories: renderPathList,
  grep_memories: renderMemoryGrep,
  write_memory: renderWriteFile,
  edit_memory: renderEdit,
  delete_memory: renderSummary,
};

/** The {@link ToolRenderer} registered for a tool, or {@link renderGeneric} when none is. */
export function resolveToolRenderer(mcpName: string, toolName: string): ToolRenderer {
  return byTool[toolIdentity(mcpName, toolName)] ?? renderGeneric;
}

/**
 * The number of body lines a collapsed tool block is currently hiding, used
 * to size the "N more" affordance without fully rendering the tool.
 *
 * @remarks Every tool routed to a renderer that reshapes its result needs a case
 *   here, `monitor_list` included: its payload is one line of unindented JSON,
 *   so falling through to the raw line count always answered `1` while the
 *   rendered body is one row per monitor.
 */
export function hiddenBodyLines(mcpName: string, toolName: string, result: string): number {
  const lines = (s: string): number => {
    const t = s.replace(/\n+$/, "");
    return t.trim().length === 0 ? 0 : t.split("\n").length;
  };
  const id = toolIdentity(mcpName, toolName);
  if (id === "shell") {
    const b = parseBash(result, null);
    return lines(b.stdout) + lines(b.stderr);
  }
  if (
    id === "monitor_start" ||
    id === "monitor_poll" ||
    id === "monitor_stop" ||
    id === "monitor_list"
  ) {
    const m = parseMonitor(result, null);
    if (m) return m.isList ? m.monitors.length : lines(m.output);
  }
  return lines(result);
}

const ERROR_AWARE = new Set<string>(["shell", "monitor_start", "monitor_poll", "monitor_stop"]);

function renderErrorGeneric(call: ToolCallView): JSX.Element {
  // An error is exactly the text a reader needs whole; clamping it to ten lines
  // with no way to lift the clamp truncates the stack trace that explains the
  // failure.
  return (
    <ClampedText
      content={trimTrailing(call.error ?? "")}
      fg={tokens.del}
      full={call.full}
      wrap={call.wrap}
    />
  );
}

/**
 * The renderer to use for a tool call that ended in an error.
 *
 * @remarks
 * A tool in {@link ERROR_AWARE} (one whose success renderer already surfaces
 * partial output, e.g. `shell`'s stdout/stderr) reuses its normal
 * {@link resolveToolRenderer} so that output still shows; every other tool
 * falls back to {@link renderErrorGeneric}, which shows only the error text.
 */
export function resolveErrorRenderer(mcpName: string, toolName: string): ToolRenderer {
  return ERROR_AWARE.has(toolIdentity(mcpName, toolName))
    ? resolveToolRenderer(mcpName, toolName)
    : renderErrorGeneric;
}

/** Renders a tool call's arguments through its resolved renderer with no result yet, for a pending-call preview. */
export function renderToolPreview(
  mcpName: string,
  toolName: string,
  args: Record<string, unknown>,
): JSX.Element {
  return resolveToolRenderer(
    mcpName,
    toolName,
  )({
    mcpName,
    toolName,
    arguments: args,
    result: "",
    error: null,
    status: "ok",
  });
}
