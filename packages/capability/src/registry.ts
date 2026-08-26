import type { CapabilitySettingsSpec } from "./settings-spec.ts";
import type { CapabilityGrantDeclaration } from "./contract.ts";

/**
 * The mutable set of {@link CapabilitySettingsSpec}s contributed by capabilities
 * that live outside the engine.
 *
 * @remarks The engine's own built-in specs are *not* registered here: they are
 * spread statically into the settings and request schemas so zod's inference
 * stays exact (the `SettingsFile` / `ParsedRunRequest` drift locks depend on
 * it). This registry is the open half of that split — a capability shipped in
 * its own package registers its settings block with the host at boot, and the
 * host validates that block against {@link CapabilitySettingsSpec.schema}
 * instead of the engine declaring it.
 *
 * Registration must happen before settings are parsed, or the block reads as an
 * unrecognized key.
 */
export interface CapabilityRegistry {
  /**
   * Add a spec.
   *
   * @param spec - the capability's settings block declaration.
   * @throws {@link Error} when a spec with the same `key` is already registered,
   *   since a silently dropped registration would surface much later as a
   *   rejected settings block.
   */
  register(spec: CapabilitySettingsSpec): void;
  /** The registered specs, in registration order. */
  specs(): readonly CapabilitySettingsSpec[];
  /** Add one capability-owned grant to the request vocabulary. */
  registerGrant(declaration: CapabilityGrantDeclaration): void;
  /** The registered grant declarations, in registration order. */
  grants(): readonly CapabilityGrantDeclaration[];
}

/** Initial declarations copied into a new isolated registry. */
export interface CapabilityRegistrySeed {
  readonly specs?: readonly CapabilitySettingsSpec[];
  readonly grants?: readonly CapabilityGrantDeclaration[];
}

/**
 * Create an empty {@link CapabilityRegistry}.
 *
 * @returns a registry holding no specs.
 */
export function createCapabilityRegistry(seed: CapabilityRegistrySeed = {}): CapabilityRegistry {
  const byKey = new Map<string, CapabilitySettingsSpec>();
  const byGrant = new Map<string, CapabilityGrantDeclaration>();
  const registry: CapabilityRegistry = {
    register(spec: CapabilitySettingsSpec): void {
      const existing = byKey.get(spec.key);
      if (existing !== undefined) {
        throw new Error(`capability settings key '${spec.key}' is already registered`);
      }
      byKey.set(spec.key, spec);
    },
    specs(): readonly CapabilitySettingsSpec[] {
      return [...byKey.values()];
    },
    registerGrant(declaration: CapabilityGrantDeclaration): void {
      if (declaration.name.trim().length === 0) {
        throw new Error("capability grant name must be a non-empty string");
      }
      const existing = byGrant.get(declaration.name);
      if (existing !== undefined) {
        if (existing.entryCanSpawn === declaration.entryCanSpawn) return;
        throw new Error(`capability grant '${declaration.name}' is already registered differently`);
      }
      byGrant.set(declaration.name, declaration);
    },
    grants(): readonly CapabilityGrantDeclaration[] {
      return [...byGrant.values()];
    },
  };
  for (const spec of seed.specs ?? []) registry.register(spec);
  for (const declaration of seed.grants ?? []) registry.registerGrant(declaration);
  return registry;
}

/**
 * Copy a registry and add per-run capability grants without mutating the host's
 * long-lived registry.
 */
export function composeCapabilityRegistry(
  base: CapabilityRegistry | undefined,
  declarations: readonly CapabilityGrantDeclaration[],
): CapabilityRegistry {
  return createCapabilityRegistry({
    specs: base?.specs() ?? [],
    grants: [...(base?.grants() ?? []), ...declarations],
  });
}
