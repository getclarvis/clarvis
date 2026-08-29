import { createMemo, For, Match, onCleanup, Show, Switch, untrack } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import { tokens } from "../theme/tokens.ts";
import { borderChars, glyph } from "../theme/glyphs.ts";
import { tone, type ToneStyle } from "../theme/tone.ts";
import { focusBg, userBandBg } from "../theme/surfaces.ts";
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
import { toolDisplayLabel } from "../adapters/tool-identity.ts";
import {
  hiddenBodyLines,
  resolveErrorRenderer,
  resolveToolRenderer,
  type ToolCallView,
} from "./tools/registry.tsx";
import { isLeadMutation, mutationStats, type DiffStats } from "./tools/mutation-gate.ts";
import { formatToolCall } from "./tools/signature.ts";
import { aggregateStatus, failureCount, type ToolGroupInfo } from "./tool-groups.ts";
import type { SectionHeader } from "./subagent-sections.ts";
import type { BlockOverride } from "./block-focus.ts";
import { formatElapsed, spinnerChar, thinkingDots, tickNow } from "./spinner.ts";
import { moreChip } from "./truncate.ts";
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
const MAX_GROUP_SIGNATURES = 6;

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
 * @param _chars - cumulative argument size; deliberately not exposed to users.
 * @returns a stable action-oriented progress label.
 *
 * @remarks It replaces the argument signature rather than sitting beside it,
 * because during this window there are no arguments to render — the node was
 * created from the tool's *name* alone, which is all the provider has sent.
 */
export function composingLabel(_chars: number): string {
  return "starting" + glyph("ellipsis");
}

