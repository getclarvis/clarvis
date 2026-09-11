import type { MemoryService } from "@clarvis/protocol";
import { KernelException } from "../core/errors.ts";

/**
 * Preserve a host while memory has executable work. A disabled workspace has no active memory
 * instance; other queue failures remain failures and must not authorize idle shutdown.
 */
export async function memoryKeepsHostAlive(
  memory: Pick<MemoryService, "jobs"> | undefined,
): Promise<boolean> {
  if (memory === undefined) return false;
  try {
    const { counts } = await memory.jobs({ limit: 1 });
    return counts.pending + counts.running + counts.retry_wait > 0;
  } catch (error) {
    if (
      error instanceof KernelException &&
      error.code === "capability_disabled" &&
      typeof error.details === "object" &&
      error.details !== null &&
      "memory_code" in error.details &&
      error.details.memory_code === "MEMORY_NOT_CONFIGURED"
    )
      return false;
    throw error;
  }
}
