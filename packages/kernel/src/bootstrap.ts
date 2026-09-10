/** File-backed kernel bootstrap and stdio hosting. */
export { createFileKernel } from "./file-kernel.ts";
export { createFileRunHost } from "./hosting/file-host.ts";
export type { FileRunHost, FileRunHostOptions } from "./hosting/file-host.ts";
export { serveLocalFileKernel } from "./hosting/serve-local.ts";
export type { ServeLocalFileKernelOptions, LocalFileKernelHost } from "./hosting/serve-local.ts";
export { connectOrLaunchLocalKernel, parseLocalHostArguments } from "./hosting/launcher.ts";
export type { LocalKernelLaunchOptions, ConnectedLocalKernel } from "./hosting/launcher.ts";
export type {
  FileKernel,
  CreateFileKernelOptions,
  ExtensionProfileDriftNotice,
  FileKernelRuntimeFactory,
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
