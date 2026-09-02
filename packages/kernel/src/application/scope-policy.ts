import type {
  ConfigService,
  MemoryService,
  ModelCatalogService,
  PlansService,
  PluginService,
  ProviderAuthService,
  RunService,
  SecretService,
  SessionService,
  SkillsService,
  StorageService,
  TasksService,
  WorkspaceService,
  WorkflowsService,
  ExtensionProfileService,
} from "@clarvis/protocol";

/** Data ownership categories used by kernel composition and host policy. */
export type KernelDataScope = "operator" | "workspace" | "owner" | "connection";

/** Whether a concrete kernel supports one owner or multiple isolated owners. */
export type KernelOwnershipMode = "single" | "multi";

/** Validated owner identity and workspace supplied to owner-service construction. */
export interface OwnerScope {
  /** Host-resolved data namespace; this value does not authenticate itself. */
  readonly owner: string;
  /** Absolute or host-opaque workspace identity. */
  readonly workspace: string;
  readonly projectId: string;
  readonly workspaceId: string;
}

/** Services instantiated once for the operator/workspace composition. */
export interface OperatorServices {
  /** Settings, agents, and sandbox inspection. */
  readonly config: ConfigService;
  /** Operator-owned credentials. */
  readonly secrets: SecretService;
  /** Operator-owned model catalog. */
  readonly models: ModelCatalogService;
  /** Kernel-owned local subscription credentials and connection lifecycle. */
  readonly providerAuth: ProviderAuthService;
  /** Workspace file access. */
  readonly files: WorkspaceService;
  /** Operator/workspace plugin projection. */
  readonly plugins: PluginService;
  /** Operator/workspace Extension Profile definitions and local selection. */
  readonly extensionProfiles: ExtensionProfileService;
  /** Operator/workspace skill projection. */
  readonly skills: SkillsService;
  /** Operator-owned generated-state inventory and disposable cleanup. */
  readonly storage: StorageService;
}

/** Services instantiated and memoized for one validated owner scope. */
export interface OwnerServices {
  /** Owner-keyed run execution and trace access. */
  readonly runs: RunService;
  /** Owner or single-workspace memory control plane. */
  readonly memory: MemoryService;
  /** Owner or single-workspace plan control plane. */
  readonly plans: PlansService;
  /** Owner-keyed sessions. */
  readonly sessions: SessionService;
  /** Owner-keyed workflow execution and records. */
  readonly workflows: WorkflowsService;
  /** Owner-bound external task provider/control plane. */
  readonly tasks: TasksService;
}

/** Declared data scope of every concrete kernel service. */
export interface KernelScopePolicy {
  readonly runs: "owner";
  readonly memory: "owner" | "workspace";
  readonly plans: "owner" | "workspace";
  readonly sessions: "owner";
  readonly workflows: "owner";
  readonly tasks: readonly ["owner", "workspace", "connection"];
  readonly config: readonly ["operator", "workspace"];
  readonly secrets: "operator";
  readonly models: "operator";
  readonly providerAuth: readonly ["operator", "connection"];
  readonly plugins: readonly ["operator", "workspace"];
  readonly extensionProfiles: readonly ["operator", "workspace"];
  readonly skills: readonly ["operator", "workspace"];
  readonly files: "workspace";
  readonly storage: "operator";
}

/** Build the scope manifest for one concrete ownership mode. */
export function createKernelScopePolicy(mode: KernelOwnershipMode): KernelScopePolicy {
  return Object.freeze({
    runs: "owner",
    memory: mode === "multi" ? "owner" : "workspace",
    plans: mode === "multi" ? "owner" : "workspace",
    sessions: "owner",
    workflows: "owner",
    tasks: ["owner", "workspace", "connection"] as const,
    config: ["operator", "workspace"] as const,
    secrets: "operator",
    models: "operator",
    providerAuth: ["operator", "connection"] as const,
    plugins: ["operator", "workspace"] as const,
    extensionProfiles: ["operator", "workspace"] as const,
    skills: ["operator", "workspace"] as const,
    files: "workspace",
    storage: "operator",
  });
}
