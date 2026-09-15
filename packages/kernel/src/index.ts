/** Public entry for the in-process kernel, its services, and transports. */
export { createInProcessKernel, DEFAULT_KERNEL_CAPABILITIES } from "./kernel.ts";
export { createAuditLogger, createComponentLoggers } from "./component-loggers.ts";
export type { ComponentLoggers } from "./component-loggers.ts";
export type { InProcessKernel, OwnerScopedKernel, CreateKernelOptions } from "./kernel.ts";
export type { PreparedKernelRun } from "./runs/prepare-run.ts";
export type { KernelRunService, PreparedRunExecution } from "./runs/run-service.ts";
export type { ConnectionEvent, ConnectionEventSink } from "./connection-health.ts";

export {
  RuntimeLaunchError,
  type RuntimeAvailability,
  type RuntimeKind,
  type RuntimeLifecycleState,
  type RuntimeLimits,
  type RuntimeNetworkMode,
  type RuntimeProtectedMount,
  type RuntimeUnavailableReason,
  type ContainerKernelBackend,
  type ContainerKernelLaunchSpec,
  type ContainerProcessLifecycle,
} from "./runtime/types.ts";
export {
  createPodmanKernelBackend,
  type PodmanAttachedProcess,
  type PodmanCommandResult,
  type PodmanControl,
} from "./runtime/podman-backend.ts";
export {
  createDockerKernelBackend,
  type DockerAttachedProcess,
  type DockerCommandResult,
  type DockerControl,
  type DockerRunOptions,
} from "./runtime/docker-backend.ts";
export {
  runtimeSettingsSchema,
  runtimeSettingsSpec,
  type RuntimeSettingsBlock,
  type RuntimeSettingsInput,
} from "./runtime/settings.ts";

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
export { readHostedSnapshot } from "./transport/hosted-snapshot.ts";
export type { RemoteKernel, ConnectKernelClientOptions } from "./transport/client.ts";
export { createLoopbackTransport } from "./transport/loopback.ts";
export { createStdioTransport, serveKernelOverStdio } from "./transport/stdio.ts";
export {
  connectLocalKernelTransport,
  listenLocalKernel,
  type LocalKernelListener,
  type LocalKernelListenerOptions,
} from "./transport/local.ts";
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
