import type {
  createFileKernel as CreateFileKernel,
  CreateFileKernelOptions,
} from "@clarvis/kernel/bootstrap";
import { ownerFromWorkspace } from "@clarvis/paths";
import type { KernelClient, WorkspaceRef } from "@clarvis/protocol";

type FileKernelFactory = typeof CreateFileKernel;
type ManagedFileKernel = Awaited<ReturnType<FileKernelFactory>>;

export async function loadFileKernelFactory(): Promise<FileKernelFactory> {
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
  ) {}

  static async create(options: WorkspaceClientOptions): Promise<WorkspaceClientManager> {
    const createFileKernel = await loadFileKernelFactory();
    const defaultOwner = options.defaultOwner ?? ownerFromWorkspace(options.workspaceRoot);
    const resolved = { ...options, defaultOwner };
    return new WorkspaceClientManager(
      await createFileKernel(resolved),
      resolved,
      defaultOwner,
      createFileKernel,
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

  /** Rebuild the same workspace kernel during an explicit backend reconnect. */
  async invalidate(workspaceId: string): Promise<void> {
    if (workspaceId !== this.current.id) throw new Error("this process is pinned to one workspace");
    await this.kernel.close();
    this.kernel = await this.createKernel(this.options);
    if (this.memoryRecoveryStarted) this.kernel.startMemoryRecovery();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.kernel.close();
  }
}
