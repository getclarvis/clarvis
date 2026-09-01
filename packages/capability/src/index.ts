/**
 * `@clarvis/capability` — the contract a cross-cutting loop feature is written
 * against, and the machinery that composes a list of them.
 *
 * @remarks A dependency-free leaf: it names what a capability *needs* (the
 * request and settings vocabulary, the ports, the trace kinds) without
 * depending on the engine that supplies them. That is what lets a capability
 * live in its own package instead of inside `@clarvis/loop`.
 */

export { projected } from "./contract.ts";
export type {
  CapabilityEvent,
  CapabilityEventListener,
  CapabilityRequestView,
  CapabilityGrantDeclaration,
  RunCapabilityContext,
  Capability,
  AgentIdentity,
  AgentScope,
  RunCapability,
  AgentCapability,
  AgentLoopContribution,
  AgentActivation,
  SubagentCapabilitiesFactory,
} from "./contract.ts";
export type { OutputTokenBudget, OutputTokenReservation } from "./output-budget.ts";
export { createCapabilityRequestView, portKey, createCapabilityServices } from "./services.ts";
export type { PortKey, CapabilityServices } from "./services.ts";
export { TASK_TRACKING_PORT } from "./task-tracking-port.ts";
export type {
  SpawnGate,
  DelegateTaskAugmentation,
  TrackedTask,
  TaskTrackingPort,
  TaskTrackingProvider,
} from "./task-tracking-port.ts";
export { TOOL_EFFECT_PORT } from "./tool-effect.ts";
export type { ToolEffect, ToolEffectPort } from "./tool-effect.ts";
export {
  capabilitiesForScope,
  systemSectionsFor,
  activationForScope,
  foldContributions,
} from "./compose.ts";
export type { FoldedContributions } from "./compose.ts";
export { requestParamKeys } from "./settings-spec.ts";
export type {
  SettingsScopeOrigin,
  SettingsValueScope,
  SettingsMergeStrategy,
  CapabilitySettingsSpec,
} from "./settings-spec.ts";
export { createCapabilityRegistry, composeCapabilityRegistry } from "./registry.ts";
export type { CapabilityRegistry, CapabilityRegistrySeed } from "./registry.ts";
export { createComputeClock } from "./compute-clock.ts";
export type { ComputeClock, ComputeRegion, ClockHolder } from "./compute-clock.ts";
export type {
  ToolArgValidate,
  AgentRunState,
  AgentBuildContext,
  HandlerVerdict,
  ToolHandler,
  FinalizeAttempt,
  GateOutcome,
  FinalizeGate,
  OrchestrationHooks,
} from "./loop-contract.ts";
export { handlerBaseOf } from "./handler-base.ts";
export type { HandlerBase } from "./handler-base.ts";
export {
  HOOKS_CAPABILITY_NAME,
  GATE_HOOK_EVENTS,
  OBSERVER_HOOK_EVENTS,
  COMPACTION_HOOK_EVENTS,
  CONTEXT_HOOK_EVENTS,
  PROMPT_HOOK_EVENTS,
  HOOK_DEFAULT_TIMEOUT_MS,
  MAX_HOOKS_PER_SOURCE,
  MAX_HOOKS_PER_RUN,
  MAX_HOOK_COMMAND_CHARS,
  MAX_HOOK_MATCH_PATTERNS,
  MAX_HOOK_PATTERN_CHARS,
  MAX_HOOK_TIMEOUT_MS,
  EXTERNAL_HOOK_EVENT_NAMES,
  EXTERNAL_TOOL_NAMES,
  EXTERNAL_HOOK_TOOL_NAMES,
  EXTERNAL_TOOLS_WITHOUT_COUNTERPART,
  normalizeToolName,
  MCP_HOOK_TOOL_PORT,
  hookSchema,
} from "./hooks-config.ts";
export type { HookConfig, McpHookToolPort } from "./hooks-config.ts";
export { openCallEnvelope } from "./call-envelope.ts";
export type { CallEnvelopeArgs, CallEnvelope } from "./call-envelope.ts";
export { memoizeByOwner, sharedFallback } from "./per-owner.ts";

export type { CompactionAnchor } from "./compaction-anchor.ts";
export type { AgentResult, AgentErrorCode, BuiltinAgentErrorCode } from "./agent-result.ts";
export { BUILTIN_AGENT_ERROR_CODES, partialStructOf } from "./agent-result.ts";
export type { ConvergenceGuards, GuardTrip, GuardWarning } from "./convergence-guards.ts";
export type { ContextPort, TracePort, Logger, LogFn } from "./ports.ts";
export type { LogLevel, Sampler, RateLimiterOptions } from "./log.ts";
export {
  LOG_LEVELS,
  DEFAULT_LOG_LEVEL,
  NOOP_LOGGER,
  isLogLevel,
  levelEnabled,
  bind,
  parseLogScopes,
  levelFor,
  createSampler,
  createRateLimiter,
  componentLogger,
  bindLevelled,
  activeLevelOf,
} from "./log.ts";

