import { bestEffort, NOOP_LOGGER, sanitizeText } from "@clarvis/capability";
import { ownerFromWorkspace, workspaceScopeKey } from "@clarvis/paths";
import type {
  HostingService,
  LocalHostService,
  LocalHostStatus,
  ModelCost,
} from "@clarvis/protocol";
import { createFileKernel, type CreateFileKernelOptions, type FileKernel } from "../file-kernel.ts";
import { kernelError, toKernelError } from "../core/errors.ts";
import { createKernelServer, type KernelServer } from "../transport/server.ts";
import type { KernelServices } from "../transport/operations.ts";
import {
  createHostedRegistry,
  type HostedRegistry,
  type HostedRegistryOptions,
} from "./registry.ts";
import { createHostedSessionCoordinator } from "./sessions.ts";
import type { HostingPeer } from "./admission.ts";
import { createLocalHostOperator } from "./operator.ts";

/** Operator-owned process resources; storage and authentication are never selected by an RPC peer. */
export interface FileRunHostOptions {
  kernel: Omit<CreateFileKernelOptions, "sessionAllowlistFor" | "ownershipMode">;
  hostGeneration: string;
  storage: Pick<
    HostedRegistryOptions,
    "projection" | "removeProjection" | "commit" | "initialState"
  >;
  /** Verify local connection authority and return its role; undefined rejects the handshake. */
  authenticate(
    token: string | undefined,
  ): HostingPeer["role"] | undefined | Promise<HostingPeer["role"] | undefined>;
  /** Fence each operation against the owning process lease, including after asynchronous approval. */
  assertAuthority?(): Promise<void>;
}

/** A process-owned FileKernel and authenticated RPC server, independent of any transport connection. */
export interface FileRunHost {
  readonly kernel: FileKernel;
  readonly server: KernelServer;
  /** Publish a bounded operator notice from application-owned runtime preparation, never from a guest request. */
  runtimeNotice(message: string): void;
  sync(): Promise<void>;
  stats(): ReturnType<HostedRegistry["stats"]> & {
    maintenance: boolean;
    disconnecting: number;
    physicalRuns: number;
    restartRequested: boolean;
  };
  /** Physical host teardown, distinct from disconnecting an individual client. */
  close(): Promise<void>;
}

/**
 * Compose the canonical file services, turn coordinator and permanent run pumps behind the existing
 * RPC catalog. The caller owns the private process lease, endpoint and durable storage. Starts must
 * enter through hosting; ordinary start/active compaction cannot bypass conversation or controller
 * admission. Offline compaction and generated-state cleanup reserve a host-wide maintenance slot.
 */
