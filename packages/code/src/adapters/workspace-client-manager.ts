import type {
  CreateFileKernelOptions,
  LocalKernelLaunchOptions,
  RemoteSshKernelOptions,
  RuntimePlacementNotice,
  ConnectLocalContainerKernelOptions,
  LaunchedContainerKernel,
} from "@clarvis/kernel/bootstrap";
import { ownerFromWorkspace } from "@clarvis/paths";
import type { KernelClient, LocalHostStatus, WorkspaceRef } from "@clarvis/protocol";
import { detachObserved } from "../core/tasks.ts";
import { resolveLocalKernelArtifact } from "./local-kernel-artifact.ts";
import { sanitizeErrorMessage } from "@clarvis/kernel/policy";
import type { ReconnectMode } from "./connection-state.ts";
import { encodeRemoteKernelArguments } from "./remote-kernel-arguments.ts";
import { codeHostEnvironment } from "./host-kernel-options.ts";
import { composeContainerClient } from "./container-client.ts";
import { productVersion } from "../cli-args.ts";
import { resolveClarvisContainerRelease } from "./runtime-image.ts";

type ExtensionDriftNotice = NonNullable<LocalHostStatus["extension_drift"]>;

async function connectLocalKernel(options: LocalKernelLaunchOptions) {
  const { connectOrLaunchLocalKernel } = await import("@clarvis/kernel/bootstrap");
  return connectOrLaunchLocalKernel(options);
}

async function connectRemoteKernel(options: RemoteSshKernelOptions) {
  const { connectRemoteKernelOverSsh } = await import("@clarvis/kernel/bootstrap");
  return connectRemoteKernelOverSsh(options);
}

async function connectContainerKernel(options: ConnectLocalContainerKernelOptions) {
  const { connectLocalContainerKernel } = await import("@clarvis/kernel/bootstrap");
  const launched = await connectLocalContainerKernel(options);
  return composeLaunchedContainerConnection(launched);
}

/** Compose one admitted launch and retire all of its resources if validation fails. */
export async function composeLaunchedContainerConnection(launched: LaunchedContainerKernel) {
  try {
    const runtime = launched.client.capabilities.runtime;
    if (runtime?.kind !== "container")
      throw new Error("Container Kernel did not report Container placement");
    const configurationListeners = new Set<
      (kind: "settings" | "agents" | "context" | "models") => void
    >();
    return {
      client: composeContainerClient({
        execution: launched.client,
        operator: launched.operator,
        project: launched.project,
        workspace: launched.workspace,
        principal: launched.client.principal,
        capabilities: { ...launched.client.capabilities, runtime },
        dispose: () => launched.close(),
        onConfigurationSaved: (kind) => {
          for (const listener of configurationListeners) listener(kind);
        },
      }),
      closed: launched.closed,
      subscribeConfigurationSaved: (
        listener: (kind: "settings" | "agents" | "context" | "models") => void,
      ) => {
        configurationListeners.add(listener);
        return () => configurationListeners.delete(listener);
      },
    };
  } catch (error) {
    await launched.close();
    throw error;
  }
}

interface WorkspaceConnection {
  client: KernelClient;
  closed?: Promise<string>;
  subscribeConfigurationSaved?: (
    listener: (kind: "settings" | "agents" | "context" | "models") => void,
  ) => () => void;
}

export interface ManagedWorkspaceClient {
  readonly client: KernelClient;
  readonly workspace: WorkspaceRef;
  release(): Promise<void>;
}

/** Identify only the connector's typed live-Container ownership conflict. */
export function isContainerKernelOwnershipConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("details" in error)) return false;
  const details = error.details;
  return (
    typeof details === "object" &&
    details !== null &&
    "kind" in details &&
    details.kind === "container_kernel_owned"
  );
}

/** Operator-selected process identity and client-local browser authority; no callbacks cross RPC. */
export interface WorkspaceClientOptions extends Pick<
  CreateFileKernelOptions,
  "workspaceRoot" | "defaultOwner" | "extensionProfileSelector" | "logger"
> {
  globalDir: string;
  openMcpAuthorizationUrl?: (url: string) => Promise<boolean>;
  onContainerProgress?: ConnectLocalContainerKernelOptions["onProgress"];
  /** One-shot interactive decision to retire the exact registered Container Kernel. */
  containerOwnershipConflict?: "refuse" | "terminate";
  /** Explicit process destination. Omission resolves local versus Container from operator settings. */
  destination?:
    | { readonly kind: "local" }
    | {
        readonly kind: "ssh";
        readonly destination: string;
        readonly workspace: string;
        readonly executable?: string;
      }
    | { readonly kind: "container" };
}

