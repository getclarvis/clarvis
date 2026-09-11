import type { Logger } from "@clarvis/capability";
import type { GoalCheckpoint, GoalEvidenceRef, GoalRecord, GoalState } from "./schemas.ts";
import type { GoalCompletionValidation } from "./criteria.ts";
import type { GoalCandidateInput, GoalCheckpointInput, GoalProgressInput } from "./model-input.ts";

/** A host transaction updates its existing session document; this port does not own another store. */
export interface GoalRepository {
  read(sessionId: string): Promise<GoalState | undefined>;
  transact<T>(
    sessionId: string,
    mutation: (current: GoalState | undefined) => {
      state: GoalState;
      result: T;
    },
  ): Promise<T>;
}

/** Immutable admission identity, assigned by the host before capability registration. */
export interface GoalRuntimeBinding {
  readonly session_id: string;
  readonly agent_instance_id: string;
  readonly execution_id: string;
  readonly goal_id: string;
  readonly objective_revision: number;
}

/** The host supplies current state and a bounded catalog of references it can resolve. */
export interface GoalRuntimeSnapshot {
  goal: GoalRecord;
  evidence: GoalEvidenceOption[];
}

/** A discoverable reference with a short host-authored label; descriptions are not proof. */
export interface GoalEvidenceOption extends GoalEvidenceRef {
  description: string;
}

/**
 * Entry-agent authority is captured by the host, never selected through model arguments.
 * Every operation revalidates the bound run and revision. Evidence IDs are resolved and stamped
 * by the host; model prose cannot establish scope, successful activity or human acceptance.
 * Methods resolve only after their state update is durable. No method grants another run.
 * Per-operation cancellation supplements the execution signal and is checked inside mutations.
 */
export interface GoalRuntimePort {
  readonly binding: GoalRuntimeBinding;
  readonly logger?: Logger;
  read(signal?: AbortSignal): Promise<GoalRuntimeSnapshot>;
  progress(input: GoalProgressInput, signal?: AbortSignal): Promise<void>;
  checkpoint(input: GoalCheckpointInput, signal?: AbortSignal): Promise<GoalCheckpoint>;
  candidate(input: GoalCandidateInput, signal?: AbortSignal): Promise<GoalCompletionValidation>;
  validateCompletion(signal?: AbortSignal): Promise<GoalCompletionValidation>;
  blocked(reason: string, signal?: AbortSignal): Promise<void>;
}
