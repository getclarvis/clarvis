import type { AuthorityEnvelopeV1, OperatorAuthorityReader } from "@clarvis/capability";
import type { AuthorityCandidateRejection } from "@clarvis/judge";
import type { GuardEffectRegistry } from "./effects/registry.ts";
import type { GuardEffectBatch } from "./effects/types.ts";
import { authorityEnvelopeSchema as envelopeSchema } from "./authority-schema.ts";

/** Reject an envelope atomically unless all references, inference ceilings and targets are valid. */
export function validateAuthorityEnvelope(
  value: unknown,
  reader: OperatorAuthorityReader,
  registry: GuardEffectRegistry,
  batch: GuardEffectBatch,
  onRejected?: (reason: AuthorityCandidateRejection) => void,
): AuthorityEnvelopeV1 | undefined {
  const reject = (reason: AuthorityCandidateRejection): undefined => {
    onRejected?.(reason);
    return undefined;
  };
  const parsed = envelopeSchema.safeParse(value);
  const state = reader.snapshot();
  if (!parsed.success) return reject("invalid_shape");
  if (state.status !== "active") return reject("stale_context");
  if (parsed.data.revision !== state.revision) return reject("revision_mismatch");
  const envelope = parsed.data;
  const evidence = new Set(
    [...state.evidence, ...(state.instructions ?? [])].map((entry) => entry.id),
  );
  const targets = new Set(
    batch.facts.flatMap((fact) => (fact.target === undefined ? [] : [fact.target.digest])),
  );
  if (new Set(envelope.grants.map((grant) => grant.id)).size !== envelope.grants.length)
    return reject("duplicate_id");
  if (
    new Set(envelope.objectives.map((objective) => objective.id)).size !==
    envelope.objectives.length
  )
    return reject("duplicate_id");
  for (const objective of envelope.objectives) {
    if (
      objective.evidence_ids.some((key) => !evidence.has(key)) ||
      objective.target_digests.some((key) => !targets.has(key))
    )
      return reject("objective_reference");
  }
  for (const grant of envelope.grants) {
    const descriptor = registry.get(grant.effect_id);
    if (
      descriptor === undefined ||
      descriptor.inference === "human_only" ||
      (grant.relation === "bounded_prerequisite" && descriptor.inference !== "bounded")
    )
      return reject("effect_not_inferable");
    if (!descriptor.validateConstraints(grant.constraints)) return reject("grant_constraints");
    if (
      grant.evidence_ids.some((key) => !evidence.has(key)) ||
      grant.target_digests.some((key) => !targets.has(key))
    )
      return reject("grant_reference");
    if (!batch.facts.some((fact) => descriptor.covers(grant, fact)))
      return reject("grant_not_covered");
    if (
      state.ceiling !== undefined &&
      !state.ceiling.grants.some(
        (parent) =>
          parent.effect_id === grant.effect_id &&
          parent.relation === grant.relation &&
          grant.target_digests.every((target) => parent.target_digests.includes(target)) &&
          JSON.stringify(parent.constraints) === JSON.stringify(grant.constraints),
      )
    )
      return reject("ceiling_mismatch");
  }
  for (const item of envelope.exclusions) {
    const retained = [
      ...(state.envelope?.exclusions ?? []),
      ...(state.ceiling?.exclusions ?? []),
    ].some((previous) => JSON.stringify(previous) === JSON.stringify(item));
    if (
      (item.effect_id !== undefined && registry.get(item.effect_id) === undefined) ||
      (!retained && item.target_digests?.some((target) => !targets.has(target)))
    )
      return reject("invalid_exclusion");
  }
  if (
    state.envelope?.exclusions.some(
      (item) =>
        !envelope.exclusions.some(
          (candidate) => JSON.stringify(candidate) === JSON.stringify(item),
        ),
    )
  )
    return reject("missing_exclusion");
  if (
    state.ceiling?.exclusions.some(
      (item) =>
        !envelope.exclusions.some(
          (candidate) => JSON.stringify(candidate) === JSON.stringify(item),
        ),
    )
  )
    return reject("missing_exclusion");
  return envelope;
}
