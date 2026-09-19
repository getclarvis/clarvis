import type {
  ListWorkspaceChangesRequest,
  ReadWorkspaceChangeRequest,
  WorkspaceChangesAvailability,
  WorkspaceChangeDetail,
  WorkspaceChangesPage,
} from "@clarvis/protocol";

/** Host-built context for one workspace-changes probe or read. */
export interface WorkspaceChangesContext {
  /** Admitted workspace root; inventory never includes paths outside it. */
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly signal?: AbortSignal;
}

/**
 * Kernel-internal changes adapter.
 *
 * Public DTOs stay in Protocol. A second backend implements this port and is
 * registered on the workspace-changes service; the TUI never branches on provider id.
 */
export interface WorkspaceChangesProvider {
  readonly id: string;
  probe(context: WorkspaceChangesContext): Promise<WorkspaceChangesAvailability>;
  listChanges(
    context: WorkspaceChangesContext,
    request: ListWorkspaceChangesRequest,
  ): Promise<WorkspaceChangesPage>;
  readChange(
    context: WorkspaceChangesContext,
    request: ReadWorkspaceChangeRequest,
  ): Promise<WorkspaceChangeDetail>;
}
