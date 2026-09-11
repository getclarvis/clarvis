import { HOOKS_CAPABILITY_NAME } from "@clarvis/capability";
import {
  createMemoryCapability,
  MEMORY_CAPABILITY_NAME,
  type MemoryFactory,
} from "@clarvis/memory/capability";
import type { ExecuteRunDeps } from "@clarvis/loop";
import { createPlansCatalogCapability } from "@clarvis/plan/capability";
import { PLANS_CAPABILITY_NAME } from "@clarvis/plan/schemas";

/**
 * Derive the deps a memory indexing pass uses when it continues the run it indexes.
 *
 * @param deps - the run deps the host composed for ordinary runs.
 * @param memoryFactory - the same factory the host's own memory capability was
 *   built from, or `undefined` when the host runs without memory.
 * @returns `deps` without workspace hooks, with memory enqueue suppressed and
 *   planning replaced in place by its catalog-only projection.
 * @remarks Capability composition is the host's job, and this is the host's one
 *   composition whose correctness is invisible at every other layer — which is
 *   why it is a named function rather than an expression inside the kernel's
 *   construction path.
 *
 * Workspace hooks are removed so ungated `PreToolUse` hooks cannot fire on the
 * indexer's writes. Previously published blocks remain historical context.
 *
 * The memory capability keeps every wire surface and loses only its `onRunEnd`,
 * so a pass cannot enqueue itself and loop forever. Replacement matters: the
 * source deps already contain the ordinary memory capability, and appending the
 * pass form beside it would leave the ordinary `onRunEnd` live.
 * Planning retains its tools and delegation augmentation, but opens no provider
 * and owns no gates or lifecycle. Dispatch restrictions alone cannot prevent a
 * source plan from being finalized by an indexing pass.
 */
export function composeIndexPassDeps(
  deps: ExecuteRunDeps,
  memoryFactory: MemoryFactory | undefined,
): ExecuteRunDeps {
  return {
    ...deps,
    capabilities: [
      ...(deps.capabilities ?? [])
        .filter(
          (capability) =>
            capability.name !== HOOKS_CAPABILITY_NAME && capability.name !== MEMORY_CAPABILITY_NAME,
        )
        .map((capability) =>
          capability.name === PLANS_CAPABILITY_NAME ? createPlansCatalogCapability() : capability,
        ),
      createMemoryCapability(memoryFactory, { enqueueOnRunEnd: false }),
    ],
  };
}