function liveTailLines(node: TranscriptToolNode): string[] {
  if (node.status !== "running" || !node.liveOutput) return [];
  const lines = node.liveOutput.split("\n");
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
   * It deliberately avoids exposing provider byte-count mechanics to the user.
   */
  const composing = createMemo<string>(() =>
    props.node.inputChars === undefined ? "" : composingLabel(props.node.inputChars),
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
              {toolDisplayLabel(props.node.mcpName, props.node.toolName)}
            </span>
          </Show>
          <Show
            when={props.node.inputChars !== undefined}
            fallback={
              <span style={{ fg: tokens.muted }}>
                {props.node.signature ??
                  formatToolCall(
                    props.node.mcpName ?? "",
                    props.node.toolName ?? "",
                    display().arguments,
                  )}
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
        </text>
      </box>
      <Show when={tail().length > 0}>
        <box flexDirection="column" paddingLeft={props.indent ? 5 : 3} overflow="hidden">
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
              internalBlockMode="top-level"
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
              internalBlockMode="top-level"
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

function SectionHead(props: { header: SectionHeader; onClick?: () => void }): JSX.Element {
  const h = (): SectionHeader => props.header;
  /**
   * The folded-section count and its label.
   *
   * @remarks The two branches count different things and must not share a word.
   *   A lead's number is how many tools it called; a sub-agent section's is how
   *   many transcript entries the fold is hiding. Both used to render as
   *   "N steps", which read like the engine's loop *iteration* — the run's own
   *   vocabulary everywhere else — and was neither.
   */
  const foldedCount = (): number => (h().lead ? (h().toolCalls ?? 0) : (h().hiddenEntries ?? 0));
  const foldedLabel = (): string =>
    h().lead
      ? `${foldedCount()} tool call${foldedCount() === 1 ? "" : "s"}`
      : `${foldedCount()} hidden`;
  const stateLabel = (): string => {
    if (h().status === "ok") return "Completed";
    if (h().status === "error") return "Failed";
    if (h().status === "pending") return "Pending";
    return "Running";
  };
  return (
    <box>
      <text
        onMouseDown={h().lead ? props.onClick : undefined}
        wrapMode="none"
        truncate
        selectable={false}
      >
        <span style={{ fg: h().lead ? tokens.accent2 : statusTone(h().status).fg }}>
          {(h().lead ? glyph("diamond") : agentGlyph(h().status)) + " "}
        </span>
        <Show when={h().lead}>
          <span style={{ fg: tokens.accent2 }}>{h().model?.split("/").pop() ?? "lead"}</span>
        </Show>
        <Show when={!h().lead}>
          <span style={{ fg: tokens.subagent(h().order) }}>{capitalize(h().title)}</span>
          <Show when={h().model}>
            <span style={{ fg: tokens.muted }}>{" " + glyph("separator") + " " + h().model}</span>
          </Show>
          <span style={{ fg: statusTone(h().status).fg }}>
            {` ${glyph("separator")} ${stateLabel()}`}
          </span>
        </Show>
        <Show when={foldedCount() > 0}>
          <span style={{ fg: tokens.muted }}>
            {h().lead
              ? ` ${glyph("separator")} ${foldedLabel()}`
              : ` ${glyph("separator")} ${glyph("chevronRight")} ${foldedLabel()}`}
          </span>
        </Show>
      </text>
    </box>
  );
}

/**
 * Renders one transcript node — user turn, assistant text, reasoning,
 * tool call (solo, group head or group member), sub-agent delegation, plan,
 * annotation, error or run boundary — honoring its fold/focus/group state.
 *
 * @remarks
 * A `subagent` node's text is the delegation card: the brief the lead handed
 * the sub-agent, which is the "what was it told to do" that the section's
 * tool rows never show. A `plan` node collapses to just its header — the
 * approval gate already told the user the plan is "shown above", and the
 * sidebar is not always on screen — so collapsing hides the task list but
 * keeps the header, and a long plan costs only one line.
 *
 * `collapsed()`'s fallback reads a `collapsed` field that is not part of
 * `TranscriptNode` and that no production node ever sets — `showcase.test.ts`
 * guards that a real store-derived node never carries it. It exists solely so
 * render-test fixtures (`tests/helpers/transcript-fixtures.ts`'s `LegacyCollapsibleNode`)
 * can force default-fold state without wiring a full `defaultFolded` prop
 * through every test.
 */
export function BlockView(props: {
  node: TranscriptNode;
  /** Maximum rendered width; the transcript shell may widen blocks when it owns the full viewport. */
  maxWidth?: number | `${number}%`;
  forceExpand?: () => boolean;
  folded?: () => boolean;
  group?: () => ToolGroupInfo | undefined;
  sectionHeader?: () => SectionHeader | undefined;
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
  const own = (): BlockOverride | undefined => props.overrideOf?.(props.node.key);
  const leadMutation = (): boolean => props.node.kind === "tool_call" && isLeadMutation(props.node);
  const collapsed = (): boolean => {
    const o = own();
    if (o === "expanded") return false;
    if (o === "collapsed") return true;
    const fixtureCollapsedFallback = (props.node as TranscriptNode & { collapsed?: boolean })
      .collapsed;
    return (
      !leadMutation() &&
      !props.forceExpand?.() &&
      (props.defaultFolded?.() ?? fixtureCollapsedFallback ?? false)
    );
  };
  const bodyFolded = (): boolean => !props.forceExpand?.() && !!props.folded?.();
  const group = createMemo<ToolGroupInfo | undefined>(() => props.group?.());
  const role = (): ToolGroupInfo["role"] => group()?.role ?? "solo";
  const headOverride = (): BlockOverride | undefined => {
    const hk = group()?.headKey;
    return hk ? props.overrideOf?.(hk) : undefined;
  };
  const groupExpanded = (): boolean => !!props.forceExpand?.() || headOverride() === "expanded";
  /**
   * Whether the body renders unclamped.
   *
   * @remarks Deliberately **not** keyed on `forceExpand`. "Expand all" unfolds
   * every block; lifting a body's ten-line cap is the per-block expand, and the
   * two are separate on purpose — otherwise one keystroke pours every `grep` and
   * `shell` result into the transcript at full length. `tool-clamp.test.tsx`
   * holds the distinction, mounting with `forceExpand` and still expecting the
   * cap.
   */
  const fullBody = (): boolean => own() === "expanded" || headOverride() === "expanded";
  const toolNode = (): TranscriptToolNode => props.node as TranscriptToolNode;
  const planNode = (): TranscriptPlanNode => props.node as TranscriptPlanNode;
  const annotationNode = (): TranscriptAnnotationNode => props.node as TranscriptAnnotationNode;
  const runNode = (): TranscriptRunNode => props.node as TranscriptRunNode;
  const subagentNode = (): Extract<TranscriptNode, { kind: "subagent" }> =>
    props.node as Extract<TranscriptNode, { kind: "subagent" }>;
  /**
   * The run's verdict, and what the user can actually do next.
   *
   * @remarks The hint names only affordances that exist. It used to read
   * "inspect the error or retry", recommending a retry no key performs and an
   * inspection the product had nothing to show — so the one line offering help
   * after a failure pointed at two things the user could not do.
   */
  const runOutcome = (): { label: string; next?: string } => {
    if (props.node.status === "ok") return { label: "Completed" };
    const restart = "send a follow-up to try again, or /clear to start fresh";
    if (/cancel/i.test(runNode().reason ?? ""))
      return { label: "Canceled", next: `Next: ${restart}` };
    return { label: "Failed", next: `Next: ${restart}` };
  };
  const hidden = (): boolean =>
    role() === "member" &&
    !groupExpanded() &&
    !(props.node.kind === "tool_call" && props.node.warn);
  const members = createMemo<TranscriptToolNode[]>(() => group()?.members ?? [toolNode()]);
  const agg = createMemo<NodeStatus>(() => aggregateStatus(members()));
  const failures = createMemo<number>(() => failureCount(members()));
  const quietMembers = createMemo<TranscriptToolNode[]>(() =>
    members().filter((m) => m.status !== "error" && !m.warn),
  );
  const signatureMembers = createMemo<TranscriptToolNode[]>(() =>
    members().filter(
      (member) =>
        member.inputChars === undefined &&
        ((member.status !== "error" && !member.warn) || guardReviewLabel(member).length > 0),
    ),
  );
  const visibleSignatureMembers = createMemo<TranscriptToolNode[]>(() => {
    const denied = signatureMembers().filter((member) => member.guard?.outcome === "denied");
    const remaining = signatureMembers().filter((member) => member.guard?.outcome !== "denied");
    return [...denied, ...remaining].slice(0, MAX_GROUP_SIGNATURES);
  });
  const composingMembers = createMemo<number>(
    () => quietMembers().filter((member) => member.inputChars !== undefined).length,
  );
  const isSubagent = (): boolean => props.node.subagentOrder !== undefined;
  return (
    <Show when={!hidden()}>
      <Show when={!bodyFolded() || props.sectionHeader?.()}>
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
          marginTop={props.sectionHeader?.() ? 1 : 0}
          backgroundColor={
            props.focused?.() ? focusBg() : props.node.kind === "run" ? undefined : tokens.bg
          }
        >
          <Show when={props.sectionHeader?.()}>
            {(h: Accessor<SectionHeader>) => <SectionHead header={h()} onClick={props.onToggle} />}
          </Show>
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
                        {(props.node.status === "running" ? spinnerChar() : glyph("bullet")) + " "}
                      </text>
                      <AssistantMarkdown node={props.node} />
                    </box>
                  </Match>

                  <Match when={props.node.kind === "tool_call"}>
                    <Switch>
                      <Match when={role() === "solo" || groupExpanded()}>
                        <ToolLine
                          node={toolNode()}
                          showBody={groupExpanded() || !collapsed()}
                          full={fullBody()}
                          ungatedMutationBody={leadMutation()}
                          onHeaderClick={props.onToggle}
                        />
                      </Match>

                      <Match when={role() === "head"}>
                        <box flexDirection="column" paddingTop={1} overflow="hidden">
                          <box paddingLeft={1}>
                            <text
                              onMouseDown={props.onToggle}
                              wrapMode="none"
                              truncate
                              selectable={false}
                            >
                              <span style={{ fg: statusTone(agg()).fg }}>
                                {statusTone(agg()).glyph + " "}
                              </span>
                              <span style={{ fg: tokens.accent }}>
                                {toolDisplayLabel(toolNode().mcpName, toolNode().toolName)}
                              </span>
                              <span style={{ fg: tokens.muted }}>
                                {` ${glyph("multiply")}${members().length}`}
                              </span>
                              <Show when={composingMembers() > 0}>
                                <span style={{ fg: tokens.muted }}>
                                  {` ${glyph("separator")} ${composingLabel(0)}`}
                                </span>
                              </Show>
                              <Show when={failures() > 0}>
                                <span style={{ fg: tokens.del }}>
                                  {` ${glyph("separator")} ${failures()} failed`}
                                </span>
                              </Show>
                            </text>
                          </box>
                          <For each={visibleSignatureMembers()}>
                            {(m) => {
                              const review = (): string => guardReviewLabel(m);
                              return (
                                <box paddingLeft={3}>
                                  <text wrapMode="none" truncate>
                                    <span style={{ fg: tokens.muted }}>
                                      {formatToolCall(
                                        m.mcpName ?? "",
                                        m.toolName ?? "",
                                        m.args ?? {},
                                      )}
                                    </span>
                                    <Show when={review().length > 0}>
                                      <span style={{ fg: tokens.muted }}>
                                        {`  ${glyph("separator")} `}
                                      </span>
                                      <span
                                        style={{
                                          fg:
                                            m.guard?.outcome === "allowed"
                                              ? tokens.add
                                              : tokens.del,
                                        }}
                                      >
                                        {review()}
                                      </span>
                                    </Show>
                                  </text>
                                </box>
                              );
                            }}
                          </For>
                          <Show when={signatureMembers().length > MAX_GROUP_SIGNATURES}>
                            <box paddingLeft={3}>
                              <text fg={tokens.muted}>
                                {moreChip(signatureMembers().length - MAX_GROUP_SIGNATURES)}
                              </text>
                            </box>
                          </Show>
                          <Show when={toolNode().warn}>
                            <ToolLine node={toolNode()} showBody={false} indent />
                          </Show>
                        </box>
                      </Match>

                      <Match when={role() === "member"}>
                        <ToolLine node={toolNode()} showBody={false} indent />
                      </Match>
                    </Switch>
                  </Match>

                  <Match when={props.node.kind === "subagent"}>
                    <Show when={!collapsed() && props.node.text.trim().length > 0}>
                      <box
                        flexDirection="row"
                        paddingLeft={1}
                        onMouseDown={() =>
                          props.onOpenDetail?.({
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
                            props.onOpenDetail?.({
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
