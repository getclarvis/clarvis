/** File-backed kernel bootstrap and stdio hosting. */
export { createFileKernel } from "./file-kernel.ts";
export type { CreateFileKernelOptions, EnvironmentDriftNotice } from "./file-kernel.ts";
export type { EnvironmentSkillDriftNotice } from "./environments/environment-manager.ts";
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
