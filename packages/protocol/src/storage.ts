/** Stable categories in the operator-facing Clarvis storage inventory. */
export type StorageCategory =
  | "traces"
  | "sessions"
  | "workflow_records"
  | "projects"
  | "spills"
  | "memory"
  | "plans"
  | "diagnostics"
  | "run_scratch"
  | "workspace_state"
  | "cache";

/** Metadata-only inventory row. No pathname or persisted content crosses this surface. */
export interface StorageCategorySummary {
  category: StorageCategory;
  files: number;
  directories: number;
  bytes: number;
  reclaimable_bytes: number;
}

/** Safe credential posture that deliberately excludes file size and content. */
export interface CredentialFilePosture {
  present: boolean;
  owner_only: boolean | null;
}

/** Bounded snapshot of Clarvis-owned local storage. */
export interface StorageSnapshot {
  generated_at: number;
  total_bytes: number;
  reclaimable_bytes: number;
  truncated: boolean;
  categories: StorageCategorySummary[];
  credentials: {
    keys: CredentialFilePosture;
    subscriptions: CredentialFilePosture;
  };
}

export type StorageCleanupCategory = "temporary" | "cache";

export interface StorageCleanupRequest {
  categories: StorageCleanupCategory[];
  dry_run: boolean;
}

export interface StorageCleanupResult {
  dry_run: boolean;
  reclaimable_bytes: number;
  removed_bytes: number;
  before: StorageSnapshot;
  after?: StorageSnapshot;
}

/** Metadata-only inventory and explicitly requested cleanup of disposable artifacts. */
export interface StorageService {
  inspect(): Promise<StorageSnapshot>;
  cleanup(request: StorageCleanupRequest): Promise<StorageCleanupResult>;
}
