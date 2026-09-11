import type { RuntimeStatus } from "./client.ts";
import type { ExtensionProfileRunRef } from "./extension-profiles.ts";
import type { ElicitationRequest, RunEvent, RunHandle, RunResult, StartRunParams } from "./runs.ts";
import type { SessionTurnKind } from "./sessions.ts";

/** Cursor in one host generation's observation stream, independent of RPC request ids. */
export interface HostedRunCursor {
  host_generation: string;
  execution_id: string;
  sequence: number;
}

/** A losslessly coalesced observation item; its sequence interval can contain several deltas. */
export interface HostedRunFrame {
  first_sequence: number;
  last_sequence: number;
  event: RunEvent;
}

/** Immutable prefix of a host-owned NDJSON observation projection. */
export interface HostedRunSnapshot {
  snapshot_id: string;
  cursor: HostedRunCursor;
  bytes: number;
}

/** Byte-bounded snapshot transfer; concatenate decoded bytes before parsing UTF-8 NDJSON. */
export interface HostedRunSnapshotPage {
  snapshot_id: string;
  offset: number;
  data_base64: string;
  /** Absent at EOF, including for an empty snapshot. */
  next_offset?: number;
}

/** Configuration actually bound to a hosted execution, without credentials or consent nonces. */
export interface HostedExecutionConfig {
  agent: string;
  model?: string;
  environment?: string;
  extension_profile?: ExtensionProfileRunRef;
  runtime?: RuntimeStatus;
}

/** Durable operator attestation; physical closure does not establish an execution outcome. */
export interface HostedRecoveryResolution {
  kind: "operator_verified_physical_closure";
  previous_host_generation: string;
  resolving_host_generation: string;
  operator_connection_id: string;
  resolved_at: number;
}

/** Explicitly archive old unknown work after the operator verifies every physical process ended. */
export interface ResolveHostedRecoveryParams {
  execution_id: string;
  host_generation: string;
  revision: number;
  physical_work_stopped: true;
}

/** Bounded discovery row. Physical lifecycle and outcome are deliberately distinct. */
export interface HostedRunRef {
  execution_id: string;
  session_id: string;
  workspace_id: string;
  host_generation: string;
  title: string;
  config: HostedExecutionConfig;
  created_at: number;
  updated_at: number;
  revision: number;
  disconnect_policy: "cancel" | "continue";
  execution_state: "starting" | "running" | "finishing" | "closed" | "unknown";
  attention: "none" | "waiting_user";
  control_epoch: number;
  /** Relative to the authenticated connection requesting this row. */
  control: "available" | "self" | "other";
  outcome?: Pick<RunResult, "status" | "ended_reason" | "error" | "usage">;
  /** A failed projection or reconciliation prevents further handoffs. */
  recovery_error?: string;
  /** The session retains this audit even after discovery acknowledgement. No result is invented. */
  recovery_resolution?: HostedRecoveryResolution;
}

/** Connection-independent confirmation of a committed handoff. */
export interface HostedRunReceipt {
  operation_id: string;
  run: HostedRunRef;
  committed_at: number;
}

/** Failure details for one handoff identity; only an explicit refusal permits a new mutation ID. */
export interface HostedHandoffFailureDetails {
  handoff: {
    operation_id: string;
    admission: "refused" | "uncertain";
  };
}

/** Snapshot and subscription cut atomically at the same cursor. Attaching never starts a run. */
export interface HostedRunAttachment {
  run: HostedRunRef;
  observation_id: string;
  snapshot: HostedRunSnapshot;
  pending_elicitations: ElicitationRequest[];
  /** Events after the snapshot cursor; this handle closes with the observation connection. */
  handle: HostedRunObservation;
}

/** A subscription carrying source sequence intervals while reusing ordinary run control semantics. */
export interface HostedRunObservation extends Omit<RunHandle, "events"> {
  readonly events: AsyncIterable<HostedRunFrame>;
  /** Observation closure does not prove physical run closure after a connection failure. */
  readonly closed: Promise<void>;
}

/** Session-bound admission. The host reserves the conversation before asynchronous preparation. */
export interface StartHostedTurnParams {
  session_id: string;
  /** Last persisted session revision observed by this client. */
  session_revision: number;
  kind: SessionTurnKind;
  user_preview: string;
  params: StartRunParams & { execution_id: string };
}

/** Reconnection names both execution and generation, fencing stale host records. */
export interface AttachHostedRunParams {
  execution_id: string;
  host_generation: string;
  /** Taking an occupied controller requires an explicit operator action. */
  control: "observe" | "acquire" | "takeover";
}

/** An explicit handoff binds the controller and the host's current execution revision. */
export interface DetachHostedRunParams {
  execution_id: string;
  host_generation: string;
  operation_id: string;
  control_epoch: number;
  revision: number;
}

/** Conversation occupancy for work owned by the TUI, which cannot itself detach. */
export interface HostedActivityLease {
  lease_id: string;
  session_id: string;
  host_generation: string;
  kind: "shell" | "compaction";
}

/**
 * Local authenticated host service, advertised only by hosts that own execution beyond a client.
 * Methods remain kernel RPC operations; sockets and named pipes are transport implementation.
 */
export interface HostingService {
  list(): Promise<HostedRunRef[]>;
  start(input: StartHostedTurnParams): Promise<HostedRunAttachment>;
  attach(input: AttachHostedRunParams): Promise<HostedRunAttachment>;
  /** Acquire authority for an existing owned observation without replacing its snapshot or stream. */
  controlObservation(observationId: string, control: "acquire" | "takeover"): Promise<HostedRunRef>;
  /** Failures carry HostedHandoffFailureDetails when the host can classify admission. */
  detach(input: DetachHostedRunParams): Promise<HostedRunReceipt>;
  /** Missing/expired receipts are unknown outcomes, never permission to replay a mutation. */
  receipt(operationId: string): Promise<HostedRunReceipt | null>;
  readSnapshot(snapshotId: string, offset: number): Promise<HostedRunSnapshotPage>;
  releaseSnapshot(snapshotId: string): Promise<void>;
  /** Stop only this observation; a run's disconnect policy is applied when control is released. */
  releaseObservation(observationId: string): Promise<void>;
  /** Retire volatile conversation consent and control on switch/resume without closing the connection. */
  closeSession(sessionId: string): Promise<void>;
  /** Dismiss a terminal result from subsequent startup offers without deleting its history. */
  acknowledge(executionId: string): Promise<void>;
  /** Operator-only old-generation recovery; archives the affected conversation without replay. */
  resolveRecovery(input: ResolveHostedRecoveryParams): Promise<HostedRunRef>;
  reserveActivity(
    sessionId: string,
    kind: HostedActivityLease["kind"],
  ): Promise<HostedActivityLease>;
  releaseActivity(leaseId: string): Promise<void>;
}
