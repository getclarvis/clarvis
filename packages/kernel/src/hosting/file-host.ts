import { addGoalAuxiliaryUsage } from "../goals/usage.ts";
import { createHash } from "node:crypto";
import { bestEffort, NOOP_LOGGER, sanitizeText } from "@clarvis/capability";
import { goalsSettingsSchema } from "@clarvis/goal/settings";
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
import { createGoalRepository } from "../goals/repository.ts";
import { goalStateFromSession, goalStateToDto } from "../goals/session-state.ts";
import { createGoalEvidenceSource } from "../goals/evidence.ts";
import { prepareHostedGoalTurn, type GoalExecutionPolicy } from "../goals/hosted-turn.ts";
import { createGoalService } from "../goals/service.ts";
import { unavailableGoalService } from "../goals/unavailable.ts";
import { createGoalChanges } from "../goals/changes.ts";
import { createContainerNativeKernel, type ContainerNativeOptions } from "./container-native.ts";

/** Operator-owned process resources; storage and authentication are never selected by an RPC peer. */
interface FileRunHostCommonOptions {
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
  /** Advertise controls that act on this machine's application host. Defaults to true. */
  exposeLocalControls?: boolean;
  /** Reveal the server-owned session namespace to a remote application client. */
  exposeDefaultOwner?: boolean;
}

/** File composition preserves discovery; Container accepts only admitted data and inference ports. */
export type FileRunHostOptions = FileRunHostCommonOptions &
  (
    | {
        composition?: { kind: "file" };
        kernel: Omit<CreateFileKernelOptions, "sessionAllowlistFor" | "ownershipMode">;
      }
    | ContainerFileRunHostOptions
  );

interface ContainerFileRunHostOptions {
  composition: Pick<ContainerNativeOptions, "configuration" | "llm" | "runtime"> & {
    kind: "container";
  };
  kernel: Pick<ContainerNativeOptions, "globalDir" | "project" | "workspace" | "logger"> & {
    workspaceRoot: string;
    defaultOwner: string;
  };
}

/** Narrow the nested composition discriminator before using file-only adapter options. */
function isContainerHost(
  options: FileRunHostOptions,
): options is FileRunHostCommonOptions & ContainerFileRunHostOptions {
  return options.composition?.kind === "container";
}

