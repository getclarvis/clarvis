import { createNodePodmanControl } from "../adapters/process/node-podman-control.ts";
import { createRuntimeAuthorityRouter } from "./isolated-run-executor.ts";
import type { RuntimeHost, RuntimeHostInput } from "./lazy-runtime.ts";
import {
  createLocalContainerRuntime,
  type LocalContainerRuntimeOptions,
} from "./local-container-runtime.ts";
import { createPodmanRuntimeBackend, type PodmanControl } from "./podman-backend.ts";

/** Podman-specific process port over the shared container authority composition. */
export interface LocalPodmanRuntimeOptions extends LocalContainerRuntimeOptions {
  readonly control?: PodmanControl;
}

/** Compose the concrete local Podman backend only after the host selected it. */
export async function createLocalPodmanRuntime(
  input: RuntimeHostInput,
  options: LocalPodmanRuntimeOptions = {},
): Promise<RuntimeHost> {
  if (input.settings.backend !== "podman") {
    throw new Error("Podman runtime composition requires backend: podman");
  }
  const router = createRuntimeAuthorityRouter(input.generation);
  const environment = Object.fromEntries(
    ["HOME", "PATH", "XDG_RUNTIME_DIR"].flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  const backend = createPodmanRuntimeBackend({
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    control:
      options.control ??
      createNodePodmanControl({
        executable: input.settings.executable,
        connection: input.settings.connection,
        environment,
      }),
    handlers: router.handlers,
  });
  return createLocalContainerRuntime(
    { ...input, settings: input.settings },
    backend,
    router,
    options,
  );
}
