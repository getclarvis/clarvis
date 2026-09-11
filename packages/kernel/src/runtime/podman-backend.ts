import {
  containerMountField,
  guestWorkspacePath,
  noContainerCapabilities,
  readContainerInspection,
  validContainerPolicy,
} from "./container-policy.ts";
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
import {
  miseCacheIdentity,
  prepareMiseCache,
  prepareCacheOwnership,
  type MiseCacheIdentity,
} from "./container-mise-cache.ts";

import type {
  ContainerControl as PodmanControl,
  ContainerCommandResult as PodmanCommandResult,
} from "./types.ts";
export type {
  ContainerCommandResult as PodmanCommandResult,
  ContainerAttachedProcess as PodmanAttachedProcess,
  ContainerControl as PodmanControl,
} from "./types.ts";

export interface PodmanBackendOptions {
  readonly control: PodmanControl;
  readonly handlers?: Readonly<Partial<Record<GuestExecutionMethod, ExecutionRequestHandler>>>;
  readonly logger?: Logger;
  readonly hostPlatform?: NodeJS.Platform;
  readonly stopTimeoutSeconds?: number;
  /** Cancels generation initialization without supplying a caller run signal. */
  readonly signal?: AbortSignal;
  readonly bootstrapTimeoutMs?: number;
}