/** Process discovery ports, injectable without replacing module-global transports. */
export interface WorkspaceClientDependencies {
  resolveArtifact?: typeof resolveLocalKernelArtifact;
  connectHost?: (options: LocalKernelLaunchOptions) => Promise<{ client: KernelClient }>;
  connectRemoteHost?: (options: RemoteSshKernelOptions) => Promise<WorkspaceConnection>;
  connectContainerHost?: (
    options: ConnectLocalContainerKernelOptions,
  ) => Promise<WorkspaceConnection>;
  resolveContainerRelease?: typeof resolveClarvisContainerRelease;
}

type WorkspaceDestination = NonNullable<WorkspaceClientOptions["destination"]>;

interface WorkspaceConnectionPlan {
  readonly destination: WorkspaceDestination;
  readonly defaultOwner: string;
  readonly connectHost: () => Promise<WorkspaceConnection>;
}

async function selectedDestination(options: WorkspaceClientOptions): Promise<WorkspaceDestination> {
  if (options.destination !== undefined) return options.destination;
  const { createOperatorServices } = await import("@clarvis/kernel/bootstrap");
  const operator = createOperatorServices({
    workspaceRoot: options.workspaceRoot,
    globalDir: options.globalDir,
    logger: options.logger,
    subscriptions: false,
  });
  try {
    const runtime = operator.configStore.readSettings().operator_merged?.runtime;
    return typeof runtime === "object" &&
      runtime !== null &&
      "backend" in runtime &&
      (runtime.backend === "docker" || runtime.backend === "podman")
      ? { kind: "container" }
      : { kind: "local" };
  } finally {
    await operator.close();
  }
}

/** Read whether startup is currently pinned to a Container engine without opening a Kernel. */
export async function isContainerWorkspaceDestination(
  options: WorkspaceClientOptions,
): Promise<boolean> {
  return (await selectedDestination(options)).kind === "container";
}

async function connectionPlan(
  options: WorkspaceClientOptions,
  deps: WorkspaceClientDependencies,
  requestedDestination?: WorkspaceDestination,
): Promise<WorkspaceConnectionPlan> {
  const destination = requestedDestination ?? (await selectedDestination(options));
  const selector = options.extensionProfileSelector;
  if (destination.kind === "local") {
    const artifact = await (deps.resolveArtifact ?? resolveLocalKernelArtifact)();
    const defaultOwner = options.defaultOwner ?? ownerFromWorkspace(options.workspaceRoot);
    const launch: LocalKernelLaunchOptions = {
      ...artifact,
      artifactId: artifact.artifactId + ":" + (selector ?? "selected"),
      workspaceRoot: options.workspaceRoot,
      globalDir: options.globalDir,
      owner: defaultOwner,
      logger: options.logger,
      environment: codeHostEnvironment({
        ...process.env,
        CLARVIS_HOST_EXTENSION_PROFILE: selector,
      }),
    };
    const connect = deps.connectHost ?? connectLocalKernel;
    return { destination, defaultOwner, connectHost: () => connect(launch) };
  }
  if (destination.kind === "ssh") {
    const payload = encodeRemoteKernelArguments({
      workspaceRoot: destination.workspace,
      ...(selector === undefined ? {} : { extensionProfileSelector: selector }),
    });
    const launch: RemoteSshKernelOptions = {
      destination: destination.destination,
      workspace: destination.workspace,
      remoteCommand: [destination.executable ?? "clarvis", "--remote-kernel", payload],
      logger: options.logger,
    };
    const connect = deps.connectRemoteHost ?? connectRemoteKernel;
    return { destination, defaultOwner: "", connectHost: () => connect(launch) };
  }
  const defaultOwner = options.defaultOwner ?? ownerFromWorkspace(options.workspaceRoot);
  const connect = deps.connectContainerHost ?? connectContainerKernel;
  const resolveRelease = deps.resolveContainerRelease ?? resolveClarvisContainerRelease;
  const { createOperatorServices } = await import("@clarvis/kernel/bootstrap");
  const operator = createOperatorServices({
    workspaceRoot: options.workspaceRoot,
    globalDir: options.globalDir,
    logger: options.logger,
    subscriptions: false,
  });
  let runtime: unknown;
  try {
    runtime = operator.configStore.readSettings().operator_merged?.runtime;
  } finally {
    await operator.close();
  }
  if (
    typeof runtime !== "object" ||
    runtime === null ||
    !("backend" in runtime) ||
    (runtime.backend !== "docker" && runtime.backend !== "podman")
  )
    throw new Error("Container destination requires a Docker or Podman runtime setting");
  const containerRuntime = runtime as ConnectLocalContainerKernelOptions["runtime"];
  return {
    destination,
    defaultOwner,
    connectHost: async () => {
      return connect({
        workspaceRoot: options.workspaceRoot,
        globalDir: options.globalDir,
        owner: defaultOwner,
        runtime: containerRuntime,
        resolveRelease: (target, signal) =>
          resolveRelease({ currentVersion: productVersion(), target, signal }),
        logger: options.logger,
        environment: process.env,
        ...(options.onContainerProgress === undefined
          ? {}
          : { onProgress: options.onContainerProgress }),
        ...(options.containerOwnershipConflict === undefined
          ? {}
          : { ownershipConflict: options.containerOwnershipConflict }),
      });
    },
  };
}

