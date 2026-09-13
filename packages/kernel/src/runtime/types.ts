import type { Readable, Writable } from "node:stream";

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

/** One host-resolved bind whose source, destination, kind and mutability are closed by policy. */
export interface RuntimeProtectedMount {
  readonly source: string;
  readonly target: string;
  readonly type: "directory" | "file";
  readonly readOnly: true;
}

/** Immutable launch authority; guest input can neither construct nor widen it. */
export interface RuntimeLaunchSpec {
  readonly generation: string;
  readonly ownerId: string;
  readonly project: ProjectRef;
  readonly workspace: WorkspaceRef;
  /** Canonical host workspace mounted read-write at `/workspace`. */
  readonly workspaceRoot: string;
  /** Exact empty private masks over both workspace control roots. */
  readonly controlRootMasks: readonly RuntimeProtectedMount[];
  /** Exact Git metadata projection; an absent nested target is refused before engine creation. */
  readonly gitMetadataMounts: readonly RuntimeProtectedMount[];
  readonly imageDigest: string;
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

/** Started execution session owned by the host. */
export interface RuntimeSession {
  readonly info: RuntimeInfo;
  /** True once the private channel or attached engine process cannot accept another request. */
  readonly closed: boolean;
  startRun(runId: string, envelope: unknown, signal?: AbortSignal): Promise<unknown>;
  steer(runId: string, input: unknown, signal?: AbortSignal): Promise<void>;
  interruptTool(runId: string, payload: unknown, signal?: AbortSignal): Promise<unknown>;
  cancel(runId: string): Promise<void>;
  stop(): Promise<void>;
}

/** Private engine boundary. Implementations must never fall back to native execution. */
export interface RuntimeBackend {
  inspect(): Promise<RuntimeAvailability>;
  start(spec: RuntimeLaunchSpec): Promise<RuntimeSession>;
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
