import {
  detachObserved,
  bestEffort,
  NOOP_LOGGER,
  suppressSecondaryRejection,
} from "@clarvis/capability";
import { kernelError } from "../core/errors.ts";
import { globalPaths } from "@clarvis/paths";
import { listenLocalKernel, type LocalKernelListener } from "../transport/local.ts";
import { createFileRunHost, type FileRunHost, type FileRunHostOptions } from "./file-host.ts";
import {
  acquireLocalHostState,
  resolveLocalHostIdentity,
  type LocalHostIdentity,
} from "./local-state.ts";

/** Process composition. None of these inputs are accepted from a connecting RPC peer. */
export interface ServeLocalFileKernelOptions {
  kernel: FileRunHostOptions["kernel"];
  artifactId: string;
  /** Idle duration measured with a monotonic clock. Defaults to one minute. */
  idleTimeoutMs?: number;
  /** Maximum lease/idle recheck interval. Defaults to one second. */
  checkIntervalMs?: number;
}

/** Owns the listener and physical kernel independently of every TUI connection. */
export interface LocalFileKernelHost {
  readonly identity: LocalHostIdentity;
  readonly generation: string;
  readonly host: FileRunHost;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw kernelError("invalid_request", "host lifecycle durations must be positive safe integers");
  return value;
}

/**
 * Hold the workspace lease before constructing the kernel and publish discovery only after its
 * listener and durable index are ready. Losing the lease closes execution authority. Zero clients
 * cannot stop admitted background work, memory jobs, maintenance, commits or disconnect cleanup.
 * A contending launcher returns null without constructing another kernel.
 */
export async function serveLocalFileKernel(
  options: ServeLocalFileKernelOptions,
): Promise<LocalFileKernelHost | null> {
  const idleTimeout = positive(options.idleTimeoutMs ?? 60_000);
  const interval = Math.min(positive(options.checkIntervalMs ?? 1000), idleTimeout);
  const logger = options.kernel.logger ?? NOOP_LOGGER;
  const identity = await resolveLocalHostIdentity({
    workspaceRoot: options.kernel.workspaceRoot,
    globalDir: options.kernel.globalDir,
    owner: options.kernel.defaultOwner,
  });
  const state = await acquireLocalHostState(identity, options.artifactId, logger);
  if (state === null) return null;
  let host: FileRunHost | undefined;
  let listener: LocalKernelListener | undefined;
  try {
    host = await createFileRunHost({
      kernel: {
        ...options.kernel,
        workspaceRoot: identity.workspaceRoot,
        globalDir: identity.globalDir,
        defaultOwner: identity.owner,
        traceDir: options.kernel.traceDir ?? globalPaths(identity.globalDir).tracesDir,
      },
      hostGeneration: state.generation,
      storage: state.storage,
      authenticate: (token) => state.authenticate(token),
      assertAuthority: () => state.lease.assertOwned(),
    });
    const ownedHost = host;
    await host.sync();
    listener = await listenLocalKernel(host.server, identity.paths.endpoint, { logger });
    const ownedListener = listener;
    await state.publish(host.kernel.workspace.id);
    host.kernel.startMemoryRecovery();
    const completion = Promise.withResolvers<void>();
    suppressSecondaryRejection(completion.promise, "LocalFileKernelHost.closed");
    let closing: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idleSince = performance.now();
    const close = (): Promise<void> => {
      closing ??= (async () => {
        clearTimeout(timer);
        await ownedListener.close();
        await ownedHost.close();
        await state.close();
      })();
      void closing.then(completion.resolve, completion.reject);
      return closing;
    };
    const busy = (): boolean => {
      const stats = ownedHost.stats();
      return (
        ownedListener.connections() > 0 ||
        stats.connections > 0 ||
        stats.runs > 0 ||
        stats.activities > 0 ||
        stats.maintenance ||
        stats.disconnecting > 0 ||
        stats.physicalRuns > 0 ||
        stats.committing > 0
      );
    };
    const tick = async (): Promise<void> => {
      try {
        if (ownedHost.stats().restartRequested) {
          await close();
          return;
        }
        if (!(await state.lease.owned())) {
          await close();
          return;
        }
        if (busy()) idleSince = performance.now();
        else if (performance.now() - idleSince >= idleTimeout) {
          const memory = ownedHost.kernel.capabilities.memory
            ? await ownedHost.kernel.memory.jobs({ limit: 1 })
            : undefined;
          const counts = memory?.counts;
          const memoryBusy =
            counts !== undefined && counts.pending + counts.running + counts.retry_wait > 0;
          if (busy() || memoryBusy) idleSince = performance.now();
          else {
            await close();
            return;
          }
        }
      } finally {
        if (closing === undefined) schedule();
      }
    };
    const schedule = (): void => {
      timer = setTimeout(
        () => detachObserved(tick, { operation: "hosting.lifecycle.tick", logger }),
        interval,
      );
      timer.unref?.();
    };
    schedule();
    return { identity, generation: state.generation, host, closed: completion.promise, close };
  } catch (error) {
    await bestEffort(() => listener?.close(), { operation: "hosting.listener.close", logger });
    if (host !== undefined) await host.close();
    await state.close();
    throw error;
  }
}
