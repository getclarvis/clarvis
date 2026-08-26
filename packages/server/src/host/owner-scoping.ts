import type { KernelResolver, RunHost } from "./run-host.ts";

/** The one kernel operation owner binding actually consumes. */
export interface OwnerScopedKernel {
  forOwner(owner: string): RunHost;
  acquireOwner?(owner: string): Promise<{ value: RunHost; release(): void }>;
}

/**
 * Serve each connection the kernel scope of the owner it speaks for.
 *
 * @param kernel - the single kernel this container runs.
 * @returns a {@link KernelResolver} binding `kernel.forOwner(ctx.owner)`.
 * @remarks One kernel, many owners: the expensive singletons — the provider
 * adapter, the trace store, the config and skills catalogues, `process.env`
 * credentials — stay shared, while runs, memory, plans and sessions separate.
 *
 *   The MCP connection **pool** object is shared too, but what it hands out is
 *   not: a pooled subprocess is keyed on the acquiring run's owner, so no owner
 *   is served another's warm connection. Setting `CLARVIS_MCP_POOL_SHARING` to
 *   `workspace` trades that back for one subprocess per workspace, which is why
 *   it is opt-in.
 *
 *   **Whether this is a boundary or a naming convention depends on the owner
 *   mode.** Under `token` the owner comes from the caller's enrolment record and
 *   is authenticated; under `fixed`, `header` and `allowlist` it is validated but
 *   caller-supplied, which separates data without authenticating the separation
 *   and must not be described to a client as isolation.
 */
export function ownerScopedKernelResolver(kernel: OwnerScopedKernel): KernelResolver {
  return async (ctx) => {
    const lease = await kernel.acquireOwner?.(ctx.owner);
    return {
      host: lease?.value ?? kernel.forOwner(ctx.owner),
      owner: ctx.owner,
      ...(ctx.principal !== undefined ? { principal: ctx.principal } : {}),
      ...(lease === undefined ? {} : { release: () => lease.release() }),
    };
  };
}
