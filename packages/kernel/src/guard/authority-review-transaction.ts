import type { OperatorAuthorityReader } from "@clarvis/capability";
import type { CompiledAuthorityTransition } from "@clarvis/judge";
import { validateAuthorityEnvelope } from "./authority-validation.ts";
import { installAuthorityEnvelope } from "./operator-authority.ts";
import { effectDigest } from "./effects/facts.ts";
import type { GuardEffectRegistry } from "./effects/registry.ts";
import type { GuardEffectBatch } from "./effects/types.ts";
import { reviewerContextIsCurrent, type ReviewerContextSource } from "./review-context.ts";

/** Identity of installed interpretation, excluding consumption/refusals which the final host rechecks. */
function authorityIdentity(reader: OperatorAuthorityReader): string {
  const state = reader.snapshot();
  return effectDigest(
    JSON.stringify([
      state.status,
      state.binding,
      state.revision,
      state.envelope ?? null,
      state.envelope_context_revision ?? null,
    ]),
  );
}

/** Read the ledger anew; a transition token binds one case to one exact installed interpretation. */
export function installedAuthorityTransition(
  reader: OperatorAuthorityReader,
  caseDigest: string,
  contextRevision: string | undefined,
): CompiledAuthorityTransition | undefined {
  const state = reader.snapshot();
  if (
    state.status !== "active" ||
    state.envelope?.revision !== state.revision ||
    state.envelope_context_revision !== contextRevision
  )
    return undefined;
  return {
    envelope: state.envelope,
    revision: state.revision,
    transition_token: effectDigest(
      caseDigest,
      JSON.stringify([state.binding, state.revision, state.envelope, contextRevision ?? null]),
    ),
  };
}

/** Capture one host transaction; the model supplies only a candidate and cannot choose its fences. */
export function createAuthorityReviewTransaction(input: {
  authority: OperatorAuthorityReader;
  registry: GuardEffectRegistry;
  batch: GuardEffectBatch;
  caseDigest: string;
  expectedAuthorityRevision: number;
  expectedReviewContextRevision?: string;
  reviewContext?: ReviewerContextSource;
  signal?: AbortSignal;
}) {
  const options = { ...input };
  const initialIdentity = authorityIdentity(options.authority);
  const batch = structuredClone(options.batch);
  let attempted = false;
  const contextCurrent = () =>
    !options.signal?.aborted &&
    reviewerContextIsCurrent(options.reviewContext, options.expectedReviewContextRevision);
  return {
    validateAndInstall(candidate: unknown): CompiledAuthorityTransition | undefined {
      if (attempted) return undefined;
      if (
        !contextCurrent() ||
        options.authority.snapshot().revision !== options.expectedAuthorityRevision ||
        authorityIdentity(options.authority) !== initialIdentity
      )
        return undefined;
      const envelope = validateAuthorityEnvelope(
        candidate,
        options.authority,
        options.registry,
        batch,
      );
      if (
        envelope === undefined ||
        !contextCurrent() ||
        authorityIdentity(options.authority) !== initialIdentity
      )
        return undefined;
      attempted = true;
      if (
        !installAuthorityEnvelope(
          options.authority,
          envelope,
          options.expectedReviewContextRevision,
        )
      )
        return undefined;
      const installedIdentity = authorityIdentity(options.authority);
      if (!contextCurrent() || authorityIdentity(options.authority) !== installedIdentity)
        return undefined;
      return installedAuthorityTransition(
        options.authority,
        options.caseDigest,
        options.expectedReviewContextRevision,
      );
    },
    isCurrent(transition: CompiledAuthorityTransition): boolean {
      if (!contextCurrent()) return false;
      const current = installedAuthorityTransition(
        options.authority,
        options.caseDigest,
        options.expectedReviewContextRevision,
      );
      return (
        current !== undefined &&
        current.revision === transition.revision &&
        current.transition_token === transition.transition_token
      );
    },
  };
}
