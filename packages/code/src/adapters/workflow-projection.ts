import type { RunEvent } from "@clarvis/protocol";

/** The lifecycle state of a workflow node (manager or leader). */
export type WorkflowNodeStatus = "running" | "ok" | "error" | "cancelled";

/** One node (the manager or a leader) in the projected workflow tree. */
export interface WorkflowNodeActivity {
  runId: string;
  parentRunId?: string;
  kind: "manager" | "leader";
  profile?: string;
  title: string;
  status: WorkflowNodeStatus;
  startedAt?: number;
  endedAt?: number;
  /** Live cumulative iteration count for a leader (its own lead loop), folded from
   * `workflow_run_progress`; undefined until the first progress tick. */
  iterations?: number;
  /** Live cumulative input tokens across the leader's run (lead + its sub-agents). */
  inputTokens?: number;
  /** Live cumulative output tokens across the leader's run (lead + its sub-agents). */
  outputTokens?: number;
  roundId?: string;
  pass?: number;
  itemIndex?: number;
  replica?: number;
  replicaCount?: number;
  error?: { code: string; message: string };
  reason?: string;
}

/** Latest manager-owned round checkpoint shown beside the leader tree. */
export interface WorkflowSequenceActivity {
  sessionId: string;
  status: "running_round" | "awaiting_manager" | "completed" | "stopped" | "failed" | "cancelled";
  revision: number;
  roundId?: string;
  pass?: number;
  nextRoundId?: string;
  nextPass?: number;
  leadersStarted: number;
  maxTotalLeaders: number;
  reason?: string;
}

/**
 * The live model of a workflow tree, folded from the manager run's structural
 * event stream.
 *
 * @remarks One reducer ({@link reduceWorkflowProjection}) feeds three surfaces:
 *   the dedicated Workflow view, the header chip, and the sidebar. It carries
 *   structure and status only, never content — a node's full transcript is
 *   drilled into separately via `runs.get`.
 */
export interface WorkflowActivity {
  /** The manager (root) run id. */
  root: string;
  /** Every node keyed by run id: the manager plus each leader. */
  nodes: Map<string, WorkflowNodeActivity>;
  /** Latest explicit round/decision state. */
  sequence?: WorkflowSequenceActivity;
}

/** The events this projection folds: the `workflow_run_*` edges plus the manager's
 * own `run_ended` (to close the root node). */
export type WorkflowProjectionEvent = Extract<
  RunEvent,
  {
    type:
      | "workflow_run_started"
      | "workflow_title_updated"
      | "workflow_sequence_state"
      | "workflow_run_progress"
      | "workflow_run_completed"
      | "workflow_run_failed"
      | "run_ended";
  }
>;

/**
 * Fold one structural event into the workflow tree — the single projection used by
 * both live and rehydrated workflows.
 *
 * A `workflow_run_started` seeds the manager (root) node from the event's
 * `parent_run_id` the first time it is seen, then adds/updates the leader node; a
 * completed/failed edge closes its leader; `run_ended` closes the manager.
 */
export function reduceWorkflowProjection(
  current: WorkflowActivity | null,
  event: WorkflowProjectionEvent,
): WorkflowActivity | null {
  if (event.type === "workflow_title_updated") {
    // A metadata-only event must not invent a live tree: it can arrive after a
    // manager-only run has already ended, when no later terminal event exists to
    // close a newly seeded root. Once a leader has established the tree, update
    // the existing manager and preserve whatever lifecycle it already reached.
    if (current === null) return null;
    const nodes = new Map(current.nodes);
    const root = nodes.get(event.run_id);
    nodes.set(event.run_id, {
      ...(root ?? { runId: event.run_id, kind: "manager", status: "running" }),
      title: event.title,
    });
    return { ...current, nodes };
  }
  if (event.type === "workflow_sequence_state") {
    const base: WorkflowActivity = current ?? {
      root: event.run_id,
      nodes: new Map([
        [
          event.run_id,
          { runId: event.run_id, kind: "manager", title: "manager", status: "running" },
        ],
      ]),
    };
    return {
      ...base,
      sequence: {
        sessionId: event.session_id,
        status: event.status,
        revision: event.revision,
        ...(event.round_id === undefined ? {} : { roundId: event.round_id }),
        ...(event.pass === undefined ? {} : { pass: event.pass }),
        ...(event.next_round_id === undefined ? {} : { nextRoundId: event.next_round_id }),
        ...(event.next_pass === undefined ? {} : { nextPass: event.next_pass }),
        leadersStarted: event.leaders_started,
        maxTotalLeaders: event.max_total_leaders,
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      },
    };
  }
  if (event.type === "run_ended") {
    if (current === null) return current;
    const root = current.nodes.get(current.root);
    if (root === undefined) return current;
    const nodes = new Map(current.nodes);
    nodes.set(current.root, {
      ...root,
      status:
        event.reason === "completed" ? "ok" : event.reason === "cancelled" ? "cancelled" : "error",
      endedAt: event.at,
    });
    return { ...current, nodes };
  }

  const base: WorkflowActivity = current ?? {
    root: event.parent_run_id,
    nodes: new Map([
      [
        event.parent_run_id,
        { runId: event.parent_run_id, kind: "manager", title: "manager", status: "running" },
      ],
    ]),
  };
  const nodes = new Map(base.nodes);

  if (event.type === "workflow_run_started") {
    nodes.set(event.run_id, {
      runId: event.run_id,
      parentRunId: event.parent_run_id,
      kind: "leader",
      ...(event.profile !== undefined ? { profile: event.profile } : {}),
      title: event.title,
      status: "running",
      startedAt: event.at,
      ...(event.round_id !== undefined ? { roundId: event.round_id } : {}),
      ...(event.pass !== undefined ? { pass: event.pass } : {}),
      ...(event.item_index !== undefined ? { itemIndex: event.item_index } : {}),
      ...(event.replica !== undefined ? { replica: event.replica } : {}),
      ...(event.replica_count !== undefined ? { replicaCount: event.replica_count } : {}),
    });
  } else if (event.type === "workflow_run_progress") {
    const existing = nodes.get(event.run_id);
    nodes.set(event.run_id, {
      ...(existing ?? {
        runId: event.run_id,
        parentRunId: event.parent_run_id,
        kind: "leader",
        title: event.run_id,
        status: "running",
      }),
      iterations: event.iterations,
      inputTokens: event.input_tokens,
      outputTokens: event.output_tokens,
    });
  } else {
    const status: WorkflowNodeStatus =
      event.type === "workflow_run_completed"
        ? "ok"
        : event.status === "cancelled"
          ? "cancelled"
          : "error";
    const existing = nodes.get(event.run_id);
    nodes.set(event.run_id, {
      ...(existing ?? {
        runId: event.run_id,
        parentRunId: event.parent_run_id,
        kind: "leader",
        title: event.run_id,
      }),
      status,
      endedAt: event.at,
      ...(event.type === "workflow_run_failed" && event.error !== undefined
        ? { error: event.error, reason: event.error.message }
        : {}),
    });
  }

  return { ...base, nodes };
}

/** Count the leaders under a workflow and how many are still running (for the chip). */
export function workflowLeaderCounts(activity: WorkflowActivity): {
  total: number;
  running: number;
} {
  let total = 0;
  let running = 0;
  for (const node of activity.nodes.values()) {
    if (node.kind !== "leader") continue;
    total += 1;
    if (node.status === "running") running += 1;
  }
  return { total, running };
}
