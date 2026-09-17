import { effectDigest } from "./effects/facts.ts";
import type { GuardEffectBatch } from "./effects/types.ts";

/** Equivalent prepared file mutations keep their identity when a caller switches edit and write. */
export function refusalKey(batch: GuardEffectBatch): string {
  return effectDigest(
    ...batch.facts
      .map((fact) => {
        const constraints = { ...fact.constraints };
        if (
          typeof constraints.diff_digest === "string" &&
          typeof constraints.expected_revision === "string" &&
          typeof constraints.next_revision === "string"
        )
          delete constraints.operation;
        return JSON.stringify([
          fact.id,
          fact.target?.digest,
          fact.target?.state_digest,
          Object.entries(constraints).sort(([left], [right]) => left.localeCompare(right)),
        ]);
      })
      .sort(),
  );
}
