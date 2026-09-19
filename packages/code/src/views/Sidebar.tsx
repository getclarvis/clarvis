import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import { useRenderer } from "@opentui/solid";
import type { ScrollBoxRenderable } from "@opentui/core";
import { tokens } from "../theme/tokens.ts";
import { scrollbarOptions, selectionBg } from "../theme/surfaces.ts";
import { borderChars, glyph } from "../theme/glyphs.ts";
import type { ActivityStore, PlanActivity } from "../adapters/activity-store.ts";
import { currentPlanTask, isExpectedPlanDiscard, isLivePlan } from "../adapters/plan-projection.ts";
import type {
  WorkflowActivity,
  WorkflowNodeActivity,
  WorkflowSequenceActivity,
} from "../adapters/workflow-projection.ts";
import { lifecycleLabel, uiLifecycle } from "../ui/presentation.ts";
import { followSelection } from "../ui/patterns/list-navigation.ts";
import { compactKey } from "../keys/keyspec.ts";
import { taskTone } from "./blocks.tsx";
import { activityPreview, type ActivityDetail } from "./activity-detail.ts";
import type { GoalController } from "../features/goal/controller.ts";
import type { GoalRecord } from "@clarvis/protocol";
import { goalStatusPresentation, stewardStatusLabel } from "../features/goal/presentation.ts";

const CONTEXT_WIDTH = 16;
export const PLAN_SIDEBAR_TASK_LIMIT = 12;
export const AGENT_SIDEBAR_ROW_LIMIT = 16;
export const WORKFLOW_SIDEBAR_ROW_LIMIT = 16;

function activityStatusPriority(status: string): number {
  switch (status) {
    case "in_progress":
    case "running":
      return 0;
    case "pending":
    case "returned":
    case "spawned":
      return 1;
    case "done":
    case "ok":
      return 2;
    case "failed":
    case "abandoned":
    case "error":
    case "cancelled":
      return 3;
    default:
      return 1;
  }
}

/** A status-prioritized bounded task slice that always contains the active task. */
export function planTaskWindow(
  plan: PlanActivity,
  limit: number = PLAN_SIDEBAR_TASK_LIMIT,
): {
  entries: { task: PlanActivity["tasks"][number]; index: number }[];
  hiddenBefore: number;
  hiddenAfter: number;
  currentIndex: number;
} {
  const size = Math.max(1, Math.floor(limit));
  const current = currentPlanTask(plan);
  const currentIndex = current ? plan.tasks.indexOf(current) : Math.max(0, plan.tasks.length - 1);
  const ordered = plan.tasks
    .map((task, index) => ({ task, index }))
    .sort(
      (left, right) =>
        activityStatusPriority(left.task.status) - activityStatusPriority(right.task.status) ||
        left.index - right.index,
    );
  const currentPosition = Math.max(
    0,
    ordered.findIndex((entry) => entry.index === currentIndex),
  );
  const start = Math.max(
    0,
    Math.min(ordered.length - size, currentPosition - Math.floor(size / 2)),
  );
  const end = Math.min(ordered.length, start + size);
  return {
    entries: ordered.slice(start, end),
    hiddenBefore: start,
    hiddenAfter: ordered.length - end,
    currentIndex,
  };
}

function compactTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
}

/** Computes the labelled context pressure used by the run strip and focused inspectors. */
export function contextMeter(
  used: number,
  window: number,
  width = CONTEXT_WIDTH,
): { frac: number; filled: number; color: string; label: string; pct: number } {
  const frac = window > 0 ? Math.min(1, used / window) : 0;
  const filled = Math.round(frac * width);
  const color = frac >= 0.9 ? tokens.del : frac >= 0.7 ? tokens.warn : tokens.add;
  const pct = Math.round(frac * 100);
  const label = `${compactTokens(used)}/${compactTokens(window)} ${glyph("separator")} ${pct}%`;
  return { frac, filled, color, label, pct };
}

function cleanTitle(raw: string): string {
  const line = raw.split("\n").find((value) => value.trim().length > 0) ?? raw;
  return line.trim().replace(/\s+/g, " ");
}

/**
 * A single, plain-language outcome for the roster.
 *
 * The sidebar is a navigation and status surface, not a second Markdown
 * reader. Keeping this to one stripped line prevents a worker's table, code
 * fence, or long final answer from competing with the transcript where that
 * result can be read in context.
 */
export function rosterSummary(raw: string | undefined, limit = 120): string | undefined {
  return activityPreview(raw, limit);
}

