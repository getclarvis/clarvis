import { createHash } from "node:crypto";
import type { ReviewedEffectTarget } from "@clarvis/capability";
import type { EffectAttestorDeps, GuardEffectFact } from "./types.ts";

/** Stable audit identity that does not expose filesystem paths or remote URLs. */
export function effectDigest(...values: string[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

/** Construct a conservative fact from a registered descriptor. */
export function effectFact(
  deps: EffectAttestorDeps,
  id: string,
  target?: ReviewedEffectTarget,
  constraints: GuardEffectFact["constraints"] = {},
  complete = false,
): GuardEffectFact {
  const descriptor = deps.registry.get(id) ?? deps.registry.get("external.unknown")!;
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
