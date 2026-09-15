import type { RunSnapshot } from "./run-contract.ts";

/** Where a durable index job sits in its lifecycle. */
export type MemoryJobState = "pending" | "running" | "retry_wait" | "completed" | "failed";

/** Which stage of an index pass failed. */
export type MemoryJobPhase = "generate" | "validate" | "apply" | "commit";

/** One recorded failure. */
export interface MemoryJobAttempt {
  at: number;
  phase: MemoryJobPhase;
  error: string;
}

/** What went wrong, as the drain reports it. */
export interface MemoryJobFailure {
  phase: MemoryJobPhase;
  error: string;
  terminal?: boolean;
}

/** One durable intent to fold a finished run into the wiki. */
export interface MemoryIndexJob {
  run_id: string;
  /** Persisted conversation instance, shared by every claim and physical retry. */
  agent_instance_id?: string;
  /** Execution reserved by the current claim before its first provider call. */
  indexer_execution_id?: string;
  /** Previous claim's execution, replayed when recovering the same conversation. */
  indexer_continue_from?: string;
  /** Reserved predecessors, newest first, including claims that died before creating a trace. */
  indexer_prior_executions?: string[];
  state: MemoryJobState;
  enqueued_at: number;
  updated_at: number;
  attempts: number;
  provider_key?: string;
  not_before?: number;
  lease_until?: number;
  lease_owner?: string;
  /** Opaque fencing token minted for this exact claim. */
  lease_token?: string;
  snapshot?: RunSnapshot;
  history: MemoryJobAttempt[];
  note?: string;
}

/** Identity of one exact claim, used to fence renewals and settlement. */
export interface MemoryJobLease {
  owner: string;
  token: string;
}

/** Where a failing job goes next. */
export type MemoryJobTransition = { state: "retry_wait"; not_before: number } | { state: "failed" };
