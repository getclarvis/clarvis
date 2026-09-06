import type { Readable, Writable } from "node:stream";
import { NOOP_LOGGER, type Logger } from "@clarvis/capability";

import {
  createExecutionPeer,
  type ExecutionRequestHandler,
  type GuestExecutionMethod,
} from "./execution-rpc.ts";
import {
  RuntimeLaunchError,
  type RuntimeAvailability,
  type RuntimeBackend,
  type RuntimeInfo,
  type RuntimeLaunchSpec,
  type RuntimeSession,
} from "./types.ts";
import { RUNTIME_PROTOCOL_LABEL, RUNTIME_PROTOCOL_REVISION } from "./protocol-revision.ts";
import { createContainerRuntimePortPreview } from "./port-preview.ts";

/** Captured, bounded result of one Podman control-plane invocation. */
export interface PodmanCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Attached container process carrying only private RPC on stdin/stdout. */
export interface PodmanAttachedProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<number | null>;
  kill(signal: NodeJS.Signals): void;
}

/** Effect port used by the policy adapter and deterministic conformance tests. */
export interface PodmanControl {
  run(args: readonly string[], signal?: AbortSignal): Promise<PodmanCommandResult>;
  attach(args: readonly string[]): PodmanAttachedProcess;
}

export interface PodmanBackendOptions {
  readonly control: PodmanControl;
  readonly handlers?: Readonly<Partial<Record<GuestExecutionMethod, ExecutionRequestHandler>>>;
  readonly logger?: Logger;
  readonly hostPlatform?: NodeJS.Platform;
  readonly stopTimeoutSeconds?: number;
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
  if (spec.network === "outbound") return ["--network", "slirp4netns"];
  throw new RuntimeLaunchError(
    "unsupported_policy",
    "internet-only egress enforcement is unavailable for the Podman adapter",
  );
}

function createArgs(spec: RuntimeLaunchSpec, name: string): readonly string[] {
  return [
    "create",
    "--name",
    name,
    "--label",
    "io.clarvis.runtime=true",
    "--label",
    `io.clarvis.generation=${spec.generation}`,
    "--interactive",
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
    "--storage-opt",
    `size=${String(spec.limits.storageBytes)}`,
    ...networkArgs(spec),
    "--tmpfs",
    `/mise:rw,nosuid,nodev,exec,size=${String(spec.limits.storageBytes)}`,
    "--mount",
    `type=bind,source=${spec.retainedWorkspaceRoot},target=/workspace,rw=true`,
    "--workdir",
    "/workspace",
    "--env",
    `CLARVIS_RUNTIME_GENERATION=${spec.generation}`,
    "--env",
    `CLARVIS_RUNTIME_IMAGE_DIGEST=${spec.imageDigest}`,
    spec.imageDigest,
  ];
}

function validEffectiveInspect(value: unknown, spec: RuntimeLaunchSpec): boolean {
  const root = Array.isArray(value) ? asRecord(value[0]) : asRecord(value);
  const hostConfig = asRecord(root?.HostConfig);
  const config = asRecord(root?.Config);
  const mounts = Array.isArray(root?.Mounts) ? root.Mounts : [];
  const labels = asRecord(config?.Labels);
  return (
    hostConfig?.Privileged === false &&
    String(hostConfig?.NetworkMode).toLowerCase() ===
      (spec.network === "none" ? "none" : "slirp4netns") &&
    labels?.["io.clarvis.generation"] === spec.generation &&
    mounts.length === 1 &&
    asRecord(mounts[0])?.Source === spec.retainedWorkspaceRoot &&
    asRecord(mounts[0])?.Destination === "/workspace" &&
    asRecord(mounts[0])?.RW === true
  );
}

