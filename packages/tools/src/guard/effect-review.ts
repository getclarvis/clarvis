/** Serializable effect facts supplied exclusively by host attestors. */
export interface GuardEffectCallFact {
  id: string;
  class:
    | "read"
    | "local_mutation"
    | "external_observation"
    | "external_mutation"
    | "destructive"
    | "credential"
    | "authority_change"
    | "unknown";
  inference: "bounded" | "explicit" | "human_only";
  target?: {
    kind: "workspace" | "repository" | "pull_request" | "workflow_run" | "external_resource";
    digest: string;
    state_digest?: string;
    labels?: Record<string, string | number | boolean>;
  };
  constraints: Record<string, string | number | boolean>;
  attestation: "complete" | "partial" | "none";
  reviewability: "static" | "judgeable" | "human_only";
  analysis_issues: Array<{
    segmentIndex: number;
    kind:
      | "parameter_expansion"
      | "command_substitution"
      | "process_substitution"
      | "dynamic_command"
      | "dynamic_subcommand"
      | "dynamic_path"
      | "opaque_command"
      | "opaque_path"
      | "unbalanced_syntax"
      | "tokenizer_gap";
    impact: "value" | "executable" | "subcommand" | "path" | "environment" | "control_flow";
  }>;
}

/** Sanitized review explanation shared structurally across standalone package boundaries. */
export interface EffectReviewDetail {
  analysis?: {
    reviewability: GuardEffectCallFact["reviewability"];
    issues: GuardEffectCallFact["analysis_issues"];
  };
  effect?: {
    id: string;
    class: GuardEffectCallFact["class"];
    attestation: GuardEffectCallFact["attestation"];
    target_digest?: string;
  };
  authority?: {
    revision: number;
    relation: "direct" | "bounded_prerequisite" | "none";
    within_scope: boolean;
  };
  reviewer?: {
    status: "failed" | "invalid" | "unsure";
    failure_kind?:
      | "timeout"
      | "auth"
      | "quota"
      | "rate_limit"
      | "transport"
      | "admission"
      | "cancelled"
      | "invalid_response"
      | "unknown";
    elapsed_ms?: number;
    attempts?: number;
  };
}