/** A process-owned native Kernel and authenticated RPC server, independent of its pipes. */
export interface FileRunHost {
  readonly kernel: Omit<FileKernel, "workspaceHooks">;
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
  if (isContainerHost(options) && options.exposeLocalControls === true)
    throw kernelError("unsupported", "Container cannot expose local machine controls");
  const exposeLocalControls = !isContainerHost(options) && options.exposeLocalControls !== false;
  const logger = options.kernel.logger ?? NOOP_LOGGER;
  const goalChanges = createGoalChanges(logger);
  const owner = options.kernel.defaultOwner ?? ownerFromWorkspace(options.kernel.workspaceRoot);
  let registry: HostedRegistry | undefined;
  let runtimeNotice: LocalHostStatus["runtime_notice"];
  let extensionDrift: LocalHostStatus["extension_drift"];
  let skillsRevision = 0;
  let sequence = 0;
  let restartRequested = false;
  let operator: ReturnType<typeof createLocalHostOperator> | undefined;
  const publishRuntimeNotice = (message: string): void => {
    runtimeNotice = { sequence: ++sequence, message: sanitizeText(message).slice(0, 4096) };
  };
  const kernel: FileRunHost["kernel"] = await (async () => {
    if (isContainerHost(options)) {
      if (options.kernel.workspaceRoot !== options.kernel.workspace.path)
        throw kernelError(
          "invalid_request",
          "Container workspace identity does not match its root",
        );
      return (
        await createContainerNativeKernel({
          ...options.composition,
          ...options.kernel,
          owner,
          operatorAuthorityFor: (run) => registry?.operatorAuthorityFor(run),
        })
      ).kernel;
    }
    return createFileKernel({
      ...options.kernel,
      defaultOwner: owner,
      ownershipMode: "single",
      sessionAllowlistFor: (run) => registry?.guardAllowlistFor(run),
      operatorAuthorityFor: (run) => registry?.operatorAuthorityFor(run),
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
      onSkillsChanged() {
        options.kernel.onSkillsChanged?.();
        skillsRevision++;
      },
    });
  })();
  const prices = new Map<string, ModelCost>();
  const disconnections = new Set<Promise<void>>();
  const roles = new Map<string, HostingPeer["role"]>();
  let maintenance = false;
  let closing: Promise<void> | undefined;
  const goalServices = new Map<string, ReturnType<typeof createGoalService>>();
  let goalControls = 0;
  const assertWritable = (): void => {
    if (closing !== undefined || maintenance || restartRequested)
      throw kernelError("conflict", "host maintenance or shutdown is in progress");
  };
  try {
    const sessions = createHostedSessionCoordinator({
      logger,
      goalChanged: (sessionId) => goalChanges.notify(sessionId),
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
      async prepareExecution(params, context) {
        await options.assertAuthority?.();
        assertWritable();
        const catalog = await kernel.models.get();
        prices.clear();
        for (const provider of catalog.providers)
          for (const model of provider.models)
            if (model.cost !== undefined) prices.set(`${provider.id}/${model.id}`, model.cost);
        const extension = await kernel.extensionProfiles.current();
        const prepareExecution = async (policy?: GoalExecutionPolicy) => {
          assertWritable();
          context.signal.throwIfAborted();
          const prepared = kernel.prepareRun(params, owner, policy);
          return {
            detachable: prepared.detachable,
            config: {
              agent: prepared.agent,
              ...(prepared.model === undefined ? {} : { model: prepared.model }),
              extension_profile: { id: extension.id, fingerprint: extension.fingerprint },
              runtime: structuredClone(kernel.runtime),
            },
            async start() {
              await options.assertAuthority?.();
              assertWritable();
              context.signal.throwIfAborted();
              if (context.conversation !== undefined)
                registry!.assertController(context.conversation);
              return operator!.withSession(context.session.id, () => prepared.start());
            },
          };
        };
        const goal = context.session.goal_state?.current;
        if (goal === undefined || goal.status === "complete" || goal.status === "cancelled")
          return prepareExecution();
        if (context.conversation === undefined)
          throw kernelError(
            "conflict",
            "Goal requires explicit resume by a live conversation controller",
          );
        registry!.assertController(context.conversation);
        return prepareHostedGoalTurn({
          params,
          context,
          repository,
          steward: {
            runtime: (limit, ttl) => kernel.goalStewardRuntime(limit, ttl, owner),
            readTrace: (executionId) => kernel.readRunTrace(executionId, owner),
            readFile: (path) => kernel.files.readFile(path),
            async settle(mutate, usage, accounting) {
              await sessions.transact(context.session.id, (session) => {
                const current = goalStateFromSession(session);
                if (!current) throw kernelError("conflict", "Goal Steward session disappeared");
                const result = mutate(current);
                session.goal_state = goalStateToDto(result.state);
                if (result.charged)
                  addGoalAuxiliaryUsage(session.totals, usage, accounting, (model) =>
                    prices.get(model),
                  );
                return { session, result: undefined };
              });
            },
          },
          sessions: sessions.sessions,
          evidence: createGoalEvidenceSource({
            executionId: params.execution_id!,
            workspaceRoot: options.kernel.workspaceRoot,
            readTrace: (executionId) => kernel.readRunTrace(executionId, owner),
          }),
          async validateDefinitionSources(sources) {
            for (const source of sources) {
              try {
                const current = await kernel.files.readFile(source.path);
                if (createHash("sha256").update(current.content).digest("hex") !== source.digest)
                  return false;
              } catch {
                return false;
              }
            }
            return true;
          },
          readRun: async (executionId) => {
            try {
              return await kernel.runs.get(executionId);
            } catch (error) {
              if (toKernelError(error).code === "not_found") return null;
              throw error;
            }
          },
          prepareExecution,
          logger,
          priceFor: (model) => prices.get(model),
          onChange: (sessionId) => goalChanges.notify(sessionId),
        });
      },
    });
    const repository = createGoalRepository(sessions.sessions, sessions);
    registry = createHostedRegistry({
      ...options.storage,
      hostGeneration: options.hostGeneration,
      workspaceId: kernel.workspace.id,
      owner: workspaceScopeKey(owner, kernel.project.id, kernel.workspace.id),
      prepare: sessions.prepare,
      archiveRecovery: sessions.archiveRecovery,
      logger,
      assertStartAllowed: assertWritable,
      executionChanged: (sessionId) => goalChanges.notify(sessionId),
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
        owned.hasPendingContinuation() ||
        goalControls > 0 ||
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
        skills_revision: skillsRevision,
        runtime: kernel.runtime,
        ...(runtimeNotice === undefined ? {} : { runtime_notice: runtimeNotice }),
        ...(extensionDrift === undefined ? {} : { extension_drift: extensionDrift }),
        restart_requested: restartRequested,
      }),
      canControl: (peerId, sessionId) => owned.controlsConversation(peerId, sessionId),
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
      goals: goalServices.get(peerId)?.service ?? unavailableGoalService(),
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
        const goalAgentAvailability = kernel.goalAgentRuntime(owner);
        goalServices.set(
          connection.peer.id,
          createGoalService({
            peerId: connection.peer.id,
            repository,
            sessions: sessions.sessions,
            registry: owned,
            assertAuthority: async () => {
              await options.assertAuthority?.();
            },
            assertWritable,
            beginControl() {
              assertWritable();
              if (goalControls >= 4)
                throw kernelError("resource_exhausted", "Too many goal controls are pending");
              goalControls++;
              return () => {
                goalControls--;
              };
            },
            defaultLimits: async () => {
              const settings = goalsSettingsSchema.parse(
                (await kernel.config.getSettings()).merged.goals ?? {},
              );
              return {
                max_auto_continuations: settings.max_auto_continuations,
                max_no_progress_checkpoints: settings.max_no_progress_checkpoints,
                ...(settings.max_net_tokens === undefined
                  ? {}
                  : { max_net_tokens: settings.max_net_tokens }),
                ...(settings.deadline_at === undefined
                  ? {}
                  : { deadline_at: settings.deadline_at }),
              };
            },
            entryTokenLimit: (params) => kernel.prepareRun(params, owner).tokenLimit,
            logger,
            subscribe: async (sessionId, listener) => goalChanges.subscribe(sessionId, listener),
            transactions: sessions,
            readRun: async (executionId) => {
              try {
                return await kernel.runs.get(executionId);
              } catch (error) {
                if (toKernelError(error).code === "not_found") return null;
                throw error;
              }
            },
            readTrace: (executionId) => kernel.readRunTrace(executionId, owner),
            readWorkspaceFile: (path) => kernel.files.readFile(path),
            priceFor: (model) => prices.get(model),
            formulateRun: (input) => kernel.goalAgentRuntime(owner).run(input),
            workspaceReadAvailable: goalAgentAvailability.workspaceReadAvailable,
          }),
        );
        return {
          principal: { id: connection.peer.id },
          workspace: kernel.workspace,
          project: kernel.project,
          services: servicesFor(
            connection.service,
            connection.peer.id,
            role === "operator" && exposeLocalControls
              ? ownedOperator.connect(connection.peer.id)
              : undefined,
          ),
          capabilities: {
            ...kernel.capabilities,
            hosting: {
              host_generation: options.hostGeneration,
              ...(options.exposeDefaultOwner === true ? { default_owner: owner } : {}),
            },
            goals: true,
            ...(role === "operator" && exposeLocalControls ? { local_host: true as const } : {}),
          },
          close() {
            roles.delete(connection.peer.id);
            ownedOperator.disconnect(connection.peer.id);
            const pending = bestEffort(
              async () => {
                await connection.close();
                await goalServices.get(connection.peer.id)?.close();
                goalServices.delete(connection.peer.id);
              },
              {
                operation: "hosting.connection.close",
                logger,
              },
            );
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
          const goalSettled = await Promise.allSettled(
            [...goalServices.values()].map((service) => service.close()),
          );
          await kernel.close();
          goalChanges.close();
          const failure = [...settled, ...goalSettled].find((value) => value.status === "rejected");
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
