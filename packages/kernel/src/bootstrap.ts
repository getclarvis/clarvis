/** File-backed kernel bootstrap and stdio hosting. */
export { createFileKernel } from "./file-kernel.ts";
export { createFileRunHost } from "./hosting/file-host.ts";
export type { FileRunHost, FileRunHostOptions } from "./hosting/file-host.ts";
export { serveLocalFileKernel } from "./hosting/serve-local.ts";
export type { ServeLocalFileKernelOptions, LocalFileKernelHost } from "./hosting/serve-local.ts";
export { serveRemoteFileKernelOverStdio } from "./hosting/serve-remote-stdio.ts";
export type {
  ServeRemoteStdioOptions,
  RemoteStdioFileKernelHost,
} from "./hosting/serve-remote-stdio.ts";
export { connectRemoteKernelOverSsh } from "./hosting/connect-remote-ssh.ts";
export type {
  ConnectedRemoteSshKernel,
  RemoteSshKernelOptions,
} from "./hosting/connect-remote-ssh.ts";
export { serveContainerKernel } from "./hosting/container-bootstrap.ts";
export { connectContainerKernel } from "./hosting/container-launcher.ts";
export { launchContainerKernel } from "./hosting/container-host-launcher.ts";
export { connectLocalContainerKernel } from "./hosting/connect-local-container.ts";
export type {
  ContainerConnectionPhase,
  ConnectLocalContainerKernelOptions,
  LocalContainerReleaseSelection,
} from "./hosting/connect-local-container.ts";
export type {
  LaunchContainerKernelOptions,
  LaunchedContainerKernel,
} from "./hosting/container-host-launcher.ts";
export type {
  ContainerKernelHost,
  ServeContainerKernelOptions,
} from "./hosting/container-bootstrap.ts";
export type {
  ConnectedContainerKernel,
  ConnectContainerKernelOptions,
} from "./hosting/container-launcher.ts";
export type { ContainerProcessLifecycle } from "./runtime/types.ts";
export { createContainerChannel } from "./hosting/container-channel.ts";
export { createOperatorServices } from "./config/operator-services.ts";
export type {
  OperatorServices,
  CreateOperatorServicesOptions,
} from "./config/operator-services.ts";
export { projectContainerHostConfiguration } from "./config/project-container-host.ts";
export { containerConfigurationDigest } from "./config/container-projection.ts";
export type { ContainerChannel, ContainerLogicalChannel } from "./hosting/container-channel.ts";
export {
  CONTAINER_BASE_ABI,
  CONTAINER_BOOT_TIMEOUT_MS,
  CONTAINER_BROKER_VERSION,
  CONTAINER_CHANNEL_VERSION,
  CONTAINER_PREPARATION_TIMEOUT_MS,
} from "./hosting/container-contract.ts";
export { connectOrLaunchLocalKernel, parseLocalHostArguments } from "./hosting/launcher.ts";
export type { LocalKernelLaunchOptions, ConnectedLocalKernel } from "./hosting/launcher.ts";
export type {
  FileKernel,
  CreateFileKernelOptions,
  ExtensionProfileDriftNotice,
  RuntimePlacementNotice,
} from "./file-kernel.ts";
export { SubscriptionManager } from "./subscriptions/manager.ts";
export { createOpenAICodexAdapter } from "./subscriptions/openai-codex.ts";
export type { ExtensionProfileSkillDriftNotice } from "./extension-profiles/extension-profile-manager.ts";
export { createOwnerScopedFileStores } from "./owner-scoped-file-stores.ts";
export type {
  CreateOwnerScopedFileStoresOptions,
  OwnerScopedFileStores,
} from "./owner-scoped-file-stores.ts";
export { serveFileKernelOverStdio } from "./serve.ts";
export type { ServeStdioOptions, ServeHandle } from "./serve.ts";
export { createLogger } from "@clarvis/loop/host";
export { loadEnv } from "@clarvis/capability";
export { ownerFromWorkspace } from "@clarvis/paths";
export type { ConnectionEvent, ConnectionEventSink } from "./connection-health.ts";
export type { Logger } from "@clarvis/capability";
export { createKernelEnvironment, resolveSecretEnvironment } from "./ports/environment.ts";
export type { KernelEnvironment, SecretEnvironmentSource } from "./ports/environment.ts";
