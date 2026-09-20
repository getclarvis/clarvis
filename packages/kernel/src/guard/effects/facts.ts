import { createHash } from "node:crypto";
import type { ReviewedEffectTarget } from "@clarvis/capability";
import type { GuardEffectRegistry } from "./registry.ts";
import type { GuardEffectFact } from "./types.ts";

/** Stable audit identity that does not expose filesystem paths or remote URLs. */
export function effectDigest(...values: string[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

/**
 * Construct a conservative fact from a registered descriptor.
 *
 * @param registry - the immutable descriptor vocabulary; `id` must be registered, since
 *   {@link attestConfiguration} is the only producer and names that closed vocabulary.
 * @param id - the descriptor id the fact is built from.
 * @param target - the reviewed target, absent when it could not be resolved.
 * @param constraints - descriptor-validated scalars carried into coverage comparison.
 * @param complete - whether the producer proved every descriptor requirement.
 * @returns a complete fact only when the descriptor validates the constraints and a target exists;
 *   otherwise a partial, human-only fact that no grant can cover.
 */
export function effectFact(
  registry: GuardEffectRegistry,
  id: string,
  target?: ReviewedEffectTarget,
  constraints: GuardEffectFact["constraints"] = {},
  complete = false,
): GuardEffectFact {
  const descriptor = registry.get(id)!;
  const attested = complete && descriptor.validateConstraints(constraints) && target !== undefined;
  return {
    id: descriptor.id,
    class: descriptor.class,
    inference: descriptor.inference,
    ...(target === undefined ? {} : { target }),
    constraints,
    attestation: attested ? "complete" : "partial",
    reviewability: attested && descriptor.inference !== "human_only" ? "static" : "human_only",
    analysis_issues: [],
  };
}
