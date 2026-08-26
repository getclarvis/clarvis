/**
 * Shared vocabulary for the Clarvis kernel contract.
 *
 * Pure types only — this package has no dependency on `@clarvis/loop`, so a
 * UI client can depend on the protocol alone.
 */

/**
 * Config lives in two scopes on the host; a write targets exactly one.
 */
export type Scope = "global" | "workspace";

/**
 * Identity of the connected principal (hosted/multi-tenant kernel).
 *
 * On a local stdio kernel this is derived from the workspace and can be ignored.
 *
 * @remarks On stdio the host derives this identity from the local connection;
 * hosted kernels bind it from authentication. Caller-supplied request fields
 * never authenticate or select a principal.
 */
export interface Principal {
  readonly id: string;
  /** Optional human-readable label for display. */
  readonly display?: string;
}

/** Stable identity of one Git project and all of its linked worktrees. */
export interface ProjectRef {
  readonly id: string;
  /** Optional human-readable repository/project label. */
  readonly label?: string;
}

/**
 * Workspace a connection is bound to.
 *
 * On stdio this is the server's cwd; on a hosted kernel it is selected per
 * connection/session and its files live server-side (a remote UI reaches them only
 * through `WorkspaceService`).
 */
export interface WorkspaceRef {
  readonly id: string;
  /** Project this checkout belongs to. */
  readonly projectId: string;
  /** Human-readable worktree label. */
  readonly label: string;
  /** Whether this is the primary checkout or any Git-linked checkout. */
  readonly kind: "primary" | "external_worktree";
  /** Present for local/stdio; absent or opaque when hosted. */
  readonly path?: string;
}

/** Offset/limit pagination request. */
export interface Pagination {
  limit?: number;
  offset?: number;
}

/** One page of a paginated list. */
export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** Opaque-cursor pagination request for stores whose contents change over time. */
export interface CursorPagination {
  limit?: number;
  cursor?: string;
}

/** One stable cursor page. */
export interface CursorPage<T> {
  items: T[];
  next_cursor?: string;
}

/** Epoch milliseconds. Wire-friendly; the UI formats it for display. */
export type Timestamp = number;

/** A JSON Schema passed through opaquely (e.g. a run's `output_schema`). */
export type JsonSchema = Record<string, unknown>;

/** Stable error codes returned by the kernel. */
export type KernelErrorCode =
  | "unauthorized"
  | "not_found"
  | "invalid_request"
  | "conflict"
  | "unavailable"
  | "unsupported"
  | "cancelled"
  | "capability_disabled"
  | "continuation_unavailable"
  | "resource_exhausted"
  | "internal";

/** Structured error returned by kernel operations. */
export interface KernelError {
  code: KernelErrorCode;
  message: string;
  /** Optional machine detail (validation issues, provider error, …). */
  details?: unknown;
}

/** Cancels a subscription created by a `subscribe` / `watch` call. */
export type Unsubscribe = () => void;
