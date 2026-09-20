import type { PortKey } from "./services.ts";

/** Semantic effect classes; independent of coarse tool scheduling effects. */
export type ReviewedEffectClass =
  | "read"
  | "local_mutation"
  | "external_observation"
  | "external_mutation"
  | "destructive"
  | "credential"
  | "authority_change"
  | "unknown";

/** The host descriptor's maximum inference, which model output cannot widen. */
export type ReviewedEffectInference = "bounded" | "explicit" | "human_only";

/** Mechanically resolved identity; labels are presentation, never identity evidence. */
export interface ReviewedEffectTarget {
  kind: "workspace" | "repository" | "pull_request" | "workflow_run" | "external_resource";
  digest: string;
  state_digest?: string;
  labels?: Record<string, string | number | boolean>;
}

/** Host-admitted evidence; `text` is operator-authored while an ask_user `prompt` is untrusted. */
export interface OperatorEvidence {
  id: string;
  source: "start" | "continue" | "steer" | "ask_user" | "inherited";
  /** Untrusted model-authored context for an authenticated `ask_user` answer. */
  prompt?: string;
  text: string;
  execution_id: string;
  agent?: "lead" | "subagent";
}

/** Host-captured persistent operator instructions, independent of model-authored messages. */
export interface OperatorInstructions {
  id: string;
  scope: "global" | "workspace";
  source: string;
  digest: string;
  content: string;
}

/** Accepted entry-agent answer admitted by the host elicitation channel. */
export interface OperatorElicitationContext {
  question: string;
  answer: string;
}

/** Host-minted conversation identity; every component must match before restoration. */
export interface OperatorAuthorityBinding {
  owner_key_name: string;
  session_id: string;
  controller_epoch: string;
  outcome_id?: string;
}

/** Host-attested execution objective supplied to reviewers as context, never as operator evidence. */
export interface OperatorReviewContext {
  kind: "goal" | "plan";
  /** Canonical bounded JSON describing one current host-attested semantic definition. */
  content: string;
}

/** Run-scoped semantic definitions that reviewers may consult without treating them as evidence. */
export interface OperatorReviewContextSnapshot {
  /** Host-owned identity that changes whenever the projected semantic definitions change. */
  revision: string;
  contexts: readonly OperatorReviewContext[];
}

export interface OperatorReviewContextProvider {
  snapshot(): OperatorReviewContextSnapshot;
}

/** Late-bound semantic context published by the Plans capability. */
export const PLANS_REVIEW_CONTEXT_PORT: PortKey<OperatorReviewContextProvider> = {
  id: "plans.review_context",
};

/** Bounded host-only input, separate from the model-visible run request. */
export interface OperatorAuthoritySeed {
  binding: OperatorAuthorityBinding;
  evidence: readonly OperatorEvidence[];
  instructions?: readonly OperatorInstructions[];
  review_context?: OperatorReviewContext;
  /** Independent child runs may only inherit an already compiled intersection. */
  parent_run_id?: string;
  ceiling?: AuthorityEnvelopeV1;
}

/** Validated semantic interpretation constrained by host effect descriptors. */
export interface AuthorityEnvelopeV1 {
  version: 1;
  revision: number;
  objectives: Array<{
    id: string;
    summary: string;
    target_digests: string[];
    evidence_ids: string[];
  }>;
  grants: Array<{
    id: string;
    effect_id: string;
    relation: "direct" | "bounded_prerequisite";
    target_digests: string[];
    constraints: Record<string, string | number | boolean>;
    evidence_ids: string[];
  }>;
  exclusions: Array<{
    effect_id?: string;
    class?: ReviewedEffectClass;
    target_digests?: string[];
  }>;
}

/** Explicit transversal persistence; settled or revoked state never reactivates grants. */
export interface OperatorAuthorityState {
  version: 1;
  binding: OperatorAuthorityBinding;
  status: "active" | "settled" | "revoked";
  revision: number;
  evidence: OperatorEvidence[];
  instructions?: OperatorInstructions[];
  review_context?: OperatorReviewContext;
  envelope?: AuthorityEnvelopeV1;
  /** Host-attested live review context used to compile the installed envelope. */
  envelope_context_revision?: string;
  /** Inherited limits cannot be enlarged by child interpretation. */
  ceiling?: AuthorityEnvelopeV1;
  parent_run_id?: string;
  /** Exact refused batches at the current evidence revision; these never grant authority. */
  denied_effects?: string[];
}

/** Detached read projection; mutating a snapshot cannot change host authority. */
export type OperatorAuthoritySnapshot = Readonly<OperatorAuthorityState>;

/** Read-only run substrate; no capability receives its writer. */
export interface OperatorAuthorityReader {
  snapshot(): OperatorAuthoritySnapshot;
}

/** Prepublished by the engine before concurrent capability activation. */
export const OPERATOR_AUTHORITY_PORT: PortKey<OperatorAuthorityReader> = {
  id: "operator.authority",
};

/** Project an active compiled envelope into a child without converting its brief to evidence. */
export function inheritOperatorAuthority(
  reader: OperatorAuthorityReader | undefined,
  parentRunId: string,
): OperatorAuthoritySeed | undefined {
  const state = reader?.snapshot();
  if (state?.status !== "active" || state.envelope?.revision !== state.revision) return undefined;
  return {
    binding: state.binding,
    parent_run_id: parentRunId,
    ceiling: structuredClone(state.envelope),
    evidence: state.evidence.map(({ prompt: _prompt, ...entry }) => ({
      ...entry,
      source: "inherited",
    })),
    ...(state.review_context === undefined
      ? {}
      : { review_context: structuredClone(state.review_context) }),
    ...(state.instructions === undefined
      ? {}
      : { instructions: structuredClone(state.instructions) }),
  };
}
