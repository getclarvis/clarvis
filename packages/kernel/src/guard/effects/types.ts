import type { ProcessRunner } from "../../ports/process-runner.ts";
import type { GuardEffectRegistry } from "./registry.ts";
import type {
  ReviewedEffectClass,
  ReviewedEffectInference,
  ReviewedEffectTarget,
  AuthorityEnvelopeV1,
} from "@clarvis/capability";
import type { GuardReviewability, ShellAnalysisIssue } from "@clarvis/tools/guard";

/** Host-attested effect of one segment or native tool call. */
export interface GuardEffectFact {
  id: string;
  class: ReviewedEffectClass;
  inference: ReviewedEffectInference;
  target?: ReviewedEffectTarget;
  constraints: Record<string, string | number | boolean>;
  attestation: "complete" | "partial" | "none";
  reviewability: GuardReviewability;
  analysis_issues: ShellAnalysisIssue[];
}

/** All effects must be covered; partial batch approval is forbidden. */
export interface GuardEffectBatch {
  facts: GuardEffectFact[];
  reviewability: GuardReviewability;
}

/** An immutable host descriptor caps both interpretation and mechanical coverage. */
export interface GuardEffectDescriptor {
  readonly id: string;
  readonly class: ReviewedEffectClass;
  readonly inference: ReviewedEffectInference;
  validateConstraints(value: Record<string, string | number | boolean>): boolean;
  covers(grant: AuthorityEnvelopeV1["grants"][number], fact: GuardEffectFact): boolean;
}

/** Exact host-selected process environment; never copied from process.env by an attestor. */
export interface EffectAttestorDeps {
  registry: GuardEffectRegistry;
  runner?: ProcessRunner;
  environment: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  guest?: boolean;
}
