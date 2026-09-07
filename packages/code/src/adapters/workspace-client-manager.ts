import type {
  createFileKernel as CreateFileKernel,
  CreateFileKernelOptions,
  ExtensionProfileDriftNotice,
  RuntimePlacementNotice,
} from "@clarvis/kernel/bootstrap";
import { ownerFromWorkspace } from "@clarvis/paths";
import type { KernelClient, WorkspaceRef } from "@clarvis/protocol";
import { productVersion } from "../cli-args.ts";

type FileKernelFactory = typeof CreateFileKernel;
type ManagedFileKernel = Awaited<ReturnType<FileKernelFactory>>;

interface ExtensionProfileDriftChannel {
  latest?: ExtensionProfileDriftNotice;
  listeners: Set<(notice: ExtensionProfileDriftNotice) => void>;
}

interface RuntimePlacementChannel {
  latest?: RuntimePlacementNotice;
  listeners: Set<(notice: RuntimePlacementNotice) => void>;
}

async function loadFileKernelFactory(): Promise<FileKernelFactory> {
  const loaded = await import("@clarvis/kernel/bootstrap");
  return loaded.createFileKernel;
}

export interface ManagedWorkspaceClient {
  readonly client: KernelClient;
  readonly workspace: WorkspaceRef;
  release(): Promise<void>;
}

/** Options for the process's single immutable workspace client. */
export type WorkspaceClientOptions = CreateFileKernelOptions;

/**
 * Owns exactly one file kernel for the workspace chosen before boot.
 *
 * The previous project navigator cached kernels for every linked worktree and searched sessions
 * across them. A Clarvis process is now pinned to one canonical checkout, so the manager is only a
 * small lifetime wrapper and Git remains the worktree registry.
 */
export class WorkspaceClientManager {
  private closed = false;
  private memoryRecoveryStarted = false;

  private constructor(
    private kernel: ManagedFileKernel,
    private readonly options: WorkspaceClientOptions,
    readonly defaultOwner: string,
    private readonly createKernel: FileKernelFactory,
    private readonly extensionProfileDrift: ExtensionProfileDriftChannel,
    private readonly runtimePlacement: RuntimePlacementChannel,
  ) {}

  static async create(options: WorkspaceClientOptions): Promise<WorkspaceClientManager> {
    const createFileKernel = await loadFileKernelFactory();
    const defaultOwner = options.defaultOwner ?? ownerFromWorkspace(options.workspaceRoot);
    const extensionProfileDrift: ExtensionProfileDriftChannel = { listeners: new Set() };
    const runtimePlacement: RuntimePlacementChannel = { listeners: new Set() };
    const originalExtensionProfileDrift = options.onExtensionProfileDrift;
    const originalRuntimePlacement = options.onRuntimePlacement;
    const publishRuntimePlacement = (notice: RuntimePlacementNotice): void => {
      runtimePlacement.latest = notice;
      originalRuntimePlacement?.(notice);
      for (const listener of runtimePlacement.listeners) listener(notice);
    };
    const resolved = {
      ...options,
      runtimeFactory:
        options.runtimeFactory ??
        ({
          create: async (input) => {
            const local = await import("@clarvis/kernel/local");
            if (input.settings.backend !== "docker") return local.createLocalPodmanRuntime(input);
            return local.createLocalDockerRuntime(input, {
              onRecipePreparation: (name) => {
                const status = runtimePlacement.latest?.status;
                if (status === undefined) return;
                publishRuntimePlacement({
                  status,
                  message: `Preparing Docker runtime recipe '${name}' for first use…`,
                });
              },
              resolveImage: async () => {
                const { resolveClarvisRuntimeImage } = await import("./runtime-image.ts");
                return resolveClarvisRuntimeImage({ currentVersion: productVersion() });
              },
            });
          },
        } satisfies NonNullable<WorkspaceClientOptions["runtimeFactory"]>),
      defaultOwner,
      onExtensionProfileDrift: (notice: ExtensionProfileDriftNotice): void => {
        extensionProfileDrift.latest = notice;
        originalExtensionProfileDrift?.(notice);
        for (const listener of extensionProfileDrift.listeners) listener(notice);
      },
      onRuntimePlacement: publishRuntimePlacement,
    };
    const kernel = await createFileKernel(resolved);
    runtimePlacement.latest = { status: kernel.runtime };
    return new WorkspaceClientManager(
      kernel,
      resolved,
      defaultOwner,
      createFileKernel,
      extensionProfileDrift,
      runtimePlacement,
    );
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

  /** Release durable memory recovery only after the interactive shell is usable. */
  startMemoryRecovery(): void {
    if (this.closed || this.memoryRecoveryStarted) return;
    this.memoryRecoveryStarted = true;
    this.kernel.startMemoryRecovery();
  }

  /** Subscribe to non-blocking extension withdrawal notices, replaying the latest one. */
  subscribeExtensionProfileDrift(
    listener: (notice: ExtensionProfileDriftNotice) => void,
  ): () => void {
    if (this.closed) return () => {};
    this.extensionProfileDrift.listeners.add(listener);
    if (this.extensionProfileDrift.latest !== undefined)
      listener(this.extensionProfileDrift.latest);
    return () => this.extensionProfileDrift.listeners.delete(listener);
  }

  /** Subscribe to lazy runtime placement transitions, replaying current placement. */
  subscribeRuntimePlacement(listener: (notice: RuntimePlacementNotice) => void): () => void {
    if (this.closed) return () => {};
    this.runtimePlacement.listeners.add(listener);
    if (this.runtimePlacement.latest !== undefined) listener(this.runtimePlacement.latest);
    return () => this.runtimePlacement.listeners.delete(listener);
  }

  /** Retry a Docker placement after the coordinator latched a sandbox fallback. */
  retryRuntime(): void {
    if (this.closed) return;
    this.kernel.retryRuntime();
  }

  /** Rebuild the same workspace kernel during an explicit backend reconnect. */
  async invalidate(workspaceId: string): Promise<void> {
    if (workspaceId !== this.current.id) throw new Error("this process is pinned to one workspace");
    await this.kernel.close();
    this.kernel = await this.createKernel(this.options);
    const notice = { status: this.kernel.runtime };
    this.runtimePlacement.latest = notice;
    for (const listener of this.runtimePlacement.listeners) listener(notice);
    if (this.memoryRecoveryStarted) this.kernel.startMemoryRecovery();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.kernel.close();
    this.extensionProfileDrift.listeners.clear();
    this.runtimePlacement.listeners.clear();
  }
}
