import { executableOnPath } from "@clarvis/paths";
import { createNodePodmanControl } from "../adapters/process/node-podman-control.ts";
import { createRuntimeAuthorityRouter } from "./isolated-run-executor.ts";
import type { RuntimeHost, RuntimeHostInput } from "./lazy-runtime.ts";
import {
  createLocalContainerRuntime,
  type LocalContainerRuntimeOptions,
} from "./local-container-runtime.ts";
import { createPodmanRuntimeBackend, type PodmanControl } from "./podman-backend.ts";
import { initializationControl } from "./initialization-control.ts";
import { resolveContainerImageDigest, type RuntimeImageSelection } from "./runtime-image.ts";
import type { ResolvedContainerRuntimeSettings } from "./settings.ts";
import { RuntimeLaunchError } from "./types.ts";

/** Podman-specific process port over the shared container authority composition. */
export interface LocalPodmanRuntimeOptions extends LocalContainerRuntimeOptions {
  readonly control?: PodmanControl;
  /** Resolves the image only when settings omit an advanced immutable image id. */
  readonly resolveImage?: (signal?: AbortSignal) => Promise<RuntimeImageSelection>;
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
  const executable =
    input.settings.executable ??
    (options.control === undefined ? executableOnPath("podman") : "/injected/podman");
  if (executable === undefined) {
    throw new RuntimeLaunchError("engine_missing", "Podman is not installed or is not on PATH");
  }
  const connection = input.settings.connection ?? "local";
  const control =
    options.control ??
    createNodePodmanControl({
      executable,
      connection,
      environment,
    });
  const imageDigest = await resolveContainerImageDigest({
    configured: input.settings.image_digest,
    control: initializationControl(control, input.signal),
    resolveImage: options.resolveImage,
    engine: "Podman",
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const resolvedSettings: ResolvedContainerRuntimeSettings = {
    ...input.settings,
    image_digest: imageDigest,
    executable,
    connection,
  };
  const backend = createPodmanRuntimeBackend({
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    control,
    handlers: router.handlers,
  });
  return createLocalContainerRuntime(
    { ...input, settings: resolvedSettings },
    backend,
    router,
    options,
  );
}
