import type { ReviewedEffectClass, ReviewedEffectInference } from "@clarvis/capability";
import type { GuardEffectDescriptor } from "./types.ts";

/**
 * The closed descriptor vocabulary of configuration review.
 *
 * @remarks Every producer and consumer of an effect fact lives in the restricted configuration
 * path: `attestConfiguration` builds the fact, `createConfigurationReview` reviews it, and the
 * authority envelope compiles a grant only for one of these four ids. Command review does not
 * consult this registry at all, so an operation name is never an authorization rule.
 */
const BUILTINS: ReadonlyArray<readonly [string, ReviewedEffectClass, ReviewedEffectInference]> = [
  ["workspace.content.write", "local_mutation", "bounded"],
  ["clarvis.authoring.write", "local_mutation", "bounded"],
  ["clarvis.operational_config.write", "authority_change", "explicit"],
  ["destructive.delete", "destructive", "human_only"],
];

/**
 * One configuration mutation's closed constraint vocabulary.
 *
 * @param value - the constraints attached to a fact or to a compiled grant.
 * @returns whether every key belongs to the vocabulary and every value fits its shape.
 * @remarks Unknown keys never disappear during validation: an unexpected key fails the fact, and
 * coverage comparison requires the fact and the grant to carry the same constraints key by key.
 */
function configurationConstraints(value: Record<string, string | number | boolean>): boolean {
  const keys = [
    "expected_revision",
    "next_revision",
    "bytes",
    "operation",
    "field_class",
    "diff_digest",
  ];
  if (Object.keys(value).some((key) => !keys.includes(key))) return false;
  if (
    Object.values(value).some((item) =>
      typeof item === "string"
        ? item.length > 256
        : typeof item === "number" && (!Number.isSafeInteger(item) || item < 0),
    )
  )
    return false;
  return (
    typeof value.expected_revision === "string" &&
    /^(?:absent|[a-f0-9]{64})$/.test(value.expected_revision) &&
    typeof value.next_revision === "string" &&
    /^(?:absent|[a-f0-9]{64})$/.test(value.next_revision) &&
    typeof value.bytes === "number" &&
    value.bytes <= 262144 &&
    (value.operation === undefined ||
      ["write", "edit", "delete"].includes(String(value.operation))) &&
    (value.field_class === undefined || typeof value.field_class === "string") &&
    (value.diff_digest === undefined ||
      (typeof value.diff_digest === "string" && /^[a-f0-9]{64}$/.test(value.diff_digest)))
  );
}

/** Registry cannot be mutated after composition; workspace configuration never registers effects. */
export function createGuardEffectRegistry() {
  const descriptors = new Map<string, GuardEffectDescriptor>();
  for (const [id, effectClass, inference] of BUILTINS) {
    descriptors.set(
      id,
      Object.freeze<GuardEffectDescriptor>({
        id,
        class: effectClass,
        inference,
        validateConstraints: configurationConstraints,
        covers(grant, fact) {
          return (
            inference !== "human_only" &&
            fact.id === id &&
            grant.effect_id === id &&
            fact.class === effectClass &&
            fact.inference === inference &&
            fact.attestation === "complete" &&
            fact.reviewability !== "human_only" &&
            fact.target !== undefined &&
            grant.target_digests.includes(fact.target.digest) &&
            (grant.relation === "direct" || inference === "bounded") &&
            configurationConstraints(grant.constraints) &&
            configurationConstraints(fact.constraints) &&
            Object.entries(fact.constraints).every(
              ([key, value]) => grant.constraints[key] === value,
            ) &&
            Object.entries(grant.constraints).every(
              ([key, value]) => fact.constraints[key] === value,
            )
          );
        },
      }),
    );
  }
  return Object.freeze({
    get: (id: string) => descriptors.get(id),
    list: () => [...descriptors.values()],
  });
}

/** Registry port consumed only by the configuration review flow. */
export type GuardEffectRegistry = ReturnType<typeof createGuardEffectRegistry>;
