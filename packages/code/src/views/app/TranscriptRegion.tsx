import { Show, createMemo, onCleanup, type Accessor, type JSX } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { ElicitRequestParams, ElicitResult } from "../../adapters/elicit-types.ts";
import type { ActivityStore } from "../../adapters/activity-store.ts";
import type { TranscriptStore } from "../../adapters/store.ts";
import type { WorkflowActivity } from "../../adapters/workflow-projection.ts";
import type { LayoutMode, SecondarySurfaceMode } from "../../app/layout.ts";
import type { Interaction } from "../../keys/interaction.ts";
import { tokens } from "../../theme/tokens.ts";
import { mixHex } from "../../theme/model.ts";
import { scrimColor } from "../../theme/surfaces.ts";
import { Sidebar, type SidebarRevealIntent } from "../Sidebar.tsx";
import { ActivitySummaryStrip, ACTIVITY_SUMMARY_PADDING } from "../ActivitySummaryStrip.tsx";
import {
  activitySummaryFacts,
  activitySummaryRowBudget,
  activitySummaryRoute,
} from "../activity-summary.ts";
import { Splash } from "../Splash.tsx";
import type { TranscriptState } from "../transcript-state.ts";
import type { HintTone } from "../hint.ts";
import type { ActivityDetail } from "../activity-detail.ts";
import { SurfaceBoundary, SurfaceOverlay } from "../../ui/patterns/surface-lifecycle.tsx";
import {
  TranscriptViewport,
  type TranscriptViewportHandle,
} from "../transcript/TranscriptViewport.tsx";
import { ElicitBlock } from "../ElicitBlock.tsx";
import type { GoalController } from "../../features/goal/controller.ts";

/** Normal bottom breathing room between the newest transcript row and composer chrome. */
const TRANSCRIPT_READING_RUNWAY_ROWS = 3;
/** Reduced breathing room for terminals in the compact height band. */
const TRANSCRIPT_READING_RUNWAY_COMPACT_ROWS = 1;
/** Maximum terminal height that uses the compact runway. */
const TRANSCRIPT_READING_RUNWAY_COMPACT_MAX_HEIGHT = 28;

/** Returns the fixed transcript runway for one terminal-height band. */
function transcriptReadingRunwayRows(terminalHeight: number): number {
  return terminalHeight <= TRANSCRIPT_READING_RUNWAY_COMPACT_MAX_HEIGHT
    ? TRANSCRIPT_READING_RUNWAY_COMPACT_ROWS
    : TRANSCRIPT_READING_RUNWAY_ROWS;
}

/** Run-specific ports consumed by the transcript region. */
export interface TranscriptRegionRun {
  elicit: Accessor<ElicitRequestParams | null>;
  resolveElicit: (result: ElicitResult) => void;
  workflowActivity: Accessor<WorkflowActivity | null>;
  /** Milliseconds left in the pending question's decision window, or null. */
  elicitRemaining?: Accessor<number | null>;
  /**
   * Confirm the pending question is on screen, called once the block is
   * actually laid out inside the viewport.
   *
   * @remarks The visibility seam owns the moment: confirming on notification
   *   would start the kernel's window while the block is still queued behind an
   *   overlay, and the user would lose part of it.
   */
  presentElicit?: () => void;
}

/** Layout projections consumed by the transcript region. */
export interface TranscriptRegionLayout {
  mode: Accessor<LayoutMode>;
  sidebarVisible: Accessor<boolean>;
  secondaryMode?: Accessor<SecondarySurfaceMode>;
  sidebarWidth: Accessor<number>;
  secondaryOpen: Accessor<boolean>;
  closeSecondary?: () => void;
  contentInset: Accessor<number>;
  width: Accessor<number>;
  height: Accessor<number>;
  sidebarHint?: Accessor<string>;
  /** The effective `activity.toggle` label, or undefined when no binding is registered. */
  toggleKey?: Accessor<string | undefined>;
  /** Opens or closes the secondary surface; the summary strip's pointer route. */
  toggleActivity?: () => void;
}

/** Props for the transcript, sidebar, splash, and elicitation shell region. */
export interface TranscriptRegionProps {
  store: TranscriptStore;
  transcript: TranscriptState;
  activity: ActivityStore;
  interaction: Interaction;
  run: TranscriptRegionRun;
  layout: TranscriptRegionLayout;
  active?: Accessor<boolean>;
  contextWindow: Accessor<number>;
  agent: Accessor<string>;
  model: Accessor<string>;
  notify: (message: string, tone?: HintTone) => void;
  openPlan: () => void;
  sidebarReveal?: Accessor<SidebarRevealIntent | null>;
  onOpenDetail?: (detail: ActivityDetail) => void;
  onScrollbox: (scrollbox: ScrollBoxRenderable) => void;
  onHistoryHandle?: (handle: TranscriptViewportHandle | undefined) => void;
  draftNonEmpty?: Accessor<boolean>;
  goals?: GoalController;
  onOpenGoal?: () => void;
}