async function admitConnection(
  plan: WorkspaceConnectionPlan,
  client: KernelClient,
  expectedOwner?: string,
): Promise<string> {
  if (plan.destination.kind === "local") {
    if (client.localHost === undefined)
      throw new Error("workspace host does not advertise local application controls");
    if (expectedOwner !== undefined && plan.defaultOwner !== expectedOwner)
      throw new Error("workspace host identity changed during reconnect");
    return plan.defaultOwner;
  }
  if (client.localHost !== undefined)
    throw new Error("remote workspace host unexpectedly exposes machine-local controls");
  const advertised = client.capabilities.hosting?.default_owner ?? "";
  if (advertised.length === 0)
    throw new Error("remote workspace host does not advertise its session namespace");
  if (
    (plan.destination.kind === "container" && advertised !== plan.defaultOwner) ||
    (expectedOwner !== undefined && advertised !== expectedOwner)
  )
    throw new Error("remote workspace host identity changed during reconnect");
  return advertised;
}

/**
 * Owns one authenticated connection to the independently launched workspace host. Closing this
 * manager releases only the connection. Recovery authenticates a new connection without restarting
 * the host. Explicit reload requests a quiescent restart; active backgrounds refuse that operation.
 */
export class WorkspaceClientManager {
  private closed = false;
  private polling = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private status: LocalHostStatus | undefined;
  private readonly driftListeners = new Set<(notice: ExtensionDriftNotice) => void>();
  private readonly skillsListeners = new Set<(revision: number) => void>();
  private readonly runtimeListeners = new Set<(notice: RuntimePlacementNotice) => void>();
  private readonly connectionListeners = new Set<(reason: string) => void>();
  private connectionFailure: string | undefined;
  private readonly browserAttempts = new Set<string>();
  private readonly retiringClients = new WeakSet<KernelClient>();
  private reconnecting: { mode: ReconnectMode; task: Promise<void> } | undefined;
  private stopConfigurationObservation: (() => void) | undefined;

  private constructor(
    private kernel: KernelClient,
    private readonly options: WorkspaceClientOptions,
    private readonly deps: WorkspaceClientDependencies,
    private destination: WorkspaceDestination,
    public defaultOwner: string,
    private connectHost: () => Promise<WorkspaceConnection>,
    closed?: Promise<string>,
  ) {
    this.observePhysicalClose(kernel, closed);
  }

  static async create(
    options: WorkspaceClientOptions,
    deps: WorkspaceClientDependencies = {},
  ): Promise<WorkspaceClientManager> {
    const plan = await connectionPlan(options, deps);
    const connection = await plan.connectHost();
    const { client } = connection;
    let defaultOwner: string;
    try {
      defaultOwner = await admitConnection(plan, client);
    } catch (error) {
      await client.close();
      throw error;
    }
    const manager = new WorkspaceClientManager(
      client,
      options,
      deps,
      plan.destination,
      defaultOwner,
      plan.connectHost,
      connection.closed,
    );
    manager.observeConfigurationSaved(connection);
    try {
      if (plan.destination.kind === "local") await manager.refresh();
    } catch (error) {
      await client.close();
      throw error;
    }
    if (plan.destination.kind === "local") manager.schedule();
    return manager;
  }

  get project() {
    return this.kernel.project;
  }
  get current() {
    return this.kernel.workspace;
  }

  /** True only when the independently owned local host can outlive this client connection. */
  get backgroundHandoffSurvivesExit(): boolean {
    return this.destination.kind === "local";
  }

  async open(workspaceId = this.current.id): Promise<ManagedWorkspaceClient> {
    if (this.closed) throw new Error("workspace client is closed");
    if (workspaceId !== this.current.id) throw new Error("this process is pinned to one workspace");
    const client: KernelClient = { ...this.kernel, close: async () => {} };
    return { client, workspace: this.current, release: async () => {} };
  }