interface PodmanInfo {
  readonly version: string;
  readonly rootless: boolean;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new RuntimeLaunchError("operational_failure", `${label} returned invalid JSON`, {
      cause,
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function inspectInfo(value: unknown): PodmanInfo | undefined {
  const root = asRecord(value);
  const host = asRecord(root?.host);
  const security = asRecord(host?.security);
  const version = asRecord(root?.version);
  const versionText = version?.Version ?? version?.version;
  return typeof versionText === "string" && security?.rootless === true
    ? { version: versionText, rootless: true }
    : undefined;
}

function containerName(generation: string): string {
  return `clarvis-runtime-${generation.toLowerCase().replace(/[^a-z0-9_.-]/gu, "-")}`;
}

function networkArgs(spec: RuntimeLaunchSpec): readonly string[] {
  if (spec.network === "none") return ["--network", "none"];
  if (spec.network === "outbound") return ["--network", "bridge"];
  throw new RuntimeLaunchError(
    "unsupported_policy",
    "internet-only egress enforcement is unavailable for the Podman adapter",
  );
}
function bindMountArgs(spec: RuntimeLaunchSpec): readonly string[] {
  return [
    "--mount",
    `type=bind,${containerMountField("source", spec.workspaceRoot)},target=/workspace,rw=true,relabel=shared`,
    ...spec.readOnlyWorkspacePaths.flatMap((path) => [
      "--mount",
      `type=bind,${containerMountField("source", path)},${containerMountField("target", guestWorkspacePath(spec, path))},ro=true,relabel=shared`,
    ]),
    ...(spec.gitCommonDir === undefined
      ? []
      : [
          "--mount",
          `type=bind,${containerMountField("source", spec.gitCommonDir)},${containerMountField("target", spec.gitCommonDir)},rw=true,relabel=shared`,
        ]),
  ];
}

function createArgs(
  spec: RuntimeLaunchSpec,
  name: string,
  cache: MiseCacheIdentity,
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
    "0:0",
    "--userns=host",
    "--read-only",
    "--read-only-tmpfs=false",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(spec.limits.processCount),
    "--memory",
    String(spec.limits.memoryBytes),
    "--cpus",
    String(spec.limits.cpuCount),
    ...networkArgs(spec),
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,noexec,size=${String(spec.limits.storageBytes)}`,
    "--mount",
    `type=volume,source=${cache.name},target=/mise,subpath=data`,
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

function validEffectiveInspect(
  value: unknown,
  spec: RuntimeLaunchSpec,
  cache: MiseCacheIdentity,
): boolean {
  const inspection = readContainerInspection(value);
  if (inspection === undefined) return false;
  const { root, host, config, policy } = inspection;
  return validContainerPolicy(
    {
      ...policy,
      identityAccepted:
        config.User === "0:0" && (host.UsernsMode === "" || host.UsernsMode === "host"),
      capabilitiesCleared:
        noContainerCapabilities(root.EffectiveCaps) &&
        noContainerCapabilities(root.BoundingCaps) &&
        noContainerCapabilities(host.CapAdd),
      cacheLayoutAccepted:
        policy.mounts.find((mount) => mount.Destination === "/mise")?.SubPath === "data",
    },
    spec,
    cache,
  );
}
function validImageInspect(value: unknown, imageDigest: string): boolean {
  const root = Array.isArray(value) ? asRecord(value[0]) : asRecord(value);
  const config = asRecord(root?.Config);
  const labels = asRecord(config?.Labels);
  const id = root?.Id;
  const canonicalId = typeof id === "string" && /^[a-f0-9]{64}$/u.test(id) ? `sha256:${id}` : id;
  return (
    canonicalId === imageDigest && labels?.[RUNTIME_PROTOCOL_LABEL] === RUNTIME_PROTOCOL_REVISION
  );
}

async function successful(
  control: PodmanControl,
  args: readonly string[],
  label: string,
): Promise<PodmanCommandResult> {
  const result = await control.run(args);
  if (result.exitCode !== 0) {
    throw new RuntimeLaunchError("operational_failure", `${label} failed`);
  }
  return result;
}

/** Create the strict rootless Podman reference backend. */
export function createPodmanRuntimeBackend(options: PodmanBackendOptions): RuntimeBackend {
  let inspected: PodmanInfo | undefined;
  const control = initializationControl(options.control, options.signal);
  return {
    async inspect(): Promise<RuntimeAvailability> {
      if ((options.hostPlatform ?? process.platform) === "win32") {
        return {
          available: false,
          reason: "unsupported_platform",
          message: "Podman isolated execution is not qualified on Windows",
        };
      }
      let result: PodmanCommandResult;
      try {
        result = await control.run(["info", "--format", "json"]);
      } catch {
        options.signal?.throwIfAborted();
        return { available: false, reason: "engine_missing", message: "Podman is unavailable" };
      }
      if (result.exitCode !== 0) {
        return { available: false, reason: "engine_stopped", message: "Podman is not ready" };
      }
      inspected = inspectInfo(parseJson(result.stdout, "podman info"));
      if (inspected === undefined) {
        return {
          available: false,
          reason: "unsupported_policy",
          message: "the selected Podman connection is not verified rootless",
        };
      }
      return { available: true, engineVersion: inspected.version, rootless: true };
    },
    async start(spec): Promise<RuntimeSession> {
      if (inspected === undefined) {
        throw new RuntimeLaunchError(
          "operational_failure",
          "Podman must be inspected before start",
        );
      }
      const name = containerName(spec.generation);
      const cache = miseCacheIdentity(spec, "0:0");
      let created = false;
      let createAttempted = false;
      try {
        const image = await successful(
          control,
          ["image", "inspect", spec.imageDigest],
          "podman image inspect",
        );
        if (!validImageInspect(parseJson(image.stdout, "podman image inspect"), spec.imageDigest)) {
          throw new RuntimeLaunchError(
            "handshake_mismatch",
            "Podman resolved image identity did not match the admitted digest",
          );
        }
        await prepareMiseCache(control, cache, "podman");
        await prepareCacheOwnership(control, spec, cache, "0:0", "podman");
        options.signal?.throwIfAborted();
        const arguments_ = createArgs(spec, name, cache);
        createAttempted = true;
        await successful(control, arguments_, "podman create");
        created = true;
        const effective = await successful(
          control,
          ["container", "inspect", name],
          "podman container inspect",
        );
        if (
          !validEffectiveInspect(
            parseJson(effective.stdout, "podman container inspect"),
            spec,
            cache,
          )
        ) {
          throw new RuntimeLaunchError(
            "unsupported_policy",
            "Podman effective configuration did not match the admitted isolation policy",
          );
        }
        return await connectContainerSession(
          {
            ...options,
            engine: "podman",
            engineVersion: inspected.version,
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
