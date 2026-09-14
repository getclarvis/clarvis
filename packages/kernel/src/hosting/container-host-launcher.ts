import { mkdir, readFile, unlink } from "node:fs/promises";
import { NOOP_LOGGER, resolveProvider, type EnvConfig, type Logger } from "@clarvis/capability";
import {
  acquireLocalLease,
  containerLaunchPaths,
  writeFileDurable,
  type LocalLease,
} from "@clarvis/paths";
import type { ProjectRef, WorkspaceRef } from "@clarvis/protocol";
import { createAiSdkProvider, withCallLogging, withTransportRetry } from "@clarvis/llm";
import { providerConfigSchema } from "@clarvis/loop/host";
import type { CachedRuntimeArtifact } from "../runtime/runtime-artifact.ts";
import type {
  ContainerKernelBackend,
  ContainerKernelLaunchSpec,
  ContainerProcessLifecycle,
  RuntimeProtectedMount,
} from "../runtime/types.ts";
import { kernelError } from "../core/errors.ts";
import {
  containerConfigurationDigest,
  type ContainerConfiguration,
} from "../config/container-projection.ts";
import { createOperatorServices, type OperatorServices } from "../config/operator-services.ts";
import { connectContainerKernel, type ConnectedContainerKernel } from "./container-launcher.ts";

export interface LaunchContainerKernelOptions {
  readonly backend: ContainerKernelBackend;
  readonly engine: "docker" | "podman";
  readonly launch: ContainerKernelLaunchSpec;
  readonly artifact: CachedRuntimeArtifact;
  readonly configuration: ContainerConfiguration;
  readonly project: ProjectRef;
  readonly workspace: WorkspaceRef & { readonly path: "/workspace" };
  readonly owner: string;
  readonly globalDir: string;
  readonly env: EnvConfig;
  readonly protectedMounts: {
    readonly controlRootMasks: readonly RuntimeProtectedMount[];
    readonly gitMetadataMounts: readonly RuntimeProtectedMount[];
    cleanup(): Promise<void>;
  };
  readonly logger?: Logger;
  readonly operator?: OperatorServices;
  readonly lease?: LocalLease;
  readonly signal?: AbortSignal;
}

export interface LaunchedContainerKernel extends ConnectedContainerKernel {
  readonly operator: OperatorServices;
  readonly project: ProjectRef;
  readonly workspace: WorkspaceRef & { readonly path: "/workspace" };
}

/**
 * Own one complete Container Kernel generation, its external lease and its host-only model authority.
 * Configuration administration stays in `operator`; only logical model calls enter the physical lane.
 */
