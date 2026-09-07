/** Public entry for the in-process kernel, its services, and transports. */
export { createInProcessKernel, DEFAULT_KERNEL_CAPABILITIES } from "./kernel.ts";
export { createAuditLogger, createComponentLoggers } from "./component-loggers.ts";
export type { ComponentLoggers } from "./component-loggers.ts";
export type { InProcessKernel, OwnerScopedKernel, CreateKernelOptions } from "./kernel.ts";
export type { ConnectionEvent, ConnectionEventSink } from "./connection-health.ts";

export { assertRuntimeLaunchSpec } from "./runtime/launch-policy.ts";
export { RUNTIME_PROTOCOL_LABEL, RUNTIME_PROTOCOL_REVISION } from "./runtime/protocol-revision.ts";
export { createRuntimeSupervisor } from "./runtime/supervisor.ts";
export type { RuntimeSupervisor } from "./runtime/supervisor.ts";
export {
  RuntimeLaunchError,
  type RuntimeAvailability,
  type RuntimeBackend,
  type RuntimeInfo,
  type RuntimeKind,
  type RuntimeLaunchSpec,
  type RuntimeLifecycleState,
  type RuntimeLimits,
  type RuntimeNetworkMode,
  type RuntimePortPreview,
  type RuntimePreviewProtocol,
  type RuntimeSession,
  type RuntimeUnavailableReason,
} from "./runtime/types.ts";
export {
  createExecutionPeer,
  decodeExecutionFrame,
  GUEST_EXECUTION_METHODS,
  HOST_EXECUTION_METHODS,
  MAX_EXECUTION_FRAME_BYTES,
  MAX_EXECUTION_QUEUE_BYTES,
  MAX_EXECUTION_QUEUE_FRAMES,
  type ExecutionIdentity,
  type ExecutionMethod,
  type ExecutionPeer,
  type ExecutionPeerRole,
  type ExecutionRequest,
  type ExecutionRequestHandler,
  type GuestExecutionMethod,
  type HostExecutionMethod,
} from "./runtime/execution-rpc.ts";
export {
  createCapabilityBroker,
  createModelBroker,
  type BrokerIdentity,
  type CapabilityBroker,
  type GuestCapabilityRequest,
  type GuestModelRequest,
  type HostCapabilityGrant,
  type HostModelExecutor,
  type HostModelResult,
  type ModelBroker,
  type ModelBrokerLease,
} from "./runtime/authority-brokers.ts";
export {
  createPodmanRuntimeBackend,
  type PodmanAttachedProcess,
  type PodmanBackendOptions,
  type PodmanCommandResult,
  type PodmanControl,
} from "./runtime/podman-backend.ts";
export {
  createDockerRuntimeBackend,
  type DockerAttachedProcess,
  type DockerBackendOptions,
  type DockerCommandResult,
  type DockerControl,
  type DockerRunOptions,
} from "./runtime/docker-backend.ts";
export {
  appendRuntimeCheckpoint,
  loadRuntimeCheckpoint,
  settleRuntimeTerminal,
  RuntimeCheckpointError,
  type RuntimeCheckpoint,
  type RuntimeCheckpointInput,
  type RuntimeSettlementParticipant,
} from "./runtime/runtime-checkpoints.ts";
export {
  serveExecutionWorker,
  type GuestExecutionBridge,
  type GuestRunExecutor,
} from "./runtime/execution-worker.ts";
export {
  createRuntimeHostHandlers,
  type RuntimeHostBridgeOptions,
} from "./runtime/host-execution-bridge.ts";
export {
  runtimeSettingsSchema,
  runtimeSettingsSpec,
  type RuntimeSettingsBlock,
  type RuntimeSettingsInput,
} from "./runtime/settings.ts";
export {
  createIsolatedRunExecutor,
  createRuntimeAuthorityRouter,
  type RuntimeAuthorityRouter,
} from "./runtime/isolated-run-executor.ts";
export {
  launchIsolatedRuntime,
  type IsolatedRuntimeController,
} from "./runtime/runtime-controller.ts";
export { createGuestLoopExecutor } from "./runtime/guest-loop-executor.ts";

export { createRunService } from "./runs/run-service.ts";
export type { RunExecutor, RunServiceConfig, RunRequestAssembler } from "./runs/run-service.ts";
export { createMemoryService } from "./memory/memory-service.ts";
export type { MemoryServiceConfig } from "./memory/memory-service.ts";
export { createPlansService } from "./plans/plans-service.ts";
export { createSkillsService } from "./skills/skills-service.ts";
export type { SkillsServiceConfig } from "./skills/skills-service.ts";
export {
  createExtensionProfileManager,
  extensionProfileId,
  type ExtensionProfileManagerOptions,
  type ExtensionProfileRuntimeBinding,
} from "./extension-profiles/extension-profile-manager.ts";
export {
  createWorkflowsService,
  type WorkflowsServiceConfig,
  type WorkflowsRuntimeSettings,
} from "./workflows/workflows-service.ts";
export {
  createWorkflowStore,
  type WorkflowStore,
  type WorkflowRecord,
  type WorkflowEdge,
} from "./workflows/workflow-store.ts";
export { createFileSecretStore, createSecretService } from "./secrets/secret-store.ts";
export type {
  SecretStore,
  SecretSnapshot,
  FileSecretStoreOptions,
} from "./secrets/secret-store.ts";

export { KernelException, kernelError, toKernelError } from "./core/errors.ts";
export { createKernelLifecycle } from "./application/lifecycle.ts";
export type {
  KernelLifecycle,
  KernelLifecycleState,
  KernelResource,
} from "./application/lifecycle.ts";
export { createKernelScopePolicy } from "./application/scope-policy.ts";
export type {
  KernelDataScope,
  KernelOwnershipMode,
  KernelScopePolicy,
  OperatorServices,
  OwnerServices,
  OwnerScope,
} from "./application/scope-policy.ts";
export { createAgentWorkflowPolicy } from "./application/workflow-policy.ts";
export type { AgentWorkflowPolicy } from "./application/workflow-policy.ts";

export { createManagedRun } from "./runs/managed-run.ts";
export type { ManagedRunContext, ManagedRunSpec } from "./runs/managed-run.ts";
export { createSettingsRunAssembler } from "./runs/settings-assembler.ts";
export type { SettingsAssemblerOptions } from "./runs/settings-assembler.ts";

export { createKernelServer } from "./transport/server.ts";
export type {
  KernelServer,
  KernelConnection,
  KernelServerOptions,
  KernelAuthorizationContext,
  KernelConnectionContext,
  NotificationSender,
  TransportDisconnect,
} from "./transport/server.ts";
export { connectKernelClient } from "./transport/client.ts";
export type { RemoteKernel, ConnectKernelClientOptions } from "./transport/client.ts";
export { createLoopbackTransport } from "./transport/loopback.ts";
export { createStdioTransport, serveKernelOverStdio } from "./transport/stdio.ts";
export { M as WIRE_METHODS, N as WIRE_NOTIFICATIONS } from "./transport/wire.ts";
export {
  OPERATIONS as KERNEL_OPERATIONS,
  SPECIAL_OPERATIONS,
  KNOWN_METHODS,
} from "./transport/operations.ts";
export type {
  KernelOperation,
  KernelOperationMetadata,
  KernelServices,
} from "./transport/operations.ts";
