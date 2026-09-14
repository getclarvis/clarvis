import { dirname } from "node:path";
import { rm, unlink } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import {
  DIR_MODE,
  FILE_MODE,
  containerGuestPaths,
  containerKernelStatePaths,
  writeFileDurable,
} from "@clarvis/paths";
import { NOOP_LOGGER, suppressSecondaryRejection, type Logger } from "@clarvis/capability";
import { kernelError } from "../core/errors.ts";
import { createContainerModelProvider } from "../runtime/model-broker-client.ts";
import {
  parseRuntimeArtifactManifest,
  RUNTIME_ARTIFACT_LIMITS,
  type RuntimeArtifactManifest,
} from "../runtime/runtime-artifact.ts";
import { openArtifactFile } from "../runtime/runtime-artifact-archive.ts";
import { createStdioTransport, serveKernelOverStdio } from "../transport/stdio.ts";
import { M } from "../transport/wire.ts";
import type { KernelServer } from "../transport/server.ts";
import { createContainerChannel } from "./container-channel.ts";
import {
  CONTAINER_BASE_ABI,
  containerReadySchema,
  parseContainerInitialize,
  type ContainerInitialize,
} from "./container-contract.ts";
import { createFileRunHost, type FileRunHost } from "./file-host.ts";
import { openHostedProjection } from "./projection.ts";
import { decodeHostedRegistryState, MAX_HOST_INDEX_BYTES } from "./state.ts";
import { preparePrivateHostDirectory, readPrivateHostJson } from "./private-files.ts";

/** Trusted process inputs; defaults are fixed guest paths and stdio descriptors. */
export interface ServeContainerKernelOptions {
  input?: Readable;
  output?: Writable;
  logger?: Logger;
  workspaceRoot?: string;
  globalDir?: string;
  artifactManifest?: RuntimeArtifactManifest;
}

/** A process-owned Container Kernel whose physical channel owns all native services. */
export interface ContainerKernelHost {
  readonly initialized: Promise<ContainerInitialize>;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

async function readArtifactManifest(): Promise<RuntimeArtifactManifest> {
  const path = `${containerGuestPaths.artifactRoot}/manifest.json`;
  const file = await openArtifactFile(path, RUNTIME_ARTIFACT_LIMITS.manifestBytes);
  try {
    return parseRuntimeArtifactManifest(await file.readFile());
  } finally {
    await file.close();
  }
}

async function hostedStorage(
  input: ContainerInitialize,
  globalDir: string,
): Promise<Parameters<typeof createFileRunHost>[0]["storage"]> {
  const paths = containerKernelStatePaths(input.workspaceIdentity.namespace, globalDir);
  await preparePrivateHostDirectory(paths.root);
  const saved = await readPrivateHostJson(paths.registryFile, MAX_HOST_INDEX_BYTES);
  return {
    ...(saved === null ? {} : { initialState: decodeHostedRegistryState(saved) }),
    async projection(executionId) {
      const path = paths.projectionFile(input.generation, executionId);
      await preparePrivateHostDirectory(dirname(path));
      return openHostedProjection(path, {
        host_generation: input.generation,
        execution_id: executionId,
      });
    },
    async removeProjection(executionId, generation) {
      const path = paths.projectionFile(generation, executionId);
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      await rm(dirname(path), { recursive: false }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
      });
    },
    async commit(state) {
      if (state.host_generation !== input.generation)
        throw kernelError("conflict", "Container host index generation mismatch");
      decodeHostedRegistryState(state);
      await writeFileDurable(paths.registryFile, `${JSON.stringify(state)}\n`, {
        mode: FILE_MODE,
        dirMode: DIR_MODE,
      });
    },
  };
}

function assertArtifact(manifest: RuntimeArtifactManifest, input: ContainerInitialize): void {
  const target = process.arch === "arm64" ? "linux-arm64" : "linux-x64";
  if (
    process.platform !== "linux" ||
    manifest.target !== target ||
    manifest.baseAbi !== input.runtime.baseAbi ||
    manifest.baseAbi !== CONTAINER_BASE_ABI ||
    manifest.kernelWireVersion !== 10 ||
    manifest.brokerVersion !== 1 ||
    manifest.channelVersion !== 1
  )
    throw kernelError("unsupported", "Container runtime artifact is incompatible");
}

/**
 * Serve one complete native Kernel over the three-lane Container stdio channel.
 * Initialization is single-use, binds fixed roots and opens inference only for the admitted lease.
 */