export async function launchContainerKernel(
  options: LaunchContainerKernelOptions,
): Promise<LaunchedContainerKernel> {
  const paths = containerLaunchPaths(options.launch.namespace, options.globalDir);
  const logger = options.logger ?? NOOP_LOGGER;
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const lease =
    options.lease ??
    (await acquireLocalLease(paths.leaseFile, {
      staleMs: 60_000,
      waitMs: 0,
      heartbeatMs: 5_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }));
  if (lease === null)
    throw kernelError("conflict", "Another Container Kernel owns this workspace namespace");
  const operator =
    options.operator ??
    createOperatorServices({
      workspaceRoot: options.launch.workspaceRoot,
      globalDir: options.globalDir,
      logger,
    });
  let connected: ConnectedContainerKernel | undefined;
  let lifecycle: ContainerProcessLifecycle | undefined;
  let registryCreated = false;
  let stopAuthorityObservation: (() => void) | undefined;
  try {
    const availability = await options.backend.inspect();
    if (!availability.available) throw kernelError("unavailable", availability.message);
    await lease.assertOwned();
    const previous = await readFile(paths.registryFile, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (previous !== undefined) {
      let registry: unknown;
      try {
        registry = JSON.parse(previous) as unknown;
      } catch {
        throw kernelError("conflict", "Container launch registry requires recovery");
      }
      const value = registry as Record<string, unknown>;
      if (
        value.schema !== 1 ||
        value.engine !== options.engine ||
        typeof value.containerId !== "string" ||
        typeof value.generation !== "string"
      )
        throw kernelError("conflict", "Container launch registry identity conflicts");
      await options.backend.reconcilePrevious({
        id: value.containerId,
        generation: value.generation,
        namespace: options.launch.namespace,
      });
      await unlink(paths.registryFile);
    }
    lifecycle = await options.backend.startKernel(options.launch);
    await writeFileDurable(
      paths.registryFile,
      `${JSON.stringify({
        schema: 1,
        generation: options.launch.generation,
        engine: options.engine,
        containerId: lifecycle.id,
        baseDigest: options.launch.baseImageId,
        artifactDigest: options.launch.artifact.digest,
      })}\n`,
    );
    registryCreated = true;
    const settings = operator.configStore.readSettings().operator_merged;
    if (settings === undefined)
      throw kernelError("invalid_request", "Operator settings are unavailable");
    const providers = providerConfigSchema.array().optional().parse(settings.providers);
    const hostPlatform = process.platform;
    if (hostPlatform !== "linux" && hostPlatform !== "darwin" && hostPlatform !== "win32")
      throw kernelError("unsupported", "Container launcher host platform is unsupported");
    const rawProvider = createAiSdkProvider({
      resolveRegistryKey: (name) => operator.resolveRegistryKey(name),
      timeoutMs: options.env.CLARVIS_DEFAULT_CALL_TIMEOUT_MS,
      maxResponseBytes: options.env.CLARVIS_PROVIDER_MAX_RESPONSE_BYTES,
      maxSseEventBytes: options.env.CLARVIS_PROVIDER_MAX_SSE_EVENT_BYTES,
      logger,
      ...(operator.resolveSubscription === undefined
        ? {}
        : {
            resolveSubscription: (scheme, signal, context) =>
              operator.resolveSubscription!(scheme, signal, context),
          }),
    });
    const provider = withTransportRetry(withCallLogging(rawProvider, logger), {
      maxRetries: options.env.CLARVIS_DEFAULT_MAX_RETRIES,
      baseDelayMs: options.env.CLARVIS_PROVIDER_RETRY_BASE_MS,
      maxDelayMs: options.env.CLARVIS_PROVIDER_RETRY_MAX_MS,
      maxRetryAfterMs: options.env.CLARVIS_DEFAULT_MAX_RETRY_AFTER_MS,
      logger,
    });
    const configDigest = containerConfigurationDigest(options.configuration);
    connected = await connectContainerKernel({
      lifecycle,
      initialize: {
        workspaceIdentity: {
          project: options.project,
          workspace: options.workspace,
          namespace: options.launch.namespace,
        },
        owner: options.owner,
        runtime: {
          engine: options.engine,
          hostPlatform,
          network: options.launch.network,
          baseDigest: options.launch.baseImageId,
          baseAbi: "clarvis-linux-glibc-v1",
        },
        artifactDigest: options.launch.artifact.digest,
        configDigest,
        configuration: options.configuration,
      },
      broker: {
        owner: options.owner,
        namespace: options.launch.namespace,
        modelCatalog: options.configuration.modelCatalog.map((model) => ({
          ...model,
          capabilities: model.capabilities,
          reasoningEfforts: model.reasoningEfforts,
          promptCache: model.promptCache,
        })),
        maxConcurrent: options.env.CLARVIS_MAX_CONCURRENT_MODEL_CALLS,
        maxQueued: options.env.CLARVIS_MAX_QUEUED_MODEL_CALLS,
        tokenCeiling: options.env.CLARVIS_TOKEN_CEILING,
        hostMaxRetries: options.env.CLARVIS_DEFAULT_MAX_RETRIES,
        maxResponseBytes: options.env.CLARVIS_PROVIDER_MAX_RESPONSE_BYTES,
        maxRetryAfterMs: options.env.CLARVIS_DEFAULT_MAX_RETRY_AFTER_MS,
        maxTimeoutMs: options.env.CLARVIS_TIMEOUT_CEILING_MS,
        defaultTimeoutMs: options.env.CLARVIS_DEFAULT_CALL_TIMEOUT_MS,
        async resolve(target) {
          const resolved = resolveProvider(target.provider, providers, target.model);
          if (!resolved.ok)
            throw kernelError("unsupported", "Container model provider is unavailable");
          return { llm: provider, providerConfig: resolved.config };
        },
      },
      logger,
    });
    const active = connected;
    stopAuthorityObservation = operator.onAuthorityChanged((change) => {
      for (const providerConfig of providers ?? []) {
        const affected =
          change.kind === "secret"
            ? providerConfig.api_key_env === change.name
            : providerConfig.kind === change.scheme;
        if (affected) active.revokeModelPair(providerConfig.name);
      }
    });
    let closing: Promise<void> | undefined;
    return {
      ...active,
      operator,
      project: options.project,
      workspace: options.workspace,
      close() {
        closing ??= (async () => {
          const failures: unknown[] = [];
          stopAuthorityObservation?.();
          stopAuthorityObservation = undefined;
          await active.close();
          for (const cleanup of [
            () =>
              unlink(paths.registryFile).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
              }),
            () => operator.close(),
            () => options.protectedMounts.cleanup(),
            () =>
              lease.release().then((released) => {
                if (!released) throw new Error("Container launch lease ownership was lost");
              }),
          ]) {
            try {
              await cleanup();
            } catch (error) {
              failures.push(error);
            }
          }
          if (failures.length > 0)
            throw new AggregateError(failures, "Container Kernel cleanup failed");
        })();
        return closing;
      },
    };
  } catch (error) {
    stopAuthorityObservation?.();
    let stopped: boolean;
    if (connected !== undefined) {
      try {
        await connected.close();
        stopped = true;
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Container launch and cleanup failed", {
          cause: cleanupError,
        });
      }
    } else if (lifecycle !== undefined) {
      try {
        await lifecycle.stop(10).catch(() => undefined);
        await lifecycle.remove();
        stopped = true;
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Container launch and cleanup failed", {
          cause: cleanupError,
        });
      }
    } else {
      stopped = true;
    }
    if (stopped) {
      const cleanupFailures: unknown[] = [];
      for (const cleanup of [
        ...(registryCreated
          ? [
              () =>
                unlink(paths.registryFile).catch((unlinkError: NodeJS.ErrnoException) => {
                  if (unlinkError.code !== "ENOENT") throw unlinkError;
                }),
            ]
          : []),
        () => operator.close(),
        () => options.protectedMounts.cleanup(),
        () =>
          lease.release().then((released) => {
            if (!released) throw new Error("Container launch lease ownership was lost");
          }),
      ]) {
        try {
          await cleanup();
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      }
      if (cleanupFailures.length > 0)
        throw new AggregateError(
          [error, ...cleanupFailures],
          "Container launch and cleanup failed",
          { cause: error },
        );
    }
    throw error;
  }
}
