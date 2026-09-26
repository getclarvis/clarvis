import type { ActionAuthorizationRequest, NamespacedTool } from "@clarvis/capability";

/** Model assessment of one exact action. Optional fields never override outcome. */
export interface Assessment {
  outcome: "allow" | "deny";
  risk_level?: "low" | "medium" | "high" | "critical";
  user_authorization?: "unknown" | "low" | "medium" | "high";
  rationale?: string;
}

export interface AuthorizationEvidence {
  readonly role: "user" | "developer" | "host" | "workspace" | "tool" | "assistant";
  readonly content: string;
  readonly adoptedByUser?: boolean;
}

/** Host-supplied evidence and immutable action snapshot. */
export interface ReviewInput {
  readonly action: ActionAuthorizationRequest;
  readonly evidence: readonly AuthorizationEvidence[];
  readonly profile: string;
  readonly previousResult?: string;
}

/** The host owns execution and must confine every inspection tool. */
export interface ReviewRunner {
  readonly tools: readonly NamespacedTool[];
  run(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ text: string; images?: { data: string; mediaType: string }[] }>;
  close(): Promise<void>;
}

export type ReviewResult =
  | { kind: "assessment"; assessment: Required<Assessment> }
  | { kind: "context_overflow" }
  | { kind: "technical_failure"; reason: string }
  | { kind: "cancelled" };
