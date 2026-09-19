/**
 * Workspace-changes control plane — VCS-agnostic inventory and patch detail.
 *
 * The UI never sends arbitrary commands or free paths. Adapters (Git, …) live in
 * the kernel and convert their native output into these DTOs. Comparison IDs,
 * bases, and query/entry IDs are opaque and bound to the active provider.
 */

import type { KernelAbortSignal } from "./transport.ts";

/** Whether a changes provider can serve the bound workspace. */
export type WorkspaceChangesStatus = "available" | "not_applicable" | "unavailable";

/** Safe, operator-facing reason when a provider cannot serve the workspace. */
export interface WorkspaceChangesReason {
  /** Stable machine code such as `executable_missing` or `not_a_repository`. */
  code: string;
  /** Human-readable message with no secret or host-path leakage beyond the workspace label. */
  message: string;
}

/** One comparison the active provider can compute. */
export interface WorkspaceChangeComparison {
  /** Opaque comparison id, unique for this provider. */
  id: string;
  /** Short label for selectors (`All`, `Staged`, `Unstaged`). */
  label: string;
  /** One-line explanation of what the comparison shows. */
  description: string;
  /** Opaque resolved bases for the header; keys and values are adapter-defined. */
  bases?: Readonly<Record<string, string>>;
}

/** Features the active provider publishes for this workspace. */
export interface WorkspaceChangesCapabilities {
  /** True when the provider has a staging area distinct from the working tree. */
  staging: boolean;
  /** True when rename/copy detection is included in inventory. */
  renames: boolean;
  /** True when unmerged/conflicted paths are reported as their own operation. */
  conflicts: boolean;
}

/** Identity and capabilities of the selected changes provider. */
export interface WorkspaceChangesProviderInfo {
  /** Opaque provider id (`git`, …). */
  id: string;
  /** Display name. */
  name: string;
  /** Opaque workspace identity the inventory is confined to. */
  workspace_identity: string;
  /** Opaque repository/project identity when the adapter has one. */
  repository_identity?: string;
  /** Comparison used when the client omits `comparison_id`. */
  default_comparison_id: string;
  /** Comparisons this provider currently offers. */
  comparisons: WorkspaceChangeComparison[];
  /** Published optional features. Staging controls appear only when `staging` is true. */
  capabilities: WorkspaceChangesCapabilities;
}

/** Result of probing workspace-changes availability. */
export type WorkspaceChangesAvailability =
  | {
      status: "available";
      provider: WorkspaceChangesProviderInfo;
    }
  | {
      status: "not_applicable" | "unavailable";
      reason: WorkspaceChangesReason;
    };

/**
 * Kind of change for one inventory entry.
 *
 * Untracked files are reported as `added`. Gitlink/submodule state uses `submodule`.
 */
export type WorkspaceChangeOperation =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type_changed"
  | "conflict"
  | "submodule";

/** Optional line-count statistics for a text change. */
export interface WorkspaceChangeStats {
  additions?: number;
  deletions?: number;
}

/** One changed path in a comparison inventory. */
export interface WorkspaceChangeEntry {
  /** Stable identity for this provider, comparison, and path pair. */
  id: string;
  /** Previous path when the operation moved or copied the file. */
  old_path?: string;
  /** Current path; omitted for a deletion that has no replacement. */
  new_path?: string;
  operation: WorkspaceChangeOperation;
  /** Present when the provider publishes staging; true if the index differs from the base. */
  staged?: boolean;
  /** Present when the provider publishes staging; true if the worktree differs from the index. */
  unstaged?: boolean;
  /** True when the adapter classified the contents as binary. */
  binary?: boolean;
  stats?: WorkspaceChangeStats;
}

/** Inventory request. Paths are never supplied by the client. */
export interface ListWorkspaceChangesRequest {
  /** Opaque comparison id; omitted means the provider default. */
  comparison_id?: string;
  /** Opaque cursor from a previous page. */
  cursor?: string;
  /** Maximum entries to return. */
  limit?: number;
}

/** One page of workspace changes for a single comparison. */
export interface WorkspaceChangesPage {
  /** Opaque query id bound to provider, workspace generation, comparison, and resolved base. */
  query_id: string;
  comparison_id: string;
  /** Opaque resolved base for the header (for example a revision label). */
  resolved_base: string;
  /** True when the adapter hit an entry/byte/time budget and the list is not exhaustive. */
  incomplete: boolean;
  items: WorkspaceChangeEntry[];
  next_cursor?: string;
}

/** On-demand detail request for one inventory entry. */
export interface ReadWorkspaceChangeRequest {
  query_id: string;
  entry_id: string;
  comparison_id?: string;
}

/**
 * Detail payload status.
 *
 * `ready` carries a complete unified patch. `truncated` must not be fed to a native
 * patch parser as a complete file. `stale` means the query's base no longer matches.
 */
export type WorkspaceChangeDetailStatus =
  "ready" | "empty" | "binary" | "conflict" | "truncated" | "stale" | "unavailable";

/** Per-entry patch or explicit non-text state. */
export interface WorkspaceChangeDetail {
  entry_id: string;
  query_id: string;
  comparison_id: string;
  resolved_base: string;
  status: WorkspaceChangeDetailStatus;
  /** Normalized unified patch for `ready` (and optionally a prefix for `truncated`). */
  patch?: string;
  /** Operator-facing explanation for non-ready states. */
  message?: string;
}

/** Cancellation is local transport metadata and is never serialized as params. */
export interface WorkspaceChangesCallOptions {
  signal?: KernelAbortSignal;
}

/**
 * Read-only workspace changes surface.
 *
 * Availability is a probe, not an inventory. An operational failure is never
 * presented as a clean workspace. The client does not pass commands or free paths.
 */
export interface WorkspaceChangesService {
  /**
   * Probe whether a changes provider can serve the bound workspace.
   *
   * @returns `available` with provider identity and comparisons, or a distinct
   *   `not_applicable` / `unavailable` reason. Never installs software or initializes
   *   a repository.
   */
  availability(options?: WorkspaceChangesCallOptions): Promise<WorkspaceChangesAvailability>;

  /**
   * List changed paths for one comparison.
   *
   * @throws `unavailable` / `unsupported` when no provider is active.
   */
  list(
    request?: ListWorkspaceChangesRequest,
    options?: WorkspaceChangesCallOptions,
  ): Promise<WorkspaceChangesPage>;

  /**
   * Read the normalized unified patch (or explicit non-text state) for one entry.
   *
   * @throws `unavailable` / `unsupported` when no provider is active.
   */
  read(
    request: ReadWorkspaceChangeRequest,
    options?: WorkspaceChangesCallOptions,
  ): Promise<WorkspaceChangeDetail>;
}