export {
  CodedError,
  ValidationError,
  ConflictError,
  PersistenceError,
  ContinuationUnavailableError,
  executionIdConflict,
} from "./errors.ts";
export { unref } from "./unref.ts";
export {
  sanitizeErrorMessage,
  sanitizeToolPayload,
  sanitizeText,
  sanitizeDeep,
} from "./sanitize.ts";
export { contentToText } from "./message-content.ts";
export { TASK_TITLE_MAX, parseTaskTitle } from "./task-title.ts";
export type { TaskTitleParseResult } from "./task-title.ts";
export { DELEGATE_TASK_MAX_CHARS, parseDelegateTaskText } from "./delegate-task.ts";
export type { DelegateTaskTextParseResult } from "./delegate-task.ts";
export { parseModelRef } from "./model-ref.ts";
export type { ModelRef } from "./model-ref.ts";
export { FORBIDDEN_PROVIDER_BODY_KEYS, resolveProvider } from "./provider-resolver.ts";
export type { ProviderResolution } from "./provider-resolver.ts";
export { reasoningOutputFloor } from "./reasoning-budget.ts";
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
  AssistantReasoningPart,
  AssistantMessagePhase,
  AssistantTextPart,
  LiveMessage,
  ToolTransport,
  AgentRole,
  McpOAuthConfig,
  McpServerConfig,
  ProviderKind,
  PromptCacheMode,
  ModelConfig,
  ProviderConfig,
  BudgetMode,
  BudgetConfig,
  BuiltinGrant,
  Grant,
  ReasoningSummary,
  ReasoningEffort,
  CompactionConfigInput,
  RetryConfigInput,
  OrchestrationConfigInput,
  AgentProfile,
  PromptCacheTtl,
  RunRequest,
  AgentsParam,
  GuardMode,
  GuardJudgeConfig,
  HandlerResult,
  GateVerdict,
  HookVerdict,
  BeforeToolUseContext,
  AfterToolUseContext,
  PreFinalizeContext,
  PreDelegateTaskContext,
  RunStartContext,
  RunEndContext,
  SubagentStartContext,
  SubagentCompleteContext,
  PreCompactContext,
  PostCompactContext,
  CompactionContribution,
  ModelCallErrorContext,
  BudgetExhaustedContext,
  UserSteerContext,
  LifecycleHook,
} from "./api.ts";
export {
  BUILTIN_RUN_ENDED_REASONS,
  isBuiltinRunEndedReason,
  BUILTIN_ERROR_CODES,
  isBuiltinErrorCode,
} from "./run.ts";
export type {
  BuiltinRunEndedReason,
  RunEndedReason,
  ExecutionMode,
  PerAgentUsage,
  Usage,
  ResourceToolKind,
  Resolved,
  NamespacedRegistry,
  BuiltinErrorCode,
  ErrorCode,
  FailureKind,
  ProviderErrorDetails,
  ErrorBody,
  StructuredResult,
  ResultValue,
  RunResponse,
  WireRunResponse,
  ResolvedConfig,
  MutableUsage,
  MCPStatus,
  ToolResult,
  MCPConnection,
  NamespacedTool,
  ContextSnapshotEntry,
  RunContinuation,
} from "./run.ts";
export type { TokenCounts, TokenAccumulator, SubagentAggregate } from "./usage.ts";
export { EXECUTION_STATUSES } from "./execution-status.ts";
export type { ExecutionStatus } from "./execution-status.ts";
export { ProviderError } from "./llm-port.ts";
export type {
  LLMToolCall,
  LLMUsage,
  LLMCallResult,
  ToolChoice,
  ResolvedProviderConfig,
  RetryInfo,
  LLMCallParams,
  LLMProvider,
  ProviderErrorInit,
} from "./llm-port.ts";
export {
  MALFORMED_ARGUMENTS_PREVIEW_CHARS,
  normalizeToolArguments,
  malformedArgumentsMessage,
} from "./tool-arguments.ts";
export type { NormalizedToolArguments } from "./tool-arguments.ts";
export { ElicitTimeoutError, PLAN_REVIEW_ELICIT_KIND, elicitWithClockPause } from "./elicit.ts";
export type {
  ElicitationAction,
  ElicitationOutcome,
  ElicitRequestedSchema,
  ElicitParams,
  ElicitRawResult,
  Elicit,
} from "./elicit.ts";
export type {
  AgentKind,
  AgentStatus,
  SettledStatus,
  WaitingOn,
  AgentControl,
  AgentRegistration,
  AgentSettlement,
  AgentHandle,
  AgentRegistryPort,
} from "./agents-port.ts";
export { DEFAULT_PENDING_TASK_NUDGES, boolFromEnv, envSchema, loadEnv } from "./env.ts";
export type { EnvConfig } from "./env.ts";
export { envRefPattern, extractEnvRefs } from "./env-ref.ts";
export {
  MissingEnvVarsError,
  interpolateEnvWith,
  resolveStringMapWith,
  resolveStringMap,
} from "./env-interpolate.ts";
export { splitFrontmatterFence } from "./frontmatter-fence.ts";
export type { FrontmatterFence } from "./frontmatter-fence.ts";
export { escapeRegExp, globToRegExp } from "./glob.ts";
export { createSemaphore } from "./semaphore.ts";
export type { Semaphore } from "./semaphore.ts";
export {
  DEFAULT_MAX_ACTIVE_EXTENSION_CALLS,
  DEFAULT_MAX_ACTIVE_EXTENSION_RUN_END_CALLS,
  DEFAULT_MAX_ACTIVE_EXTENSION_CALLS_PER_OPERATION,
  ExtensionAdmissionController,
  ExtensionCallUnavailableError,
  createExtensionAdmissionController,
} from "./extension-admission.ts";
export type {
  ExtensionCallClass,
  ExtensionCallUnavailableReason,
  ExtensionAdmissionSnapshot,
  ExtensionAdmissionOptions,
} from "./extension-admission.ts";
export { bestEffort, detachObserved, suppressSecondaryRejection } from "./tasks.ts";
export type { TaskFailure, TaskObservation } from "./tasks.ts";
export {
  BUILTIN_TRACE_KINDS,
  isBuiltinTraceEntry,
  isBuiltinTraceKind,
  BUILTIN_TRACE_EVENT_TYPES,
  isBuiltinTraceEvent,
  createPersistedTraceProjectorRegistry,
  composePersistedTraceProjectors,
} from "./trace.ts";
export type {
  BuiltinTraceKind,
  TraceKind,
  LeadIterationDetail,
  SubagentIterationDetail,
  ToolCallDetail,
  CommandGuardReview,
  ToolCallStartedDetail,
  ToolOutputDeltaDetail,
  ToolInputDeltaDetail,
  SubagentIterationStartedDetail,
  LeadIterationStartedDetail,
  DelegationCreatedDetail,
  DelegationFinishedDetail,
  BudgetCheckDetail,
  CancellationDetail,
  CompactionDetail,
  CompactionSkippedDetail,
  UserQuestionDetail,
  UserSteeringDetail,
  SoftLimitCheckDetail,
  PlanReviewDetail,
  TaskNudgeDetail,
  RunStartedDetail,
  RunEndedDetail,
  DelegationStartedDetail,
  ModelCallErrorDetail,
  ModelCallRetryDetail,
  ConvergenceWarningDetail,
  GuardEscalationDetail,
  ModelReasoningDetail,
  ModelStreamDeltaDetail,
  McpDegradedDetail,
  ElicitationRequestedDetail,
  AgentRegisteredDetail,
  AgentStoppedDetail,
  AgentSteeredDetail,
  AgentFinishNudgeDetail,
  TraceDetailMap,
  TraceDetailFor,
  BuiltinTraceEntry,
  TraceEntry,
  RecordingTrace,
  Trace,
  TraceEvent,
  BuiltinTraceEvent,
  ContributedTraceEvent,
  PersistedContributedTraceEvent,
  ExecutionRecord,
  ExecutionRecovery,
  PersistedTraceProjection,
  PersistedTraceProjectorContext,
  PersistedTraceProjector,
  PersistedTraceProjectorRegistry,
} from "./trace.ts";
export {
  CAPABILITY_EXECUTABLE_PROTOCOL_VERSION,
  capabilityExecutablePlatformSchema,
  capabilityExecutableDeclarationSchema,
  capabilityExecutablesSchema,
  resolveCapabilityExecutable,
  CapabilityExecutableRpcError,
} from "./capability-executables.ts";
export type {
  CapabilityExecutablePlatform,
  CapabilityExecutableDeclaration,
  EffectiveCapabilityExecutable,
  CapabilityExecutableInitialization,
  CapabilityExecutableSession,
  CapabilityExecutableSessionInput,
  CapabilityExecutablePort,
} from "./capability-executables.ts";
export {
  capabilitySkillPlansModeSchema,
  capabilityRunPoliciesSchema,
} from "./capability-run-policies.ts";
export type { CapabilityRunPolicies, CapabilitySkillPlansMode } from "./capability-run-policies.ts";