/**
 * Renders the main transcript region independently of application orchestration.
 *
 * @remarks The root box **clips**. Everything in this region is expected to fit
 *   inside it, but {@link Splash} is absolutely positioned and vertically
 *   centred, so when the region is squeezed — opening the slash-command popup
 *   adds ~20 rows to the input dock, and this region is the only child that can
 *   give them up — centring content taller than the box yields a negative `y`
 *   and the wordmark is laid out above the terminal's first row.
 *
 *   Without a clip that overflow still paints, and whether it is *visible*
 *   depends on paint order: the persistent shell keeps this owner mounted
 *   behind full-region overlays, while clipping prevents an oversized splash
 *   from escaping its Yoga allocation during either the initial or retained
 *   paint order.
 *
 *   This region also owns the two compact-band presentations. In `"single"` mode the activity
 *   sections are summarised in one strip below the transcript instead of opening beside or over
 *   it; the same sections open into the whole content region when the reader asks for them. The
 *   Sidebar keeps one implementation and two mounts — the inline column shared by `split` and
 *   `full`, and the scrim-backed drawer of the narrow band.
 */
export function TranscriptRegion(props: TranscriptRegionProps): JSX.Element {
  const ts = props.transcript;
  const regionActive = (): boolean => props.active?.() ?? true;
  const secondaryMode = (): SecondarySurfaceMode =>
    props.layout.secondaryMode?.() ??
    (props.layout.mode() === "single" && props.layout.secondaryOpen()
      ? "full"
      : props.layout.mode() !== "single" &&
          props.layout.mode() !== "floor" &&
          props.layout.sidebarVisible()
        ? "split"
        : "closed");
  const splitOpen = (): boolean => secondaryMode() === "split";
  const fullOpen = (): boolean => secondaryMode() === "full";
  const summaryVisible = (): boolean =>
    props.layout.mode() === "single" && secondaryMode() === "closed";
  const inlineWidth = (): number =>
    fullOpen() ? props.layout.width() : props.layout.sidebarWidth();
  /**
   * Columns the splash must leave free on the right.
   *
   * @remarks This region owns the inline column it renders, so a visible split
   *   is its own answer — the shell's `contentInset` projection also covers a
   *   surface this region does not mount. Two surfaces that must coexist cannot
   *   depend on which one happens to paint last.
   */
  const splashInset = (): number =>
    splitOpen() ? props.layout.sidebarWidth() : props.layout.contentInset();
  const toggleKey = (): string | undefined => props.layout.toggleKey?.();
  const agentTitle = (agent: ActivityStore["subagents"][number]): string =>
    agent.title
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "sub-agent";
  const projectionId = (): string | null => ts.selectedSubagent();
  const childTitle = createMemo((): string | undefined => {
    const selected = projectionId();
    if (selected === null) return undefined;
    const agent = props.activity.subagents.find(
      (candidate: ActivityStore["subagents"][number]) => candidate.id === selected,
    );
    if (agent !== undefined)
      return secondaryMode() === "closed"
        ? `Viewing A${agent.order + 1} ${agentTitle(agent)} · Back to Lead`
        : undefined;
    const marker = props.store.nodes.find((node) => node.delegationTarget === selected);
    const title =
      marker?.kind === "annotation" ? marker.text.replace(/^Spawned sub-agent /, "") : selected;
    return `Viewing ${title} · Back to Lead`;
  });
  const summaryFacts = createMemo(() => {
    const formulating = props.goals?.formulating() === true;
    const status = props.goals?.view()?.state.current?.status;
    const facts = activitySummaryFacts({
      goal: status === undefined ? { formulating } : { formulating, status },
      plan: props.activity.plan,
      workflow: props.run.workflowActivity(),
      subagents: props.activity.subagents,
    });
    const key = toggleKey();
    if (facts.length === 0 || key === undefined) return facts;
    return [...facts, activitySummaryRoute(`[${key}] activity`)];
  });
  const publishHandle = (handle: TranscriptViewportHandle | undefined): void => {
    props.onHistoryHandle?.(handle);
  };
  const activityPanel = (): JSX.Element => (
    <Sidebar
      activity={props.activity}
      focused={() => ts.selectedSubagent() !== null}
      contextWindow={props.contextWindow}
      selected={ts.selectedSubagent}
      onSelectSubagent={(id) => ts.toggleSubagent(id)}
      onShowAllAgents={() => {
        const selected = ts.selectedSubagent();
        if (selected !== null) ts.toggleSubagent(selected);
      }}
      width={inlineWidth}
      workflow={props.run.workflowActivity}
      reveal={props.sidebarReveal}
      onOpenDetail={props.onOpenDetail}
      footerHint={props.layout.sidebarHint}
      onClose={props.layout.closeSecondary}
      goals={props.goals}
      onOpenGoal={props.onOpenGoal}
    />
  );

  onCleanup(() => {
    props.onHistoryHandle?.(undefined);
  });

  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
      <box flexDirection="row" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
        <Show when={!fullOpen()}>
          <box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} minHeight={0}>
            <Show when={childTitle()}>
              {(title: Accessor<string>) => (
                <box
                  id="transcript-child-navigation"
                  height={1}
                  flexShrink={0}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={tokens.bgElev}
                  onMouseDown={() => {
                    const selected = projectionId();
                    if (selected !== null && regionActive()) ts.toggleSubagent(selected);
                  }}
                >
                  <text wrapMode="none" truncate selectable={false}>
                    <span style={{ fg: tokens.accent }}>
                      <b>{title()}</b>
                    </span>
                  </text>
                </box>
              )}
            </Show>
            <TranscriptViewport
              store={props.store}
              transcript={ts}
              active={regionActive}
              width={() => props.layout.width() - (splitOpen() ? props.layout.sidebarWidth() : 0)}
              notify={props.notify}
              onOpenDetail={props.onOpenDetail}
              onScrollbox={props.onScrollbox}
              onHandle={publishHandle}
            >
              <Show when={regionActive() ? props.run.elicit() : null} keyed>
                {(request: ElicitRequestParams) => (
                  <ElicitBlock
                    interaction={props.interaction}
                    request={request}
                    onResolve={props.run.resolveElicit}
                    onNotify={props.notify}
                    plan={() => props.activity.plan}
                    onOpenPlan={props.openPlan}
                    fillAvailableWidth={splitOpen}
                    remaining={props.run.elicitRemaining}
                  />
                )}
              </Show>
              <box
                id="transcript-reading-runway"
                height={transcriptReadingRunwayRows(props.layout.height())}
                flexShrink={0}
              />
            </TranscriptViewport>
          </box>
        </Show>
        <Show when={splitOpen()}>{activityPanel()}</Show>
        <Show when={fullOpen()}>
          <box
            id="activity-panel"
            flexDirection="column"
            flexGrow={1}
            flexShrink={1}
            minWidth={0}
            minHeight={0}
          >
            <box
              id="activity-panel-header"
              flexDirection="row"
              flexShrink={0}
              paddingLeft={ACTIVITY_SUMMARY_PADDING}
              paddingRight={ACTIVITY_SUMMARY_PADDING}
              backgroundColor={tokens.bgElev}
            >
              <text wrapMode="word" selectable={false}>
                <span style={{ fg: tokens.accent }}>
                  <b>{`Activity`}</b>
                </span>
                <Show when={toggleKey()}>
                  {(key: Accessor<string>) => (
                    <span style={{ fg: tokens.muted }}>{`  [${key()}] close`}</span>
                  )}
                </Show>
              </text>
            </box>
            {activityPanel()}
          </box>
        </Show>
        <Show
          when={
            props.store.nodes.length === 0 &&
            !props.run.elicit() &&
            !props.draftNonEmpty?.() &&
            !fullOpen()
          }
        >
          <Splash
            agent={props.agent}
            model={props.model}
            width={() => props.layout.width() - splashInset()}
            rightInset={splashInset}
          />
        </Show>
        <SurfaceBoundary active={() => secondaryMode() === "drawer"} retention="retain-one">
          {() => (
            <SurfaceOverlay>
              <box
                position="absolute"
                left={0}
                right={0}
                top={0}
                bottom={0}
                backgroundColor={mixHex(tokens.bg, scrimColor(), 0.72)}
                zIndex={2}
                onMouseDown={() => props.layout.closeSecondary?.()}
              />
              <box
                position="absolute"
                flexDirection="row"
                right={0}
                top={0}
                bottom={0}
                width={props.layout.sidebarWidth()}
                backgroundColor={tokens.bg}
                zIndex={3}
              >
                {activityPanel()}
              </box>
            </SurfaceOverlay>
          )}
        </SurfaceBoundary>
      </box>
      <Show when={summaryVisible()}>
        <ActivitySummaryStrip
          facts={summaryFacts}
          width={() => props.layout.width()}
          maxRows={() => activitySummaryRowBudget(props.layout.height())}
          active={regionActive}
          onToggle={props.layout.toggleActivity}
        />
      </Show>
    </box>
  );
}
