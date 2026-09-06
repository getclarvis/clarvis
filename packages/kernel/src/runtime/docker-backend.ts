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

export interface DockerCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}
export interface DockerAttachedProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<number | null>;
  kill(signal: NodeJS.Signals): void;
}
export interface DockerControl {
  run(args: readonly string[], signal?: AbortSignal): Promise<DockerCommandResult>;
  attach(args: readonly string[]): DockerAttachedProcess;
}
export interface DockerBackendOptions {
  readonly control: DockerControl;
  readonly handlers?: Readonly<Partial<Record<GuestExecutionMethod, ExecutionRequestHandler>>>;
  readonly logger?: Logger;
  readonly hostPlatform?: NodeJS.Platform;
  readonly stopTimeoutSeconds?: number;
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
    "--tmpfs",
    `/mise:rw,nosuid,nodev,exec,size=${String(spec.limits.storageBytes)}`,
    "--mount",
    `type=bind,source=${spec.retainedWorkspaceRoot},target=/workspace`,
    "--workdir",
    "/workspace",
    "--env",
    `CLARVIS_RUNTIME_GENERATION=${spec.generation}`,
    "--env",
    `CLARVIS_RUNTIME_IMAGE_DIGEST=${spec.imageDigest}`,
    spec.imageDigest,
  ];
}
function validInspect(value: unknown, spec: RuntimeLaunchSpec): boolean {
  const root = record(Array.isArray(value) ? value[0] : value);
  const host = record(root?.HostConfig);
  const config = record(root?.Config);
  const mounts = Array.isArray(root?.Mounts) ? root.Mounts : [];
  const labels = record(config?.Labels);
  const security = Array.isArray(host?.SecurityOpt) ? host.SecurityOpt.map(String) : [];
  const drops = Array.isArray(host?.CapDrop)
    ? host.CapDrop.map((v) => String(v).toLowerCase())
    : [];
  const workspaceMounts = mounts.filter((item) => record(item)?.Destination === "/workspace");
  return (
    host?.Privileged === false &&
    host?.ReadonlyRootfs === true &&
    String(host?.NetworkMode).toLowerCase() === network(spec) &&
    labels?.["io.clarvis.generation"] === spec.generation &&
    security.some((v) => v.includes("no-new-privileges")) &&
    drops.includes("all") &&
    host?.PidsLimit === spec.limits.processCount &&
    host?.Memory === spec.limits.memoryBytes &&
    workspaceMounts.length === 1 &&
    record(workspaceMounts[0])?.Source === spec.retainedWorkspaceRoot &&
    record(workspaceMounts[0])?.RW === true
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
  const logger = options.logger ?? NOOP_LOGGER;
  const stopSeconds = Math.max(1, Math.min(30, Math.floor(options.stopTimeoutSeconds ?? 5)));
  let version: string | undefined;
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
        result = await options.control.run(["info", "--format", "{{json .}}"]);
      } catch {
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
      version = candidate;
      const rootless =
        Array.isArray(info?.SecurityOptions) &&
        info.SecurityOptions.some((v) => String(v).includes("rootless"));
      return { available: true, engineVersion: version, rootless };
    },
    async start(spec): Promise<RuntimeSession> {
      if (version === undefined)
        throw new RuntimeLaunchError(
          "operational_failure",
          "Docker must be inspected before start",
        );
      const name = nameFor(spec.generation);
      let created = false;
      let attached: DockerAttachedProcess | undefined;
      try {
        const image = await successful(
          options.control,
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
        await successful(options.control, createArgs(spec, name), "docker create");
        created = true;
        const effective = await successful(
          options.control,
          ["container", "inspect", name],
          "docker container inspect",
        );
        if (!validInspect(parse(effective.stdout, "docker container inspect"), spec))
          throw new RuntimeLaunchError(
            "unsupported_policy",
            "Docker effective configuration did not match the admitted isolation policy",
          );
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
          engine: "docker",
          engineVersion: version,
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
            await successful(options.control, ["rm", "--force", name], "docker rm");
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
