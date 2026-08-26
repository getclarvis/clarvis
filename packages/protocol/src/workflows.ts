/**
 * The transport-agnostic contract for **workflows** — a manager run whose
 * `run_leader` tool calls each spawn a full, isolated leader run (Manager →
 * Leaders → Sub-agents). Mirrors {@link import("./runs.ts").RunService | RunService}
 * for the live surface and {@link import("./plans.ts").PlansService | PlansService}
 * for the control-plane surface, so a UI programs against it exactly as it does
 * runs and plans.
 *
 * A workflow's `execution_id` is the manager run's id (the tree root). Each node —
 * manager or leader — is an independent stored run reachable through
 * {@link import("./runs.ts").RunService.get | RunService.get}; this service adds
 * only the tree structure (the edges + a rollup) on top.
 */
import type { Page, Pagination, Timestamp } from "./common.ts";
import type { RunStatus } from "./runs.ts";

/** Whether a workflow node is the manager (root) or a spawned leader. */
export type WorkflowNodeKind = "manager" | "leader";

/**
 * One node in a workflow tree: the manager or a leader. Sub-agents are NOT nodes
 * here — they belong to a leader's own run and surface when that run is opened via
 * {@link import("./runs.ts").RunService.get | RunService.get}.
 */
export interface WorkflowNode {
  run_id: string;
  parent_run_id?: string;
  kind: WorkflowNodeKind;
  profile?: string;
  title: string;
  /** Full leader instruction. Absent on the manager and legacy records. */
  task?: string;
  /** Optional authored round context; absent on managers and legacy records. */
  round_id?: string;
  /** Zero for the initial sequence; repeat passes start at one. */
  pass?: number;
  /** Zero-based item and replica positions within the round. */
  item_index?: number;
  replica?: number;
  replica_count?: number;
  /** Terminal context retained for monitors without opening the child run. */
  error?: { code: string; message: string };
  reason?: string;
  status: RunStatus;
  started_at?: Timestamp;
  ended_at?: Timestamp;
}

/** Compact list row for a workflow. */
export interface WorkflowSummary {
  /** The manager (root) run id. */
  execution_id: string;
  status: RunStatus;
  title?: string;
  workspace?: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  /** Number of leaders spawned so far. */
  leader_count: number;
}

/** Full record for {@link WorkflowsService.get}: the summary plus the tree nodes
 * (manager + leaders). */
export interface WorkflowDetail extends WorkflowSummary {
  nodes: WorkflowNode[];
}

/**
 * Inspect, list, and delete workflows.
 *
 * @remarks There is no `start` here: a workflow is started through
 *   {@link import("./runs.ts").RunService.start | RunService.start} like any run —
 *   the kernel routes it as a workflow when the entry agent profile carries the
 *   `workflow` grant. This service is the control-plane view of the resulting
 *   tree (edges + rollup); the live surface is the ordinary
 *   {@link import("./runs.ts").RunHandle | RunHandle} that `RunService.start`
 *   returns.
 */
export interface WorkflowsService {
  /**
   * Load a workflow's tree (manager + leader edges + rollup).
   *
   * @param id - the manager (root) run id.
   */
  get(id: string): Promise<WorkflowDetail>;

  /**
   * Page through workflow summaries.
   *
   * @param page - optional pagination.
   */
  list(page?: Pagination): Promise<Page<WorkflowSummary>>;

  /**
   * Delete a workflow's record (its edges + rollup). The manager and leader runs
   * remain individually deletable through {@link import("./runs.ts").RunService | RunService}.
   *
   * @param id - the manager (root) run id.
   */
  delete(id: string): Promise<void>;
}
