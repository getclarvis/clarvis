import { createMemo, For, Match, onCleanup, Show, Switch, untrack } from "solid-js";
import type { JSX } from "solid-js";
import { tokens } from "../theme/tokens.ts";
import { borderChars, glyph } from "../theme/glyphs.ts";
import { tone, type ToneStyle } from "../theme/tone.ts";
import { focusBg, userBandBg } from "../theme/surfaces.ts";
import { terminalPlainText } from "../core/terminal-text.ts";
import { parseBash } from "../adapters/tool-parsers.ts";
import type {
  NodeStatus,
  TranscriptAnnotationNode,
  TranscriptNode,
  TranscriptPlanNode,
  TranscriptRunNode,
  TranscriptToolNode,
} from "../adapters/store.ts";
import { rawToolArguments } from "../adapters/store.ts";
import {
  IncrementalMarkdownSegmenter,
  guardReviewLabel,
  planMetaText,
  projectTranscriptToolDisplay,
  TRANSCRIPT_TOOL_DISPLAY_SHORTENED_NOTICE,
  transcriptDisplayText,
  type TranscriptToolDisplayProjection,
} from "../core/transcript/index.ts";
import { streamMetrics } from "../adapters/stream-metrics.ts";
import { toolDisplayLabel, toolIdentity } from "../adapters/tool-identity.ts";
import {
  hiddenBodyLines,
  resolveErrorRenderer,
  resolveToolRenderer,
  type ToolCallView,
} from "./tools/registry.tsx";
import { isLeadMutation, mutationStats, type DiffStats } from "./tools/mutation-gate.ts";
import { resolveToolCallSignature } from "./tools/signature.ts";
import type { BlockOverride } from "./block-focus.ts";
import { formatElapsed, spinnerChar, thinkingDots, tickNow } from "./spinner.ts";
import { fmtCount, moreChip } from "./truncate.ts";
import { activityPreview, type ActivityDetail } from "./activity-detail.ts";
import { StableMarkdown } from "../ui/patterns/stable-syntax.tsx";

/**
 * Default maximum width, in columns, for a transcript block or elicitation card.
 *
 * @remarks A *readability* bound, not a terminal one. A split transcript may fill
 * its pane so the sidebar does not strand that margin in the middle. Otherwise,
 * lines stop here before the eye loses its place returning to the next one,
 * which is the same constraint that puts printed measures around this width. It
 * also has to leave a code fence room to render without wrapping, which is why
 * it sits above the 80- and 100-column conventions rather than at one of them —
 * the repository's own Prettier `printWidth` is 100.
 */
export const MEASURE_MAX_COLS = 110;

const streamDebug = streamMetrics();

/**
 * The Markdown source a message node publishes to its renderable.
 *
 * @remarks The debug counter is read under `untrack` on purpose. Left tracked,
 *   the computation carrying this value subscribes to `status` as well as
 *   `text`, so settling the node re-publishes identical content and re-parses
 *   the whole message for nothing.
 */
function markdownContent(node: TranscriptNode): string {
  untrack(() => {
    if (node.status === "running") streamDebug.count("markdown_publish");
  });
  return transcriptDisplayText(node);
}

