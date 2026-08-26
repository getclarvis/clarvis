/**
 * Whether a run can produce children at all — the one question that decides
 * whether it gets a supervision registry.
 */
import type { CapabilityGrantDeclaration } from "@clarvis/capability";
import type { RunShape } from "./run-shape.ts";

/**
 * Report whether this run's entry agent can spawn children.
 *
 * @param shape - the derived run shape.
 * @param declarations - the run's capability-owned grant catalogue.
 * @returns true for a lead or an entry carrying a grant declared spawn-capable.
 * @remarks This gates the registry's existence, and with it the five supervision
 *   tools. A solo run therefore never sees them in its schema — the surface
 *   follows from what a run can spawn, not from a request flag.
 */
export function canSpawnChildren(
  shape: RunShape,
  declarations: readonly CapabilityGrantDeclaration[],
): boolean {
  if (shape.isLead) return true;
  const spawnGrants = new Set(
    declarations
      .filter((declaration) => declaration.entryCanSpawn === true)
      .map((declaration) => declaration.name),
  );
  return (shape.entryProfile.grants ?? []).some((grant) => spawnGrants.has(grant));
}
