import type { HostedRunRef } from "./hosting.ts";

/** Semantic state of a persistent objective, independent of physical execution. */
export type GoalStatus =
  "active" | "paused" | "blocked" | "budget_limited" | "usage_limited" | "complete" | "cancelled";

export interface GoalLimits {
  max_net_tokens: number;
  max_auto_continuations: number;
  max_no_progress_stages: number;
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

export interface GoalDefinitionSource {
  path: string;
  digest: string;
}

export interface GoalFormulationOrigin {
  formulation_execution_id: string;
  source_session_revision: number;
  source_execution_ids: string[];
  trajectory_digest: string;
  trajectory_truncated: boolean;
  formulation_usage?: GoalUsage;
}

export type GoalOrigin =
  | { kind: "literal" }
  | ({ kind: "guided"; seed: string } & GoalFormulationOrigin)
  | ({ kind: "auto" } & GoalFormulationOrigin);

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

/**
 * Why one call's consumption stayed unresolved, in the host's closed vocabulary.
 *
 * @remarks A provider that would not report it, a call still in flight when the stage closed,
 *   telemetry that arrived unusable, or a rejection that carried none. No member identifies a
 *   prompt, response or credential.
 */
export type GoalUsageGapCause =
  "no_usage" | "provider_unknown" | "pending_call" | "invalid_measure";

/** One bounded, attributable gap in a partial measurement. */
export interface GoalUsageGap {
  cause: GoalUsageGapCause;
  calls: number;
  call_ids?: string[];
  fingerprint?: string;
}

/**
 * One scope's confirmed consumption.
 *
 * @remarks `complete` and `partial` both carry the tokens actually observed and differ only in
 *   whether every call is accounted for; `partial` names what stayed unresolved and why. Missing
 *   cache is a conservative estimate in either case, while an absent subtotal is not a measured
 *   zero — that is what `unknown` is for.
 */
export type GoalUsage =
  | { kind: "unknown" }
  | {
      kind: "complete";
      revision?: number;
      input: number;
      output: number;
      cached?: number;
      cost_usd?: number;
    }
  | {
      kind: "partial";
      revision?: number;
      input: number;
      output: number;
      cached?: number;
      cost_usd?: number;
      gaps: GoalUsageGap[];
    };

/**
 * Why a stage ended, in the host's closed vocabulary.
 *
 * @remarks Mirrors the Goal domain's own enum so a client can name an ending
 *   without parsing prose. Only `checkpoint`, `local_limit`, `stagnation`,
 *   `empty_response`, `impediment`, `transient` and `steward_interrupted` may be
 *   re-evaluated by a successor stage; the rest are never presumed recoverable.
 */
export type GoalRunCause =
  | "checkpoint"
  | "local_limit"
  | "declined"
  | "cancelled"
  | "stagnation"
  | "empty_response"
  | "impediment"
  | "transient"
  | "steward_interrupted"
  | "usage_unknown"
  | "context_overflow"
  | "provider_refused"
  | "tools_unavailable"
  | "control_failure"
  | "finalization_conflict"
  | "unclassified";

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
  accepted_usage_gaps?: string;
  usage_estimate?: { sequence: number; usage: GoalUsage };
  /** Host-prepared non-final settlement; physical proof is still required and this grants no completion. */
  settlement_preparation?: {
    outcome: "completed" | "failed" | "cancelled";
    disposition: "final" | "checkpoint";
    usage: GoalUsage;
    activity?: string[];
    activity_unavailable?: boolean;
  };
  /**
   * What the closed stage leaves for the host's automatic path.
   *
   * @remarks Written by the Goal domain's settlement, read by the host's
   *   continuation policy. `decision` is the one field that admits a successor;
   *   `cause` is the closed vocabulary the successor is told, and
   *   `progress_observed` is the host's own observation that the stage advanced the
   *   work rather than repeating itself.
   */
  decision?: "complete" | "continue" | "attention" | "closed";
  cause?: GoalRunCause;
  progress_observed?: boolean;
  /** Activity could not be measured; absence of receipts does not establish stagnation. */
  activity_unavailable?: boolean;
  /** Receipts this stage contributed that the Goal had not already recorded. */
  activity?: string[];
  not_before?: number;
  /** A model-declared blocker: evidence the stage reported, never an operator control. */
  impediment?: { reason: string; declared_at: number };
  checkpoint?: GoalCheckpoint;
  progress?: GoalProgress;
  candidate?: GoalCandidate;
  steward_reviews?: GoalStewardReview[];
  steward_review_count?: number;
}