export function serveContainerKernel(
  options: ServeContainerKernelOptions = {},
): ContainerKernelHost {
  const logger = options.logger ?? NOOP_LOGGER;
  const workspaceRoot = options.workspaceRoot ?? containerGuestPaths.workspaceRoot;
  const globalDir = options.globalDir ?? containerGuestPaths.globalRoot;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const channel = createContainerChannel({ input, output });
  const initialized = Promise.withResolvers<ContainerInitialize>();
  suppressSecondaryRejection(initialized.promise, "ContainerKernelHost.initialized");
  let host: FileRunHost | undefined;
  let kernelPump: { close(): void } | undefined;
  let modelTransport: ReturnType<typeof createStdioTransport> | undefined;
  let controlPump: { close(): void } | undefined;
  let initializationStarted = false;
  let closing: Promise<void> | undefined;
  let closeAfterResponse = false;

  const close = (): Promise<void> => {
    closing ??= (async () => {
      modelTransport?.close().catch(() => undefined);
      kernelPump?.close();
      controlPump?.close();
      await host?.close();
      channel.close();
    })();
    return closing;
  };
  const control: KernelServer = {
    connect() {
      let connected = true;
      return {
        async handle(method, value) {
          if (!connected || closing !== undefined)
            throw kernelError("unavailable", "Container Kernel is closing");
          if (method === "container.shutdown") {
            if (host === undefined)
              throw kernelError("conflict", "Container Kernel is not initialized");
            closeAfterResponse = true;
            return { received: true };
          }
          if (method !== "container.initialize")
            throw kernelError("unauthorized", "Container control method is unavailable");
          if (initializationStarted)
            throw kernelError("conflict", "Container Kernel is already initialized");
          initializationStarted = true;
          try {
            const admitted = parseContainerInitialize(value);
            if (
              admitted.workspaceIdentity.workspace.projectId !==
              admitted.workspaceIdentity.project.id
            )
              throw kernelError("invalid_request", "Container workspace identity mismatch");
            const manifest = options.artifactManifest ?? (await readArtifactManifest());
            assertArtifact(manifest, admitted);
            modelTransport = createStdioTransport(channel.model, logger);
            const llm = createContainerModelProvider({
              transport: modelTransport,
              leaseId: admitted.modelLease.leaseId,
              generation: admitted.generation,
            });
            host = await createFileRunHost({
              composition: {
                kind: "container",
                configuration: admitted.configuration,
                llm,
                runtime: {
                  kind: "container",
                  engine: admitted.runtime.engine,
                  host_platform: admitted.runtime.hostPlatform,
                  guest_platform: "linux",
                  network: admitted.runtime.network,
                  generation: admitted.generation,
                  image_digest: admitted.runtime.baseDigest,
                  artifact_digest: admitted.artifactDigest,
                  base_abi: admitted.runtime.baseAbi,
                  broker_version: 1,
                  channel_version: 1,
                  state_namespace: admitted.workspaceIdentity.namespace,
                  lifecycle: "ready",
                },
              },
              kernel: {
                globalDir,
                workspaceRoot,
                defaultOwner: admitted.owner,
                project: admitted.workspaceIdentity.project,
                workspace:
                  workspaceRoot === containerGuestPaths.workspaceRoot
                    ? admitted.workspaceIdentity.workspace
                    : { ...admitted.workspaceIdentity.workspace, path: workspaceRoot },
                logger,
              },
              hostGeneration: admitted.generation,
              storage: await hostedStorage(admitted, globalDir),
              authenticate: () => "operator",
              exposeLocalControls: false,
              exposeDefaultOwner: true,
            });
            await host.sync();
            let recoveryStarted = false;
            const server: KernelServer = {
              connect(send, disconnect) {
                const connection = host!.server.connect(send, disconnect);
                return {
                  ...connection,
                  responseSent(method, result) {
                    connection.responseSent?.(method, result);
                    if (method === M.hello && !recoveryStarted) {
                      recoveryStarted = true;
                      host!.kernel.startMemoryRecovery();
                    }
                  },
                };
              },
            };
            kernelPump = serveKernelOverStdio(server, channel.kernel, logger, {
              strictDirection: true,
            });
            initialized.resolve(admitted);
            return containerReadySchema.parse({
              ready: true,
              generation: admitted.generation,
              artifactDigest: admitted.artifactDigest,
              configDigest: admitted.configDigest,
              kernelWireVersion: 10,
              brokerVersion: 1,
            });
          } catch (error) {
            initialized.reject(error);
            throw error;
          }
        },
        responseSent() {
          if (closeAfterResponse) queueMicrotask(() => void close());
        },
        close() {
          connected = false;
        },
      };
    },
  };
  void channel.ready.then(
    () => {
      if (closing !== undefined) return;
      controlPump = serveKernelOverStdio(control, channel.control, logger, {
        strictDirection: true,
      });
    },
    (error) => initialized.reject(error),
  );
  void channel.closed.then(
    () => close(),
    () => close(),
  );
  return { initialized: initialized.promise, closed: channel.closed, close };
}