function validImageInspect(value: unknown, imageDigest: string): boolean {
  const root = Array.isArray(value) ? asRecord(value[0]) : asRecord(value);
  const config = asRecord(root?.Config);
  const labels = asRecord(config?.Labels);
  return (
    root?.Digest === imageDigest && labels?.[RUNTIME_PROTOCOL_LABEL] === RUNTIME_PROTOCOL_REVISION
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
  const logger = options.logger ?? NOOP_LOGGER;
  const stopSeconds = Math.max(1, Math.min(30, Math.floor(options.stopTimeoutSeconds ?? 5)));
  let inspected: PodmanInfo | undefined;
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
        result = await options.control.run(["info", "--format", "json"]);
      } catch {
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
      let created = false;
      let attached: PodmanAttachedProcess | undefined;
      try {
        const image = await successful(
          options.control,
          ["image", "inspect", spec.imageDigest],
          "podman image inspect",
        );
        if (!validImageInspect(parseJson(image.stdout, "podman image inspect"), spec.imageDigest)) {
          throw new RuntimeLaunchError(
            "handshake_mismatch",
            "Podman resolved image identity did not match the admitted digest",
          );
        }
        await successful(options.control, createArgs(spec, name), "podman create");
        created = true;
        const effective = await successful(
          options.control,
          ["container", "inspect", name],
          "podman container inspect",
        );
        if (!validEffectiveInspect(parseJson(effective.stdout, "podman container inspect"), spec)) {
          throw new RuntimeLaunchError(
            "unsupported_policy",
            "Podman effective configuration did not match the admitted isolation policy",
          );
        }
        attached = options.control.attach(["start", "--attach", "--interactive", name]);
        let stderrBytes = 0;
        attached.stderr.on("data", (chunk: Buffer | string) => {
          stderrBytes += Buffer.byteLength(chunk);
          if (stderrBytes > spec.limits.outputBytes) attached?.kill("SIGKILL");
        });
        const peer = createExecutionPeer({
          role: "host",
          generation: spec.generation,
          input: attached.stdout,
          output: attached.stdin,
          handlers: options.handlers ?? {},
          logger,
        });
        const handshake = await peer.request<{
          generation: string;
          imageDigest: string;
          runtimeProtocolRevision: string;
        }>(
          "runtime.bootstrap",
          { generation: spec.generation },
          {
            generation: spec.generation,
            imageDigest: spec.imageDigest,
            runtimeProtocolRevision: RUNTIME_PROTOCOL_REVISION,
            configurationRevision: spec.configurationRevision,
            extensionRevision: spec.extensionRevision,
            capabilityMethods: spec.capabilityMethods,
          },
        );
        if (
          handshake.generation !== spec.generation ||
          handshake.imageDigest !== spec.imageDigest ||
          handshake.runtimeProtocolRevision !== RUNTIME_PROTOCOL_REVISION
        ) {
          peer.close();
          throw new RuntimeLaunchError("handshake_mismatch", "guest bootstrap identity mismatch");
        }
        const info: RuntimeInfo = {
          kind: "container",
          generation: spec.generation,
          engine: "podman",
          engineVersion: inspected.version,
          hostPlatform: options.hostPlatform ?? process.platform,
          guestPlatform: "linux",
          imageDigest: spec.imageDigest,
          runtimeProtocolRevision: RUNTIME_PROTOCOL_REVISION,
          network: spec.network,
          limits: spec.limits,
          lifecycle: "ready",
        };
        const previews = createContainerRuntimePortPreview(options.control, name);
        let stopped = false;
        return {
          info,
          startRun: (runId, envelope, signal) =>
            peer.request("runtime.start", { generation: spec.generation, runId }, envelope, {
              ...(signal === undefined ? {} : { signal }),
            }),
          async steer(runId, input, signal) {
            await peer.request("runtime.steer", { generation: spec.generation, runId }, input, {
              ...(signal === undefined ? {} : { signal }),
            });
          },
          async cancel(runId) {
            await peer.request("runtime.cancel", { generation: spec.generation, runId });
          },
          exposePort: (guestPort, protocol, signal) => previews.expose(guestPort, protocol, signal),
          async stop() {
            if (stopped) return;
            stopped = true;
            await previews.close();
            peer.close();
            await options.control
              .run(["stop", "--time", String(stopSeconds), name])
              .catch(() => undefined);
            await successful(options.control, ["rm", "--force", name], "podman rm");
          },
        };
      } catch (error) {
        attached?.kill("SIGKILL");
        if (created) await options.control.run(["rm", "--force", name]).catch(() => undefined);
        throw error;
      }
    },
  };
}
