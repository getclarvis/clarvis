import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
  type Accessor,
  type JSX,
} from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { ElicitRequestParams, ElicitResult } from "../../adapters/elicit-types.ts";
import type { ActivityStore } from "../../adapters/activity-store.ts";
import type { TranscriptNode, TranscriptStore } from "../../adapters/store.ts";
import type { WorkflowActivity } from "../../adapters/workflow-projection.ts";
import type { MemoryPressureSnapshot } from "../../adapters/memory-pressure.ts";
import type { LayoutMode, SecondarySurfaceMode } from "../../app/layout.ts";
import type { Interaction } from "../../keys/interaction.ts";
import { tokens } from "../../theme/tokens.ts";
import { mixHex } from "../../theme/model.ts";
import { scrimColor } from "../../theme/surfaces.ts";
import { Sidebar, type SidebarRevealIntent } from "../Sidebar.tsx";
import { Splash } from "../Splash.tsx";
import type { TranscriptState } from "../transcript-state.ts";
import type { HintTone } from "../hint.ts";
import type { ActivityDetail } from "../activity-detail.ts";
import { SurfaceBoundary, SurfaceOverlay } from "../../ui/patterns/surface-lifecycle.tsx";
import {
  CommittedHistory,
  type CommittedHistoryHandle,
  type CommittedHistoryState,
  type TranscriptMeasurementRecoveryPolicy,
} from "../history/CommittedHistory.tsx";
import { LiveTranscriptTail } from "../live/LiveTranscriptTail.tsx";

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
}

/** Layout projections consumed by the transcript region. */
export interface TranscriptRegionLayout {
  mode: Accessor<LayoutMode>;
  sidebarVisible: Accessor<boolean>;
  secondaryMode?: Accessor<SecondarySurfaceMode>;
  sidebarWidth: Accessor<number>;
  drawerOpen: Accessor<boolean>;
  closeDrawer?: () => void;
  contentInset: Accessor<number>;
  width: Accessor<number>;
  height: Accessor<number>;
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
  onHistoryHandle?: (handle: CommittedHistoryHandle | undefined) => void;
  onLeadHistoryHandle?: (handle: CommittedHistoryHandle | undefined) => void;
  historyMeasurementRecovery?: TranscriptMeasurementRecoveryPolicy;
  draftNonEmpty?: Accessor<boolean>;
  memoryPressure?: {
    state: Accessor<MemoryPressureSnapshot>;
    onRecover: () => void;
  };
}

interface TranscriptProjectionProps {
  region: TranscriptRegionProps;
  projectionId: string | null;
  semanticNodes: Accessor<readonly TranscriptNode[]>;
  active: Accessor<boolean>;
  splitOpen: Accessor<boolean>;
  title?: Accessor<string | undefined>;
  onScrollbox: (scrollbox: ScrollBoxRenderable | undefined) => void;
  onHistoryHandle: (handle: CommittedHistoryHandle | undefined) => void;
}

