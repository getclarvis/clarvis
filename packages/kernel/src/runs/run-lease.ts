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