  subscribeExtensionProfileDrift(listener: (notice: ExtensionDriftNotice) => void): () => void {
    if (this.closed) return () => {};
    this.driftListeners.add(listener);
    if (this.status?.extension_drift !== undefined) listener(this.status.extension_drift);
    return () => this.driftListeners.delete(listener);
  }

  subscribeRuntimePlacement(listener: (notice: RuntimePlacementNotice) => void): () => void {
    if (this.closed) return () => {};
    this.runtimeListeners.add(listener);
    if (this.status !== undefined) listener(this.runtimeNotice(this.status));
    else if (this.kernel.capabilities.runtime !== undefined)
      listener({ status: this.kernel.capabilities.runtime });
    return () => this.runtimeListeners.delete(listener);
  }

  /** Subscribe to host-validated catalog replacements without reconnecting this process. */
  subscribeSkillsChanged(listener: (revision: number) => void): () => void {
    if (this.closed) return () => {};
    this.skillsListeners.add(listener);
    listener(this.status?.skills_revision ?? 0);
    return () => this.skillsListeners.delete(listener);
  }

  /** Report failed host probes without deriving connection health from a runtime placement label. */
  subscribeConnectionFailure(listener: (reason: string) => void): () => void {
    if (this.closed) return () => {};
    this.connectionListeners.add(listener);
    if (this.connectionFailure !== undefined) listener(this.connectionFailure);
    return () => this.connectionListeners.delete(listener);
  }

  private runtimeNotice(status: LocalHostStatus): RuntimePlacementNotice {
    return {
      status: status.runtime,
      ...(status.runtime_notice === undefined ? {} : { message: status.runtime_notice.message }),
    };
  }

  private observePhysicalClose(client: KernelClient, closed?: Promise<string>): void {
    if (closed === undefined) return;
    void closed
      .then((reason) => {
        if (this.closed || this.kernel !== client || this.retiringClients.has(client)) return;
        this.connectionFailure = sanitizeErrorMessage(reason);
        for (const listener of this.connectionListeners) listener(this.connectionFailure);
      })
      .catch((error: unknown) => {
        if (this.closed || this.kernel !== client || this.retiringClients.has(client)) return;
        this.connectionFailure = sanitizeErrorMessage(String(error));
        for (const listener of this.connectionListeners) listener(this.connectionFailure);
      });
  }

  private observeConfigurationSaved(connection: WorkspaceConnection): void {
    this.stopConfigurationObservation?.();
    this.stopConfigurationObservation = connection.subscribeConfigurationSaved?.((kind) => {
      if (this.closed || this.destination.kind !== "container") return;
      const status = this.kernel.capabilities.runtime;
      if (status === undefined) return;
      const label = kind === "models" ? "Model catalog" : "Configuration";
      for (const listener of this.runtimeListeners)
        listener({
          status,
          message: `${label} saved on the host; the active Container keeps its immutable projection until reconnect`,
          pendingReconnect: true,
        });
    });
  }

  private async refresh(): Promise<void> {
    const client = this.kernel;
    const state = await client.localHost!.inspect();
    if (this.closed || this.kernel !== client) return;
    this.publishStatus(state);
    if (this.options.openMcpAuthorizationUrl === undefined) return;
    const request = await client.localHost!.takeBrowserRequest();
    if (
      request === null ||
      this.closed ||
      this.kernel !== client ||
      this.browserAttempts.has(request.id)
    )
      return;
    this.browserAttempts.add(request.id);
    try {
      const opened = await this.options.openMcpAuthorizationUrl(request.url);
      if (!this.closed && this.kernel === client)
        await client.localHost!.respondBrowser(request.id, opened);
    } finally {
      if (this.browserAttempts.size > 128)
        this.browserAttempts.delete(this.browserAttempts.values().next().value!);
    }
  }

  private publishStatus(state: LocalHostStatus): void {
    const previous = this.status;
    this.status = state;
    if (previous?.skills_revision !== state.skills_revision) {
      for (const listener of this.skillsListeners) listener(state.skills_revision ?? 0);
    }
    if (
      previous?.extension_drift?.sequence !== state.extension_drift?.sequence &&
      state.extension_drift !== undefined
    )
      for (const listener of this.driftListeners) listener(state.extension_drift);
    if (
      JSON.stringify(previous?.runtime) !== JSON.stringify(state.runtime) ||
      previous?.runtime_notice?.sequence !== state.runtime_notice?.sequence
    )
      for (const listener of this.runtimeListeners) listener(this.runtimeNotice(state));
  }