/** Upper-cases the first character of `s`; empty strings pass through unchanged. */
export function capitalize(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** The glyph/color a plan task's status renders with. */
export function taskTone(status: string): ToneStyle {
  switch (status) {
    case "done":
      return tone("ok");
    case "in_progress":
      return tone("running", spinnerChar());
    case "failed":
      return tone("error");
    case "abandoned":
      return { glyph: glyph("skipped"), fg: tone("muted").fg };
    case "returned":
      return tone("warn");
    default:
      return tone("pending");
  }
}

/** @see planMetaText — kept as a local alias for BlockView call sites. */
function planMeta(node: TranscriptPlanNode): string {
  return planMetaText(node);
}
const AGENT_KINDS = new Set<TranscriptNode["kind"]>([
  "assistant",
  "thinking",
  "reasoning",
  "tool_call",
  "subagent",
  "error",
]);

/**
 * Distinct call signatures a collapsed tool group names before it stops listing
 * them.
 *
 * @remarks The group header exists to say *what* was repeated; past a handful of
 * distinct signatures it stops being a summary and becomes the list it replaced.
 * Six fits one line at {@link MEASURE_MAX_COLS} for typical signatures, which is
 * the real constraint — a header that wraps defeats the collapse.
 */

/**
 * How long a tool call must run before the transcript shows its elapsed time.
 *
 * @remarks A threshold for *volunteering* a duration, so the cost of it being
 * too high is only that a slow call looks briefly indistinguishable from a fast
 * one. It sits above the point where a call reads as instantaneous and below the
 * point where a user starts wondering whether anything is happening — which is
 * the window the timer exists to fill.
 */
const SLOW_TOOL_MS = 2000;

/**
 * Lines of a running tool's output kept visible as a live tail.
 *
 * @remarks Deliberately small: the tail is a sign of life, not a viewport. Every
 * line it shows displaces transcript above it and is re-rendered on each flush,
 * and the complete output is available once the call settles. Enough lines to
 * see that output is moving and to recognise what it is.
 */
const LIVE_TAIL_LINES = 5;

/**
 * The stand-in shown while the model is still writing a tool call's arguments.
 *
 * @param chars - cumulative argument size received from the provider.
 * @param complete - whether the provider has closed the argument stream.
 * @param streamChars - cumulative characters observed across the provider stream.
 * @returns an action-oriented state, adding a compact count once argument bytes arrive.
 *
 * @remarks It replaces the argument signature rather than sitting beside it,
 * because during this window there are no arguments to render — the node was
 * created from the tool's *name* alone, which is all the provider has sent. A
 * zero count therefore says it is waiting rather than claiming byte progress.
 */
export function composingLabel(chars: number, complete = false, streamChars?: number): string {
  const stream =
    streamChars === undefined ? "" : ` ${glyph("separator")} stream ${fmtCount(streamChars)} chars`;
  if (complete) return `awaiting execution ${glyph("separator")} ${fmtCount(chars)} chars${stream}`;
  if (chars === 0) return `waiting for arguments${glyph("ellipsis")}${stream}`;
  return `receiving arguments${glyph("ellipsis")} ${fmtCount(chars)} chars${stream}`;
}

function liveTailLines(node: TranscriptToolNode): string[] {
  if (node.status !== "running" || !node.liveOutput) return [];
  const lines = terminalPlainText(node.liveOutput).split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-LIVE_TAIL_LINES);
}

/** The accent color for `node`'s left rail: background for non-agent kinds, else its sub-agent color (or the default accent for the lead). */
export function railColor(node: TranscriptNode): string {
  if (!AGENT_KINDS.has(node.kind)) return tokens.bg;
  return node.subagentOrder === undefined ? tokens.accent2 : tokens.subagent(node.subagentOrder);
}

/**
 * Added/removed counts for a mutation, measured on the node's real payload.
 *
 * @remarks Never on `display()`, which is bounded for rendering — see
 * {@link ToolCallView.mutation}. A dehydrated node has neither `args` nor
 * `diff` left, which is exactly what the precomputed `node.mutation` is for.
 */
function trueMutationStats(node: TranscriptToolNode): DiffStats | undefined {
  const args = rawToolArguments(node);
  const measured =
    node.mutation ??
    mutationStats({
      mcpName: node.mcpName,
      toolName: node.toolName,
      ...(node.diff !== undefined ? { diff: node.diff } : {}),
      ...(args !== undefined ? { args } : {}),
    });
  return measured ?? undefined;
}

function callView(
  node: TranscriptToolNode,
  display: TranscriptToolDisplayProjection,
  full = false,
  ungatedMutationBody = false,
): ToolCallView {
  const mutation = trueMutationStats(node);
  return {
    mcpName: node.mcpName ?? "",
    toolName: node.toolName ?? "",
    arguments: display.arguments,
    result: display.result,
    diff: display.diff,
    error: display.error,
    status: node.status,
    full,
    ungatedMutationBody,
    ...(mutation !== undefined ? { mutation } : {}),
  };
}

function toolBody(
  node: TranscriptToolNode,
  display: TranscriptToolDisplayProjection,
  full = false,
  ungatedMutationBody = false,
): JSX.Element {
  return resolveToolRenderer(
    node.mcpName ?? "",
    node.toolName ?? "",
  )(callView(node, display, full, ungatedMutationBody));
}