/** Keeps one bounded transcript projection physically mounted while another surface is active. */
function TranscriptProjection(props: TranscriptProjectionProps): JSX.Element {
  const [handoffKeys, setHandoffKeys] = createSignal<ReadonlySet<string>>(new Set());
  const [tailEntries, setTailEntries] = createSignal(0);
  const transcript: CommittedHistoryState = {
    semanticNodes: props.semanticNodes,
    expandAll: props.region.transcript.expandAll,
    selectedSubagent: () => props.projectionId,
    focusedKey: props.region.transcript.focusedKey,
    overrideOf: (key) => props.region.transcript.overrideOf(key),
    toggleAt: (key) => props.region.transcript.toggleAt(key),
  };
  onCleanup(() => props.onScrollbox(undefined));

  return (
    <box
      position="absolute"
      left={0}
      right={0}
      top={0}
      bottom={0}
      flexDirection="column"
      overflow="hidden"
      opacity={props.active() ? 1 : 0}
      zIndex={props.active() ? 1 : -1}
      onMouse={(event) => {
        if (props.active()) return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <Show when={props.title?.()}>
        {(title: Accessor<string>) => (
          <box
            height={1}
            flexShrink={0}
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={tokens.bgElev}
          >
            <text wrapMode="none" truncate selectable={false}>
              <span style={{ fg: tokens.accent }}>
                <b>{title()}</b>
              </span>
            </text>
          </box>
        )}
      </Show>
      <CommittedHistory
        store={props.region.store}
        transcript={transcript}
        active={props.active}
        splitOpen={props.splitOpen}
        notify={props.region.notify}
        onOpenDetail={props.region.onOpenDetail}
        onScrollbox={(value) => props.onScrollbox(value)}
        onHandle={props.onHistoryHandle}
        measurementRecovery={props.region.historyMeasurementRecovery}
        handoffKeys={handoffKeys}
        tailEntries={tailEntries}
        tail={(historyOwnedKeys, followingTail, isOwnerVisible) => (
          <LiveTranscriptTail
            store={props.region.store}
            activity={props.region.activity}
            interaction={props.region.interaction}
            active={props.active}
            elicit={() => (props.active() ? props.region.run.elicit() : null)}
            resolveElicit={props.region.run.resolveElicit}
            selectedSubagent={() => props.projectionId}
            historyOwnedKeys={historyOwnedKeys}
            followingTail={followingTail}
            isOwnerVisible={isOwnerVisible}
            onHandoffKeysChange={setHandoffKeys}
            onFrontierCountChange={setTailEntries}
            splitOpen={props.splitOpen}
            notify={props.region.notify}
            openPlan={props.region.openPlan}
            onOpenDetail={props.region.onOpenDetail}
            memoryPressure={props.region.memoryPressure}
            readingRunwayRows={() => transcriptReadingRunwayRows(props.region.layout.height())}
          />
        )}
      />
    </box>
  );
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
 */
export function TranscriptRegion(props: TranscriptRegionProps): JSX.Element {
  const ts = props.transcript;
  const regionActive = (): boolean => props.active?.() ?? true;
  const secondaryMode = (): SecondarySurfaceMode =>
    props.layout.secondaryMode?.() ??
    (props.layout.mode() === "single" && props.layout.drawerOpen()
      ? "drawer"
      : props.layout.mode() !== "single" &&
          props.layout.mode() !== "floor" &&
          props.layout.sidebarVisible()
        ? "split"
        : "closed");
  const splitOpen = (): boolean => secondaryMode() === "split";
  const agentTitle = (agent: ActivityStore["subagents"][number]): string =>
    agent.title
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "sub-agent";
  const leadNodes = createMemo(() => {
    const nodes = props.store.committedNodes();
    return nodes.some((node) => node.subagentId !== undefined || node.subagentOrder !== undefined)
      ? nodes.filter((node) => node.subagentId === undefined && node.subagentOrder === undefined)
      : nodes;
  });
  const [retainedChildId, setRetainedChildId] = createSignal<string | null>(
    untrack(ts.selectedSubagent),
  );
  const [leadScrollbox, setLeadScrollbox] = createSignal<ScrollBoxRenderable>();
  const [childScrollbox, setChildScrollbox] = createSignal<ScrollBoxRenderable>();
  const [leadHandle, setLeadHandle] = createSignal<CommittedHistoryHandle>();
  const [childHandle, setChildHandle] = createSignal<CommittedHistoryHandle>();
  const revealedChildHandles = new WeakSet<CommittedHistoryHandle>();

  createEffect(() => {
    const selected = ts.selectedSubagent();
    if (selected !== null) {
      if (retainedChildId() !== selected) setRetainedChildId(selected);
      return;
    }
    const retained = retainedChildId();
    if (
      retained !== null &&
      !props.activity.subagents.some(
        (agent: ActivityStore["subagents"][number]) => agent.id === retained,
      )
    )
      setRetainedChildId(null);
  });

  createEffect(() => {
    const selected = ts.selectedSubagent();
    const childSelected = selected !== null && retainedChildId() === selected;
    const handle = childSelected ? childHandle() : leadHandle();
    const scrollbox = childSelected ? childScrollbox() : leadScrollbox();
    props.onHistoryHandle?.(handle);
    if (scrollbox !== undefined) props.onScrollbox(scrollbox);
    if (!childSelected || handle === undefined || scrollbox === undefined) return;
    if (revealedChildHandles.has(handle)) return;
    const first = ts.grouped().ordered[0];
    if (first === undefined) return;
    if (!handle.revealKey(first.key)) {
      if (scrollbox.content.findDescendantById(first.key) === undefined) return;
      scrollbox.scrollChildIntoView(first.key);
    }
    revealedChildHandles.add(handle);
  });

  onCleanup(() => props.onHistoryHandle?.(undefined));

  return (
    <box flexDirection="row" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
      <box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} minHeight={0}>
        <TranscriptProjection
          region={props}
          projectionId={null}
          semanticNodes={leadNodes}
          active={() => regionActive() && ts.selectedSubagent() === null}
          splitOpen={splitOpen}
          onScrollbox={(value) => setLeadScrollbox(value)}
          onHistoryHandle={(value) => {
            setLeadHandle(value);
            props.onLeadHistoryHandle?.(value);
          }}
        />
        <Show when={retainedChildId()} keyed>
          {(childId: string) => {
            const childNodes = createMemo(() =>
              props.store.committedNodes().filter((node) => node.subagentId === childId),
            );
            const child = () =>
              props.activity.subagents.find(
                (agent: ActivityStore["subagents"][number]) => agent.id === childId,
              );
            return (
              <TranscriptProjection
                region={props}
                projectionId={childId}
                semanticNodes={childNodes}
                active={() => regionActive() && ts.selectedSubagent() === childId}
                splitOpen={splitOpen}
                title={() => {
                  if (secondaryMode() !== "closed") return undefined;
                  const agent = child();
                  return agent === undefined
                    ? undefined
                    : `Viewing A${agent.order + 1} ${agentTitle(agent)}`;
                }}
                onScrollbox={(value) => setChildScrollbox(value)}
                onHistoryHandle={(value) => setChildHandle(value)}
              />
            );
          }}
        </Show>
      </box>
      <Show when={splitOpen()}>
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
          width={props.layout.sidebarWidth}
          workflow={props.run.workflowActivity}
          reveal={props.sidebarReveal}
          onOpenDetail={props.onOpenDetail}
        />
      </Show>
      <Show
        when={props.store.nodes.length === 0 && !props.run.elicit() && !props.draftNonEmpty?.()}
      >
        <Splash
          agent={props.agent}
          model={props.model}
          width={() => props.layout.width() - props.layout.contentInset()}
          rightInset={props.layout.contentInset}
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
              onMouseDown={() => props.layout.closeDrawer?.()}
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
                width={props.layout.sidebarWidth}
                workflow={props.run.workflowActivity}
                reveal={props.sidebarReveal}
                onOpenDetail={props.onOpenDetail}
              />
            </box>
          </SurfaceOverlay>
        )}
      </SurfaceBoundary>
    </box>
  );
}
