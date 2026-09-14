import { createContainerKernelBackend } from "./container-kernel-backend.ts";
import type { ContainerControl, ContainerKernelBackend } from "./types.ts";

export type {
  ContainerCommandResult as DockerCommandResult,
  ContainerAttachedProcess as DockerAttachedProcess,
  ContainerControl as DockerControl,
  ContainerRunOptions as DockerRunOptions,
} from "./types.ts";

/** Docker adapter for one complete Container Kernel connection. */
export function createDockerKernelBackend(options: {
  readonly control: ContainerControl;
  readonly hostPlatform?: NodeJS.Platform;
  readonly signal?: AbortSignal;
}): ContainerKernelBackend {
  return createContainerKernelBackend({ engine: "docker", ...options });
}