function toolErrorBody(
  node: TranscriptToolNode,
  display: TranscriptToolDisplayProjection,
): JSX.Element {
  return resolveErrorRenderer(node.mcpName ?? "", node.toolName ?? "")(callView(node, display));
}

function statusTone(status: NodeStatus): ToneStyle {
  switch (status) {
    case "ok":
      return tone("ok");
    case "error":
      return tone("error");
    case "running":
      return tone("running", spinnerChar());
    default:
      return tone("pending");
  }
}

/** The glyph for an agent/sub-agent's status: a spark on success, else the shared {@link statusTone} glyph. */
export function agentGlyph(status: NodeStatus): string {
  return status === "ok" ? glyph("spark") : statusTone(status).glyph;
}

function nodeTone(node: TranscriptNode): ToneStyle {
  return node.status === "ok" && node.kind === "tool_call" && node.warn
    ? tone("warn")
    : statusTone(node.status);
}

/**
 * One tool call's header line, plus its live tail and/or body when shown.
 *
 * @remarks
 * The header truncates instead of wrapping so a collapsed call is always
 * exactly one row, whatever the terminal width.
 */
function ToolLine(props: {
  node: TranscriptToolNode;
  showBody: boolean;
  indent?: boolean;
  full?: boolean;
  ungatedMutationBody?: boolean;
  onHeaderClick?: () => void;
}): JSX.Element {
  const display = createMemo(() =>
    projectTranscriptToolDisplay(props.node, rawToolArguments(props.node)),
  );
  const isCollapsed = (): boolean => !props.showBody && props.node.status !== "running";
  const failureSummary = (): string => {
    const error = display().error ?? "No authoritative result";
    if (toolIdentity(props.node.mcpName, props.node.toolName) === "shell") {
      const shell = parseBash(display().result, error);
      if (shell.exitCode !== null) return `exit ${shell.exitCode}`;
      return terminalPlainText(shell.stderr || error)
        .split("\n")[0]!
        .slice(0, 160);
    }
    return `${props.node.toolPhase ?? "failed"}: ${terminalPlainText(error).split("\n")[0]!.slice(0, 160)}`;
  };
  const diffChip = createMemo<DiffStats | null>(() =>
    isCollapsed() && props.node.status !== "error" ? (trueMutationStats(props.node) ?? null) : null,
  );
  const hiddenLines = createMemo<number>(() => {
    if (!isCollapsed() || props.node.status === "error" || diffChip() !== null) return 0;
    return hiddenBodyLines(props.node.mcpName ?? "", props.node.toolName ?? "", display().result);
  });
  const hasBody = (): boolean => props.showBody && props.node.status !== "running";
  /**
   * The running tool's last few output lines.
   *
   * @remarks Memoized because the `<Show>` and the `<For>` below both need it,
   *   and {@link liveTailLines} splits a buffer of up to `LIVE_OUTPUT_MAX_CHARS`
   *   — so calling it once per consumer split 8 KB twice per output delta.
   */
  const tail = createMemo<string[]>(() => liveTailLines(props.node));
  /**
   * The stable composing stand-in, or `""` once the call's real arguments exist.
   * Argument characters stay distinct from the broader streamed-character
   * heartbeat so the user can see that the provider is alive without claiming
   * that reasoning or prose has already become tool input.
   */
  const composing = createMemo<string>(() =>
    props.node.inputChars === undefined
      ? ""
      : composingLabel(
          props.node.inputChars,
          props.node.inputComplete === true,
          props.node.inputStreamChars,
        ),
  );
  const guardLabel = createMemo<string>(() => guardReviewLabel(props.node));
  return (
    <box
      flexDirection="column"
      paddingTop={props.indent ? 0 : 1}
      overflow="hidden"
      backgroundColor={tokens.bg}
    >
      <box paddingLeft={props.indent ? 3 : 1}>
        <text
          onMouseDown={props.indent ? undefined : props.onHeaderClick}
          wrapMode="none"
          truncate
          selectable={false}
        >
          <span style={{ fg: nodeTone(props.node).fg }}>{nodeTone(props.node).glyph + " "}</span>
          <Show when={!props.indent}>
            <span style={{ fg: tokens.accent }}>
              {toolDisplayLabel(props.node.mcpName, props.node.toolName, display().arguments)}
            </span>
          </Show>
          <Show
            when={props.node.inputChars !== undefined}
            fallback={
              <span style={{ fg: tokens.muted }}>
                {resolveToolCallSignature(props.node, display().arguments)}
              </span>
            }
          >
            <span style={{ fg: tokens.muted }}>{(props.indent ? "" : " ") + composing()}</span>
          </Show>
          <Show when={props.node.status === "running" && props.node.startedAt !== undefined}>
            <span style={{ fg: tokens.muted }}>
              {"  " + formatElapsed(tickNow() - props.node.startedAt!)}
            </span>
          </Show>
          <Show
            when={props.node.status !== "running" && (props.node.elapsedMs ?? 0) >= SLOW_TOOL_MS}
          >
            <span style={{ fg: tokens.muted }}>{"  " + formatElapsed(props.node.elapsedMs!)}</span>
          </Show>
          <Show when={diffChip()}>
            <span style={{ fg: tokens.muted }}>{`  ${glyph("separator")} `}</span>
            <span style={{ fg: tokens.add }}>{`+${diffChip()!.added}`}</span>
            <Show when={diffChip()!.removed > 0}>
              <span style={{ fg: tokens.del }}>{` ${glyph("minus")}${diffChip()!.removed}`}</span>
            </Show>
            <span style={{ fg: tokens.muted }}>
              {` ${glyph("separator")} ${moreChip(diffChip()!.lines)}`}
            </span>
          </Show>
          <Show when={hiddenLines() > 0}>
            <span style={{ fg: tokens.muted }}>{`  ${moreChip(hiddenLines())}`}</span>
          </Show>
          <Show when={guardLabel().length > 0}>
            <span style={{ fg: tokens.muted }}>{`  ${glyph("separator")} `}</span>
            <span
              style={{
                fg: props.node.guard?.outcome === "allowed" ? tokens.add : tokens.del,
              }}
            >
              {guardLabel()}
            </span>
          </Show>
          <Show when={props.node.status === "error" && isCollapsed()}>
            <span style={{ fg: tokens.del }}>{` · ${failureSummary()}`}</span>
          </Show>
        </text>
      </box>
      <Show when={tail().length > 0}>
        <box flexDirection="column" paddingLeft={props.indent ? 6 : 4} overflow="hidden">
          <For each={tail()}>
            {(line) => (
              <text fg={tokens.muted} wrapMode="none" truncate>
                {line}
              </text>
            )}
          </For>
        </box>
      </Show>
      <Show when={props.showBody && props.node.dehydrated && props.node.hydrationNotice}>
        <box paddingLeft={props.indent ? 5 : 3} paddingTop={1}>
          <text fg={tokens.muted} wrapMode="word">
            {props.node.hydrationNotice}
          </text>
        </box>
      </Show>
      <Show when={hasBody()}>
        <box
          flexDirection="column"
          marginLeft={props.indent ? 5 : 3}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={tokens.bgElev}
        >
          <Switch>
            <Match when={props.node.error}>{toolErrorBody(props.node, display())}</Match>
            <Match when={props.showBody && props.node.status !== "running"}>
              {toolBody(props.node, display(), props.full, props.ungatedMutationBody)}
            </Match>
          </Switch>
        </box>
      </Show>
      <Show when={props.showBody && props.node.status !== "running" && display().truncated}>
        <box
          flexDirection="column"
          paddingLeft={props.indent ? 5 : 3}
          paddingTop={1}
          paddingRight={1}
        >
          <text fg={tokens.warn} wrapMode="word">
            {TRANSCRIPT_TOOL_DISPLAY_SHORTENED_NOTICE}
          </text>
        </box>
      </Show>
    </box>
  );
}

