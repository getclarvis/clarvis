import { HOOKS_CAPABILITY_NAME } from "@clarvis/capability";
import { createMemoryCapability, type MemoryFactory } from "@clarvis/memory/capability";
import type { ExecuteRunDeps } from "@clarvis/loop";

/**
 * Derive the deps a memory indexing pass uses when it continues the run it indexes.
 *
 * @param deps - the run deps the host composed for ordinary runs.
 * @param memoryFactory - the same factory the host's own memory capability was
 *   built from, or `undefined` when the host runs without memory.
 * @returns `deps` with exactly two changes: no workspace-hooks capability, and a
 *   memory capability whose post-run enqueue is suppressed.
 * @remarks Capability composition is the host's job, and this is the host's one
 *   composition whose correctness is invisible at every other layer — which is
 *   why it is a named function rather than an expression inside the kernel's
 *   construction path.
 *
 * Workspace hooks are **removed from the list**, not disabled. The engine
 * collects seed markers from every *registered* capability and keeps a carried
 * seed block only while its marker is still live, so a hooks capability that is
 * present but inactive makes the block the continuation carried get dropped out
 * of the middle of the transcript — re-billing everything behind it. A
 * capability the run never registers is unrecognised instead, so its block reads
 * as ordinary history and survives untouched. The removal doubles as the reason
 * `PreToolUse` hooks, which are not gated by grants, cannot fire on a pass's own
 * `write_memory` calls.
 *
 * The memory capability keeps every wire surface and loses only its `onRunEnd`,
 * so a pass cannot enqueue itself and loop forever.
 */
export function composeIndexPassDeps(
  deps: ExecuteRunDeps,
  memoryFactory: MemoryFactory | undefined,
): ExecuteRunDeps {
  return {
    ...deps,
    capabilities: [
      ...(deps.capabilities ?? []).filter((c) => c.name !== HOOKS_CAPABILITY_NAME),
      createMemoryCapability(memoryFactory, { enqueueOnRunEnd: false }),
    ],
  };
}
