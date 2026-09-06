/**
 * {@link KernelClient} — the single object a UI programs against.
 *
 * A UI (e.g. `@clarvis/code`) depends on this interface and nothing from
 * `@clarvis/loop`. Swapping stdio ↔ HTTP is only a matter of which transport
 * the client was built on.
 */

import type { Principal, ProjectRef, WorkspaceRef } from "./common.ts";
import type { RunService } from "./runs.ts";
import type { ConfigService } from "./config.ts";
import type { PluginService } from "./plugins.ts";
import type { SecretService } from "./secrets.ts";
import type { ModelCatalogService } from "./models.ts";
import type { WorkspaceService } from "./workspace.ts";
import type { MemoryService } from "./memory.ts";
import type { PlansService } from "./plans.ts";
import type { WorkflowsService } from "./workflows.ts";
import type { SkillsService } from "./skills.ts";
import type { SessionService } from "./sessions.ts";
import type { TasksService } from "./tasks.ts";
import type { ProviderAuthService } from "./provider-auth.ts";
import type { StorageService } from "./storage.ts";
import type { ExtensionProfileService } from "./extension-profiles.ts";

/** Features and versions a kernel advertises to a freshly connected client. */
export interface KernelCapabilities {
  /** Whether the memory control plane is available. */
  memory: boolean;
  /** Whether skills listing / prompt rendering is available. */
  skills: boolean;
  /** Whether agent-tool surfaces are available. */
  agent_tools: boolean;
  /** Whether this host wires the external Tasks capability/control plane. */
  tasks: boolean;
  /** Effective execution placement selected by the host. */
  runtime?: RuntimeStatus;
}

/** Truthful host-reported runtime placement and effective container policy. */
export type RuntimeStatus =
  | {
      kind: "native";
      host_platform: string;
      isolation: "host" | "sandbox";
      lifecycle: "ready" | "fallback";
      fallback_from?: "docker" | "podman";
    }
  | {
      kind: "container";
      engine: "podman" | "docker";
      host_platform: string;
      guest_platform: "linux";
      network: "none" | "internet" | "outbound";
      generation?: string;
      engine_version?: string;
      image_digest?: string;
      runtime_protocol_revision?: string;
      lifecycle:
        | "cold"
        | "inspecting"
        | "preparing"
        | "starting"
        | "ready"
        | "stopping"
        | "stopped"
        | "disconnected"
        | "failed";
    };

/** Options passed when connecting a {@link KernelClient}. */
export interface ConnectOptions {
  /** Workspace to bind; string form is a path or id. */
  workspace?: WorkspaceRef | string;
  /** Bearer/OAuth token for a hosted kernel; ignored on local stdio. */
  auth?: string;
  /** Client identity shown in telemetry / connection logs. */
  clientInfo?: { name: string; version?: string };
}

/**
 * Facade over every kernel service a UI needs after connect.
 */
export interface KernelClient {
  /** Capabilities advertised at connect time. */
  readonly capabilities: KernelCapabilities;
  /** Connected principal when the kernel is hosted/multi-tenant. */
  readonly principal?: Principal;
  /** Project shared by every workspace this client may navigate. */
  readonly project: ProjectRef;
  /** Bound workspace for this connection. */
  readonly workspace: WorkspaceRef;

  /** Start, stream, and control loop runs. */
  readonly runs: RunService;
  /** Read/write settings, agents, and context docs. */
  readonly config: ConfigService;
  /** Install/manage plugins and review unmanaged hooks. */
  readonly plugins: PluginService;
  /** Select and diagnose deterministic Extension Profiles. */
  readonly extensionProfiles: ExtensionProfileService;
  /** Server-side API keys / provider secrets. */
  readonly secrets: SecretService;
  /** Model and pricing catalog. */
  readonly models: ModelCatalogService;
  /** Local-user subscription connection lifecycle. */
  readonly providerAuth: ProviderAuthService;
  /** Read-only workspace file access. */
  readonly files: WorkspaceService;
  /** Owner-facing execution memory control plane. */
  readonly memory: MemoryService;
  /** Workspace-local file-backed plan history. */
  readonly plans: PlansService;
  /** Agentic workflows: a manager run fanning out isolated leader runs. */
  readonly workflows: WorkflowsService;
  /** User-invocable skills (slash-commands). */
  readonly skills: SkillsService;
  /** Conversation/session index over runs. */
  readonly sessions: SessionService;
  /** Provider-neutral external task control plane. */
  readonly tasks: TasksService;
  /** Metadata-only local storage inventory and disposable-artifact cleanup. */
  readonly storage: StorageService;

  /** Tear down the client and its transport. */
  close(): Promise<void>;
}