/** Compact progress vocabulary for the Agents section header. */
export function subagentProgress(
  agents: readonly Pick<ActivityStore["subagents"][number], "status">[],
): { total: number; settled: number; running: number; label: string } {
  const total = agents.length;
  const settled = agents.filter(
    (agent) => agent.status === "done" || agent.status === "error",
  ).length;
  const running = agents.filter((agent) => agent.status === "running").length;
  const suffix = running > 0 ? ` ${glyph("separator")} ${running} running` : "";
  return { total, settled, running, label: `${settled}/${total} finished${suffix}` };
}

function subagentTone(
  status: ActivityStore["subagents"][number]["status"],
): ReturnType<typeof taskTone> {
  switch (status) {
    case "running":
      return taskTone("in_progress");
    case "done":
      return taskTone("done");
    case "error":
      return taskTone("failed");
    case "spawned":
      return taskTone("pending");
  }
}

/** Compact progress vocabulary for the Parallel work section header. */
export function workflowProgress(leaders: readonly Pick<WorkflowNodeActivity, "status">[]): {
  total: number;
  settled: number;
  running: number;
  label: string;
} {
  const total = leaders.length;
  const settled = leaders.filter((leader) => leader.status !== "running").length;
  const running = leaders.filter((leader) => leader.status === "running").length;
  const suffix = running > 0 ? ` ${glyph("separator")} ${running} running` : "";
  return { total, settled, running, label: `${settled}/${total} finished${suffix}` };
}

function workflowTone(status: WorkflowNodeActivity["status"]): ReturnType<typeof taskTone> {
  switch (status) {
    case "running":
      return taskTone("in_progress");
    case "ok":
      return taskTone("done");
    case "error":
      return taskTone("failed");
    case "cancelled":
      return taskTone("abandoned");
  }
}

function SectionHeader(props: {
  label: string;
  meta?: string;
  pad?: boolean;
  id?: string;
}): JSX.Element {
  return (
    <text id={props.id} fg={tokens.accent} paddingTop={props.pad ? 1 : 0} selectable={false}>
      <b>{props.label}</b>
      <Show when={props.meta}>
        <span style={{ fg: tokens.muted }}>{`  ${props.meta}`}</span>
      </Show>
    </text>
  );
}

/** Sidebar section selected by one bounded automatic or explicit reveal intent. */
export type SidebarRevealSection = "goal" | "plan" | "workflow" | "agents";

/** Run-scoped reveal token consumed by the Sidebar's native ScrollBox. */
export interface SidebarRevealIntent {
  section: SidebarRevealSection;
  context: string;
}

function planProgress(plan: PlanActivity): string {
  if (plan.removed && !isExpectedPlanDiscard(plan)) return "plan file unavailable";
  if (plan.status === "awaiting_approval")
    return `${plan.tasks.length} ${plan.tasks.length === 1 ? "task" : "tasks"} proposed`;
  const completed = plan.tasks.filter((task) => task.status === "done").length;
  return `${completed}/${plan.tasks.length} completed`;
}

function planDisplayLifecycle(plan: PlanActivity): ReturnType<typeof uiLifecycle> {
  if (plan.tasks.length > 0 && plan.tasks.every((task) => task.status === "done"))
    return "completed";
  return uiLifecycle(plan.status);
}

function planStatusColor(plan: PlanActivity): string {
  if (plan.removed && !isExpectedPlanDiscard(plan)) return tokens.del;
  switch (planDisplayLifecycle(plan)) {
    case "running":
    case "completed":
      return tokens.add;
    case "needs-approval":
      return tokens.warn;
    case "failed":
    case "canceled":
      return tokens.del;
    case "waiting":
      return tokens.muted;
  }
}

