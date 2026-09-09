import type {
  CreateFileKernelOptions,
  LocalKernelLaunchOptions,
  RuntimePlacementNotice,
} from "@clarvis/kernel/bootstrap";
import { ownerFromWorkspace } from "@clarvis/paths";
import type { KernelClient, LocalHostStatus, WorkspaceRef } from "@clarvis/protocol";
import { detachObserved } from "../core/tasks.ts";
import { resolveLocalKernelArtifact } from "./local-kernel-artifact.ts";
import { sanitizeErrorMessage } from "@clarvis/kernel/policy";
import type { ReconnectMode } from "./connection-state.ts";

type ExtensionDriftNotice = NonNullable<LocalHostStatus["extension_drift"]>;

async function connectLocalKernel(options: LocalKernelLaunchOptions) {
  const { connectOrLaunchLocalKernel } = await import("@clarvis/kernel/bootstrap");
  return connectOrLaunchLocalKernel(options);
}

export interface ManagedWorkspaceClient {
  readonly client: KernelClient;
  readonly workspace: WorkspaceRef;
  release(): Promise<void>;
}

/** Operator-selected process identity and client-local browser authority; no callbacks cross RPC. */
export interface WorkspaceClientOptions extends Pick<
  CreateFileKernelOptions,
  "workspaceRoot" | "globalDir" | "defaultOwner" | "extensionProfileSelector" | "logger"
> {
  openMcpAuthorizationUrl?: (url: string) => Promise<boolean>;
}

/** Process discovery ports, injectable without replacing module-global transports. */
export interface WorkspaceClientDependencies {
  resolveArtifact?: typeof resolveLocalKernelArtifact;
  connectHost?: (options: LocalKernelLaunchOptions) => Promise<{ client: KernelClient }>;
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
  private readonly runtimeListeners = new Set<(notice: RuntimePlacementNotice) => void>();
  private readonly connectionListeners = new Set<(reason: string) => void>();
  private connectionFailure: string | undefined;
  private readonly browserAttempts = new Set<string>();
  private reconnecting: { mode: ReconnectMode; task: Promise<void> } | undefined;

  private constructor(
    private kernel: KernelClient,
    private readonly options: WorkspaceClientOptions,
    private readonly launch: LocalKernelLaunchOptions,
    readonly defaultOwner: string,
    private readonly connectHost: NonNullable<WorkspaceClientDependencies["connectHost"]>,
  ) {}

  static async create(
    options: WorkspaceClientOptions,
    deps: WorkspaceClientDependencies = {},
  ): Promise<WorkspaceClientManager> {
    const artifact = await (deps.resolveArtifact ?? resolveLocalKernelArtifact)();
    const defaultOwner = options.defaultOwner ?? ownerFromWorkspace(options.workspaceRoot);
    const selector = options.extensionProfileSelector;
    const launch: LocalKernelLaunchOptions = {
      ...artifact,
      artifactId: artifact.artifactId + ":" + (selector ?? "selected"),
      workspaceRoot: options.workspaceRoot,
      globalDir: options.globalDir,
      owner: defaultOwner,
      logger: options.logger,
      environment: { ...process.env, CLARVIS_HOST_EXTENSION_PROFILE: selector },
    };
    const connectHost = deps.connectHost ?? connectLocalKernel;
    const { client } = await connectHost(launch);
    if (client.localHost === undefined) {
      await client.close();
      throw new Error("workspace host does not advertise local application controls");
    }
    const manager = new WorkspaceClientManager(client, options, launch, defaultOwner, connectHost);
    try {
      await manager.refresh();
    } catch (error) {
      await client.close();
      throw error;
    }
    manager.schedule();
    return manager;
  }

  get project() {
    return this.kernel.project;
  }
  get current() {
    return this.kernel.workspace;
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
    return () => this.runtimeListeners.delete(listener);
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
    if (this.closed || this.reconnecting !== undefined) return;
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

  /** Retry placement only through the host's quiescent operator admission. */
  retryRuntime(): void {
    if (this.closed) return;
    detachObserved("hosting.runtime.retry", async () => {
      try {
        await this.kernel.localHost!.retryRuntime();
        await this.refresh();
      } catch (error) {
        if (this.status !== undefined)
          for (const listener of this.runtimeListeners)
            listener({ status: this.status.runtime, message: sanitizeErrorMessage(String(error)) });
      }
    });
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
      if (mode === "reload") await previous.localHost!.requestRestart();
      clearTimeout(this.timer);
      if (mode === "reload") await previous.close();
      const { client } = await this.connectHost(this.launch);
      let state: LocalHostStatus;
      try {
        if (client.localHost === undefined)
          throw new Error("workspace host does not advertise local application controls");
        state = await client.localHost.inspect();
        if (mode === "connection") await previous.close();
        if (this.closed) throw new Error("workspace client is closed");
      } catch (error) {
        await client.close();
        throw error;
      }
      this.kernel = client;
      this.status = undefined;
      this.connectionFailure = undefined;
      this.browserAttempts.clear();
      if (!this.closed) this.publishStatus(state);
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
    await this.kernel.close();
    this.driftListeners.clear();
    this.runtimeListeners.clear();
    this.connectionListeners.clear();
  }
}
