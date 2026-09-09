import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import {
  createExecutionPeer,
  type ExecutionRequestHandler,
  type GuestExecutionMethod,
} from "./execution-rpc.ts";
import {
  RuntimeLaunchError,
  type ContainerControl,
  type RuntimeInfo,
  type RuntimeLaunchSpec,
  type RuntimeSession,
} from "./types.ts";
import { RUNTIME_PROTOCOL_REVISION } from "./protocol-revision.ts";
import { createContainerRuntimePortPreview } from "./port-preview.ts";

/** Engine-neutral lifecycle inputs after image and effective isolation-policy admission. */
export interface ContainerSessionOptions {
  readonly control: ContainerControl;
  readonly engine: "docker" | "podman";
  readonly engineVersion: string;
  readonly handlers?: Readonly<Partial<Record<GuestExecutionMethod, ExecutionRequestHandler>>>;
  readonly logger?: Logger;
  readonly hostPlatform?: NodeJS.Platform;
  readonly stopTimeoutSeconds?: number;
  /** Generation-owned cancellation, observed only while acquiring the session. */
  readonly signal?: AbortSignal;
  /** Bounded response deadline, separate from the RPC writer's flush deadline. */
  readonly bootstrapTimeoutMs?: number;
}

async function successful(
  control: ContainerControl,
  args: readonly string[],
  label: string,
): Promise<void> {
  const result = await control.run(args);
  if (result.exitCode !== 0) throw new RuntimeLaunchError("operational_failure", `${label} failed`);
}

/**
 * Reconcile an interrupted create only through its generation label, then remove the immutable
 * container ID. A failed probe cannot authorize deletion of a reused name or another generation.
 */
export async function cleanupInterruptedContainerCreate(
  control: ContainerControl,
  name: string,
  generation: string,
): Promise<void> {
  const result = await control.run(["container", "inspect", name]);
  if (result.exitCode !== 0)
    throw new RuntimeLaunchError(
      "operational_failure",
      "interrupted container creation could not be inspected",
    );
  const parsed: unknown = JSON.parse(result.stdout);
  const candidate: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
  if (typeof candidate !== "object" || candidate === null) return;
  const container = candidate as { Id?: unknown; Config?: { Labels?: Record<string, unknown> } };
  if (container.Config?.Labels?.["io.clarvis.generation"] !== generation) return;
  if (typeof container.Id !== "string" || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(container.Id))
    throw new RuntimeLaunchError(
      "operational_failure",
      "interrupted container creation has no verifiable identity",
    );
  await successful(control, ["rm", "--force", container.Id], "interrupted container cleanup");
}

/** Attach and own the private channel, preview relays and physical teardown for either engine. */
export async function connectContainerSession(
  options: ContainerSessionOptions,
  spec: RuntimeLaunchSpec,
  name: string,
): Promise<RuntimeSession> {
  const logger = options.logger ?? NOOP_LOGGER;
  const stopSeconds = Math.max(1, Math.min(30, Math.floor(options.stopTimeoutSeconds ?? 5)));
  const bootstrapTimeout = options.bootstrapTimeoutMs ?? 30_000;
  if (
    !Number.isSafeInteger(bootstrapTimeout) ||
    bootstrapTimeout <= 0 ||
    bootstrapTimeout > 120_000
  )
    throw new RuntimeLaunchError(
      "invalid_launch_spec",
      "guest bootstrap timeout must be within 120 seconds",
    );
  options.signal?.throwIfAborted();
  const attached = options.control.attach(["start", "--attach", "--interactive", name]);
  const peer = createExecutionPeer({
    role: "host",
    generation: spec.generation,
    input: attached.stdout,
    output: attached.stdin,
    handlers: options.handlers ?? {},
    logger,
  });
  let stderrBytes = 0;
  attached.stderr.on("data", (chunk: Buffer | string) => {
    stderrBytes += Buffer.byteLength(chunk);
    if (stderrBytes > spec.limits.outputBytes) {
      peer.close(new Error("container stderr bound exceeded"));
      attached.kill("SIGKILL");
    }
  });
  let stopped = false;
  let removed = false;
  let exited = false;
  void attached.exited.then(
    (code) => {
      exited = true;
      if (!stopped) peer.close(new Error(`Container runtime process exited (${String(code)})`));
    },
    () => {
      exited = true;
      if (!stopped) peer.close(new Error("Container runtime process exit was unavailable"));
    },
  );
  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(
        new RuntimeLaunchError("operational_failure", "guest bootstrap response timed out"),
      ),
    bootstrapTimeout,
  );
  const signal =
    options.signal === undefined
      ? deadline.signal
      : AbortSignal.any([deadline.signal, options.signal]);
  try {
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
      { signal },
    );
    if (
      handshake.generation !== spec.generation ||
      handshake.imageDigest !== spec.imageDigest ||
      handshake.runtimeProtocolRevision !== RUNTIME_PROTOCOL_REVISION
    ) {
      peer.close();
      throw new RuntimeLaunchError("handshake_mismatch", "guest bootstrap identity mismatch");
    }
  } catch (error) {
    peer.close(error instanceof Error ? error : new Error("guest bootstrap failed"));
    attached.kill("SIGKILL");
    signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const info: RuntimeInfo = {
    kind: "container",
    generation: spec.generation,
    engine: options.engine,
    engineVersion: options.engineVersion,
    hostPlatform: options.hostPlatform ?? process.platform,
    guestPlatform: "linux",
    imageDigest: spec.imageDigest,
    runtimeProtocolRevision: RUNTIME_PROTOCOL_REVISION,
    network: spec.network,
    limits: spec.limits,
    lifecycle: "ready",
  };
  const previews = createContainerRuntimePortPreview(options.control, name);
  return {
    info,
    get closed() {
      return stopped || exited || peer.closed;
    },
    startRun: (runId, envelope, signal) =>
      peer.request("runtime.start", { generation: spec.generation, runId }, envelope, {
        ...(signal === undefined ? {} : { signal }),
      }),
    callHookMcp: (runId, call, signal) =>
      peer.request("runtime.hook_mcp", { generation: spec.generation, runId }, call, {
        ...(signal === undefined ? {} : { signal }),
      }),
    elicitMcp: (runId, input, signal) =>
      peer.request("runtime.mcp_elicit", { generation: spec.generation, runId }, input, {
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
      if (removed) return;
      if (!stopped) {
        stopped = true;
        await previews.close();
        peer.close();
        await options.control
          .run(["stop", "--time", String(stopSeconds), name])
          .catch(() => undefined);
      }
      await successful(options.control, ["rm", "--force", name], `${options.engine} rm`);
      removed = true;
    },
  };
}
