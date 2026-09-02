/**
 * Curated public API of `@clarvis/loop` — the named surface hosts program
 * against: {@link executeRun} and its deps, the capability contract and
 * built-in capabilities, providers, persistence/trace types, MCP, messages,
 * errors, logging, and {@link VERSION}. Engine integration tests use the much
 * smaller `./testing` entrypoint; no general internal barrel is exported.
 */
export { executeRun } from "./runtime/execute-run.ts";
export type { ExecuteRunArgs, ExecuteRunDeps, ExecuteRunOutcome } from "./runtime/execute-run.ts";
export {
  compactStoredContext,
  estimateStoredContextTokens,
  fitStoredContextToWindow,
} from "./runtime/context/stored-context-compaction.ts";
export type {
  CompactStoredContextArgs,
  StoredContextCompactionResult,
} from "./runtime/context/stored-context-compaction.ts";
export type { SkillsProvider } from "@clarvis/skills/capability";
export type { ShadowedSkill, SkillInfo } from "@clarvis/skills";
export {
  buildExecuteRunDeps,
  createHostExtensionAdmission,
  createHostModelCallAdmission,
  hooksEffective,
} from "./runtime/build-run-deps.ts";
export type {
  BuildRunDepsOptions,
  BuiltRunDeps,
  HostExtensionAdmission,
  HostModelCallAdmission,
  SkillRootSnapshotProvider,
  SkillRootInput,
} from "./runtime/build-run-deps.ts";
export type { PluginBootstrapSkill } from "./runtime/capabilities/skills-settings.ts";
export type { ResolvedTraceStore } from "@clarvis/trace";
export type {
  AgentToolsCapabilityOptions,
  GuardResolution,
  GuardResolver,
} from "./runtime/capabilities/tools.ts";
export {
  CONTEXT_HOOK_EVENTS,
  GATE_HOOK_EVENTS,
  HOOK_DEFAULT_TIMEOUT_MS,
  HOOKS_CAPABILITY_NAME,
  OBSERVER_HOOK_EVENTS,
} from "@clarvis/capability";
export type { HookConfig } from "@clarvis/capability";
export {
  createAskUserCapability,
  ASK_USER_CAPABILITY_NAME,
} from "./runtime/capabilities/ask-user.ts";
export { DELEGATION_CAPABILITY_NAME } from "./runtime/capabilities/delegation.ts";
export type {
  AgentActivation,
  AgentBuildContext,
  AgentCapability,
  AgentIdentity,
  AgentLoopContribution,
  AgentScope,
  Capability,
  CapabilityEvent,
  CapabilityEventListener,
  RunCapability,
  RunCapabilityContext,
  SubagentCapabilitiesFactory,
} from "@clarvis/capability";
export type {
  AgentControl,
  AgentHandle,
  AgentKind,
  AgentRegistration,
  AgentRegistryPort,
  AgentSettlement,
  AgentStatus,
  SettledStatus,
  WaitingOn,
} from "@clarvis/capability";

export { ProviderError } from "@clarvis/capability";
export type {
  LLMProvider,
  LLMCallParams,
  LLMCallResult,
  LLMUsage,
  LLMToolCall,
  ToolChoice,
  ResolvedProviderConfig,
  ProviderErrorInit,
} from "@clarvis/capability";
export type { TraceStore, StoredExecution, StoredSummary, ListResult } from "@clarvis/trace";
export { TraceCleanup } from "@clarvis/trace";
export type { TraceCleanupOptions } from "@clarvis/trace";
export { generateExecutionId } from "@clarvis/trace";
export { ownerSegment } from "@clarvis/paths";
export { memoizeByOwner } from "@clarvis/capability";
export type {
  ConnectionManager,
  Lease,
  AcquireOptions,
  PoolScope,
  PoolSharing,
} from "@clarvis/mcp-client";
export type { ConnectionEvent, ConnectionEventSink } from "@clarvis/mcp-client";
export { createMCPClientFactory } from "@clarvis/mcp-client";
export type { MCPClientFactory, RuntimeEnvironment } from "@clarvis/mcp-client";
export { isMcpRequestTimeout } from "@clarvis/mcp-client";
export { ElicitTimeoutError } from "./runtime/tools/ask-user-tool.ts";
export type {
  Elicit,
  ElicitParams,
  ElicitRawResult,
  ElicitRequestedSchema,
  ElicitationAction,
} from "./runtime/tools/ask-user-tool.ts";

export type {
  MessageRole,
  TextPart,
  ImagePart,
  ContentPart,
  MessageContent,
  Message,
  SteerMessage,
  SteerSource,
  CompactionRequest,
  CompactionSource,
  ToolCallRef,
  ToolResultImage,
  LiveMessage,
  ToolTransport,
  AgentRole,
  McpServerConfig,
  ProviderKind,
  ProviderConfig,
  ModelConfig,
  BudgetMode,
  BudgetConfig,
  Grant,
  GuardMode,
  GuardJudgeConfig,
  ReasoningSummary,
  ReasoningEffort,
  CompactionConfigInput,
  RetryConfigInput,
  OrchestrationConfigInput,
  AgentProfile,
  RunRequest,
  GateVerdict,
  HookVerdict,
  BeforeToolUseContext,
  AfterToolUseContext,
  PreFinalizeContext,
  PreDelegateTaskContext,
  RunStartContext,
  RunEndContext,
  SubagentCompleteContext,
  PreCompactContext,
  ModelCallErrorContext,
  BudgetExhaustedContext,
  UserSteerContext,
  LifecycleHook,
  HandlerResult,
} from "@clarvis/capability";

export type {
  Guard,
  Elicit as GuardElicit,
  GuardContext,
  GuardDecision,
  GuardElicitAnswer,
  GuardReview,
  ShellFacts,
  PathFact,
  ElicitRequest,
  Verdict,
} from "./runtime/tools/builtin/index.ts";

export type {
  RunResponse,
  WireRunResponse,
  ResultValue,
  Usage,
  PerAgentUsage,
  RunEndedReason,
  ExecutionMode,
  ErrorBody,
  ErrorCode,
  FailureKind,
  ProviderErrorDetails,
  ContextSnapshotEntry,
} from "@clarvis/capability";
export type { TraceEntry } from "@clarvis/capability";
export type { TraceEvent, Trace, ExecutionRecord } from "@clarvis/capability";
export type { ExecutionStatus } from "@clarvis/capability";

export { loadEnv } from "@clarvis/capability";
export type { EnvConfig } from "@clarvis/capability";
export { createLogger } from "./logger.ts";
export type { Logger, CreateLoggerOptions } from "./logger.ts";
export { sanitizeErrorMessage } from "@clarvis/capability";
export {
  CodedError,
  ValidationError,
  ConflictError,
  ContinuationUnavailableError,
  PersistenceError,
  executionIdConflict,
} from "@clarvis/capability";
export { VERSION } from "./version.ts";
