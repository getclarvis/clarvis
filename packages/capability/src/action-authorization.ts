import { portKey } from "./services.ts";

/** Trusted identity attached by the host and loop after hooks settle. */
export interface ActionIdentity {
  readonly owner: string;
  readonly executionId: string;
  readonly actor: string;
  readonly callId: string;
  readonly attempt: number;
}

/** A permission difference requested for exactly one action. */
export interface ActionPermissions {
  readonly writeRoots?: readonly string[];
  readonly readRoots?: readonly string[];
  readonly network?: "enabled";
  readonly host?: boolean;
}

/** The final action presented to a reviewer, with no model-owned authority fields. */
export interface ActionAuthorizationRequest {
  readonly identity: ActionIdentity;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly command?: string;
  readonly argv?: readonly (readonly string[])[];
  readonly shell?: string;
  readonly cwd?: string;
  readonly paths?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly requestedProfile: "host" | "sandbox";
  readonly effectiveProfile: "host" | "sandbox";
  readonly permissions?: ActionPermissions;
  readonly reason: string;
  readonly policyRevision: string;
  readonly authorizationRevision: number;
}

/** Evidence retained separately from text output, even when output is truncated. */
export interface ActionAuthorizationEvidence {
  readonly decision: "allow" | "prompt" | "forbidden";
  readonly source: "rule" | "fallback" | "heuristic" | "host" | "reviewer";
  readonly reason: string;
  readonly requestedProfile: "host" | "sandbox";
  readonly effectiveProfile: "host" | "sandbox";
  readonly executionStarted: boolean;
}

/** A decision bound to a request fingerprint, never a bearer capability. */
export interface ActionAuthorizationDecision {
  readonly granted: boolean;
  readonly fingerprint: string;
  readonly evidence: ActionAuthorizationEvidence;
  readonly permissions?: ActionPermissions;
}

/** The host decides policy and reviewer; executors only consume this port. */
export interface ActionAuthorizationPort {
  readonly identity: Pick<ActionIdentity, "owner" | "executionId">;
  readonly mayRelayMcpElicitation: boolean;
  readonly policyRevision: string;
  revision(): number;
  /** Host-owned stop condition, independent of engine convergence guards. */
  stopReason?(): string | undefined;
  authorize(
    request: ActionAuthorizationRequest,
    signal?: AbortSignal,
  ): Promise<ActionAuthorizationDecision>;
  valid(request: ActionAuthorizationRequest, decision: ActionAuthorizationDecision): boolean;
  recordAttempt(
    request: ActionAuthorizationRequest,
    phase: "admitted" | "started" | "settled" | "uncertain",
    backend?: "host" | "bubblewrap" | "seatbelt",
    effectiveProfile?: "host" | "sandbox",
  ): void;
}

/** Run-scoped authorization service shared by builtins, MCP and capabilities. */
export const ACTION_AUTHORIZATION_PORT = portKey<ActionAuthorizationPort>(
  "execution.action_authorization",
);
