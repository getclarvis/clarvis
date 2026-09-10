import type { HostedRunRef } from "./hosting.ts";

/** Semantic state of a persistent objective, independent of physical execution. */
export type GoalStatus =
  "active" | "paused" | "blocked" | "budget_limited" | "usage_limited" | "complete" | "cancelled";

export interface GoalLimits {
  max_net_tokens: number;
  max_auto_continuations: number;
  max_no_progress_checkpoints: number;
  deadline_at?: number;
}

export interface GoalCriterion {
  id: string;
  description: string;
  kind: "host" | "qualitative" | "human";
  verification?:
    | { kind: "tool_success"; tool_name: string; arguments_digest?: string }
    | { kind: "artifact_digest"; path: string; digest: string };
}

export interface GoalEvidenceRef {
  id: string;
  execution_id: string;
  goal_id: string;
  objective_revision: number;
  kind: "tool_result" | "artifact" | "human_acceptance";
  digest?: string;
}

export interface GoalAssessment {
  criterion_id: string;
  kind: "host" | "qualitative" | "human";
  justification: string;
  evidence: GoalEvidenceRef[];
}

export interface GoalCandidate {
  objective_revision: number;
  execution_id: string;
  summary: string;
  assessments: GoalAssessment[];
}

export interface GoalCheckpoint {
  summary: string;
  next_step: string;
  evidence: GoalEvidenceRef[];
  activity_fingerprint?: string;
  progress_accepted: boolean;
  reason: string;
}

/** A bounded annotation; only a separately accepted checkpoint can end a stage. */
export interface GoalProgress {
  summary: string;
  evidence: GoalEvidenceRef[];
}

/** Missing cache is a conservative estimate; unknown total is not a measured zero. */
export type GoalUsage =
  { kind: "unknown" } | { kind: "measured"; input: number; output: number; cached?: number };

export interface GoalRun {
  execution_id: string;
  admission_id: string;
  control_revision: number;
  objective_revision: number;
  automatic: boolean;
  phase: "preparing" | "running" | "settling" | "unknown" | "closed";
  admitted_at: number;
  ended_at?: number;
  disposition?: "final" | "checkpoint";
  outcome?: "completed" | "failed" | "cancelled";
  usage?: GoalUsage;
  usage_estimate?: { sequence: number; usage: GoalUsage };
  checkpoint?: GoalCheckpoint;
  progress?: GoalProgress;
  candidate?: GoalCandidate;
}

/** Bounded host-owned audit record; a completion candidate is not a completion commit. */
export interface GoalRecord {
  goal_id: string;
  session_id: string;
  revision: number;
  control_revision: number;
  objective_revision: number;
  objective: string;
  criteria: GoalCriterion[];
  status: GoalStatus;
  reason?: string;
  created_at: number;
  updated_at: number;
  limits: GoalLimits;
  consumption: {
    input: number;
    output: number;
    cached?: number;
    net_tokens: number;
    usage_unknown: boolean;
    cache_estimated: boolean;
    overrun_tokens: number;
  };
  auto_continuations: number;
  no_progress_checkpoints: number;
  runs: GoalRun[];
  candidate?: GoalCandidate;
  human_acceptances: Array<{
    criterion_id: string;
    objective_revision: number;
    operation_id: string;
    accepted_at: number;
  }>;
  plan_ref?: { id: string; revision: number; provider_key: string };
}

/** Idempotent result retained independently of whatever newer goal state is now visible. */
export interface GoalReceipt {
  operation_id: string;
  fingerprint: string;
  revision: number;
  /** Reserved before launch; replay never starts another execution for this operation. */
  execution_id?: string;
  goal_id?: string;
  status?: GoalStatus;
}

/** Optional private-session field, writable only by the host's short transaction. */
export interface GoalState {
  version: 1;
  revision: number;
  current?: GoalRecord;
  archive: GoalRecord[];
  receipts: GoalReceipt[];
}

export type GoalControlAction =
  | {
      kind: "create" | "replace";
      objective: string;
      criteria?: GoalCriterion[];
      limits?: Partial<GoalLimits>;
    }
  | { kind: "edit"; objective?: string; criteria?: GoalCriterion[]; limits?: Partial<GoalLimits> }
  | { kind: "pause"; running?: boolean }
  | { kind: "resume" | "cancel" | "clear" }
  | { kind: "accept"; criterion_id: string; objective_revision: number };

export interface GoalControlRequest {
  session_id: string;
  expected_revision: number;
  operation_id: string;
  action: GoalControlAction;
}

export interface GoalView {
  state: GoalState;
  physical_run?: HostedRunRef;
  attention?: string;
}

/** Display invalidation only; callers reread canonical state and cannot derive authority from it. */
export interface GoalChange {
  session_id: string;
}

/** Authenticated conversation controls; model calls cannot access this user-control surface. */
export interface GoalService {
  availability(): Promise<{ available: boolean; reason?: string }>;
  get(sessionId: string): Promise<GoalView>;
  control(request: GoalControlRequest): Promise<GoalReceipt>;
  receipt(sessionId: string, operationId: string): Promise<GoalReceipt | null>;
  /** Install a bounded live subscription before reading state; disposal releases it at the host. */
  subscribe(sessionId: string, listener: (change: GoalChange) => void): Promise<() => void>;
}