/**
 * Renders an assistant message's Markdown as sealed segments plus a live tail.
 *
 * @remarks Splitting the message is what keeps a long reply's cost per delta
 *   flat. A single `<markdown>` re-parses and re-measures its trailing token on
 *   every flush, so a message that never breaks into paragraphs — a large file
 *   quoted inside one fence, most often — grows quadratically and was measured
 *   at ~50 ms per flush at 60 KB, against a 33 ms frame. The sealed prefixes
 *   are cut only on a terminated blank line outside a fenced code block, once
 *   the accumulating segment has reached `SEGMENT_MIN` characters — so every
 *   cut depends solely on the characters before it and appending never moves
 *   one already taken. Being prefix-stable, sealed segments stay mounted
 *   untouched. Sealed segments use OpenTUI's final mode; only the live tail
 *   uses streaming mode, and it leaves that mode when the assistant settles.
 *
 *   Every segment after the first carries `marginTop={1}`. `MarkdownRenderable`
 *   applies its inter-block margin internally, and that margin is exactly what a
 *   cut discards; without it the segmented render is visibly not the single-block
 *   render. The pure segmenter suite owns cut-point permutations, and
 *   `tests/integration/markdown-render-contract.test.tsx` keeps the small
 *   contract against this real component.
 */
function AssistantMarkdown(props: { node: TranscriptNode }): JSX.Element {
  const segmenter = new IncrementalMarkdownSegmenter();
  const running = (): boolean => props.node.status === "running";
  const epoch = (): number => (props.node.kind === "assistant" ? (props.node.textEpoch ?? 0) : 0);
  const seg = createMemo(() => segmenter.update(markdownContent(props.node), epoch(), running()));
  const tailMargin = (): number => (seg().sealed.length > 0 ? 1 : 0);
  onCleanup(() => segmenter.reset());
  return (
    <box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0}>
      <Show when={!running() && seg().simplified}>
        <text fg={tokens.muted} wrapMode="word" marginBottom={1}>
          {"Formatting simplified to keep this large response responsive."}
        </text>
      </Show>
      <For each={seg().sealed}>
        {(part, i) => (
          <Show
            when={part.kind === "markdown"}
            fallback={
              <text fg={tokens.fg} wrapMode="word" marginTop={i() === 0 ? 0 : 1}>
                {part.text}
              </text>
            }
          >
            <StableMarkdown
              streaming={false}
              conceal
              content={part.text}
              marginTop={i() === 0 ? 0 : 1}
            />
          </Show>
        )}
      </For>
      <Show when={seg().tail.length > 0}>
        <Show
          when={seg().tailKind === "plain"}
          fallback={
            <StableMarkdown
              streaming={running()}
              conceal
              content={seg().tail}
              geometryEpoch={epoch()}
              internalBlockMode={running() ? "top-level" : undefined}
              marginTop={tailMargin()}
            />
          }
        >
          <text fg={tokens.fg} wrapMode="word" marginTop={tailMargin()}>
            {seg().tail}
          </text>
        </Show>
      </Show>
    </box>
  );
}

