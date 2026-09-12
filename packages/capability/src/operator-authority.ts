import type { PortKey } from "./services.ts";

/** Shared operator-owned reviewer settings; workspace input may only narrow operational limits. */
export interface EffectReviewConfig {
  model?: string;
  timeout_ms?: number;
  max_retries?: number;
  on_unsure?: "ask" | "deny";
  rollout?: "shadow" | "local" | "ci_retry";
}

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

/** Operator text captured before host-generated prompt assembly. Never accepted from rawBody. */
export interface OperatorEvidence {
  id: string;
  source: "start" | "continue" | "steer" | "inherited";
  text: string;
  execution_id: string;
  agent?: "lead" | "subagent";
}

/** Host-minted conversation identity; every component must match before restoration. */
export interface OperatorAuthorityBinding {
  owner_key_name: string;
  session_id: string;
  controller_epoch: string;
  outcome_id?: string;
}

/** Bounded host-only input, separate from the model-visible run request. */
export interface OperatorAuthoritySeed {
  binding: OperatorAuthorityBinding;
  evidence: readonly OperatorEvidence[];
  /** Independent child runs may only inherit an already compiled intersection. */
  parent_run_id?: string;
  ceiling?: AuthorityEnvelopeV1;
  consumed_effects?: string[];
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
  envelope?: AuthorityEnvelopeV1;
  /** Inherited limits cannot be enlarged by child interpretation. */
  ceiling?: AuthorityEnvelopeV1;
  parent_run_id?: string;
  /** Stable one-attempt identities, retained across continuation and recompilation. */
  consumed_effects?: string[];
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
    ceiling: {
      ...state.envelope,
      grants: state.envelope.grants.filter(
        (grant) => grant.effect_id !== "github.actions.rerun_failed",
      ),
    },
    evidence: state.evidence.map((entry) => ({ ...entry, source: "inherited" })),
    consumed_effects: state.consumed_effects ?? [],
  };
}
