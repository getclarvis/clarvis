/**
 * `@clarvis/workflows` — an agentic workflow layer over `@clarvis/loop`.
 *
 * A **workflow** is a top-level "manager" agent-loop run whose `run_leader` tool
 * calls each spawn a full, isolated `executeRun` "leader"; each leader may delegate
 * its own sub-agents. This fixes a three-level topology — Manager → Leaders →
 * Sub-agents — structurally, via the non-inherited `workflow` grant plus the flat
 * delegation rule, with no depth counter.
 *
 * The package is a library above the loop and below any host: it exposes the
 * capability the host injects into a manager run ({@link createWorkflowsCapability}),
 * the leader primitive ({@link runLeader}), the tree budget ({@link createWorkflowLedger}),
 * the cumulative registration bound ({@link createWorkflowLeaderCount}), and the elicitation
 * multiplexer ({@link createElicitMux}). It has no dependency on
 * `@clarvis/kernel`; a host supplies the {@link WorkflowCtx} (engine deps, the narrow
 * {@link WorkflowRunDeps} execution port, semaphore, ledger, leader count and assembler).
 *
 * Shared agent, run, tool, trace and elicitation contracts are consumed directly
 * from `@clarvis/capability`; the loop dependency is limited to execution and its
 * workflow-specific elicitation serializer rather than contract pass-throughs.
 */
export { runLeader } from "./run-leader.ts";
export { createWorkflowsCapability, WORKFLOW_GRANT } from "./capability.ts";
export { createWorkflowLedger } from "./ledger.ts";
export type { WorkflowLedger } from "./ledger.ts";
export { createWorkflowLeaderCount } from "./leader-count.ts";
export type { WorkflowLeaderCount, WorkflowLeaderReservation } from "./leader-count.ts";
export { buildRunLeaderTool, RUN_LEADER_TOOL_NAME } from "./tool.ts";
export type { LeaderProfileInfo } from "./tool.ts";
export { createElicitMux } from "./elicit-mux.ts";
export type { ElicitMux, ElicitMuxOptions } from "./elicit-mux.ts";
export { createWorkflowSemaphore } from "./concurrency.ts";
export type { WorkflowSemaphore } from "./concurrency.ts";
export {
  BUILTIN_WORKFLOWS,
  BUILTIN_WORKFLOW_NAMES,
  resolveWorkflowDefinitions,
} from "./builtin-workflows/index.ts";
export {
  DISCOVERY_SCHEMA,
  FINDINGS_SCHEMA,
  VERDICT_SCHEMA,
  WORKFLOW_RESULT_SCHEMAS,
} from "./schemas.ts";
export type { WorkflowResultSchema } from "./schemas.ts";
export { WORKFLOW_LIMITS } from "./limits.ts";
export type {
  LeaderRequestAssembler,
  LeaderResult,
  LeaderSpec,
  LeaderStatus,
  WorkflowCtx,
  WorkflowRunDeps,
  WorkflowSequenceState,
  WorkflowSequenceStatus,
} from "./types.ts";
export {
  isWorkflowPersistedTraceEvent,
  isWorkflowRunFinishedDetail,
  isWorkflowRunStartedDetail,
  recordWorkflowTrace,
  WORKFLOW_PERSISTED_TRACE_PROJECTORS,
  WORKFLOW_RUN_COMPLETED_TRACE_KIND,
  WORKFLOW_RUN_FAILED_TRACE_KIND,
  WORKFLOW_RUN_STARTED_TRACE_KIND,
  WORKFLOW_TRACE_KINDS,
} from "./trace-events.ts";
export type {
  WorkflowPersistedTraceEvent,
  WorkflowRunCompletedTraceEvent,
  WorkflowRunFailedTraceEvent,
  WorkflowRunFinishedDetail,
  WorkflowRunStartedDetail,
  WorkflowRunStartedTraceEvent,
  WorkflowTraceDetailMap,
  WorkflowTraceKind,
} from "./trace-events.ts";

export {
  managerLiveChildrenFloor,
  WORKFLOWS_DEFAULTS,
  WORKFLOWS_MAX_CONCURRENCY,
  WORKFLOWS_MAX_TOTAL_LEADERS,
  WORKFLOWS_SETTINGS_FIELDS,
  workflowsSettingsSpec,
} from "./settings.ts";
export type { WorkflowsSettingsBlock } from "./settings.ts";
