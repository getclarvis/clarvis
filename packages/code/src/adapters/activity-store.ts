import { createStore, produce } from "solid-js/store";
import type { RunEvent } from "@clarvis/protocol";
import type { EventSpan } from "./event-span.ts";
import type { RunSink } from "./store.ts";
import { createSubagentRegistry, iterationTokens, subagentCompletedOk } from "./run-reducers.ts";
import { reducePlanProjection, type PlanActivity } from "./plan-projection.ts";

export type { PlanActivity, PlanTaskActivity } from "./plan-projection.ts";

/** Lifecycle of one tracked subagent, as reflected in the activity panel. */
export type SubagentStatus = "spawned" | "running" | "done" | "error";

/** One selected sidebar result is informative at this size without retaining a tool-sized body. */
export const ACTIVITY_SUBAGENT_SUMMARY_MAX_CHARS = 512;
/** Mirrors the supervision registry's maximum retained settled-child roster. */
export const ACTIVITY_SUBAGENT_SUMMARIES_MAX = 64;
const ACTIVITY_SUMMARY_TRUNCATED_NOTICE = "...[display truncated]";

function boundActivitySummary(value: string): string {
  if (value.length <= ACTIVITY_SUBAGENT_SUMMARY_MAX_CHARS) return value;
  return (
    value.slice(0, ACTIVITY_SUBAGENT_SUMMARY_MAX_CHARS - ACTIVITY_SUMMARY_TRUNCATED_NOTICE.length) +
    ACTIVITY_SUMMARY_TRUNCATED_NOTICE
  );
}

interface SubagentActivity {
  id: string;
  title: string;
  model?: string;
  profile?: string;
  status: SubagentStatus;
  input: number;
  output: number;
  order: number;
  startedAt?: number;
  endedAt?: number;
  summary?: string;
}

/** Total token usage accumulated across every run currently mounted in this session projection. */
export interface UsageActivity {
  input: number;
  output: number;
  /**
   * How much of `input` the provider served from its prefix cache.
   *
   * @remarks Absent when nothing was cached, or when the provider reports no
   *   split at all — the run strip then has only the gross figure to state, and
   *   says so by showing it unqualified.
   */
  cached?: number;
}

/** The lead agent's most recent context-window usage. */
export interface ContextActivity {
  used: number;
  model?: string;
}

/**
 * Reactive projection of a run's live activity (subagents, plan, token usage,
 * context) for the sidebar/status surfaces, fed by {@link RunEvent}s through
 * {@link ActivityStore.openRun}.
 *
 * @remarks One projection, not one per run: subagent and plan surfaces show *the*
 *   current run, while usage remains cumulative across its mounted run sinks for
 *   the session footer. {@link ActivityStore.openRun} therefore takes no execution
 *   id — it used to accept one and ignore it, which read as a per-run guarantee the
 *   store does not make. Two sinks open at once fold into the same activity state;
 *   {@link TranscriptStore.openRun}, which really is keyed by execution, is the one
 *   that keeps its parameter.
 */
export interface ActivityStore {
  subagents: SubagentActivity[];
  plan: PlanActivity | null;
  usage: UsageActivity | null;
  context: ContextActivity | null;
  openRun(): RunSink;
  clear(): void;
}

interface ActivityState {
  subagents: SubagentActivity[];
  plan: PlanActivity | null;
  usage: UsageActivity | null;
  context: ContextActivity | null;
}

