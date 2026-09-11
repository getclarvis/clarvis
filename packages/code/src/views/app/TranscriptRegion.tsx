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
  draftNonEmpty?: Accessor<boolean>;
  memoryPressure?: {
    state: Accessor<MemoryPressureSnapshot>;
    onRecover: () => void;
  };
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
  const projectionId = (): string | null => ts.selectedSubagent();
  const semanticNodes = createMemo((): readonly TranscriptNode[] => {
    const selected = projectionId();
    const nodes = props.store.committedNodes();
    if (selected !== null) return nodes.filter((node) => node.subagentId === selected);
    return nodes.some((node) => node.subagentId !== undefined || node.subagentOrder !== undefined)
      ? nodes.filter((node) => node.subagentId === undefined && node.subagentOrder === undefined)
      : nodes;
  });
  const childTitle = createMemo((): string | undefined => {
    const selected = projectionId();
    if (selected === null || secondaryMode() !== "closed") return undefined;
    const agent = props.activity.subagents.find(
      (candidate: ActivityStore["subagents"][number]) => candidate.id === selected,
    );
    return agent === undefined ? undefined : `Viewing A${agent.order + 1} ${agentTitle(agent)}`;
  });
  const [tailEntries, setTailEntries] = createSignal(0);
  const [historyHandle, setHistoryHandle] = createSignal<CommittedHistoryHandle>();
  const scrollTopByProjection = new Map<string | null, number>();
  let scrollbox: ScrollBoxRenderable | undefined;
  const transcript: CommittedHistoryState = {
    semanticNodes,
    expandAll: ts.expandAll,
    selectedSubagent: ts.selectedSubagent,
    focusedKey: ts.focusedKey,
    overrideOf: (key) => ts.overrideOf(key),
    toggleAt: (key) => ts.toggleAt(key),
  };

  const publishHandle = (handle: CommittedHistoryHandle | undefined): void => {
    setHistoryHandle(handle);
    props.onHistoryHandle?.(handle);
    props.onLeadHistoryHandle?.(handle);
  };

  createEffect((previous: string | null | undefined) => {
    const selected = projectionId();
    const element = scrollbox;
    if (previous !== undefined && previous !== selected && element !== undefined)
      scrollTopByProjection.set(previous, element.scrollTop);
    if (previous === undefined || previous === selected) return selected;
    queueMicrotask(() => {
      const current = scrollbox;
      const handle = untrack(historyHandle);
      if (current === undefined || handle === undefined) return;
      const restored = scrollTopByProjection.get(selected);
      if (restored === undefined) {
        if (selected === null) handle.returnToTail();
        else {
          handle.requestEarlier();
          current.scrollTo({ x: 0, y: 0 });
        }
        return;
      }
      const maxScrollTop = Math.max(0, current.scrollHeight - current.viewport.height);
      current.scrollTo({ x: 0, y: Math.min(restored, maxScrollTop) });
    });
    return selected;
  });

  onCleanup(() => {
    props.onHistoryHandle?.(undefined);
    props.onLeadHistoryHandle?.(undefined);
  });

  return (
    <box flexDirection="row" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
      <box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} minHeight={0}>
        <Show when={childTitle()}>
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
          store={props.store}
          transcript={transcript}
          active={regionActive}
          splitOpen={splitOpen}
          notify={props.notify}
          onOpenDetail={props.onOpenDetail}
          onScrollbox={(value) => {
            scrollbox = value;
            props.onScrollbox(value);
          }}
          onHandle={publishHandle}
          tailEntries={tailEntries}
          tail={(historyOwnedKeys) => (
            <LiveTranscriptTail
              store={props.store}
              activity={props.activity}
              interaction={props.interaction}
              active={regionActive}
              elicit={() => (regionActive() ? props.run.elicit() : null)}
              resolveElicit={props.run.resolveElicit}
              selectedSubagent={ts.selectedSubagent}
              historyOwnedKeys={historyOwnedKeys}
              onFrontierCountChange={setTailEntries}
              splitOpen={splitOpen}
              notify={props.notify}
              openPlan={props.openPlan}
              onOpenDetail={props.onOpenDetail}
              memoryPressure={props.memoryPressure}
              readingRunwayRows={() => transcriptReadingRunwayRows(props.layout.height())}
            />
          )}
        />
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
