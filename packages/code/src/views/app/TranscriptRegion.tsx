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
  onHistoryHandle?: (handle: TranscriptViewportHandle | undefined) => void;
  draftNonEmpty?: Accessor<boolean>;
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
  const publishHandle = (handle: TranscriptViewportHandle | undefined): void => {
    props.onHistoryHandle?.(handle);
  };

  onCleanup(() => {
    props.onHistoryHandle?.(undefined);
  });

  return (
    <box flexDirection="row" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
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