  private schedule(): void {
    if (this.closed || this.reconnecting !== undefined || this.destination.kind !== "local") return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.polling) return;
      this.polling = true;
      const client = this.kernel;
      detachObserved("hosting.operator.poll", async () => {
        let failed = false;
        try {
          await this.refresh();
        } catch (error) {
          if (!this.closed && this.kernel === client) {
            failed = true;
            this.connectionFailure = sanitizeErrorMessage(String(error));
            for (const listener of this.connectionListeners) listener(this.connectionFailure);
            if (this.status !== undefined)
              for (const listener of this.runtimeListeners)
                listener({
                  status: this.status.runtime,
                  message:
                    "Workspace host connection needs attention; use /reconnect: " +
                    this.connectionFailure,
                });
          }
        } finally {
          this.polling = false;
        }
        if (!failed) this.schedule();
      });
    }, 500);
    this.timer.unref?.();
  }

  /** Replace a lost connection without requesting restart, runtime retry or execution replay. */
  recover(workspaceId: string): Promise<void> {
    return this.reconnect(workspaceId, "connection");
  }

  /** Apply saved configuration only after the current host accepts an explicit idle restart. */
  invalidate(workspaceId: string): Promise<void> {
    return this.reconnect(workspaceId, "reload");
  }

  private async reconnect(workspaceId: string, mode: ReconnectMode): Promise<void> {
    if (this.closed) throw new Error("workspace client is closed");
    if (workspaceId !== this.current.id) throw new Error("this process is pinned to one workspace");
    if (this.reconnecting !== undefined) {
      if (this.reconnecting.mode !== mode)
        throw new Error("another workspace connection transition is already in progress");
      return this.reconnecting.task;
    }
    const reconnect = (async () => {
      const previous = this.kernel;
      const previousDestination = this.destination;
      const nextPlan =
        mode === "reload"
          ? await connectionPlan(this.options, this.deps)
          : {
              destination: this.destination,
              defaultOwner: this.defaultOwner,
              connectHost: this.connectHost,
            };
      const retirePrevious = async (): Promise<void> => {
        this.retiringClients.add(previous);
        try {
          await previous.close();
        } catch (error) {
          this.retiringClients.delete(previous);
          throw error;
        }
      };
      if (mode === "reload" && previousDestination.kind === "ssh")
        throw new Error("SSH workspace reload is unavailable; reconnect instead");
      if (mode === "reload" && previousDestination.kind === "container") {
        const runs = await (previous.hosting?.list() ?? []);
        if (runs.some((run) => ["starting", "running", "finishing"].includes(run.execution_state)))
          throw new Error(
            "Container configuration is saved and pending reconnect; stop active runs first",
          );
      }
      if (mode === "reload" && previousDestination.kind === "local") {
        this.retiringClients.add(previous);
        try {
          await previous.localHost!.requestRestart();
        } catch (error) {
          this.retiringClients.delete(previous);
          throw error;
        }
      }
      clearTimeout(this.timer);
      if (mode === "reload" || previousDestination.kind !== "local") {
        await retirePrevious();
      }
      const connection = await nextPlan.connectHost();
      const { client } = connection;
      let state: LocalHostStatus | undefined;
      try {
        await admitConnection(nextPlan, client, this.defaultOwner);
        if (nextPlan.destination.kind === "local") {
          state = await client.localHost!.inspect();
        }
        if (mode === "connection" && previousDestination.kind === "local") {
          await retirePrevious();
        }
        if (this.closed) throw new Error("workspace client is closed");
      } catch (error) {
        await client.close();
        throw error;
      }
      this.kernel = client;
      this.destination = nextPlan.destination;
      this.connectHost = nextPlan.connectHost;
      this.status = undefined;
      this.connectionFailure = undefined;
      this.browserAttempts.clear();
      this.observePhysicalClose(client, connection.closed);
      this.observeConfigurationSaved(connection);
      if (!this.closed && state !== undefined) this.publishStatus(state);
      else if (!this.closed && client.capabilities.runtime !== undefined)
        for (const listener of this.runtimeListeners)
          listener({ status: client.capabilities.runtime });
    })();
    this.reconnecting = { mode, task: reconnect };
    try {
      await reconnect;
    } finally {
      this.reconnecting = undefined;
      this.schedule();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.stopConfigurationObservation?.();
    this.stopConfigurationObservation = undefined;
    await this.kernel.close();
    this.driftListeners.clear();
    this.skillsListeners.clear();
    this.runtimeListeners.clear();
    this.connectionListeners.clear();
  }
}
