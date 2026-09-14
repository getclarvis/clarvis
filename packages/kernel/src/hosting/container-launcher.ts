import {
  sanitizeText,
  suppressSecondaryRejection,
  type Logger,
  NOOP_LOGGER,
} from "@clarvis/capability";
import type { KernelClient } from "@clarvis/protocol";
import { kernelError } from "../core/errors.ts";
import {
  createContainerModelBroker,
  type ContainerModelBrokerOptions,
} from "../runtime/model-broker-host.ts";
import type { ContainerProcessLifecycle } from "../runtime/types.ts";
import { connectKernelClient } from "../transport/client.ts";
import { createStdioTransport, serveKernelOverStdio } from "../transport/stdio.ts";
import { createContainerChannel } from "./container-channel.ts";
import {
  CONTAINER_BOOT_TIMEOUT_MS,
  containerReadySchema,
  type ContainerInitialize,
} from "./container-contract.ts";

/** Host-owned launch inputs after base, artifact, workspace, volumes and policy are admitted. */
export interface ConnectContainerKernelOptions {
  readonly lifecycle: ContainerProcessLifecycle;
  readonly initialize: Omit<ContainerInitialize, "generation" | "modelLease">;
  readonly broker: ContainerModelBrokerOptions;
  readonly logger?: Logger;
  readonly timeoutMs?: number;
}

/** One generation: public execution client, launch identity and physical process ownership. */
export interface ConnectedContainerKernel {
  readonly client: KernelClient;
  readonly generation: string;
  readonly artifactDigest: `sha256:${string}`;
  readonly configDigest: `sha256:${string}`;
  readonly closed: Promise<string>;
  stderr(): string;
  /** Host-only credential revocation fence; never appears on KernelClient. */
  revokeModelPair(provider: string, model?: string): void;
  close(): Promise<void>;
}

function deadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(kernelError("unavailable", "Container Kernel boot timed out")),
        milliseconds,
      );
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function bootDeadline<T>(promise: Promise<T>, expiresAt: number): Promise<T> {
  const remaining = expiresAt - Date.now();
  if (remaining <= 0)
    return Promise.reject(kernelError("unavailable", "Container Kernel boot timed out"));
  return deadline(promise, remaining);
}

function physicalExitWithin(process: ContainerProcessLifecycle["process"], milliseconds: number) {
  return Promise.race([
    process.exited.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => {
      const timer = setTimeout(() => resolve(false), milliseconds);
      timer.unref?.();
    }),
  ]);
}

/**
 * Negotiate one attached Container process and expose its public Kernel client.
 * The broker is bound to the physical model lane; no administrative host service is dispatched.
 */
