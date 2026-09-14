import type { Readable, Writable } from "node:stream";
import type { RuntimeStatus } from "@clarvis/protocol";

/** Captured result of one bounded engine control invocation. */
export interface ContainerCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Private RPC streams whose lifecycle is owned by the engine backend. */
export interface ContainerAttachedProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<number | null>;
  kill(signal: NodeJS.Signals): void;
}

/** Exceptional command bounds, clamped by the concrete process adapter. */
export interface ContainerRunOptions {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

/** Argv-only engine effects, separate from effective policy and guest authority. */
export interface ContainerControl {
  run(
    args: readonly string[],
    signal?: AbortSignal,
    options?: ContainerRunOptions,
  ): Promise<ContainerCommandResult>;
  attach(args: readonly string[]): ContainerAttachedProcess;
}

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

/** Informational placement transition emitted to local user interfaces. */
export interface RuntimePlacementNotice {
  readonly status: RuntimeStatus;
  readonly message?: string;
}

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

/** One host-resolved bind whose source, destination, kind and mutability are closed by policy. */
export interface RuntimeProtectedMount {
  readonly source: string;
  readonly target: string;
  readonly type: "directory" | "file";
  readonly readOnly: true;
}

/** Immutable mounts and identity for one complete Kernel process. */
export interface ContainerKernelLaunchSpec {
  readonly generation: string;
  readonly namespace: string;
  readonly workspaceRoot: string;
  readonly controlRootMasks: readonly RuntimeProtectedMount[];
  readonly gitMetadataMounts: readonly RuntimeProtectedMount[];
  readonly baseImageId: `sha256:${string}`;
  readonly baseAbi: string;
  readonly artifact: {
    readonly volume: string;
    readonly digest: `sha256:${string}`;
    readonly target: "linux-x64" | "linux-arm64";
  };
  readonly data: {
    readonly contentVolume: string;
    readonly stateVolume: string;
  };
  readonly miseVolume: string;
  readonly network: Exclude<RuntimeNetworkMode, "internet">;
  readonly limits: RuntimeLimits;
  readonly user: { readonly uid: number; readonly gid: number };
}

/** Exact attached process and destructive lifecycle authority for one admitted Container ID. */
export interface ContainerProcessLifecycle {
  readonly id: string;
  readonly process: ContainerAttachedProcess;
  stop(graceSeconds: 10): Promise<void>;
  remove(): Promise<void>;
}

/** Engine adapter for a complete Kernel process; it never accepts or executes a run request. */
export interface ContainerKernelBackend {
  inspect(): Promise<RuntimeAvailability>;
  reconcilePrevious(input: {
    readonly id: string;
    readonly generation: string;
    readonly namespace: string;
  }): Promise<void>;
  startKernel(spec: ContainerKernelLaunchSpec): Promise<ContainerProcessLifecycle>;
}

/** Stable typed launch failure suitable for UI error mapping. */
export class RuntimeLaunchError extends Error {
  readonly code:
    | RuntimeUnavailableReason
    | "invalid_launch_spec"
    | "handshake_mismatch"
    | "runtime_recipe_invalid"
    | "runtime_recipe_failed";

  constructor(code: RuntimeLaunchError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeLaunchError";
    this.code = code;
  }
}