/** Individual content presenter. Row/group identity and pagination belong to the viewport. */
export function BlockView(props: {
  node: TranscriptNode;
  /** Whether this physical owner may react to pointer input. */
  interactive?: () => boolean;
  /** Maximum rendered width; the transcript shell may widen blocks when it owns the full viewport. */
  maxWidth?: number | `${number}%`;
  forceExpand?: () => boolean;
  folded?: () => boolean;
  overrideOf?: (key: string) => BlockOverride | undefined;
  focused?: () => boolean;
  onToggle?: () => void;
  onOpenDetail?: (detail: ActivityDetail) => void;
  defaultFolded?: () => boolean;
  /** Lets a containing split pane use its full content width; the physical
   * parent remains the hard boundary, so this cannot overlap an adjacent
   * sibling such as the activity sidebar. */
  fillAvailableWidth?: () => boolean;
}): JSX.Element {
  const interactive = (): boolean => props.interactive?.() ?? true;
  const onToggle = (): void => {
    if (interactive()) props.onToggle?.();
  };
  const onOpenDetail = (detail: ActivityDetail): void => {
    if (interactive()) props.onOpenDetail?.(detail);
  };
  const own = (): BlockOverride | undefined => props.overrideOf?.(props.node.key);
  const leadMutation = (): boolean => props.node.kind === "tool_call" && isLeadMutation(props.node);
  const collapsed = (): boolean => {
    const o = own();
    if (o === "expanded") return false;
    if (o === "collapsed") return true;
    return !props.forceExpand?.() && (props.defaultFolded?.() ?? false);
  };
  const bodyFolded = (): boolean => !props.forceExpand?.() && !!props.folded?.();
  const fullBody = (): boolean => own() === "expanded";

  const toolNode = (): TranscriptToolNode => props.node as TranscriptToolNode;
  const planNode = (): TranscriptPlanNode => props.node as TranscriptPlanNode;
  const annotationNode = (): TranscriptAnnotationNode => props.node as TranscriptAnnotationNode;
  const runNode = (): TranscriptRunNode => props.node as TranscriptRunNode;
  const subagentNode = (): Extract<TranscriptNode, { kind: "subagent" }> =>
    props.node as Extract<TranscriptNode, { kind: "subagent" }>;
  const runOutcome = (): { label: string; next?: string } => {
    if (props.node.status === "ok")
      return { label: runNode().disposition === "checkpoint" ? "Checkpoint saved" : "Completed" };
    const next = "Next: send a follow-up to try again, or /clear to start fresh";
    return { label: /cancel/i.test(runNode().reason ?? "") ? "Canceled" : "Failed", next };
  };
  const isSubagent = (): boolean => props.node.subagentOrder !== undefined;
  return (
    <Show when={true}>
      <Show when={!bodyFolded()}>
        <box
          id={props.node.key}
          flexDirection="column"
          width="100%"
          maxWidth={props.maxWidth ?? (props.fillAvailableWidth?.() ? "100%" : MEASURE_MAX_COLS)}
          border={isSubagent() ? ["left"] : false}
          borderStyle="single"
          customBorderChars={borderChars()}
          borderColor={isSubagent() ? tokens.subagent(props.node.subagentOrder!) : undefined}
          paddingLeft={isSubagent() ? 1 : 0}

          backgroundColor={
            props.focused?.() ? focusBg() : props.node.kind === "run" ? undefined : tokens.bg
          }
        >
          <Show when={!bodyFolded()}>
            <box flexDirection="row">
              <box flexDirection="column" flexGrow={1}>
                <Switch>
                  <Match when={props.node.kind === "user"}>
                    <box
                      flexDirection="row"
                      backgroundColor={userBandBg()}
                      paddingLeft={1}
                      paddingRight={1}
                      paddingTop={1}
                      paddingBottom={1}
                      marginTop={1}
                    >
                      <text fg={tokens.accent} flexShrink={0}>
                        {glyph("rail") + " "}
                      </text>
                      <text fg={tokens.fg} flexGrow={1} flexBasis={0} minWidth={0}>
                        {transcriptDisplayText(props.node)}
                      </text>
                    </box>
                  </Match>

                  <Match when={props.node.kind === "reasoning"}>
                    <Show when={!collapsed()}>
                      <box paddingTop={1} paddingLeft={1} flexDirection="column">
                        <text>
                          <span style={{ fg: railColor(props.node) }}>
                            {(props.node.status === "running" ? spinnerChar() : glyph("spark")) +
                              " "}
                          </span>
                          <span style={{ fg: tokens.muted }}>thinking</span>
                        </text>
                        <text fg={tokens.muted}>{transcriptDisplayText(props.node)}</text>
                      </box>
                    </Show>
                  </Match>

                  <Match when={props.node.kind === "thinking"}>
                    <box paddingTop={1} paddingLeft={1}>
                      <text>
                        <span style={{ fg: railColor(props.node) }}>{spinnerChar() + " "}</span>
                        <span style={{ fg: tokens.muted }}>{"thinking" + thinkingDots()}</span>
                      </text>
                    </box>
                  </Match>

                  <Match when={props.node.kind === "assistant"}>
                    <box paddingTop={1} flexDirection="row">
                      <text fg={railColor(props.node)} flexShrink={0}>
                        {glyph("bullet") + " "}
                      </text>
                      <AssistantMarkdown node={props.node} />
                    </box>
                  </Match>

                  <Match when={props.node.kind === "tool_call"}>
                    <ToolLine
                      node={toolNode()}
                      showBody={!collapsed()}
                      full={fullBody()}
                      ungatedMutationBody={leadMutation()}
                      onHeaderClick={onToggle}
                    />
                  </Match>

                  <Match when={props.node.kind === "subagent"}>
                    <Show when={!collapsed() && props.node.text.trim().length > 0}>
                      <box
                        flexDirection="row"
                        paddingLeft={1}
                        onMouseDown={() =>
                          onOpenDetail({
                            title: `${capitalize(subagentNode().title ?? "sub-agent")} delegation`,
                            eyebrow: "Brief from the lead",
                            content: props.node.text,
                          })
                        }
                      >
                        <text fg={tokens.subagent(props.node.subagentOrder ?? 0)} flexShrink={0}>
                          {glyph("rail") + " "}
                        </text>
                        <text
                          fg={tokens.muted}
                          wrapMode="none"
                          truncate
                          flexGrow={1}
                          minWidth={0}
                          selectable={false}
                          onMouseDown={() =>
                            onOpenDetail({
                              title: `${capitalize(subagentNode().title ?? "sub-agent")} delegation`,
                              eyebrow: "Brief from the lead",
                              content: props.node.text,
                            })
                          }
                        >
                          {`${activityPreview(transcriptDisplayText(props.node), 180) ?? "Delegation brief"} · click to read`}
                        </text>
                      </box>
                    </Show>
                  </Match>

                  <Match when={props.node.kind === "plan"}>
                    <box flexDirection="column" paddingTop={1} paddingLeft={1}>
                      <text wrapMode="none" truncate>
                        <span style={{ fg: tokens.accent2 }}>{"plan "}</span>
                        <span style={{ fg: tokens.fg }}>{planNode().planTitle ?? "plan"}</span>
                        <span style={{ fg: tokens.muted }}>{planMeta(planNode())}</span>
                      </text>
                      <Show when={planNode().planReview}>
                        <text fg={tokens.accent2} wrapMode="none" truncate>
                          {"  review: " + planNode().planReview}
                        </text>
                      </Show>
                      <Show when={!collapsed()}>
                        <text fg={tokens.muted} wrapMode="word">
                          {planNode().planRemoved
                            ? planNode().planDiscarded
                              ? "  Plan was deleted after success, as configured"
                              : "  The backing record is unavailable; restore it or create a replacement plan"
                            : "  Open plan for the full objective, task list and review history"}
                        </text>
                      </Show>
                    </box>
                  </Match>

                  <Match when={props.node.kind === "annotation"}>
                    <box paddingTop={1} paddingLeft={1}>
                      <text
                        fg={
                          annotationNode().tone === "warn"
                            ? tokens.warn
                            : annotationNode().tone === "accent"
                              ? tokens.accent2
                              : tokens.muted
                        }
                        wrapMode="word"
                      >
                        {glyph("separator") + " " + transcriptDisplayText(props.node)}
                      </text>
                    </box>
                  </Match>

                  <Match when={props.node.kind === "error"}>
                    <box flexDirection="column" paddingTop={1} paddingLeft={1}>
                      <text>
                        <span style={{ fg: tokens.del }}>{glyph("error") + " error "}</span>
                        <Show when={props.node.agentLabel}>
                          <span style={{ fg: tokens.accent2 }}>
                            {"(" + capitalize(props.node.agentLabel ?? "") + ") "}
                          </span>
                        </Show>
                      </text>
                      <text fg={tokens.del}>{transcriptDisplayText(props.node)}</text>
                    </box>
                  </Match>

                  <Match when={props.node.kind === "run"}>
                    <box paddingTop={1} flexDirection="column">
                      <text wrapMode="word">
                        <span style={{ fg: tokens.muted }}>
                          {glyph("horizontal") + glyph("horizontal") + " "}
                        </span>
                        <span style={{ fg: statusTone(props.node.status).fg }}>
                          {statusTone(props.node.status).glyph + " "}
                        </span>
                        <span style={{ fg: statusTone(props.node.status).fg }}>
                          <b>{runOutcome().label}</b>
                        </span>
                        <Show when={runNode().elapsedMs !== undefined}>
                          <span style={{ fg: tokens.muted }}>
                            {" " + glyph("separator") + " " + formatElapsed(runNode().elapsedMs!)}
                          </span>
                        </Show>
                      </text>
                      <Show when={runOutcome().next}>
                        <text fg={tokens.muted} paddingLeft={3} wrapMode="word">
                          {runOutcome().next}
                        </text>
                      </Show>
                    </box>
                  </Match>
                </Switch>
              </box>
            </box>
          </Show>
        </box>
      </Show>
    </Show>
  );
}