export async function connectContainerKernel(
  options: ConnectContainerKernelOptions,
): Promise<ConnectedContainerKernel> {
  const logger = options.logger ?? NOOP_LOGGER;
  const timeout = options.timeoutMs ?? CONTAINER_BOOT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > CONTAINER_BOOT_TIMEOUT_MS)
    throw kernelError("invalid_request", "Container boot timeout is invalid");
  const process = options.lifecycle.process;
  const bootExpiresAt = Date.now() + timeout;
  const channel = createContainerChannel({ input: process.stdout, output: process.stdin });
  const broker = createContainerModelBroker(options.broker);
  if (
    broker.generation.length === 0 ||
    options.initialize.owner !== options.broker.owner ||
    options.initialize.workspaceIdentity.namespace !== options.broker.namespace
  ) {
    broker.revoke();
    channel.close();
    throw kernelError("invalid_request", "Container broker identity mismatch");
  }
  let stderr = Buffer.alloc(0);
  process.stderr.on("data", (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stderr = Buffer.concat([stderr, bytes]).subarray(-64 * 1024);
  });
  const modelPump = serveKernelOverStdio(broker, channel.model, logger, {
    strictDirection: true,
  });
  const control = createStdioTransport(channel.control, logger);
  const physical = Promise.withResolvers<string>();
  suppressSecondaryRejection(physical.promise, "ConnectedContainerKernel.closed");
  void channel.closed.then(
    () => physical.resolve("Container channel closed"),
    () => physical.resolve("Container channel failed"),
  );
  void process.exited.then(
    (code) => physical.resolve(`Container exited (${String(code)})`),
    () => physical.resolve("Container process failed"),
  );
  let client: Awaited<ReturnType<typeof connectKernelClient>> | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      broker.revoke();
      try {
        await deadline(control.request("container.shutdown", {}), 5_000);
      } catch {
        channel.close();
      }
      const exited = await physicalExitWithin(process, 30_000);
      if (!exited) {
        let stopError: unknown;
        try {
          await options.lifecycle.stop(10);
        } catch (error) {
          stopError = error;
        }
        if (!(await physicalExitWithin(process, 10_000))) {
          try {
            await options.lifecycle.kill();
          } catch (killError) {
            throw new AggregateError(
              [...(stopError === undefined ? [] : [stopError]), killError],
              "Container Kernel termination is unconfirmed",
              { cause: killError },
            );
          }
          if (!(await physicalExitWithin(process, 10_000))) process.kill("SIGKILL");
        }
      }
      modelPump.close();
      await control.close().catch(() => undefined);
      channel.close();
      await options.lifecycle.remove();
    })();
    return closing;
  };
  void physical.promise
    .then(() => close())
    .catch((error: unknown) => {
      logger.error(
        {
          event: "container.cleanup.failed",
          error: sanitizeText(error instanceof Error ? error.message : String(error)),
        },
        "the Container channel closed and lifecycle cleanup failed",
      );
    });
  try {
    await bootDeadline(channel.ready, bootExpiresAt);
    const initialize: ContainerInitialize = {
      ...options.initialize,
      generation: broker.generation,
      modelLease: {
        leaseId: broker.leaseId,
        expiresAt: broker.expiresAt,
        models: options.broker.modelCatalog.map(({ provider, model }) => ({ provider, model })),
        limits: {
          maxConcurrent: options.broker.maxConcurrent,
          maxQueued: options.broker.maxQueued,
          tokenCeiling: options.broker.tokenCeiling,
          hostMaxRetries: options.broker.hostMaxRetries,
          maxResponseBytes: Math.min(32 * 1024 * 1024, options.broker.maxResponseBytes),
          maxRetryAfterMs: options.broker.maxRetryAfterMs ?? 0,
          maxTimeoutMs: options.broker.maxTimeoutMs,
          defaultTimeoutMs: options.broker.defaultTimeoutMs,
        },
      },
    };
    const ready = containerReadySchema.parse(
      await bootDeadline(control.request("container.initialize", initialize), bootExpiresAt),
    );
    if (
      ready.generation !== broker.generation ||
      ready.artifactDigest !== initialize.artifactDigest ||
      ready.configDigest !== initialize.configDigest
    )
      throw kernelError("unsupported", "Container Kernel ready identity mismatch");
    client = await bootDeadline(
      connectKernelClient(createStdioTransport(channel.kernel, logger), {
        clientInfo: { name: "clarvis-container" },
        workspace: initialize.workspaceIdentity.workspace.id,
        logger,
      }),
      bootExpiresAt,
    );
    if (
      client.localHost !== undefined ||
      client.workspace.id !== initialize.workspaceIdentity.workspace.id ||
      client.project.id !== initialize.workspaceIdentity.project.id ||
      client.capabilities.runtime?.kind !== "container"
    )
      throw kernelError("unsupported", "Container Kernel public identity mismatch");
    return {
      client,
      generation: broker.generation,
      artifactDigest: initialize.artifactDigest,
      configDigest: initialize.configDigest,
      closed: physical.promise,
      stderr: () => sanitizeText(stderr.toString("utf8")).slice(-4096),
      revokeModelPair: (provider, model) => broker.revokePair(provider, model),
      close,
    };
  } catch (error) {
    await client?.close().catch(() => undefined);
    await close().catch(() => undefined);
    const diagnostic = sanitizeText(stderr.toString("utf8"))
      .replace(/[\r\n\t]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(-4096);
    if (diagnostic !== "")
      throw kernelError("unavailable", `Container Kernel boot failed: ${diagnostic}`);
    throw error;
  }
}
