import { executableOnPath } from "@clarvis/paths";
import { createNodeDockerControl } from "../adapters/process/node-docker-control.ts";
import { createNodeProcessRunner } from "../adapters/process/node-process-runner.ts";
import type { ProcessRunner, ProcessRunResult } from "../ports/process-runner.ts";
import { createDockerRuntimeBackend, type DockerControl } from "./docker-backend.ts";
import { createRuntimeAuthorityRouter } from "./isolated-run-executor.ts";
import type { RuntimeHost, RuntimeHostInput } from "./lazy-runtime.ts";
import {
  createLocalContainerRuntime,
  type LocalContainerRuntimeOptions,
} from "./local-podman-runtime.ts";
import type { ResolvedContainerRuntimeSettings } from "./settings.ts";
import { RuntimeLaunchError } from "./types.ts";

type LocalRuntimeInput = RuntimeHostInput;

/** A local development tag or release-manifest-pinned image reference. */
export interface RuntimeImageSelection {
  readonly reference: string;
  readonly pull: boolean;
}

/** Deterministic host-effect seams for local Docker composition tests. */
export interface LocalDockerRuntimeOptions extends LocalContainerRuntimeOptions {
  readonly control?: DockerControl;
  /** Resolves the image only when settings omit an advanced immutable image id. */
  readonly resolveImage?: () => Promise<RuntimeImageSelection>;
  /** Injectable context-discovery runner for deterministic tests. */
  readonly processRunner?: ProcessRunner;
}

const LOCAL_IMAGE = /^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9._-]+)?$/u;
const PINNED_IMAGE = /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/u;

function dockerEnvironment(): Readonly<Record<string, string>> {
  return Object.fromEntries(
    ["HOME", "PATH", "DOCKER_CONFIG", "DOCKER_CONTEXT"].flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

async function dockerConnection(
  executable: string,
  configured: string | undefined,
  environment: Readonly<Record<string, string>>,
  runner: ProcessRunner,
): Promise<string> {
  if (configured !== undefined) return configured;
  const selected = environment.DOCKER_CONTEXT?.trim();
  if (selected) return selected;
  let result: ProcessRunResult;
  try {
    result = await runner.run({
      command: executable,
      args: ["context", "show"],
      environment,
      timeoutMs: 10_000,
    });
  } catch (cause) {
    throw new RuntimeLaunchError("engine_missing", "Docker is unavailable", { cause });
  }
  const context = result.stdout.trim();
  if (result.exitCode !== 0 || context.length === 0 || /[\r\n\0]/u.test(context)) {
    throw new RuntimeLaunchError("operational_failure", "Docker context could not be resolved");
  }
  return context;
}

function imageId(source: string): string | undefined {
  try {
    const parsed = JSON.parse(source) as unknown;
    const item: unknown = Array.isArray(parsed) ? (parsed as unknown[])[0] : parsed;
    if (typeof item !== "object" || item === null) return undefined;
    const id = (item as { Id?: unknown }).Id;
    return typeof id === "string" && /^sha256:[a-f0-9]{64}$/u.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

async function resolveImageDigest(
  configured: string | undefined,
  control: DockerControl,
  resolveImage: LocalDockerRuntimeOptions["resolveImage"],
): Promise<string> {
  if (configured !== undefined) return configured;
  let selected: RuntimeImageSelection;
  try {
    selected =
      (await resolveImage?.()) ??
      ({ reference: "clarvis-runtime:development", pull: false } as const);
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "runtime_image_integrity"
    ) {
      throw new RuntimeLaunchError(
        "invalid_launch_spec",
        "Clarvis runtime image identity could not be verified",
        { cause },
      );
    }
    throw new RuntimeLaunchError(
      "operational_failure",
      "Clarvis runtime image could not be resolved",
      {
        cause,
      },
    );
  }
  if (
    (selected.pull && !PINNED_IMAGE.test(selected.reference)) ||
    (!selected.pull && !LOCAL_IMAGE.test(selected.reference))
  ) {
    throw new RuntimeLaunchError(
      "operational_failure",
      "Clarvis runtime image reference is invalid",
    );
  }
  if (selected.pull) {
    const pulled = await control.run(["pull", selected.reference]);
    if (pulled.exitCode !== 0) {
      throw new RuntimeLaunchError("operational_failure", "Clarvis runtime image download failed");
    }
  }
  const inspected = await control.run(["image", "inspect", selected.reference]);
  if (inspected.exitCode !== 0) {
    throw new RuntimeLaunchError("operational_failure", "Clarvis runtime image is not installed");
  }
  const digest = imageId(inspected.stdout);
  if (digest === undefined) {
    throw new RuntimeLaunchError(
      "operational_failure",
      "Docker returned an invalid runtime image id",
    );
  }
  return digest;
}

/** Compose the concrete Docker backend only after the host selected it. */
export async function createLocalDockerRuntime(
  input: LocalRuntimeInput,
  options: LocalDockerRuntimeOptions = {},
): Promise<RuntimeHost> {
  if (input.settings.backend !== "docker") {
    throw new Error("Docker runtime composition requires backend: docker");
  }
  const router = createRuntimeAuthorityRouter(input.generation);
  const environment = dockerEnvironment();
  const executable =
    input.settings.executable ??
    (options.control === undefined ? executableOnPath("docker") : "/injected/docker");
  if (executable === undefined) {
    throw new RuntimeLaunchError("engine_missing", "Docker is not installed or is not on PATH");
  }
  const connection =
    options.control === undefined
      ? await dockerConnection(
          executable,
          input.settings.connection,
          environment,
          options.processRunner ?? createNodeProcessRunner(),
        )
      : (input.settings.connection ?? "injected");
  const control =
    options.control ??
    createNodeDockerControl({
      executable,
      context: connection,
      environment,
    });
  const imageDigest = await resolveImageDigest(
    input.settings.image_digest,
    control,
    options.resolveImage,
  );
  const resolvedSettings: ResolvedContainerRuntimeSettings = {
    ...input.settings,
    image_digest: imageDigest,
    executable,
    connection,
  };
  const resolvedInput = { ...input, settings: resolvedSettings };
  const backend = createDockerRuntimeBackend({
    control,
    handlers: router.handlers,
  });
  return createLocalContainerRuntime(resolvedInput, backend, router, options);
}
