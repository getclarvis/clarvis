import { For, Show, type Accessor, type JSX } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { ElicitRequestParams, ElicitResult } from "../../adapters/elicit-types.ts";
import type { ActivityStore } from "../../adapters/activity-store.ts";
import type { TranscriptStore } from "../../adapters/store.ts";
import type { WorkflowActivity } from "../../adapters/workflow-projection.ts";
import type { LayoutMode, SecondarySurfaceMode } from "../../app/layout.ts";
import type { Interaction } from "../../keys/interaction.ts";
import { tokens } from "../../theme/tokens.ts";
import { mixHex } from "../../theme/model.ts";
import { glyph } from "../../theme/glyphs.ts";
import { scrollbarOptions, SCROLLBOX_TABLE_GUTTER, scrimColor } from "../../theme/surfaces.ts";
import { BlockView } from "../blocks.tsx";
import { ElicitBlock } from "../ElicitBlock.tsx";
import { rosterSummary, Sidebar } from "../Sidebar.tsx";
import { Splash } from "../Splash.tsx";
import type { TranscriptState } from "../transcript-state.ts";
import { earlierLabel, laterLabel } from "../transcript-window.ts";
import type { HintTone } from "../hint.ts";
import { completionBeforeFinalAnswer } from "../transcript-completion.ts";
import { lifecycleLabel, uiLifecycle } from "../../ui/presentation.ts";
import type { ActivityDetail } from "../activity-detail.ts";
import { SurfaceBoundary, SurfaceOverlay } from "../../ui/patterns/surface-lifecycle.tsx";

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
}

/** Props for the transcript, sidebar, splash, and elicitation shell region. */
export interface TranscriptRegionProps {
  store: TranscriptStore;
  transcript: TranscriptState;
  activity: ActivityStore;
  interaction: Interaction;
  run: TranscriptRegionRun;
  layout: TranscriptRegionLayout;
  contextWindow: Accessor<number>;
  agent: Accessor<string>;
  model: Accessor<string>;
  notify: (message: string, tone?: HintTone) => void;
  openPlan: () => void;
  onOpenDetail?: (detail: ActivityDetail) => void;
  onScrollbox: (scrollbox: ScrollBoxRenderable) => void;
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
 *   depends on paint order: normally the header, rule, footer and dock are
 *   painted after this region and cover it, but opening a config view unmounts
 *   the region (it is a `Switch` fallback in `OverlayRegion`) and closing it
 *   appends a **new** renderable, which then paints last. `@opentui/solid`'s
 *   slot placeholders carry no `zIndex`, so the renderer's sort comparator
 *   reports "equal" for every pair involving one and cannot restore the order.
 *   Clipping here makes the symptom impossible rather than order-dependent.
 */
export function TranscriptRegion(props: TranscriptRegionProps): JSX.Element {
  const ts = props.transcript;
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
  const focusedAgent = () =>
    props.activity.subagents.find(
      (agent: ActivityStore["subagents"][number]) => agent.id === ts.selectedSubagent(),
    );
  const agentTitle = (agent: ActivityStore["subagents"][number]): string =>
    agent.title
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "sub-agent";
  const agentOutcome = (agent: ActivityStore["subagents"][number]): string => {
    const summary = rosterSummary(agent.summary, 92);
    if (agent.status === "error") return summary ? `Failed: ${summary}` : "Failed";
    if (agent.status === "done") return summary ? `Result: ${summary}` : "Completed";
    return agent.status === "running" ? "Activity: working" : "Activity: waiting to start";
  };
  const openSubagentDetail = (id: string): void => {
    const agent = props.activity.subagents.find((candidate) => candidate.id === id);
    if (!agent) return;
    const response = [...props.store.nodes]
      .reverse()
      .find(
        (node) =>
          node.kind === "assistant" && node.subagentId === id && node.text.trim().length > 0,
      );
    const content = response?.kind === "assistant" ? response.text : agent.summary;
    if (!content) return;
    props.onOpenDetail?.({
      title: `A${agent.order + 1} ${agentTitle(agent)}`,
      eyebrow: `${lifecycleLabel(uiLifecycle(agent.status))} sub-agent response`,
      content,
    });
  };
  return (
    <box flexDirection="row" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
      <box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} minHeight={0}>
        <Show when={secondaryMode() === "closed" ? focusedAgent() : undefined}>
          {(agent: Accessor<ActivityStore["subagents"][number]>) => (
            <box
              height={1}
              flexShrink={0}
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={tokens.bgElev}
            >
              <text wrapMode="none" truncate selectable={false}>
                <span style={{ fg: tokens.accent }}>
                  <b>{`Viewing A${agent().order + 1} ${agentTitle(agent())}`}</b>
                </span>
                <span style={{ fg: agent().status === "error" ? tokens.del : tokens.muted }}>
                  {` ${glyph("separator")} ${agentOutcome(agent())}`}
                </span>
              </text>
            </box>
          )}
        </Show>
        <scrollbox
          ref={props.onScrollbox}
          stickyScroll
          stickyStart="bottom"
          flexGrow={1}
          paddingLeft={1}
          paddingRight={SCROLLBOX_TABLE_GUTTER}
          contentOptions={{ alignItems: "flex-start" }}
          verticalScrollbarOptions={scrollbarOptions()}
        >
          <Show when={ts.window().hiddenBlocks > 0}>
            <box paddingLeft={1} paddingTop={1}>
              <text
                fg={tokens.muted}
                wrapMode="none"
                truncate
                onMouseDown={() => {
                  if (!ts.loadEarlier()) props.notify("start of transcript");
                }}
              >
                {`${glyph("caretUp")} ${earlierLabel(ts.window())} ${glyph("emDash")} page up here, or click, to load`}
              </text>
            </box>
          </Show>
          <For each={completionBeforeFinalAnswer(ts.grouped().ordered)}>
            {(node) => (
              <BlockView
                node={node}
                maxWidth={splitOpen() ? undefined : "100%"}
                forceExpand={ts.expandAll}
                folded={() => ts.folded(node.key)}
                group={() => ts.toolGroups().get(node.key)}
                sectionHeader={() => ts.grouped().headers.get(node.key)}
                overrideOf={(key) => ts.overrideOf(key)}
                focused={() => ts.focusedKey() === node.key}
                onToggle={() => ts.toggleAt(node.key)}
                defaultFolded={() => props.store.defaultFolded(node.key)}
                onOpenDetail={props.onOpenDetail}
                fillAvailableWidth={splitOpen}
              />
            )}
          </For>
          <Show when={ts.window().laterBlocks > 0}>
            <box paddingLeft={1} paddingTop={1} paddingBottom={1}>
              <text
                fg={tokens.muted}
                wrapMode="none"
                truncate
                onMouseDown={() => {
                  if (!ts.loadLater()) props.notify("latest transcript page");
                }}
              >
                {`${glyph("caretDown")} ${laterLabel(ts.window())} ${glyph("emDash")} page down here, or click, to load`}
              </text>
            </box>
          </Show>
          <Show when={props.run.elicit()} keyed>
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
        </scrollbox>
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
          onOpenDetail={props.onOpenDetail}
          onOpenSubagentDetail={openSubagentDetail}
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
                onOpenDetail={props.onOpenDetail}
                onOpenSubagentDetail={openSubagentDetail}
              />
            </box>
          </SurfaceOverlay>
        )}
      </SurfaceBoundary>
    </box>
  );
}
