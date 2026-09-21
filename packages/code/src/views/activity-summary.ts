import type { PlanActivity, ActivityStore } from "../adapters/activity-store.ts";
import { isExpectedPlanDiscard } from "../adapters/plan-projection.ts";
import type {
  WorkflowActivity,
  WorkflowSequenceActivity,
} from "../adapters/workflow-projection.ts";
import type { GoalRecord } from "@clarvis/protocol";
import { goalStatusPresentation } from "../features/goal/presentation.ts";
import { lifecycleLabel, uiLifecycle, type UiLifecycle } from "../ui/presentation.ts";
import { glyph } from "../theme/glyphs.ts";

/** The surface a compact activity fact belongs to; `"route"` is the strip's own action affordance. */
export type ActivitySummarySection = "goal" | "plan" | "workflow" | "agents" | "route";

/** Canonical presentation state of one fact, mapped to colour by the owning view. */
export type ActivitySummaryTone = UiLifecycle | "paused" | "attention" | "muted";

/** How much a fact is worth keeping when the strip must shed a whole row. */
export type ActivitySummaryPriority = "attention" | "running" | "settled" | "route";

/** One canonical fact in the compact activity summary. */
export interface ActivitySummaryFact {
  section: ActivitySummarySection;
  /** Canonical words and counts only — never a title, path or parsed formatted line. */
  text: string;
  tone: ActivitySummaryTone;
  priority: ActivitySummaryPriority;
}

/** The run projections a compact summary states, all read from the same stores as the Sidebar. */
export interface ActivitySummaryInput {
  /** Live Goal state; `status` is absent while no Goal exists. */
  goal: { formulating: boolean; status?: GoalRecord["status"] };
  plan: PlanActivity | null;
  workflow: WorkflowActivity | null;
  /**
   * The child roster.
   *
   * @remarks Counts are scoped to sub-agents only. The Lead is never part of
   *   `Agents`, so the strip cannot report the same work twice.
   */
  subagents: readonly Pick<ActivityStore["subagents"][number], "status">[];
}

/** The strip's target row count; it never exceeds it. */
export const ACTIVITY_SUMMARY_MAX_ROWS = 2;
/**
 * Tallest terminal that still gets a single summary row.
 *
 * @remarks Below this height the strip would take the rows the conversation
 *   itself needs: the remaining region seats the reading runway and almost no
 *   transcript. The strip therefore states one row and sheds facts by priority
 *   rather than pushing the conversation off screen.
 */
export const ACTIVITY_SUMMARY_SINGLE_ROW_MAX_HEIGHT = 19;
/** The inter-fact separator, matching every other summary surface in the application. */
const SEPARATOR = (): string => glyph("separator");

function priorityOf(tone: ActivitySummaryTone): ActivitySummaryPriority {
  if (tone === "failed" || tone === "canceled" || tone === "attention") return "attention";
  return tone === "running" ? "running" : "settled";
}

function fact(
  section: ActivitySummarySection,
  text: string,
  tone: ActivitySummaryTone,
): ActivitySummaryFact {
  return { section, text, tone, priority: priorityOf(tone) };
}

function goalTone(status: GoalRecord["status"]): ActivitySummaryTone {
  switch (status) {
    case "active":
      return "running";
    case "complete":
      return "completed";
    case "paused":
      return "paused";
    case "blocked":
    case "budget_limited":
    case "usage_limited":
      return "attention";
    case "cancelled":
      return "canceled";
  }
}

/**
 * Plan lifecycle as compact surfaces present it: a plan whose every task is done
 * has completed, whatever its own status still says.
 */
export function planDisplayLifecycle(plan: Pick<PlanActivity, "tasks" | "status">): UiLifecycle {
  if (plan.tasks.length > 0 && plan.tasks.every((task) => task.status === "done"))
    return "completed";
  return uiLifecycle(plan.status);
}

