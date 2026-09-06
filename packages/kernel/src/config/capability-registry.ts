import { createCapabilityRegistry, type CapabilityRegistry } from "@clarvis/capability";
import { settingsSchemaFor, type SettingsFile as LoopSettingsFile } from "@clarvis/loop/host";
import { memorySettingsSpec, type MemorySettingsBlock } from "@clarvis/memory/settings";
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
 *   This registry is only for capabilities that live in their own package, of
 *   `@clarvis/memory`, `@clarvis/plan` and `@clarvis/workflows` today.
 */
export const kernelCapabilityRegistry: CapabilityRegistry = createCapabilityRegistry();
kernelCapabilityRegistry.register(memorySettingsSpec);
kernelCapabilityRegistry.register(plansSettingsSpec);
kernelCapabilityRegistry.register(workflowsSettingsSpec);
kernelCapabilityRegistry.register(tasksSettingsSpec);
kernelCapabilityRegistry.register(runtimeSettingsSpec);

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
  workflows?: WorkflowsSettingsBlock;
  tasks?: TasksSettingsBlock;
  runtime?: RuntimeSettingsBlock;
};
