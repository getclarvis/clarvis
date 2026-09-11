import {
  containerMountField,
  guestWorkspacePath,
  noContainerCapabilities,
  readContainerInspection,
  validContainerPolicy,
} from "./container-policy.ts";
import {
  miseCacheIdentity,
  prepareMiseCache,
  prepareCacheOwnership,
  type MiseCacheIdentity,
} from "./container-mise-cache.ts";
import type { Logger } from "@clarvis/capability";
import { type ExecutionRequestHandler, type GuestExecutionMethod } from "./execution-rpc.ts";
import {
  RuntimeLaunchError,
  type RuntimeAvailability,
  type RuntimeBackend,
  type RuntimeLaunchSpec,
  type RuntimeSession,
} from "./types.ts";
import { RUNTIME_PROTOCOL_LABEL, RUNTIME_PROTOCOL_REVISION } from "./protocol-revision.ts";
import { connectContainerSession, cleanupInterruptedContainerCreate } from "./container-session.ts";
import { initializationControl } from "./initialization-control.ts";

import type {
  ContainerControl as DockerControl,
  ContainerCommandResult as DockerCommandResult,
} from "./types.ts";
export type {
  ContainerCommandResult as DockerCommandResult,
  ContainerAttachedProcess as DockerAttachedProcess,
  ContainerControl as DockerControl,
  ContainerRunOptions as DockerRunOptions,
} from "./types.ts";

