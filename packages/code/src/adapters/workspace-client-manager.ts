import {
  createFileKernel,
  type CreateFileKernelOptions,
  ownerFromWorkspace,
} from "@clarvis/kernel/bootstrap";
import type { KernelClient, WorkspaceRef } from "@clarvis/protocol";

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

  private constructor(
    private kernel: Awaited<ReturnType<typeof createFileKernel>>,
    private readonly options: WorkspaceClientOptions,
    readonly defaultOwner: string,
  ) {}

  static async create(options: WorkspaceClientOptions): Promise<WorkspaceClientManager> {
    const defaultOwner = options.defaultOwner ?? ownerFromWorkspace(options.workspaceRoot);
    const resolved = { ...options, defaultOwner };
    return new WorkspaceClientManager(await createFileKernel(resolved), resolved, defaultOwner);
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

  /** Rebuild the same workspace kernel during an explicit backend reconnect. */
  async invalidate(workspaceId: string): Promise<void> {
    if (workspaceId !== this.current.id) throw new Error("this process is pinned to one workspace");
    await this.kernel.close();
    this.kernel = await createFileKernel(this.options);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.kernel.close();
  }
}
