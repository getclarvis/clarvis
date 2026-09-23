import type { RunHandle } from "@clarvis/protocol";

/**
 * Execute one physical run while a host lifecycle lease remains held.
 *
 * @param acquire - Admission boundary that returns an idempotent release.
 * @param run - Physical run body; never called when admission fails.
 * @returns The run body's result.
 */
export async function withRunLease<T>(
  acquire: () => () => void,
  run: () => Promise<T>,
): Promise<T> {
  const release = acquire();
  try {
    return await run();
  } finally {
    release();
  }
}

/** Release execution resources at `done` and host stream ownership at `closed`. */
export function releaseRunLeases(
  handle: Pick<RunHandle, "done" | "closed">,
  leases: { host?: () => void; skillCatalog?: () => void },
): void {
  if (leases.host !== undefined) void handle.closed.then(leases.host, leases.host);
  if (leases.skillCatalog !== undefined)
    void handle.done.then(leases.skillCatalog, leases.skillCatalog);
}
