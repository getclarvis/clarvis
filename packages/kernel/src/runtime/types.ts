import type { ProjectRef, WorkspaceRef } from "@clarvis/protocol";

/** Runtime placement selected by the operator. */
export type RuntimeKind = "native" | "container";

/** Container network authority enforced outside the guest. */
export type RuntimeNetworkMode = "none" | "internet" | "outbound";

/** Lifecycle states visible to the host control plane. */
export type RuntimeLifecycleState =
  | "inspecting"
  | "preparing"
  | "starting"
  | "ready"
  | "stopping"
  | "stopped"
  | "disconnected"
  | "failed";

/** A typed reason why an explicitly selected runtime cannot launch. */
export type RuntimeUnavailableReason =
  | "engine_missing"
  | "engine_stopped"
  | "unsupported_platform"
  | "unsupported_policy"
  | "operational_failure";

/** Result of inspecting a backend without starting agent execution. */
export type RuntimeAvailability =
  | { readonly available: true; readonly engineVersion: string; readonly rootless: boolean }
  | {
      readonly available: false;
      readonly reason: RuntimeUnavailableReason;
      readonly message: string;
    };

/** Host-resolved immutable limits applied by an engine adapter. */
export interface RuntimeLimits {
  readonly cpuCount: number;
  readonly memoryBytes: number;
  readonly processCount: number;
  readonly outputBytes: number;
  readonly storageBytes: number;
}

/** Immutable launch authority; guest input can neither construct nor widen it. */
export interface RuntimeLaunchSpec {
  readonly generation: string;
  readonly ownerId: string;
  readonly project: ProjectRef;
  readonly workspace: WorkspaceRef;
  readonly sourceWorkspaceRoot: string;
  readonly retainedWorkspaceRoot: string;
  readonly imageDigest: string;
  readonly configurationRevision: string;
  readonly extensionRevision: string;
  readonly network: RuntimeNetworkMode;
  readonly limits: RuntimeLimits;
  readonly capabilityMethods: readonly string[];
}

/** Effective placement and policy reported after engine admission. */
export interface RuntimeInfo {
  readonly kind: "container";
  readonly generation: string;
  readonly engine: "podman" | "docker";
  readonly engineVersion: string;
  readonly hostPlatform: NodeJS.Platform;
  readonly guestPlatform: "linux";
  readonly imageDigest: string;
  readonly runtimeProtocolRevision: string;
  readonly network: RuntimeNetworkMode;
  readonly limits: RuntimeLimits;
  readonly lifecycle: RuntimeLifecycleState;
}

/** Application protocol used to present one guest TCP listener to the user. */
export type RuntimePreviewProtocol = "http" | "https" | "tcp";

/** Loopback-only host endpoint backed by one guest TCP listener. */
export interface RuntimePortPreview {
  readonly guestPort: number;
  readonly host: "127.0.0.1";
  readonly hostPort: number;
  readonly protocol: RuntimePreviewProtocol;
  readonly url: string;
}

/** Started execution session owned by the host. */
export interface RuntimeSession {
  readonly info: RuntimeInfo;
  startRun(runId: string, envelope: unknown, signal?: AbortSignal): Promise<unknown>;
  steer(runId: string, input: unknown, signal?: AbortSignal): Promise<void>;
  cancel(runId: string): Promise<void>;
  exposePort(
    guestPort: number,
    protocol?: RuntimePreviewProtocol,
    signal?: AbortSignal,
  ): Promise<RuntimePortPreview>;
  stop(): Promise<void>;
}

/** Private engine boundary. Implementations must never fall back to native execution. */
export interface RuntimeBackend {
  inspect(): Promise<RuntimeAvailability>;
  start(spec: RuntimeLaunchSpec): Promise<RuntimeSession>;
}

/** Stable typed launch failure suitable for UI error mapping. */
export class RuntimeLaunchError extends Error {
  readonly code: RuntimeUnavailableReason | "invalid_launch_spec" | "handshake_mismatch";

  constructor(code: RuntimeLaunchError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeLaunchError";
    this.code = code;
  }
}
