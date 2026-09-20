import {
  attestConfiguration,
  type ConfigurationMutationFacts,
} from "../../src/guard/effects/configuration.ts";
import type { GuardEffectRegistry } from "../../src/guard/effects/registry.ts";
import type { GuardEffectFact } from "../../src/guard/effects/types.ts";

/**
 * One canonical operational settings edit.
 *
 * @remarks The restricted writer is the only producer of reviewed effect facts, so every fixture
 * that needs a real, coverable fact starts from this shape rather than from a hand-built literal.
 */
function configurationMutation(
  overrides: Partial<ConfigurationMutationFacts> = {},
): ConfigurationMutationFacts {
  return {
    canonicalPath: ".clarvis/settings.json",
    root: "workspace_clarvis",
    expectedRevision: "a".repeat(64),
    nextRevision: "b".repeat(64),
    bytes: 100,
    operation: "edit",
    fieldClass: "settings",
    surface: "operational",
    ...overrides,
  };
}

/** Attest a {@link configurationMutation} against the closed configuration descriptor vocabulary. */
export function configurationFact(
  registry: GuardEffectRegistry,
  overrides: Partial<ConfigurationMutationFacts> = {},
): GuardEffectFact {
  return attestConfiguration(configurationMutation(overrides), registry);
}