function PlanSummary(props: { plan: Accessor<PlanActivity> }): JSX.Element {
  const taskWindow = createMemo(() => planTaskWindow(props.plan()));
  const expectedDiscard = createMemo(() => isExpectedPlanDiscard(props.plan()));
  const currentIndex = createMemo(() => taskWindow().currentIndex);
  const [scrollEl, setScrollEl] = createSignal<ScrollBoxRenderable>();
  const scrollCurrent = (): void =>
    scrollEl()?.scrollChildIntoView(`sidebar-plan-${currentIndex()}`);
  const scheduleScrollCurrent = (): void => queueMicrotask(scrollCurrent);
  followSelection(scrollEl, "sidebar-plan-", currentIndex);
  onMount(scheduleScrollCurrent);
  return (
    <box flexDirection="column" paddingBottom={1}>
      <text fg={tokens.accent2} wrapMode="word">
        <b>{props.plan().title}</b>
      </text>
      <text fg={planStatusColor(props.plan())} selectable={false} paddingBottom={1}>
        <span>
          {expectedDiscard()
            ? `Completed ${glyph("separator")} ${planProgress(props.plan())} ${glyph("separator")} history discarded`
            : props.plan().removed
              ? `Unavailable ${glyph("separator")} ${planProgress(props.plan())}`
              : `${lifecycleLabel(planDisplayLifecycle(props.plan()))} ${glyph("separator")} ${planProgress(props.plan())}`}
        </span>
      </text>
      <Show when={!props.plan().removed}>
        <text selectable={false}>
          <span style={{ fg: tokens.accent }}>
            <b>{`[${compactKey("<leader>p")}]`}</b>
          </span>
          <span style={{ fg: tokens.muted }}> full plan</span>
        </text>
      </Show>
      <Show when={taskWindow().hiddenBefore > 0}>
        <text fg={tokens.muted} selectable={false}>
          {`${glyph("caretUp")} ${taskWindow().hiddenBefore} earlier tasks`}
        </text>
      </Show>
      <scrollbox
        ref={(el: ScrollBoxRenderable) => setScrollEl(el)}
        maxHeight={Math.min(16, Math.max(4, props.plan().tasks.length * 2 + 2))}
        onSizeChange={scheduleScrollCurrent}
        verticalScrollbarOptions={scrollbarOptions()}
      >
        <For each={taskWindow().entries}>
          {(entry) => {
            const task = entry.task;
            // A completed plan has no active task. Retaining the chevron on
            // its final task made a finished plan look like it was still
            // executing.
            const active = (): boolean =>
              !props.plan().removed &&
              isLivePlan(props.plan()) &&
              planDisplayLifecycle(props.plan()) === "running" &&
              currentPlanTask(props.plan()) !== undefined &&
              entry.index === currentIndex();
            const tone = () => taskTone(task.status);
            const removed = (): boolean => props.plan().removed === true;
            return (
              <box
                id={`sidebar-plan-${entry.index}`}
                flexDirection="column"
                paddingTop={1}
                backgroundColor={active() ? selectionBg() : undefined}
              >
                <text wrapMode="word">
                  <span
                    style={{ fg: active() ? tokens.accent : removed() ? tokens.muted : tone().fg }}
                  >
                    {(active()
                      ? glyph("chevronRight")
                      : removed()
                        ? glyph("separator")
                        : tone().glyph) + " "}
                  </span>
                  <span style={{ fg: active() ? tokens.fg : tokens.muted }}>{task.title}</span>
                </text>
              </box>
            );
          }}
        </For>
      </scrollbox>
      <Show when={taskWindow().hiddenAfter > 0}>
        <text fg={tokens.muted} selectable={false}>
          {`${glyph("caretDown")} ${taskWindow().hiddenAfter} later tasks`}
        </text>
      </Show>
      <Show when={props.plan().removed}>
        <text fg={expectedDiscard() ? tokens.muted : tokens.del} selectable={false} paddingTop={1}>
          {expectedDiscard()
            ? "Plan deleted after success"
            : "Restore the plan file or create a replacement"}
        </text>
      </Show>
    </box>
  );
}

