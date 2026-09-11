import { createCapabilityRegistry, type CapabilityRegistry } from "@clarvis/capability";
import { settingsSchemaFor, type SettingsFile as LoopSettingsFile } from "@clarvis/loop/host";
import { memorySettingsSpec, type MemorySettingsBlock } from "@clarvis/memory/settings";
import { goalsSettingsSpec, type GoalsSettingsBlock } from "@clarvis/goal/settings";
import { plansSettingsSpec, type PlansSettingsBlock } from "@clarvis/plan/settings";
import { workflowsSettingsSpec, type WorkflowsSettingsBlock } from "@clarvis/workflows";
import { tasksSettingsSpec, type TasksSettingsBlock } from "@clarvis/tasks/settings";
import { runtimeSettingsSpec, type RuntimeSettingsBlock } from "../runtime/settings.ts";

/**
 * The capabilities this kernel hosts that declare their own `settings.json`
 * block, registered at module load — before any settings file is read.
 *
 * @remarks Ordering is the whole reason this is a module-level constant rather
 *   than something assembled per kernel: a block registered after settings were
 *   parsed is not in the schema, so its key reads as an unrecognized one and the
 *   file is rejected. The engine's own blocks are not here — those are spread
 *   statically into `settingsSchema`, which is what keeps zod's inference exact.
 *   Product capabilities own their blocks; the host additionally owns runtime
 *   placement settings.
 */
export const kernelCapabilityRegistry: CapabilityRegistry = createCapabilityRegistry();
kernelCapabilityRegistry.register(memorySettingsSpec);
kernelCapabilityRegistry.register(plansSettingsSpec);
kernelCapabilityRegistry.register(goalsSettingsSpec);
kernelCapabilityRegistry.register(workflowsSettingsSpec);
kernelCapabilityRegistry.register(tasksSettingsSpec);
kernelCapabilityRegistry.register(runtimeSettingsSpec);

/**
 * Compose the kernel's schema authority with host extensions for every owned
 * execution, including auxiliary passes. Kernel specs win key collisions;
 * conflicting grant declarations fail through the shared registry contract.
 */
export function composeKernelCapabilityRegistry(base?: CapabilityRegistry): CapabilityRegistry {
  const registry = createCapabilityRegistry();
  const keys = new Set<string>();
  for (const spec of [...kernelCapabilityRegistry.specs(), ...(base?.specs() ?? [])]) {
    if (keys.has(spec.key)) continue;
    keys.add(spec.key);
    registry.register(spec);
  }
  for (const grant of [...kernelCapabilityRegistry.grants(), ...(base?.grants() ?? [])]) {
    registry.registerGrant(grant);
  }
  return registry;
}

/**
 * The schema every `settings.json` this kernel reads or writes is validated
 * against: the engine's blocks plus the ones in
 * {@link kernelCapabilityRegistry}.
 */
export const kernelSettingsSchema = settingsSchemaFor(kernelCapabilityRegistry);

/**
 * The settings shape this kernel reads and writes: the engine's own blocks plus
 * the ones {@link kernelCapabilityRegistry} contributes.
 *
 * @remarks The engine's `SettingsFile` covers only the blocks it declares
 * statically, which is what keeps zod's inference exact there. A block a
 * capability registers is validated by {@link kernelSettingsSchema} but is
 * absent from that type, so a client typing a settings file against the engine's
 * would find the registered blocks missing. The kernel is the schema authority,
 * so it is the right place to compose the two.
 */
export type KernelSettingsFile = LoopSettingsFile & {
  memory?: MemorySettingsBlock;
  plans?: PlansSettingsBlock;
  goals?: GoalsSettingsBlock;
  workflows?: WorkflowsSettingsBlock;
  tasks?: TasksSettingsBlock;
  runtime?: RuntimeSettingsBlock;
};
