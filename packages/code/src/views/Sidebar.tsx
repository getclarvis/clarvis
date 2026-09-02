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
import { formatElapsed, tickNow } from "./spinner.ts";
import { lifecycleLabel, uiLifecycle } from "../ui/presentation.ts";
import { followSelection } from "../ui/patterns/list-navigation.ts";
import { taskTone } from "./blocks.tsx";
import { activityPreview, type ActivityDetail } from "./activity-detail.ts";

const CONTEXT_WIDTH = 16;
const MAX_DISPLAY_ELAPSED_MS = 7 * 24 * 60 * 60 * 1_000;
export const PLAN_SIDEBAR_TASK_LIMIT = 12;

/** A bounded task slice that always contains the active task. */
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
  const start = Math.max(
    0,
    Math.min(plan.tasks.length - size, currentIndex - Math.floor(size / 2)),
  );
  const end = Math.min(plan.tasks.length, start + size);
  return {
    entries: plan.tasks.slice(start, end).map((task, offset) => ({ task, index: start + offset })),
    hiddenBefore: start,
    hiddenAfter: plan.tasks.length - end,
    currentIndex,
  };
}

function displayElapsed(startedAt: number | undefined, endedAt = tickNow()): string {
  if (startedAt === undefined) return "";
  const elapsed = endedAt - startedAt;
  return elapsed >= 0 && elapsed <= MAX_DISPLAY_ELAPSED_MS ? formatElapsed(elapsed) : "";
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

/** Progress vocabulary shared by the sidebar's All-agents row and its roster. */
export function subagentProgress(
  agents: readonly Pick<ActivityStore["subagents"][number], "status">[],
): { total: number; settled: number; running: number; failed: number; label: string } {
  const total = agents.length;
  const settled = agents.filter(
    (agent) => agent.status === "done" || agent.status === "error",
  ).length;
  const running = agents.filter((agent) => agent.status === "running").length;
  const failed = agents.filter((agent) => agent.status === "error").length;
  const suffix = running > 0 ? ` ${glyph("separator")} ${running} running` : "";
  return { total, settled, running, failed, label: `${settled}/${total} finished${suffix}` };
}

function agentOutcome(agent: ActivityStore["subagents"][number]): string | undefined {
  const summary = rosterSummary(agent.summary);
  if (agent.status === "error") return summary ? `Failed: ${summary}` : "Failed";
  if (agent.status === "done") return summary ? `Result: ${summary}` : "Completed";
  return undefined;
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
export type SidebarRevealSection = "plan" | "workflow" | "agents";

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

function planStatusColor(plan: PlanActivity): string {
  if (plan.removed && !isExpectedPlanDiscard(plan)) return tokens.del;
  switch (uiLifecycle(plan.status)) {
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

function taskStatusLabel(status: string, removed: boolean): string {
  if (removed) return "Recorded";
  switch (status) {
    case "done":
      return "Done";
    case "in_progress":
      return "Running";
    case "failed":
      return "Failed";
    case "abandoned":
      return "Skipped";
    case "returned":
      return "Returned";
    default:
      return "Next";
  }
}

function PlanSummary(props: {
  plan: Accessor<PlanActivity>;
  onOpenDetail?: (detail: ActivityDetail) => void;
}): JSX.Element {
  const taskWindow = createMemo(() => planTaskWindow(props.plan()));
  const expectedDiscard = createMemo(() => isExpectedPlanDiscard(props.plan()));
  const currentIndex = createMemo(() => taskWindow().currentIndex);
  const lastOutcome = createMemo(() =>
    [...props.plan().tasks]
      .reverse()
      .find(
        (task) =>
          task.status === "done" ||
          task.status === "failed" ||
          task.status === "returned" ||
          task.status === "abandoned",
      ),
  );
  const outcomeContent = (): string | undefined => {
    const task = lastOutcome();
    return task?.error ?? task?.result ?? task?.reason;
  };
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
        {expectedDiscard()
          ? `Completed ${glyph("separator")} ${planProgress(props.plan())} ${glyph("separator")} history discarded`
          : props.plan().removed
            ? `Unavailable ${glyph("separator")} ${planProgress(props.plan())}`
            : `${lifecycleLabel(uiLifecycle(props.plan().status))} ${glyph("separator")} ${planProgress(props.plan())}`}
      </text>
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
              !props.plan().removed && isLivePlan(props.plan()) && entry.index === currentIndex();
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
                  <span style={{ fg: removed() ? tokens.muted : tone().fg }}>
                    <b>{taskStatusLabel(task.status, removed())}</b>
                  </span>
                  <span
                    style={{ fg: active() ? tokens.fg : tokens.muted }}
                  >{`  ${task.title}`}</span>
                  <Show when={task.assignee}>
                    <span style={{ fg: tokens.muted }}>
                      {` ${glyph("separator")} ${task.assignee}`}
                    </span>
                  </Show>
                </text>
                <Show when={active() && task.exit_condition}>
                  <text wrapMode="word">
                    <span style={{ fg: tokens.accent2 }}>
                      <b>Exit</b>
                    </span>
                    <span style={{ fg: tokens.muted }}>{`  ${task.exit_condition}`}</span>
                  </text>
                </Show>
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
      <Show when={lastOutcome()}>
        <box
          flexDirection="column"
          paddingTop={1}
          onMouseDown={() => {
            const task = lastOutcome();
            const content = outcomeContent();
            if (!task || !content) return;
            props.onOpenDetail?.({
              title: task.title,
              eyebrow: `Plan task ${glyph("separator")} ${lifecycleLabel(uiLifecycle(task.status))}`,
              content,
            });
          }}
        >
          <text selectable={false}>
            <span style={{ fg: tokens.accent2 }}>
              <b>Last result</b>
            </span>
            <Show when={outcomeContent()}>
              <span style={{ fg: tokens.muted }}> {`${glyph("separator")} click to read`}</span>
            </Show>
            <Show when={!outcomeContent()}>
              <span style={{ fg: tokens.muted }}>
                {`  ${lifecycleLabel(uiLifecycle(lastOutcome()!.status))}`}
              </span>
            </Show>
          </text>
          <Show when={outcomeContent()}>
            <text fg={lastOutcome()!.error ? tokens.del : tokens.muted} wrapMode="none" truncate>
              {activityPreview(outcomeContent(), 96)}
            </text>
          </Show>
        </box>
      </Show>
      <text
        fg={props.plan().removed && !expectedDiscard() ? tokens.del : tokens.muted}
        selectable={false}
        paddingTop={1}
      >
        {expectedDiscard() ? (
          "Plan deleted after success"
        ) : props.plan().removed ? (
          "Restore the plan file or create a replacement"
        ) : (
          <>
            <span style={{ fg: tokens.accent }}>
              <b>Ctrl+P</b>
            </span>
            <span style={{ fg: tokens.muted }}> full plan</span>
          </>
        )}
      </text>
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
}): JSX.Element {
  const renderer = useRenderer();
  let activityScrollEl: ScrollBoxRenderable | undefined;
  const leaders = (): WorkflowNodeActivity[] => {
    const workflow = props.workflow?.();
    if (!workflow) return [];
    return [...workflow.nodes.values()]
      .filter((node) => node.kind === "leader")
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  };
  const hasContent = (): boolean =>
    props.activity.plan !== null ||
    leaders().length > 0 ||
    props.workflow?.()?.sequence !== undefined ||
    props.activity.subagents.length > 0;
  const progress = () => subagentProgress(props.activity.subagents);
  const progressLabel = (): string =>
    `${progress().label}${progress().failed > 0 ? ` ${glyph("separator")} ${progress().failed} failed` : ""}`;
  createEffect(() => {
    const reveal = props.reveal?.();
    if (reveal === null || reveal === undefined) return;
    const available =
      reveal.section === "plan"
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
        <Show when={props.activity.plan !== null}>
          <box id="sidebar-section-plan" flexDirection="column">
            <SectionHeader label="Plan" />
            <PlanSummary plan={() => props.activity.plan!} onOpenDetail={props.onOpenDetail} />
          </box>
        </Show>
        <Show when={leaders().length > 0 || props.workflow?.()?.sequence !== undefined}>
          <box id="sidebar-section-workflow" flexDirection="column">
            <SectionHeader
              label="Parallel work"
              meta={
                props.workflow?.()?.sequence?.status === "awaiting_manager"
                  ? "awaiting Admiral"
                  : `${leaders().length} ${leaders().length === 1 ? "leader" : "leaders"}`
              }
              pad
            />
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
            <For each={leaders()}>
              {(node, index) => {
                const elapsed = (): string =>
                  displayElapsed(node.startedAt, node.endedAt ?? tickNow());
                return (
                  <box flexDirection="column" paddingTop={1}>
                    <text wrapMode="word" selectable={false}>
                      <span style={{ fg: tokens.accent2 }}>{`L${index() + 1}  `}</span>
                      <span style={{ fg: tokens.fg }}>{cleanTitle(node.title)}</span>
                    </text>
                    <text fg={tokens.muted} selectable={false}>
                      {`${lifecycleLabel(uiLifecycle(node.status))}${elapsed() ? ` · ${elapsed()}` : ""}${node.iterations === undefined ? "" : ` · ${node.iterations} iterations`}`}
                    </text>
                  </box>
                );
              }}
            </For>
          </box>
        </Show>
        <Show when={props.activity.subagents.length > 0}>
          <box id="sidebar-section-agents" flexDirection="column">
            <SectionHeader label="Agents" meta={progressLabel()} pad />
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
            <For each={props.activity.subagents}>
              {(agent) => {
                const selected = (): boolean => props.selected?.() === agent.id;
                const elapsed = (): string =>
                  agent.status === "running" ? displayElapsed(agent.startedAt) : "";
                return (
                  <box
                    flexDirection="column"
                    paddingTop={1}
                    onMouseDown={() => props.onSelectSubagent?.(agent.id)}
                  >
                    <text wrapMode="word" selectable={false}>
                      <span style={{ fg: selected() ? tokens.accent : tokens.muted }}>
                        {(selected() ? "> " : "  ") + `A${agent.order + 1}  `}
                      </span>
                      <span style={{ fg: tokens.fg }}>{cleanTitle(agent.title)}</span>
                    </text>
                    <text fg={tokens.muted} wrapMode="word" selectable={false}>
                      {`${lifecycleLabel(uiLifecycle(agent.status))}${elapsed() ? ` · ${elapsed()}` : ""}`}
                    </text>
                    <Show when={agentOutcome(agent)}>
                      {(outcome: Accessor<string>) => (
                        <text
                          fg={agent.status === "error" ? tokens.del : tokens.muted}
                          wrapMode="none"
                          truncate
                          selectable={false}
                        >
                          {`${outcome()}${agent.summary ? " · click to read" : ""}`}
                        </text>
                      )}
                    </Show>
                    <Show when={selected() && (agent.profile ?? agent.model)}>
                      <text fg={tokens.muted} wrapMode="word" selectable={false}>
                        {`Profile ${agent.profile ?? "default"}${agent.model ? ` ${glyph("separator")} ${agent.model}` : ""}`}
                      </text>
                    </Show>
                  </box>
                );
              }}
            </For>
          </box>
        </Show>
        <Show when={!hasContent()}>
          <text fg={tokens.muted}>No run activity to inspect</text>
        </Show>
      </scrollbox>
    </box>
  );
}