export async function createFileRunHost(options: FileRunHostOptions): Promise<FileRunHost> {
  const logger = options.kernel.logger ?? NOOP_LOGGER;
  const owner = options.kernel.defaultOwner ?? ownerFromWorkspace(options.kernel.workspaceRoot);
  let registry: HostedRegistry | undefined;
  let runtimeNotice: LocalHostStatus["runtime_notice"];
  let extensionDrift: LocalHostStatus["extension_drift"];
  let sequence = 0;
  let restartRequested = false;
  let operator: ReturnType<typeof createLocalHostOperator> | undefined;
  const publishRuntimeNotice = (message: string): void => {
    runtimeNotice = { sequence: ++sequence, message: sanitizeText(message).slice(0, 4096) };
  };
  const kernel = await createFileKernel({
    ...options.kernel,
    defaultOwner: owner,
    ownershipMode: "single",
    sessionAllowlistFor: (run) => registry?.guardAllowlistFor(run),
    onRuntimePlacement(notice) {
      options.kernel.onRuntimePlacement?.(notice);
      if (notice.message !== undefined) publishRuntimeNotice(notice.message);
    },
    onExtensionProfileDrift(notice) {
      options.kernel.onExtensionProfileDrift?.(notice);
      extensionDrift = {
        sequence: ++sequence,
        kind: notice.kind,
        name: sanitizeText(notice.kind === "skill" ? notice.name : notice.plugin).slice(0, 4096),
        ...(notice.kind === "skill" ? { source: notice.source } : {}),
      };
    },
    openMcpAuthorizationUrl(url) {
      if (operator === undefined)
        return Promise.reject(
          kernelError("unavailable", "interactive browser handoff is not ready"),
        );
      return operator.openAuthorizationUrl(url);
    },
  });
  const prices = new Map<string, ModelCost>();
  const disconnections = new Set<Promise<void>>();
  const roles = new Map<string, HostingPeer["role"]>();
  let maintenance = false;
  let closing: Promise<void> | undefined;
  try {
    const sessions = createHostedSessionCoordinator({
      sessions: kernel.sessions,
      workspaceId: kernel.workspace.id,
      projectId: kernel.project.id,
      occupied: (sessionId) => maintenance || registry!.occupied(sessionId),
      redact: sanitizeText,
      priceFor: (model) => prices.get(model),
      async readRun(id) {
        try {
          return await kernel.runs.get(id);
        } catch (error) {
          if (toKernelError(error).code === "not_found") return null;
          throw error;
        }
      },
      async prepareExecution(params) {
        const catalog = await kernel.models.get();
        prices.clear();
        for (const provider of catalog.providers)
          for (const model of provider.models)
            if (model.cost !== undefined) prices.set(`${provider.id}/${model.id}`, model.cost);
        const extension = await kernel.extensionProfiles.current();
        const prepared = kernel.prepareRun(params, owner);
        return {
          detachable: prepared.detachable,
          config: {
            agent: prepared.agent,
            ...(prepared.model === undefined ? {} : { model: prepared.model }),
            extension_profile: { id: extension.id, fingerprint: extension.fingerprint },
            runtime: structuredClone(kernel.runtime),
          },
          start: () => prepared.start(),
        };
      },
    });
    registry = createHostedRegistry({
      ...options.storage,
      hostGeneration: options.hostGeneration,
      workspaceId: kernel.workspace.id,
      owner: workspaceScopeKey(owner, kernel.project.id, kernel.workspace.id),
      prepare: sessions.prepare,
      archiveRecovery: sessions.archiveRecovery,
      retireConfigurationSession: (scope) => kernel.nativeConfiguration.retireSession(owner, scope),
      logger,
    });
    const owned = registry;
    const exclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
      const active = owned.stats();
      if (
        maintenance ||
        restartRequested ||
        active.runs > 0 ||
        active.activities > 0 ||
        active.unresolved > 0 ||
        kernel.activeExecutionLeases() > 0
      )
        throw kernelError("conflict", "host has active work; wait for physical closure");
      maintenance = true;
      try {
        return await operation();
      } finally {
        maintenance = false;
      }
    };
    operator = createLocalHostOperator({
      inspect: () => ({
        host_generation: options.hostGeneration,
        runtime: kernel.runtime,
        ...(runtimeNotice === undefined ? {} : { runtime_notice: runtimeNotice }),
        ...(extensionDrift === undefined ? {} : { extension_drift: extensionDrift }),
        restart_requested: restartRequested,
      }),
      canControl: (peerId, sessionId) => owned.controlsConversation(peerId, sessionId),
      retryRuntime: () => exclusive(async () => kernel.retryRuntime()),
      requestRestart: () =>
        exclusive(async () => {
          restartRequested = true;
        }),
    });
    const ownedOperator = operator;
    const servicesFor = (
      hosting: HostingService,
      peerId: string,
      localHost?: LocalHostService,
    ): KernelServices => ({
      ...kernel.operatorServices,
      ...kernel.defaultOwnerServices,
      sessions: {
        ...sessions.sessions,
        save: (value) =>
          sessions.saveDuringActivity(
            value,
            () => !maintenance && !restartRequested && owned.ownsActivity(peerId, value.id),
          ),
      },
      ...(localHost === undefined ? {} : { localHost }),
      hosting: {
        ...hosting,
        start(input) {
          if (maintenance || restartRequested)
            throw kernelError("conflict", "host maintenance is in progress");
          return ownedOperator.withSession(input.session_id, () => hosting.start(input));
        },
        reserveActivity(...args) {
          if (maintenance || restartRequested)
            throw kernelError("conflict", "host maintenance is in progress");
          return hosting.reserveActivity(...args);
        },
      },
      runs: {
        ...kernel.runs,
        start() {
          throw kernelError(
            "unsupported",
            "this host starts conversation runs through hosting.start",
          );
        },
        compact: (...args) => exclusive(() => kernel.runs.compact(...args)),
        delete: (id) => exclusive(() => kernel.runs.delete(id)),
      },
      workflows: {
        ...kernel.workflows,
        delete: (id) => exclusive(() => kernel.workflows.delete(id)),
      },
      storage: {
        ...kernel.storage,
        cleanup: (request) => exclusive(() => kernel.storage.cleanup(request)),
      },
    });
    const server = createKernelServer(kernel, {
      async resolveConnection(params) {
        if (closing !== undefined || restartRequested)
          throw kernelError("unavailable", "local host is closing");
        const role = await options.authenticate(params.auth);
        if (role !== "operator" && role !== "observer")
          throw kernelError("unauthorized", "local host authentication failed");
        if (closing !== undefined || restartRequested)
          throw kernelError("unavailable", "local host is closing");
        if (
          params.workspace !== undefined &&
          params.workspace !== kernel.workspace.id &&
          params.workspace !== kernel.workspace.path
        )
          throw kernelError("invalid_request", "local host belongs to a different workspace");
        if (closing !== undefined) throw kernelError("unavailable", "local host is closing");
        if (disconnections.size >= 4)
          throw kernelError("resource_exhausted", "previous local connections are still closing");
        const connection = owned.connect(role);
        roles.set(connection.peer.id, role);
        return {
          principal: { id: connection.peer.id },
          workspace: kernel.workspace,
          project: kernel.project,
          services: servicesFor(
            connection.service,
            connection.peer.id,
            role === "operator" ? ownedOperator.connect(connection.peer.id) : undefined,
          ),
          capabilities: {
            ...kernel.capabilities,
            hosting: { host_generation: options.hostGeneration },
            ...(role === "operator" ? { local_host: true as const } : {}),
          },
          close() {
            roles.delete(connection.peer.id);
            ownedOperator.disconnect(connection.peer.id);
            const pending = bestEffort(() => connection.close(), {
              operation: "hosting.connection.close",
              logger,
            });
            disconnections.add(pending);
            const release = (): void => {
              disconnections.delete(pending);
            };
            void pending.then(release, release);
          },
        };
      },
      async authorize({ principal, metadata }) {
        await options.assertAuthority?.();
        const role = principal === undefined ? undefined : roles.get(principal.id);
        return (
          (role === "operator" && (!restartRequested || metadata.access === "read")) ||
          (role === "observer" && metadata.access === "read" && metadata.sensitivity === undefined)
        );
      },
    });
    return {
      kernel,
      server,
      runtimeNotice: publishRuntimeNotice,
      sync: () => owned.sync(),
      stats: () => ({
        ...owned.stats(),
        maintenance,
        disconnecting: disconnections.size,
        physicalRuns: kernel.activeExecutionLeases(),
        restartRequested,
      }),
      close() {
        closing ??= (async () => {
          roles.clear();
          ownedOperator.close();
          const settled = await Promise.allSettled([owned.close(), ...disconnections]);
          await kernel.close();
          const failure = settled.find((value) => value.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
        })();
        return closing;
      },
    };
  } catch (error) {
    await kernel.close();
    throw error;
  }
}