export interface DockerBackendOptions {
  readonly control: DockerControl;
  readonly handlers?: Readonly<Partial<Record<GuestExecutionMethod, ExecutionRequestHandler>>>;
  readonly logger?: Logger;
  readonly hostPlatform?: NodeJS.Platform;
  readonly stopTimeoutSeconds?: number;
  /** Cancels generation initialization without supplying a caller run signal. */
  readonly signal?: AbortSignal;
  readonly bootstrapTimeoutMs?: number;
  /** Numeric host identity seam; production inherits the invoking operator, never an image's USER. */
  readonly hostUser?: { readonly uid: number; readonly gid: number };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function parse(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new RuntimeLaunchError("operational_failure", `${label} returned invalid JSON`, {
      cause,
    });
  }
}
function nameFor(generation: string): string {
  return `clarvis-runtime-${generation.toLowerCase().replace(/[^a-z0-9_.-]/gu, "-")}`;
}
function network(spec: RuntimeLaunchSpec): string {
  if (spec.network === "none") return "none";
  if (spec.network === "outbound") return "bridge";
  throw new RuntimeLaunchError(
    "unsupported_policy",
    "internet-only egress enforcement is unavailable for the Docker adapter",
  );
}
function bindMountArgs(spec: RuntimeLaunchSpec): readonly string[] {
  return [
    "--mount",
    `type=bind,${containerMountField("source", spec.workspaceRoot)},target=/workspace`,
    ...spec.readOnlyWorkspacePaths.flatMap((path) => [
      "--mount",
      `type=bind,${containerMountField("source", path)},${containerMountField("target", guestWorkspacePath(spec, path))},readonly`,
    ]),
    ...(spec.gitCommonDir === undefined
      ? []
      : [
          "--mount",
          `type=bind,${containerMountField("source", spec.gitCommonDir)},${containerMountField("target", spec.gitCommonDir)}`,
        ]),
  ];
}
function createArgs(
  spec: RuntimeLaunchSpec,
  name: string,
  cache: MiseCacheIdentity,
  user: string,
): readonly string[] {
  return [
    "create",
    "--name",
    name,
    "--label",
    "io.clarvis.runtime=true",
    "--label",
    `io.clarvis.generation=${spec.generation}`,
    "--interactive",
    "--user",
    user,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges=true",
    "--pids-limit",
    String(spec.limits.processCount),
    "--memory",
    String(spec.limits.memoryBytes),
    "--cpus",
    String(spec.limits.cpuCount),
    "--network",
    network(spec),
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,noexec,size=${String(spec.limits.storageBytes)}`,
    "--mount",
    `type=volume,source=${cache.name},target=/mise,volume-subpath=data,volume-nocopy`,
    ...bindMountArgs(spec),
    "--workdir",
    "/workspace",
    "--env",
    `CLARVIS_RUNTIME_GENERATION=${spec.generation}`,
    "--env",
    `CLARVIS_RUNTIME_IMAGE_DIGEST=${spec.imageDigest}`,
    spec.imageDigest,
  ];
}
function validInspect(
  value: unknown,
  spec: RuntimeLaunchSpec,
  cache: MiseCacheIdentity,
  user: string,
): boolean {
  const inspection = readContainerInspection(value);
  if (inspection === undefined) return false;
  const { host, config, policy } = inspection;
  const configured = Array.isArray(host.Mounts) ? host.Mounts.map(record) : [];
  const cacheConfig = configured.find((mount) => mount?.Target === "/mise");
  const volume = record(cacheConfig?.VolumeOptions);
  return validContainerPolicy(
    {
      ...policy,
      identityAccepted: config.User === user,
      capabilitiesCleared:
        Array.isArray(host.CapDrop) &&
        host.CapDrop.some((cap) => typeof cap === "string" && cap.toLowerCase() === "all") &&
        noContainerCapabilities(host.CapAdd),
      cacheLayoutAccepted: volume?.Subpath === "data" && volume.NoCopy === true,
    },
    spec,
    cache,
  );
}
async function successful(
  control: DockerControl,
  args: readonly string[],
  label: string,
): Promise<DockerCommandResult> {
  const result = await control.run(args);
  if (result.exitCode !== 0) throw new RuntimeLaunchError("operational_failure", `${label} failed`);
  return result;
}

/** Create the strict Docker reference backend, suitable for Docker Desktop or Colima. */
export function createDockerRuntimeBackend(options: DockerBackendOptions): RuntimeBackend {
  let version: string | undefined;
  let rootless = false;
  const control = initializationControl(options.control, options.signal);
  return {
    async inspect(): Promise<RuntimeAvailability> {
      if ((options.hostPlatform ?? process.platform) === "win32")
        return {
          available: false,
          reason: "unsupported_platform",
          message: "Docker isolated execution is not qualified on Windows",
        };
      let result: DockerCommandResult;
      try {
        result = await control.run(["info", "--format", "{{json .}}"]);
      } catch {
        options.signal?.throwIfAborted();
        return { available: false, reason: "engine_missing", message: "Docker is unavailable" };
      }
      if (result.exitCode !== 0)
        return { available: false, reason: "engine_stopped", message: "Docker is not ready" };
      const info = record(parse(result.stdout, "docker info"));
      const candidate = info?.ServerVersion;
      const os = info?.OSType;
      if (typeof candidate !== "string" || os !== "linux")
        return {
          available: false,
          reason: "unsupported_policy",
          message: "the selected Docker context is not a Linux engine",
        };
      rootless =
        Array.isArray(info?.SecurityOptions) &&
        info.SecurityOptions.some((v) => String(v).includes("rootless"));
      if (
        !rootless &&
        Array.isArray(info?.SecurityOptions) &&
        info.SecurityOptions.some((value) => String(value).includes("userns"))
      ) {
        version = undefined;
        return {
          available: false,
          reason: "unsupported_policy",
          message: "Docker userns-remap cannot preserve the operator workspace identity",
        };
      }
      version = candidate;
      return { available: true, engineVersion: version, rootless };
    },
    async start(spec): Promise<RuntimeSession> {
      if (version === undefined)
        throw new RuntimeLaunchError(
          "operational_failure",
          "Docker must be inspected before start",
        );
      const name = nameFor(spec.generation);
      network(spec);
      const uid = rootless ? 0 : (options.hostUser?.uid ?? process.getuid?.());
      const gid = rootless ? 0 : (options.hostUser?.gid ?? process.getgid?.());
      if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid! < 0 || gid! < 0) {
        throw new RuntimeLaunchError(
          "unsupported_policy",
          "Docker requires an explicit compatible numeric UID and GID",
        );
      }
      const user = `${uid}:${gid}`;
      const cache = miseCacheIdentity(spec, user);
      let created = false;
      let createAttempted = false;
      try {
        const image = await successful(
          control,
          ["image", "inspect", spec.imageDigest],
          "docker image inspect",
        );
        const imageRoot = record(
          Array.isArray(parse(image.stdout, "docker image inspect"))
            ? (parse(image.stdout, "docker image inspect") as unknown[])[0]
            : parse(image.stdout, "docker image inspect"),
        );
        const imageConfig = record(imageRoot?.Config);
        const imageLabels = record(imageConfig?.Labels);
        if (
          imageRoot?.Id !== spec.imageDigest ||
          imageLabels?.[RUNTIME_PROTOCOL_LABEL] !== RUNTIME_PROTOCOL_REVISION
        )
          throw new RuntimeLaunchError(
            "handshake_mismatch",
            "Docker resolved image identity or runtime protocol did not match admission",
          );
        await prepareMiseCache(control, cache);
        await prepareCacheOwnership(control, spec, cache, user);
        options.signal?.throwIfAborted();
        const arguments_ = createArgs(spec, name, cache, user);
        createAttempted = true;
        await successful(control, arguments_, "docker create");
        created = true;
        const effective = await successful(
          control,
          ["container", "inspect", name],
          "docker container inspect",
        );
        if (!validInspect(parse(effective.stdout, "docker container inspect"), spec, cache, user))
          throw new RuntimeLaunchError(
            "unsupported_policy",
            "Docker effective configuration did not match the admitted isolation policy",
          );
        return await connectContainerSession(
          {
            ...options,
            engine: "docker",
            engineVersion: version,
          },
          spec,
          name,
        );
      } catch (error) {
        if (created) await options.control.run(["rm", "--force", name]).catch(() => undefined);
        else if (createAttempted) {
          try {
            await cleanupInterruptedContainerCreate(options.control, name, spec.generation);
          } catch (cleanup) {
            throw new AggregateError(
              [error, cleanup],
              "runtime initialization and cleanup failed",
              { cause: cleanup },
            );
          }
        }
        throw error;
      }
    },
  };
}