/** Bounded audit only; prompts, tool exchanges and pending decisions remain host-private. */
export interface GoalStewardReview {
  steward_execution_id: string;
  mode: "completion";
  goal_id: string;
  work_execution_id: string;
  control_revision: number;
  objective_revision: number;
  definition_digest: string;
  trajectory_digest: string;
  plan_context_revision: string;
  operator_steering_epoch: number;
  candidate_digest?: string;
  final_attempt_digest?: string;
  evidence_digest: string;
  decision: "achieved" | "needs_work" | "needs_evidence" | "interrupted";
  summary: string;
  next_step?: string;
  question?: string;
  answer?: string;
  speakers?: Array<{
    speaker: "operator" | "work_agent" | "steward";
    kind: "request" | "correction" | "report" | "question" | "answer";
  }>;
  /**
   * Why a technical interruption stopped the review.
   *
   * @remarks `usage_unknown` means the evaluation answered but its consumption
   *   could not be determined, so the Goal cannot be concluded on it; it used to
   *   be reported as `transport`, which named the wrong cause.
   */
  interruption_cause?: "timeout" | "transport" | "invalid_output" | "cancelled" | "usage_unknown";
  usage: GoalUsage;
  reviewed_at: number;
}

export interface GoalStewardChainState {
  last_steward_execution_id?: string;
  pending_execution_id?: string;
  trajectory_digest?: string;
  operator_steering_epoch?: number;
  last_consumed_work_sequence: number;
  runtime_fingerprint: string;
  prompt_cache_ttl: "5m" | "1h";
  status: "idle" | "verifying" | "verified" | "evidence_requested" | "attention";
  pending_question?: { review_id: string; question: string };
  consumption: {
    input: number;
    output: number;
    cached?: number;
    net_tokens: number;
    usage_unknown: boolean;
  };
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
  constraints: string[];
  exclusions: string[];
  assumptions: string[];
  sources: GoalDefinitionSource[];
  origin: GoalOrigin;
  steward?: GoalStewardChainState;
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
    /** Bounded aggregate of what the charged subtotal does not cover, by cause. */
    gaps: GoalUsageGap[];
    /** Closed executions whose incomplete measurement the operator accepted. */
    usage_accepted_runs: string[];
  };
  auto_continuations: number;
  no_progress_stages: number;
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
  resume_pending?: true;
  resume_condition?: "physical" | "token_limit" | "deadline";
  outcome?: "running" | "recovering" | "needs_input" | "superseded" | "unavailable";
  operation_id: string;
  fingerprint: string;
  revision: number;
  /** Reserved before launch; replay never starts another execution for this operation. */
  execution_id?: string;
  goal_id?: string;
  status?: GoalStatus;
  formulation?: {
    formulation_execution_id?: string;
    mode: "auto" | "guided";
    outcome: "created" | "insufficient_context" | "stale_context" | "failed";
    question?: string;
    message?: string;
  };
}

export type GoalFormulateRequest = {
  session_id: string;
  expected_revision: number;
  operation_id: string;
} & ({ mode: "auto"; seed?: never } | { mode: "guided"; seed: string });

export interface GoalFormulateResult extends GoalReceipt {
  formulation: NonNullable<GoalReceipt["formulation"]>;
}

/** Admitted guided creation; it is not a Goal and does not authorize implementation. */
export interface GoalCreationIntent {
  seed: string;
  execution_id: string;
  operation_id: string;
  phase: "formulating";
  admitted_at: number;
}

/** Optional private-session field, writable only by the host's short transaction. */
export interface GoalState {
  version: 1;
  revision: number;
  current?: GoalRecord;
  archive: GoalRecord[];
  receipts: GoalReceipt[];
  creation_intent?: GoalCreationIntent;
}

export type GoalControlAction =
  | {
      kind: "create" | "replace";
      objective: string;
      criteria?: GoalCriterion[];
      limits?: Partial<GoalLimits>;
    }
  | {
      kind: "edit";
      resume_operation_id?: string;
      objective?: string;
      criteria?: GoalCriterion[];
      constraints?: string[];
      exclusions?: string[];
      assumptions?: string[];
      limits?: Partial<GoalLimits>;
    }
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

/** Ephemeral formulation activity; it is presentation only and never enters durable Goal state. */
export interface GoalFormulationActivity {
  phase: "thinking" | "reading" | "searching" | "idle";
  iteration?: number;
  last_workspace_activity?: "reading" | "searching";
}

/** Display invalidation or ephemeral activity; neither grants authority. */
export interface GoalChange {
  session_id: string;
  formulation_activity?: GoalFormulationActivity;
}

/** Authenticated conversation controls; model calls cannot access this user-control surface. */
export interface GoalService {
  availability(): Promise<{ available: boolean; reason?: string }>;
  get(sessionId: string): Promise<GoalView>;
  control(request: GoalControlRequest): Promise<GoalReceipt>;
  formulate(request: GoalFormulateRequest): Promise<GoalFormulateResult>;
  receipt(sessionId: string, operationId: string): Promise<GoalReceipt | null>;
  /** Install a bounded live subscription before reading state; disposal releases it at the host. */
  subscribe(sessionId: string, listener: (change: GoalChange) => void): Promise<() => void>;
}
