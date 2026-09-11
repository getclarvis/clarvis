import type {
  ConfigChange,
  ElicitationRequest,
  KernelCapabilities,
  Principal,
  ProjectRef,
  RunEvent,
  RunResult,
  WorkspaceRef,
} from "@clarvis/protocol";
import { OPERATIONS, SPECIAL_OPERATIONS } from "./operations.ts";

/** Clean-break version of Clarvis's internal request/notification wire. */
export const CLARVIS_WIRE_VERSION = 7 as const;

/**
 * The request/response method vocabulary for kernel RPC — Clarvis's own,
 * JSON-RPC-shaped names (not MCP's).
 *
 * @remarks Both the client façade ({@link connectKernelClient}) and the server
 *   dispatcher ({@link createKernelServer}) key off these same constants, so a
 *   method string is never spelled twice and the two sides can never drift. Each
 *   value maps one-to-one onto a protocol service call (e.g. `runs.start` →
 *   `RunService.start`, `plans.read` → `PlansService.read`).
 */
export const M = {
  hello: SPECIAL_OPERATIONS.hello.method,
  hostingStart: SPECIAL_OPERATIONS.hostingStart.method,
  hostingAttach: SPECIAL_OPERATIONS.hostingAttach.method,
  hostingSteer: SPECIAL_OPERATIONS.hostingSteer.method,
  hostingCompact: SPECIAL_OPERATIONS.hostingCompact.method,
  hostingCancel: SPECIAL_OPERATIONS.hostingCancel.method,
  hostingRespond: SPECIAL_OPERATIONS.hostingRespond.method,
  runsStart: SPECIAL_OPERATIONS.runsStart.method,
  runsSteer: SPECIAL_OPERATIONS.runsSteer.method,
  runsCompact: SPECIAL_OPERATIONS.runsCompact.method,
  runsCancel: SPECIAL_OPERATIONS.runsCancel.method,
  runsRespond: SPECIAL_OPERATIONS.runsRespond.method,
  runsGet: OPERATIONS.runs.get.method,
  runsList: OPERATIONS.runs.list.method,
  runsDelete: OPERATIONS.runs.delete.method,
  plansList: OPERATIONS.plans.list.method,
  plansRead: OPERATIONS.plans.read.method,
  plansSetRetention: OPERATIONS.plans.setRetention.method,
  plansDelete: OPERATIONS.plans.delete.method,
  workflowsGet: OPERATIONS.workflows.get.method,
  workflowsList: OPERATIONS.workflows.list.method,
  workflowsDelete: OPERATIONS.workflows.delete.method,
  listAgents: OPERATIONS.config.listAgents.method,
  getSettings: OPERATIONS.config.getSettings.method,
  updateSettings: OPERATIONS.config.updateSettings.method,
  inspectSandbox: OPERATIONS.config.inspectSandbox.method,
  approveWorkspace: OPERATIONS.config.approveWorkspace.method,
  revokeWorkspace: OPERATIONS.config.revokeWorkspace.method,
  workspaceTrustError: OPERATIONS.config.workspaceTrustError.method,
  getAgent: OPERATIONS.config.getAgent.method,
  writeAgent: OPERATIONS.config.writeAgent.method,
  deleteAgent: OPERATIONS.config.deleteAgent.method,
  renameAgent: OPERATIONS.config.renameAgent.method,
  getContext: OPERATIONS.config.getContext.method,
  configSubscribe: SPECIAL_OPERATIONS.configSubscribe.method,
  configUnsubscribe: SPECIAL_OPERATIONS.configUnsubscribe.method,
  goalsSubscribe: SPECIAL_OPERATIONS.goalsSubscribe.method,
  goalsUnsubscribe: SPECIAL_OPERATIONS.goalsUnsubscribe.method,
} as const;

/**
 * The notification method vocabulary for server→client pushes — the one-way
 * channel that carries a live run's stream and config changes back to a client.
 *
 * @remarks These have no response frame. {@link createKernelServer} emits them via
 *   its {@link NotificationSender}; {@link connectKernelClient} routes each back
 *   onto the matching local event stream or listener.
 */
export const N = {
  hostedObservation: "hosting.observation",
  runEvent: "run.event",
  runElicitation: "run.elicitation",
  runResult: "run.result",
  runStreamEnd: "run.stream_end",
  configChange: "config.change",
  goalChange: "goals.change",
} as const;

/**
 * Parameters a client sends with the opening `hello` request ({@link M.hello}).
 *
 * @remarks `wire_version` is mandatory. The remaining fields identify the
 *   client, requested workspace, and authentication material.
 */
export interface HelloParams {
  /** Exact wire contract spoken by the client. */
  wire_version: typeof CLARVIS_WIRE_VERSION;
  /** Client name and optional version, for the kernel's own bookkeeping. */
  clientInfo?: { name: string; version?: string };
  /** Workspace the client wishes to bind to. */
  workspace?: string;
  /** Opaque auth token, when the transport requires one. */
  auth?: string;
}

/**
 * The kernel's answer to `hello`: the advertised capabilities, the bound
 * workspace, and the resolved principal (when the transport authenticates).
 *
 * @remarks {@link connectKernelClient} surfaces these three fields directly on the
 *   returned {@link RemoteKernel}.
 */
export interface HelloResult {
  wire_version: typeof CLARVIS_WIRE_VERSION;
  capabilities: KernelCapabilities;
  project: ProjectRef;
  workspace: WorkspaceRef;
  principal?: Principal;
}

/**
 * Payload of a {@link N.runEvent} notification: one trace/capability event for a
 * specific run.
 */
export interface RunEventNote {
  /** Run the event belongs to; the client uses it to route onto the right stream. */
  execution_id: string;
  event: RunEvent;
}

/**
 * Payload of a {@link N.runElicitation} notification: a run's request for user
 * input.
 *
 * @remarks The run is identified by the request's own `execution_id`, so no
 *   separate id field is carried here.
 */
export interface RunElicitationNote {
  request: ElicitationRequest;
}

/**
 * Payload of a {@link N.runResult} notification: a run's terminal result.
 *
 * @remarks Receiving this settles the run's `done` promise. The independent
 *   {@link RunStreamEndNote} closes the event stream, so final events may arrive
 *   after the result without being lost.
 */
export interface RunResultNote {
  execution_id: string;
  result: RunResult;
}

/** Closes one run's event channel independently from its terminal result. */
export interface RunStreamEndNote {
  execution_id: string;
}

/**
 * Payload of a {@link N.configChange} notification: one config change fanned out
 * to a specific subscription.
 *
 * @remarks The `subscription_id` echoes the id the client chose at
 *   {@link ConfigService.subscribe} time, so the client can dispatch to the
 *   matching listener.
 */
export interface ConfigChangeNote {
  subscription_id: string;
  change: ConfigChange;
}
