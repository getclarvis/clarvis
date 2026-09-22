import type { Logger, OperatorReviewContextProvider } from "@clarvis/capability";
import type {
  GoalStewardCompletionDecision,
  GoalStewardFinalizeAttempt,
} from "./agent/steward-types.ts";
import type { GoalCheckpoint, GoalEvidenceRef, GoalRecord, GoalState } from "./schemas.ts";
import type { GoalCompletionValidation } from "./criteria.ts";
import type { GoalCandidateInput, GoalCheckpointInput, GoalProgressInput } from "./model-input.ts";
import type { GoalCreationInput } from "./model-input.ts";

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
 * The outcome of a model operation that can be refused as corrigible input.
 *
 * @remarks A rejected argument — an evidence identifier that is absent, obsolete,
 *   duplicated or unsuccessful — is a mistake the model can fix by reading the
 *   catalog again, not proof that the bound control is unavailable. Returning it as
 *   a value keeps the two apart: the caller answers the model instead of ending the
 *   stage with host attention. Thrown errors stay reserved for infrastructure,
 *   authority and state conflicts, and only ever report a rejection that happened
 *   *before* any durable write, so an operation the host could not confirm is never
 *   presented as an argument the model may simply retry.
 */
export type GoalOperationOutcome<T> =
  { kind: "ok"; value: T } | { kind: "invalid"; reason: string };

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
  readonly steward?: GoalStewardPort;
  read(signal?: AbortSignal): Promise<GoalRuntimeSnapshot>;
  progress(input: GoalProgressInput, signal?: AbortSignal): Promise<GoalOperationOutcome<void>>;
  checkpoint(
    input: GoalCheckpointInput,
    signal?: AbortSignal,
  ): Promise<GoalOperationOutcome<GoalCheckpoint>>;
  candidate(
    input: GoalCandidateInput,
    signal?: AbortSignal,
  ): Promise<GoalOperationOutcome<GoalCompletionValidation>>;
  /** Deterministic candidate and host/human evidence validation; this never invokes a model. */
  validateCompletion(signal?: AbortSignal): Promise<GoalCompletionValidation>;
  blocked(reason: string, signal?: AbortSignal): Promise<void>;
}

/** Host-owned bridge exposed only during the first main-agent turn of a guided Goal. */
export interface GoalCreationPort {
  readonly session_id: string;
  readonly agent_instance_id: string;
  readonly execution_id: string;
  create(input: GoalCreationInput, signal?: AbortSignal): Promise<GoalRuntimePort>;
  bindReviewContext?(provider: OperatorReviewContextProvider): void;
  reviewCompletion?(
    attempt: GoalStewardFinalizeAttempt,
    signal?: AbortSignal,
  ): Promise<GoalStewardCompletionDecision>;
}

/** Host-bound activation of an existing Goal by the authenticated operator's current run. */
export interface GoalAttachmentPort extends Omit<GoalCreationPort, "create"> {
  readonly goal: GoalRecord;
  attach(signal?: AbortSignal): Promise<GoalRuntimePort>;
}

/** Shared runtime activation; only creation restricts work before activation. */
export type GoalActivationPort = GoalCreationPort | GoalAttachmentPort;

/** Host attestation only; the Goal capability owns notes and finalization gate policy. */
export interface GoalStewardPort {
  bindReviewContext(provider: OperatorReviewContextProvider): void;
  reviewCompletion(
    attempt: GoalStewardFinalizeAttempt,
    signal?: AbortSignal,
  ): Promise<GoalStewardCompletionDecision>;
  closeCoordinator(): Promise<void>;
}
