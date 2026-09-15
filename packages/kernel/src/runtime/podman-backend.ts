import { createContainerKernelBackend } from "./container-kernel-backend.ts";
import type { ContainerControl, ContainerKernelBackend } from "./types.ts";

export type {
  ContainerCommandResult as PodmanCommandResult,
  ContainerAttachedProcess as PodmanAttachedProcess,
  ContainerControl as PodmanControl,
} from "./types.ts";

/** Podman adapter for one complete Container Kernel connection. */
export function createPodmanKernelBackend(options: {
  readonly control: ContainerControl;
  readonly hostPlatform?: NodeJS.Platform;
  readonly signal?: AbortSignal;
}): ContainerKernelBackend {
  return createContainerKernelBackend({ engine: "podman", ...options });
}