/** Summary-only inspector/roster. Complete prompts, plans, results and run totals live elsewhere. */
export function Sidebar(props: {
  activity: ActivityStore;
  focused: Accessor<boolean>;
  contextWindow: Accessor<number>;
  selected?: Accessor<string | null>;
  onSelectSubagent?: (id: string) => void;
  onShowAllAgents?: () => void;
  onOpenDetail?: (detail: ActivityDetail) => void;
  width?: Accessor<number>;
  workflow?: Accessor<WorkflowActivity | null>;
  reveal?: Accessor<SidebarRevealIntent | null>;
  footerHint?: Accessor<string>;
  onClose?: () => void;
  goals?: GoalController;
  onOpenGoal?: () => void;
}): JSX.Element {
  const renderer = useRenderer();
  let activityScrollEl: ScrollBoxRenderable | undefined;
  const [agentScrollEl, setAgentScrollEl] = createSignal<ScrollBoxRenderable>();
  const leaderEntries = (): { node: WorkflowNodeActivity; handle: number }[] => {
    const workflow = props.workflow?.();
    if (!workflow) return [];
    return [...workflow.nodes.values()]
      .filter((node) => node.kind === "leader")
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
      .map((node, handle) => ({ node, handle }))
      .sort(
        (left, right) =>
          activityStatusPriority(left.node.status) - activityStatusPriority(right.node.status) ||
          left.handle - right.handle,
      );
  };
  const leaders = (): WorkflowNodeActivity[] => leaderEntries().map((entry) => entry.node);
  const agents = () =>
    [...props.activity.subagents].sort(
      (left, right) =>
        activityStatusPriority(left.status) - activityStatusPriority(right.status) ||
        left.order - right.order,
    );
  const hasContent = (): boolean =>
    props.goals?.formulating() === true ||
    props.goals?.view()?.state.current !== undefined ||
    props.activity.plan !== null ||
    leaders().length > 0 ||
    props.workflow?.()?.sequence !== undefined ||
    props.activity.subagents.length > 0;
  const progress = () => subagentProgress(props.activity.subagents);
  const parallelProgress = () => workflowProgress(leaders());
  const selectedAgentIndex = (): number =>
    Math.max(
      0,
      agents().findIndex((agent) => agent.id === props.selected?.()),
    );
  const scrollSelectedAgent = (): void =>
    agentScrollEl()?.scrollChildIntoView(`sidebar-agent-${selectedAgentIndex()}`);
  const scheduleScrollSelectedAgent = (): void => queueMicrotask(scrollSelectedAgent);
  followSelection(agentScrollEl, "sidebar-agent-", selectedAgentIndex);
  onMount(scheduleScrollSelectedAgent);
  createEffect(() => {
    const reveal = props.reveal?.();
    if (reveal === null || reveal === undefined) return;
    const available =
      reveal.section === "goal"
        ? props.goals?.formulating() === true || props.goals?.view()?.state.current !== undefined
        : reveal.section === "plan"
          ? props.activity.plan !== null
          : reveal.section === "workflow"
            ? leaders().length > 0 || props.workflow?.()?.sequence !== undefined
            : props.activity.subagents.length > 0;
    if (!available) return;
    const revealAfterLayout = (): void => {
      activityScrollEl?.scrollChildIntoView(`sidebar-section-${reveal.section}`);
      renderer.requestRender();
    };
    renderer.once("frame", revealAfterLayout);
    renderer.requestRender();
    onCleanup(() => renderer.off("frame", revealAfterLayout));
  });
  return (
    <box
      flexDirection="column"
      width={props.width?.() ?? 44}
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={tokens.bg}
      zIndex={1}
      borderStyle="rounded"
      customBorderChars={borderChars()}
      border={["left"]}
      borderColor={props.focused() ? tokens.accent : tokens.muted}
    >
      <scrollbox
        ref={(el: ScrollBoxRenderable) => (activityScrollEl = el)}
        flexGrow={1}
        minHeight={0}
        verticalScrollbarOptions={scrollbarOptions()}
      >
        <Show
          when={
            props.goals?.formulating() === true || props.goals?.view()?.state.current !== undefined
          }
        >
          <box
            id="sidebar-section-goal"
            flexDirection="column"
            paddingBottom={1}
            onMouseDown={() => props.onOpenGoal?.()}
          >
            <SectionHeader label="Goal" />
            <text fg={tokens.accent2} wrapMode="word" maxHeight={3}>
              <b>
                {props.goals?.formulating()
                  ? "Formulating Goal"
                  : props.goals?.view()?.state.current?.objective}
              </b>
            </text>
            <Show when={props.goals?.formulating()}>
              <text fg={tokens.muted}>
                {props.goals?.formulationPhase() === "reviewing_definition"
                  ? "Reviewing definition…"
                  : "Preparing with the selected agent…"}
              </text>
            </Show>
            <Show when={!props.goals?.formulating() && props.goals?.view()?.state.current}>
              {(goal: Accessor<GoalRecord>) => {
                const status = () => goalStatusPresentation(goal().status);
                return (
                  <box flexDirection="column">
                    <text fg={status().color} wrapMode="none" truncate>
                      <span>{`${status().label} ${glyph("separator")} ${goal().runs.length} stage${goal().runs.length === 1 ? "" : "s"}`}</span>
                    </text>
                    <text selectable={false}>
                      <span style={{ fg: tokens.accent }}>
                        <b>{`[${compactKey("<leader>o")}]`}</b>
                      </span>
                      <span style={{ fg: tokens.muted }}> full goal</span>
                    </text>
                    <Show when={stewardStatusLabel(goal())}>
                      <text
                        fg={tokens.muted}
                        wrapMode="none"
                        truncate
                      >{`Steward  ${stewardStatusLabel(goal())}`}</text>
                    </Show>
                  </box>
                );
              }}
            </Show>
          </box>
        </Show>
        <Show when={props.activity.plan !== null}>
          <box id="sidebar-section-plan" flexDirection="column">
            <SectionHeader label="Plan" />
            <PlanSummary plan={() => props.activity.plan!} />
          </box>
        </Show>
        <Show when={leaders().length > 0 || props.workflow?.()?.sequence !== undefined}>
          <box id="sidebar-section-workflow" flexDirection="column">
            <SectionHeader label="Parallel work" meta={parallelProgress().label} pad />
            <Show when={props.workflow?.()?.sequence}>
              {(sequence: Accessor<WorkflowSequenceActivity>) => (
                <text wrapMode="word" selectable={false}>
                  <span style={{ fg: tokens.muted }}>
                    {sequence().status === "awaiting_manager"
                      ? `Checkpoint r${sequence().revision}: next ${sequence().nextRoundId ?? "round"}`
                      : `${sequence().status}: ${sequence().roundId ?? sequence().sessionId}`}
                  </span>
                </text>
              )}
            </Show>
            <scrollbox
              id="sidebar-workflow-scroll"
              maxHeight={Math.min(WORKFLOW_SIDEBAR_ROW_LIMIT, Math.max(4, leaders().length))}
              minHeight={0}
              verticalScrollbarOptions={scrollbarOptions()}
            >
              <For each={leaderEntries()}>
                {(entry, index) => {
                  const node = () => entry.node;
                  const tone = () => workflowTone(node().status);
                  return (
                    <box id={`sidebar-leader-${index()}`} height={1} flexShrink={0}>
                      <text wrapMode="none" truncate selectable={false}>
                        <span style={{ fg: tone().fg }}>{`${tone().glyph} `}</span>
                        <span style={{ fg: tokens.muted }}>
                          {`L${entry.handle + 1}  ${cleanTitle(node().title)}`}
                        </span>
                      </text>
                    </box>
                  );
                }}
              </For>
            </scrollbox>
          </box>
        </Show>
        <Show when={props.activity.subagents.length > 0}>
          <box id="sidebar-section-agents" flexDirection="column">
            <SectionHeader label="Agents" meta={progress().label} pad />
            <box
              flexDirection="column"
              paddingTop={1}
              onMouseDown={() => props.onShowAllAgents?.()}
            >
              <text wrapMode="none" truncate selectable={false}>
                <span style={{ fg: !props.focused() ? tokens.accent : tokens.muted }}>
                  {(!props.focused() ? "> " : "  ") + "Lead transcript"}
                </span>
              </text>
            </box>
            <scrollbox
              ref={(el: ScrollBoxRenderable) => setAgentScrollEl(el)}
              maxHeight={Math.min(
                AGENT_SIDEBAR_ROW_LIMIT,
                Math.max(4, props.activity.subagents.length),
              )}
              minHeight={0}
              onSizeChange={scheduleScrollSelectedAgent}
              verticalScrollbarOptions={scrollbarOptions()}
            >
              <For each={agents()}>
                {(agent, index) => {
                  const selected = (): boolean => props.selected?.() === agent.id;
                  const tone = () => subagentTone(agent.status);
                  return (
                    <box
                      id={`sidebar-agent-${index()}`}
                      height={1}
                      flexShrink={0}
                      onMouseDown={() => props.onSelectSubagent?.(agent.id)}
                    >
                      <text wrapMode="none" truncate selectable={false}>
                        <span style={{ fg: selected() ? tokens.accent : tokens.muted }}>
                          {selected() ? "> " : "  "}
                        </span>
                        <span style={{ fg: tone().fg }}>{`${tone().glyph} `}</span>
                        <span style={{ fg: selected() ? tokens.fg : tokens.muted }}>
                          {`A${agent.order + 1}  ${cleanTitle(agent.title)}`}
                        </span>
                      </text>
                    </box>
                  );
                }}
              </For>
            </scrollbox>
          </box>
        </Show>
        <Show when={!hasContent()}>
          <text fg={tokens.muted}>No run activity to inspect</text>
        </Show>
      </scrollbox>
      <Show when={props.footerHint?.()}>
        {(hint: Accessor<string>) => (
          <text
            fg={tokens.muted}
            height={1}
            flexShrink={0}
            wrapMode="none"
            truncate
            selectable={false}
            onMouseDown={() => props.onClose?.()}
          >
            {hint()}
          </text>
        )}
      </Show>
    </box>
  );
}
