import type { AuthorityEnvelopeV1, OperatorAuthorityReader } from "@clarvis/capability";
import type { GuardEffectRegistry } from "./effects/registry.ts";
import type { GuardEffectBatch } from "./effects/types.ts";
import { authorityEnvelopeSchema as envelopeSchema } from "./authority-schema.ts";

/** Reject an envelope atomically unless all references, inference ceilings and targets are valid. */
export function validateAuthorityEnvelope(
  value: unknown,
  reader: OperatorAuthorityReader,
  registry: GuardEffectRegistry,
  batch: GuardEffectBatch,
): AuthorityEnvelopeV1 | undefined {
  const parsed = envelopeSchema.safeParse(value);
  const state = reader.snapshot();
  if (!parsed.success || state.status !== "active" || parsed.data.revision !== state.revision)
    return undefined;
  const envelope = parsed.data;
  const evidence = new Set(state.evidence.map((entry) => entry.id));
  const targets = new Set(
    batch.facts.flatMap((fact) => (fact.target === undefined ? [] : [fact.target.digest])),
  );
  if (new Set(envelope.grants.map((grant) => grant.id)).size !== envelope.grants.length)
    return undefined;
  if (
    new Set(envelope.objectives.map((objective) => objective.id)).size !==
    envelope.objectives.length
  )
    return undefined;
  for (const objective of envelope.objectives) {
    if (
      objective.evidence_ids.some((key) => !evidence.has(key)) ||
      objective.target_digests.some((key) => !targets.has(key))
    )
      return undefined;
  }
  for (const grant of envelope.grants) {
    const descriptor = registry.get(grant.effect_id);
    if (
      descriptor === undefined ||
      descriptor.inference === "human_only" ||
      (grant.relation === "bounded_prerequisite" && descriptor.inference !== "bounded") ||
      !descriptor.validateConstraints(grant.constraints) ||
      grant.evidence_ids.some((key) => !evidence.has(key)) ||
      grant.target_digests.some((key) => !targets.has(key)) ||
      !batch.facts.some((fact) => descriptor.covers(grant, fact))
    )
      return undefined;
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
      return undefined;
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
      return undefined;
  }
  if (
    state.envelope?.exclusions.some(
      (item) =>
        !envelope.exclusions.some(
          (candidate) => JSON.stringify(candidate) === JSON.stringify(item),
        ),
    )
  )
    return undefined;
  if (
    state.ceiling?.exclusions.some(
      (item) =>
        !envelope.exclusions.some(
          (candidate) => JSON.stringify(candidate) === JSON.stringify(item),
        ),
    )
  )
    return undefined;
  return envelope;
}