function planFacts(plan: PlanActivity): ActivitySummaryFact[] {
  if (plan.removed && !isExpectedPlanDiscard(plan))
    return [fact("plan", "Plan unavailable", "failed")];
  const facts: ActivitySummaryFact[] = [];
  const total = plan.tasks.length;
  const done = plan.tasks.filter((task) => task.status === "done").length;
  if (plan.status === "awaiting_approval") {
    facts.push(fact("plan", `Plan ${total} proposed`, "attention"));
  } else {
    const lifecycle = uiLifecycle(plan.status);
    const allDone = total > 0 && done === total;
    const suffix = allDone || lifecycle === "running" ? "" : ` ${lifecycleLabel(lifecycle)}`;
    facts.push(fact("plan", `Plan ${done}/${total}${suffix}`, allDone ? "completed" : lifecycle));
  }
  const failed = plan.tasks.filter((task) => task.status === "failed").length;
  const abandoned = plan.tasks.filter((task) => task.status === "abandoned").length;
  if (failed > 0) facts.push(fact("plan", `${failed} failed`, "failed"));
  if (abandoned > 0) facts.push(fact("plan", `${abandoned} canceled`, "canceled"));
  return facts;
}

function sequenceFacts(sequence: WorkflowSequenceActivity): ActivitySummaryFact[] {
  if (sequence.status === "awaiting_manager")
    return [fact("workflow", `Workflow checkpoint r${sequence.revision}`, "attention")];
  const presented: Record<
    Exclude<WorkflowSequenceActivity["status"], "awaiting_manager">,
    { label: string; tone: ActivitySummaryTone }
  > = {
    running_round: { label: "running", tone: "running" },
    completed: { label: "Completed", tone: "completed" },
    stopped: { label: "Stopped", tone: "muted" },
    failed: { label: "Failed", tone: "failed" },
    cancelled: { label: "Canceled", tone: "canceled" },
  };
  const state = presented[sequence.status];
  return [fact("workflow", `Workflow ${state.label}`, state.tone)];
}

function workflowFacts(workflow: WorkflowActivity | null): ActivitySummaryFact[] {
  if (workflow === null) return [];
  const leaders = [...workflow.nodes.values()].filter((node) => node.kind === "leader");
  if (leaders.length === 0)
    return workflow.sequence === undefined ? [] : sequenceFacts(workflow.sequence);
  const running = leaders.filter((leader) => leader.status === "running").length;
  const failed = leaders.filter((leader) => leader.status === "error").length;
  const canceled = leaders.filter((leader) => leader.status === "cancelled").length;
  const settled = leaders.length - running;
  const tone: ActivitySummaryTone =
    running > 0 ? "running" : failed > 0 ? "failed" : canceled > 0 ? "canceled" : "completed";
  const facts = [fact("workflow", `Workflow ${settled}/${leaders.length}`, tone)];
  if (failed > 0) facts.push(fact("workflow", `${failed} failed`, "failed"));
  if (canceled > 0) facts.push(fact("workflow", `${canceled} canceled`, "canceled"));
  return facts;
}

function agentFacts(subagents: ActivitySummaryInput["subagents"]): ActivitySummaryFact[] {
  if (subagents.length === 0) return [];
  const settled = subagents.filter(
    (agent) => agent.status === "done" || agent.status === "error",
  ).length;
  const failed = subagents.filter((agent) => agent.status === "error").length;
  const running = subagents.length - settled;
  const tone: ActivitySummaryTone = running > 0 ? "running" : failed > 0 ? "failed" : "completed";
  const facts = [fact("agents", `Agents ${settled}/${subagents.length}`, tone)];
  if (failed > 0) facts.push(fact("agents", `${failed} failed`, "failed"));
  return facts;
}