/** Builds an empty {@link ActivityStore}; {@link ActivityStore.openRun} feeds it from a run's events. */
export function createActivityStore(): ActivityStore {
  const [state, setState] = createStore<ActivityState>({
    subagents: [],
    plan: null,
    usage: null,
    context: null,
  });
  const subagentSeeds = createSubagentRegistry();
  const summaryIndexes: number[] = [];
  const summarized = new Set<number>();
  let totalInput = 0;
  let totalOutput = 0;
  let totalCached = 0;
  let leadModel: string | undefined;

  function syncUsage(): void {
    setState("usage", {
      input: totalInput,
      output: totalOutput,
      ...(totalCached > 0 ? { cached: totalCached } : {}),
    });
  }

  function clearAll(): void {
    setState({ subagents: [], plan: null, usage: null, context: null });
    subagentSeeds.clear();
    summaryIndexes.length = 0;
    summarized.clear();
    totalInput = 0;
    totalOutput = 0;
    totalCached = 0;
    leadModel = undefined;
  }

  function upsertSubagent(id: string, init: () => Omit<SubagentActivity, "id" | "order">): number {
    const { order } = subagentSeeds.resolve(id);
    if (state.subagents[order] === undefined)
      setState("subagents", order, { id, order, ...init() });
    return order;
  }

  function patchSubagent(index: number, updater: (w: SubagentActivity) => void): void {
    setState("subagents", index, produce(updater));
  }

  function retainSummary(index: number, summary: string | undefined): void {
    patchSubagent(index, (subagent) => {
      if (summary === undefined) delete subagent.summary;
      else subagent.summary = boundActivitySummary(summary);
    });
    if (summary === undefined || summarized.has(index)) return;
    summarized.add(index);
    summaryIndexes.push(index);
    while (summaryIndexes.length > ACTIVITY_SUBAGENT_SUMMARIES_MAX) {
      const evicted = summaryIndexes.shift();
      if (evicted === undefined) break;
      summarized.delete(evicted);
      patchSubagent(evicted, (subagent) => {
        delete subagent.summary;
      });
    }
  }

  function openRun(): RunSink {
    let planBeforeReconcile: PlanActivity | null = null;
    let sawPlanDuringReconcile = false;
    let runInput = 0;
    let runOutput = 0;
    let runCached = 0;

    const resetRunUsage = (): void => {
      totalInput = Math.max(0, totalInput - runInput);
      totalOutput = Math.max(0, totalOutput - runOutput);
      totalCached = Math.max(0, totalCached - runCached);
      runInput = 0;
      runOutput = 0;
      runCached = 0;
      syncUsage();
    };

    return {
      open(span: EventSpan, event: RunEvent) {
        if (span.kind === "run" && event.type === "run_started") {
          setState({ subagents: [], plan: null });
          subagentSeeds.clear();
          summaryIndexes.length = 0;
          summarized.clear();
          resetRunUsage();
          if (event.lead_model) leadModel = event.lead_model;
          return;
        }
        if (span.kind === "subagent" && event.type === "delegation_created") {
          const i = upsertSubagent(event.delegation_id, () => ({
            title: event.title,
            ...(event.profile !== undefined ? { profile: event.profile } : {}),
            status: "spawned",
            input: 0,
            output: 0,
          }));
          patchSubagent(i, (w) => {
            w.title = event.title;
            w.profile = event.profile;
          });
        }
      },

      point(span: EventSpan, event: RunEvent) {
        if (span.kind === "subagent" && event.type === "delegation_started") {
          const i = upsertSubagent(event.delegation_id, () => ({
            title: "subagent",
            status: "running",
            input: 0,
            output: 0,
          }));
          patchSubagent(i, (w) => {
            w.model = event.model;
            w.status = "running";
            w.startedAt = event.at;
          });
          return;
        }
        if (span.kind !== "event") return;
        if (
          event.type === "plan_created" ||
          event.type === "plan_updated" ||
          event.type === "plan_removed" ||
          event.type === "plan_review_requested" ||
          event.type === "plan_review_resolved"
        ) {
          if (planBeforeReconcile !== null) sawPlanDuringReconcile = true;
          setState("plan", reducePlanProjection(state.plan, event));
        }
      },

      close(span: EventSpan, event: RunEvent) {
        if (span.kind === "run" && event.type === "run_ended") {
          const ok = event.reason === "completed";
          state.subagents.forEach((w, i) => {
            if (w.status === "running" || w.status === "spawned")
              patchSubagent(i, (m) => {
                m.status = ok ? "done" : "error";
              });
          });
          return;
        }
        if (
          span.kind === "subagent" &&
          (event.type === "delegation_completed" || event.type === "delegation_failed")
        ) {
          const i = upsertSubagent(event.delegation_id, () => ({
            title: "subagent",
            status: "done",
            input: 0,
            output: 0,
          }));
          patchSubagent(i, (w) => {
            w.status = subagentCompletedOk(event.status) ? "done" : "error";
            w.endedAt = event.at;
          });
          retainSummary(i, event.summary);
          return;
        }
        if (span.kind === "iteration" && event.type === "iteration_completed") {
          const tokens = iterationTokens(event);
          runInput += tokens.input;
          runOutput += tokens.output;
          runCached += tokens.cached;
          totalInput += tokens.input;
          totalOutput += tokens.output;
          totalCached += tokens.cached;
          syncUsage();
          if (event.agent === "lead") {
            setState("context", { used: tokens.input, model: leadModel });
          } else if (event.subagent_id !== undefined) {
            const seed = subagentSeeds.peek(event.subagent_id);
            if (seed !== undefined) {
              patchSubagent(seed.order, (w) => {
                w.input += tokens.input;
                w.output += tokens.output;
              });
            }
          }
        }
      },

      beginReconcile() {
        planBeforeReconcile = state.plan;
        sawPlanDuringReconcile = false;
        setState({ subagents: [], plan: null });
        subagentSeeds.clear();
        summaryIndexes.length = 0;
        summarized.clear();
        resetRunUsage();
      },

      endReconcile() {
        // Capability events are live-only and therefore absent from the stored
        // trace used for the end-of-run replay. Keep the authoritative plan
        // projection the live stream already delivered unless the replay did
        // contain a newer plan event. Other aggregates are rebuilt normally.
        if (!sawPlanDuringReconcile && planBeforeReconcile !== null)
          setState("plan", planBeforeReconcile);
        planBeforeReconcile = null;
        sawPlanDuringReconcile = false;
      },
    };
  }

  return {
    get subagents() {
      return state.subagents;
    },
    get plan() {
      return state.plan;
    },
    get usage() {
      return state.usage;
    },
    get context() {
      return state.context;
    },
    openRun,
    clear: clearAll,
  };
}