/**
 * Projects the strip's canonical facts from the live run stores.
 *
 * @param input - The same Goal, Plan, workflow and sub-agent projections the
 *   Sidebar reads; no extra query and no formatted-text parsing.
 * @returns Ordered facts. A section with nothing to state contributes none, and
 *   no fact repeats another section's work.
 * @remarks Attention and in-flight facts precede settled ones inside their own section, so the
 *   strip can state what needs the reader first when it must shed a row. Terminal outcomes stay
 *   distinct: a finished/total count is never presented as success on its own.
 */
export function activitySummaryFacts(input: ActivitySummaryInput): ActivitySummaryFact[] {
  const goal: ActivitySummaryFact[] = input.goal.formulating
    ? [fact("goal", "Goal Formulating", "running")]
    : input.goal.status === undefined
      ? []
      : [
          fact(
            "goal",
            `Goal ${goalStatusPresentation(input.goal.status).label}`,
            goalTone(input.goal.status),
          ),
        ];
  return [
    ...goal,
    ...(input.plan === null ? [] : planFacts(input.plan)),
    ...workflowFacts(input.workflow),
    ...agentFacts(input.subagents),
  ];
}

/** The strip's trailing action affordance, carrying the effective `activity.toggle` binding. */
export function activitySummaryRoute(text: string): ActivitySummaryFact {
  return { section: "route", text, tone: "muted", priority: "route" };
}

function wrapFacts(facts: readonly ActivitySummaryFact[], limit: number): ActivitySummaryFact[][] {
  const rows: ActivitySummaryFact[][] = [];
  let current: ActivitySummaryFact[] = [];
  let used = 0;
  for (const entry of facts) {
    const gap = current.length === 0 ? 0 : SEPARATOR().length + 2;
    if (current.length > 0 && used + gap + entry.text.length > limit) {
      rows.push(current);
      current = [];
      used = 0;
    }
    used = current.length === 0 ? entry.text.length : used + gap + entry.text.length;
    current.push(entry);
  }
  if (current.length > 0) rows.push(current);
  return rows;
}

/**
 * The least load-bearing fact the strip may drop: settled before in-flight, and
 * never the strip's own route while anything else remains.
 */
function disposableIndex(facts: readonly ActivitySummaryFact[]): number {
  for (const priority of ["settled", "running", "attention"] as const) {
    const index = facts.findLastIndex((entry) => entry.priority === priority);
    if (index >= 0) return index;
  }
  return -1;
}

/**
 * Wraps facts into complete-group rows within the strip's row budget.
 *
 * @param facts - Ordered facts from {@link activitySummaryFacts}, optionally followed by a route.
 * @param width - Cells available to one row.
 * @param budget - Rows the strip may occupy.
 * @returns Rows of whole facts. A fact is never split, and only whole facts are dropped.
 * @remarks When the budget cannot seat every fact, the strip drops facts by priority and re-wraps,
 *   so a short terminal still states what needs the reader *and* keeps the route to the complete
 *   Activity panel. Settled work leaves before in-flight work, and attention outranks both.
 */
export function activitySummaryRows(
  facts: readonly ActivitySummaryFact[],
  width: number,
  budget: number = ACTIVITY_SUMMARY_MAX_ROWS,
): ActivitySummaryFact[][] {
  const limit = Math.max(1, width);
  const rows = Math.max(1, budget);
  const candidates = [...facts];
  for (;;) {
    const wrapped = wrapFacts(candidates, limit);
    if (wrapped.length <= rows) return wrapped;
    const drop = disposableIndex(candidates);
    if (drop < 0) return wrapped.slice(0, rows);
    candidates.splice(drop, 1);
  }
}

/** The strip's row budget for one terminal height. */
export function activitySummaryRowBudget(terminalHeight: number): number {
  return terminalHeight > ACTIVITY_SUMMARY_SINGLE_ROW_MAX_HEIGHT ? ACTIVITY_SUMMARY_MAX_ROWS : 1;
}

/** Joins one row's facts for a plain-text projection. */
export function activitySummaryRowText(row: readonly ActivitySummaryFact[]): string {
  return row.map((entry) => entry.text).join(` ${SEPARATOR()} `);
}
