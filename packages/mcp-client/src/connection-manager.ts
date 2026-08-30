import { createHash } from "node:crypto";
import type { McpServerConfig } from "@clarvis/capability";
import type { MCPConnection } from "@clarvis/capability";
import type { Logger } from "@clarvis/capability";
import { ownerSegment } from "@clarvis/paths";
import {
  NOOP_LOGGER,
  bestEffort,
  bind,
  createSampler,
  detachObserved,
  levelEnabled,
  unref,
} from "@clarvis/capability";
import type {
  ElicitationRelay,
  MCPAuthorizationWait,
  MCPClientFactory,
  MCPClientHandle,
} from "./client.ts";
import { aliasMCPRequestAuthorization } from "./client.ts";
import { MCPAuthorizationPendingError } from "./oauth.ts";
import { MCPBackgroundConnectDeferredError } from "./errors.ts";
import { openConnection } from "./connection.ts";
import type { OpenedConnection, ConnectionEventSink, PoolScope } from "./connection.ts";
import { normalizeMcpCloseGraceMs, type ResilientSessionTimer } from "./resilient-session.ts";

/**
 * A borrowed {@link OpenedConnection} with a `release` that returns it to the
 * pool. For a shared (pooled) lease, `release` decrements the refcount and arms
 * an idle-eviction timer at zero; for a fresh (unpooled) lease it closes the
 * connection outright. `release` is idempotent.
 */
export interface Lease extends OpenedConnection {
  release: () => Promise<void>;
}

export type { PoolScope } from "./connection.ts";

/**
 * Inputs to {@link ConnectionManager.acquire}: the `server` to connect to, the
 * `owner` of the acquiring run, an optional elicitation `relay`, and an optional
 * `signal` to abort the wait.
 */
export interface AcquireOptions {
  server: McpServerConfig;
  /** Owner of the run acquiring the lease; part of the pool key unless
   * `poolSharing` is `workspace`. */
  owner: string;
  /** Bridge for server-initiated elicitation. Honoured on a dedicated
   * connection; **dropped, with a warning, on a pooled one**, which therefore
   * advertises no `elicitation` capability. */
  relay?: ElicitationRelay;
  signal?: AbortSignal;
  /** Whether browser OAuth blocks this acquisition or continues in the background. */
  authorizationWait?: MCPAuthorizationWait;
  /** Override pool sharing for this lease; security-sensitive adapters use `owner`. */
  poolSharing?: PoolSharing;
}

/**
 * A pool over MCP connections: {@link ConnectionManager.acquire | acquire} a
 * lease per run, and {@link ConnectionManager.closeAll | closeAll} to tear the
 * pool down. Eligible connections (stdio, `shared`) are shared across concurrent
 * leases by a pool key and kept warm for `idleTtlMs` after the last release;
 * everything else gets a dedicated connection.
 */
export interface ConnectionManager {
  acquire(opts: AcquireOptions): Promise<Lease>;
  closeAll(): Promise<void>;
}

/**
 * How far a pooled subprocess may be shared.
 *
 * @remarks `owner` (the default) keys every pooled connection on the acquiring
 *   run's owner, so no subprocess is ever shared between owners. `workspace`
 *   drops owner from the key, letting every owner of the workspace share one
 *   subprocess — cheaper, but a deliberate opt-in, because owner is
 *   caller-supplied under every mode but `token` and a shared subprocess shares
 *   whatever state that server holds.
 */
export type PoolSharing = "owner" | "workspace";

/**
 * Construction options for {@link createConnectionManager}: the `workspace` the
 * manager serves, the client `factory` and timeouts forwarded to
 * {@link openConnection}, the `idleTtlMs` warm-hold for pooled connections
 * (default {@link DEFAULT_IDLE_TTL_MS}), and optional sharing/resource/health
 * tuning, a connection-event sink, and a logger.
 */
export interface ConnectionManagerOptions {
  /** Absolute workspace root; always part of the pool key. */
  workspace: string;
  factory: MCPClientFactory;
  connectTimeoutMs: number;
  callTimeoutMs: number;
  idleTtlMs?: number;
  /** How far a pooled subprocess may be shared; defaults to `owner`. */
  poolSharing?: PoolSharing;
  resourcesEnabled?: boolean;
  timeoutStreakThreshold?: number;
  healthPingIntervalMs?: number;
  onConnectionEvent?: ConnectionEventSink;
  logger?: Logger;
  /** Maximum live plus connecting MCP transports. Defaults to 32. */
  maxConnections?: number;
  /** Maximum handshakes or retained background authorization completions. Defaults to 4. */
  maxParallelConnects?: number;
  /** Maximum zero-ref shared transports kept warm. Defaults to 8. */
  maxIdleConnections?: number;
  /** Per-operation shutdown grace before late closes are detached. Defaults to 2s. */
  closeGraceMs?: number;
  /** Internal deterministic-test seam; production uses an unref'ed timer. */
  scheduleCloseTimeout?: (callback: () => void, delayMs: number) => ResilientSessionTimer;
}

interface SharedSlot {
  connPromise: Promise<OpenedConnection>;
  opened?: OpenedConnection;
  refcount: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  idleSince?: number;
  /** The server this slot holds, so an eviction record can name it. */
  mcpName: string;
}

/**
 * A stable, non-reversible handle on a pool key.
 *
 * @remarks The key itself embeds a server's resolved `env` and `headers`, so it
 *   is exactly the string this package may never log. A digest still tells an
 *   operator that two records concern the same pooled connection, which is the
 *   only thing the raw key was wanted for.
 */
function poolKeyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

const DEFAULT_IDLE_TTL_MS = 60_000;
export const DEFAULT_MAX_MCP_CONNECTIONS = 32;
export const DEFAULT_MAX_PARALLEL_MCP_CONNECTS = 4;
export const DEFAULT_MAX_IDLE_MCP_CONNECTIONS = 8;

function finiteIntegerAtLeast(
  value: number | undefined,
  fallback: number,
  minimum: number,
): number {
  const selected = value ?? fallback;
  return Number.isFinite(selected) ? Math.max(minimum, Math.floor(selected)) : fallback;
}

function linkedSignal(
  primary: AbortSignal | undefined,
  shutdown: AbortSignal,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const sources = primary === undefined ? [shutdown] : [primary, shutdown];
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  for (const signal of sources) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const listener = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
    listeners.push({ signal, listener });
  }
  return {
    signal: controller.signal,
    dispose(): void {
      for (const entry of listeners) {
        entry.signal.removeEventListener("abort", entry.listener);
      }
    },
  };
}

interface InitialHandleTracker {
  active: boolean;
  handle: MCPClientHandle | undefined;
  registry: Set<MCPClientHandle> | undefined;
  /** The initial factory invocation, retained only until open admission can
   * decide whether its connection-capacity slot must stay quarantined. */
  attempt: Promise<MCPClientHandle> | undefined;
  settled: boolean;
  failure: unknown;
}

/** Keep the initial post-handshake handle visible to manager teardown without
 * making the session's long-lived reconnect factory retain the manager graph. */
function withInitialHandleTracking(
  factory: MCPClientFactory,
  tracker: InitialHandleTracker,
  attempts: Set<Promise<MCPClientHandle>>,
  trackHandleClose: (handle: MCPClientHandle) => MCPClientHandle,
): MCPClientFactory {
  return (server, relay, connect) => {
    const attempt = factory(server, relay, connect).then((handle) => {
      const tracked = trackHandleClose(handle);
      if (tracker.active) {
        tracker.handle = tracked;
        tracker.registry?.add(tracked);
      }
      return tracked;
    });
    attempts.add(attempt);
    void attempt.then(
      () => attempts.delete(attempt),
      () => attempts.delete(attempt),
    );
    if (tracker.active && tracker.attempt === undefined) {
      tracker.attempt = attempt;
      void attempt.then(
        () => {
          tracker.settled = true;
        },
        (error: unknown) => {
          tracker.settled = true;
          tracker.failure = error;
        },
      );
    }
    return attempt;
  };
}

interface ManagedCloseState {
  disposeSignal: () => void;
  releaseCapacity: () => void;
}

const NOOP = (): void => {};

/** Install manager bookkeeping around an idempotent connection close. The
 * callbacks are discarded after the first completion so a retained old lease
 * cannot keep the manager's maps and counters reachable. */
function manageConnectionClose(connection: MCPConnection, state: ManagedCloseState): void {
  const close = connection.close.bind(connection);
  connection.close = async (): Promise<void> => {
    try {
      await close();
    } finally {
      const disposeSignal = state.disposeSignal;
      const releaseCapacity = state.releaseCapacity;
      state.disposeSignal = NOOP;
      state.releaseCapacity = NOOP;
      disposeSignal();
      releaseCapacity();
    }
  };
}

export class MCPConnectionLimitError extends Error {
  readonly code = "mcp_connection_limit" as const;
  constructor(readonly limit: number) {
    super(`MCP connection limit reached (${String(limit)}).`);
    this.name = "MCPConnectionLimitError";
  }
}

/** Await `p`, but reject as soon as `signal` aborts — without disturbing `p`
 * itself, since a shared connection's connPromise may still be awaited by other
 * runs. Lets a cancelled run stop waiting on a pooled connect promptly instead
 * of blocking until the connect timeout. */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

function awaitAbortable<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return p;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(e);
      },
    );
  });
}

interface PhysicalConnectWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface PhysicalConnectGate {
  factory: MCPClientFactory;
  close(): void;
}

type RetainPendingAdmission = (completion: Promise<void>, release: () => void) => void;

/**
 * Keep a permit for the lifetime of the physical factory invocation, not only
 * for the caller's bounded wait around it.
 *
 * A transport factory is expected to honour its abort signal, but it is a
 * pluggable/native boundary and may not. If the logical connect timeout freed
 * this permit, repeated acquires could start one never-settling subprocess or
 * HTTP handshake per timeout. Holding it until the underlying promise settles
 * turns those late attempts into a fixed-size quarantine.
 */
function createPhysicalConnectGate(
  factory: MCPClientFactory,
  maxParallelConnects: number,
  logger: Logger,
  retainPendingAdmission: RetainPendingAdmission,
): PhysicalConnectGate {
  const waiters: PhysicalConnectWaiter[] = [];
  const sampleQueued = createSampler();
  const queuedEnabled = levelEnabled(logger, "debug");
  let active = 0;
  let closed = false;

  const release = (): void => {
    active = Math.max(0, active - 1);
    while (!closed && waiters.length > 0 && active < maxParallelConnects) {
      const waiter = waiters.shift()!;
      if (waiter.signal?.aborted) continue;
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      active += 1;
      waiter.resolve();
      break;
    }
  };

  const acquire = (
    signal: AbortSignal | undefined,
    authorizationWait: MCPAuthorizationWait | undefined,
  ): Promise<void> | null => {
    if (closed) return Promise.reject(new Error("connection manager closed"));
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (active < maxParallelConnects) {
      active += 1;
      return null;
    }
    if (authorizationWait === "background") {
      throw new MCPBackgroundConnectDeferredError(maxParallelConnects);
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: PhysicalConnectWaiter = { resolve, reject, signal };
      if (signal !== undefined) {
        waiter.onAbort = (): void => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      waiters.push(waiter);
    });
  };

  return {
    factory: async (server, relay, connect) => {
      const signal = connect?.signal;
      const waiting = acquire(signal, connect?.authorizationWait);
      if (waiting !== null) {
        if (queuedEnabled && sampleQueued(server.name)) {
          logger.debug(
            {
              event: "mcp.pool.connect_queued",
              mcp: server.name,
              active,
              max_parallel: maxParallelConnects,
            },
            "mcp connect is waiting for a handshake permit; this server starts once one frees",
          );
        }
        await waiting;
      }
      let retained = false;
      try {
        if (signal?.aborted) throw abortReason(signal);
        return await factory(server, relay, connect);
      } catch (error) {
        if (error instanceof MCPAuthorizationPendingError) {
          retained = true;
          retainPendingAdmission(error.completion, release);
        }
        throw error;
      } finally {
        // Deliberately follows the physical factory promise. A logical timeout
        // aborts `signal`, but cannot release this permit until the factory has
        // actually unwound.
        if (!retained) release();
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      for (const waiter of waiters.splice(0)) {
        if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
        waiter.reject(new Error("connection manager closed"));
      }
    },
  };
}

function sortKeys(o?: Record<string, string>): Record<string, string> | null {
  if (!o) return null;
  return Object.fromEntries(
    Object.keys(o)
      .sort()
      .map((k) => [k, o[k]!]),
  );
}

/**
 * The {@link McpServerConfig} fields {@link poolKey} discriminates on.
 *
 * @remarks Everything except `shared`, which is a precondition of the poolable
 *   path rather than a discriminant, and `auto_tools`, which is run-level tool
 *   admission applied by the loop after a connection opens. Neither changes the
 *   physical server or the tools it advertises.
 */
type PoolKeyField =
  | "name"
  | "transport"
  | "command"
  | "args"
  | "env"
  | "cwd"
  | "url"
  | "headers"
  | "expandVariables"
  | "resources";

/**
 * Compile-time drift guard: only type-checks while {@link PoolKeyField} plus
 * `shared` covers every field of {@link McpServerConfig}.
 *
 * @remarks A runtime "every field changes the key" test cannot cover this:
 *   altering `transport`, `url` or `headers` makes the server unpoolable, so no
 *   slot is ever created and the assertion is vacuous. `resources` is the field
 *   this exists for — it decides whether the synthetic resource tools are
 *   attached, and every lease of a slot is handed the same `tools` array.
 */
type PoolKeyCoversConfig = [
  Exclude<keyof McpServerConfig, PoolKeyField | "shared" | "auto_tools">,
] extends [never]
  ? true
  : false;

const _poolKeyDriftLock: PoolKeyCoversConfig = true;
void _poolKeyDriftLock;

/**
 * The identity of a poolable connection: its whole server config plus the
 * {@link PoolScope} it belongs to.
 *
 * @param server - the server being connected to.
 * @param scope - the workspace/owner boundary the connection belongs to.
 * @param sharing - how far a subprocess may be shared; under `workspace` the
 *   owner is dropped from the key while remaining on the scope, so events still
 *   report which owner opened the connection.
 * @returns a stable string key.
 * @remarks `cwd` is read raw rather than resolved against the client factory's
 *   `defaultCwd`. That is sound only because a manager has exactly one
 *   `defaultCwd` and one `workspace`, and `workspace` is already in the key —
 *   resolving it here would add no discrimination.
 */
function poolKey(server: McpServerConfig, scope: PoolScope, sharing: PoolSharing): string {
  return JSON.stringify({
    workspace: scope.workspace,
    owner: sharing === "owner" ? scope.owner : null,
    name: server.name,
    transport: server.transport,
    command: server.command ?? null,
    args: server.args ?? [],
    env: sortKeys(server.env),
    cwd: server.cwd ?? null,
    url: server.url ?? null,
    headers: sortKeys(server.headers),
    expandVariables: server.expandVariables ?? true,
    resources: server.resources ?? null,
  });
}

/**
 * Create a {@link ConnectionManager} that pools shareable MCP connections and
 * hands out {@link Lease}s.
 *
 * @param opts - workspace, factory, timeouts and tuning; see
 *   {@link ConnectionManagerOptions}.
 * @returns the manager.
 * @remarks A connection is poolable when it is `stdio` and marked `shared`; such
 *   connections are keyed by their full config and by the {@link PoolScope} they
 *   belong to, so identical servers share one connection and refcounting keeps it
 *   alive across concurrent leases. A pooled connection is opened **without** the
 *   acquiring run's elicitation relay and so advertises no `elicitation`
 *   capability: it may serve several runs at once, and there is no single human a
 *   server-initiated prompt could be routed to. Routing it to one lease would let
 *   one run's server ask another run's user — and, under `poolSharing:
 *   "workspace"`, another owner's. A relay handed to a poolable acquire is
 *   dropped with a warning rather than silently disabling the pool, which is what
 *   made `shared` inert for every run that could ask a question. At refcount zero
 *   a connection is held warm
 *   for `idleTtlMs` then evicted; a slot whose connection is no longer
 *   `connected` is discarded and reopened on the next acquire. Non-poolable
 *   acquires get a dedicated connection closed on release. `signal` aborts only
 *   the caller's wait, never a shared connect that other runs may still be
 *   awaiting. A background acquire never queues behind a saturated physical
 *   gate; it degrades for that run while already admitted work retains its
 *   permit until completion. After {@link ConnectionManager.closeAll | closeAll}
 *   every acquire throws, without opening anything first.
 */
export function createConnectionManager(opts: ConnectionManagerOptions): ConnectionManager {
  const idleTtlMs = finiteIntegerAtLeast(opts.idleTtlMs, DEFAULT_IDLE_TTL_MS, 0);
  const maxConnections = finiteIntegerAtLeast(opts.maxConnections, DEFAULT_MAX_MCP_CONNECTIONS, 1);
  const maxParallelConnects = finiteIntegerAtLeast(
    opts.maxParallelConnects,
    DEFAULT_MAX_PARALLEL_MCP_CONNECTS,
    1,
  );
  const maxIdleConnections = finiteIntegerAtLeast(
    opts.maxIdleConnections,
    DEFAULT_MAX_IDLE_MCP_CONNECTIONS,
    0,
  );
  const closeGraceMs = normalizeMcpCloseGraceMs(opts.closeGraceMs);
  const scheduleCloseTimeout =
    opts.scheduleCloseTimeout ??
    ((callback: () => void, delayMs: number): ResilientSessionTimer => {
      const timer = setTimeout(callback, delayMs);
      unref(timer);
      return { cancel: () => clearTimeout(timer) };
    });
  const sharing: PoolSharing = opts.poolSharing ?? "owner";
  const logger = bind(opts.logger ?? NOOP_LOGGER, { workspace: opts.workspace });
  const shutdown = new AbortController();
  const slots = new Map<string, SharedSlot>();
  const live = new Set<MCPConnection>();
  const backgroundClosures = new Set<Promise<unknown>>();
  const pendingAdmissions = new Set<Promise<void>>();
  const pendingConnectAttempts = new Set<Promise<MCPClientHandle>>();
  const pendingOpens = new Set<Promise<OpenedConnection>>();
  const openingHandles = new Set<MCPClientHandle>();
  const retainPendingAdmission: RetainPendingAdmission = (completion, release) => {
    const retained = completion.then(release, release);
    pendingAdmissions.add(retained);
    void retained.then(
      () => pendingAdmissions.delete(retained),
      () => pendingAdmissions.delete(retained),
    );
  };
  const physicalConnects = createPhysicalConnectGate(
    opts.factory,
    maxParallelConnects,
    logger,
    retainPendingAdmission,
  );
  let admittedConnections = 0;
  let closed = false;
  let closeAllPromise: Promise<void> | undefined;

  function trackClosure(close: () => Promise<void>): Promise<void> {
    const promise = Promise.resolve().then(close);
    backgroundClosures.add(promise);
    void promise.then(
      () => backgroundClosures.delete(promise),
      () => backgroundClosures.delete(promise),
    );
    return promise;
  }

  function trackHandleClose(handle: MCPClientHandle): MCPClientHandle {
    const close = handle.close.bind(handle);
    let closing: Promise<void> | undefined;
    const trackedClose = (): Promise<void> => {
      closing ??= trackClosure(close);
      return closing;
    };
    try {
      handle.close = trackedClose;
      if (handle.close === trackedClose) return handle;
    } catch {}
    const tracked: MCPClientHandle = {
      get client() {
        return handle.client;
      },
      get protocolVersion() {
        return handle.protocolVersion;
      },
      close: trackedClose,
    };
    aliasMCPRequestAuthorization(handle, tracked);
    return tracked;
  }

  function trackOpen(open: Promise<OpenedConnection>): Promise<OpenedConnection> {
    pendingOpens.add(open);
    void open.then(
      () => pendingOpens.delete(open),
      () => pendingOpens.delete(open),
    );
    return open;
  }

  const scopeOf = (owner: string): PoolScope => ({
    workspace: opts.workspace,
    owner: ownerSegment(owner),
  });

  const relayDroppedWarned = new Set<string>();

  /**
   * Warn once per server that a shared server cannot elicit.
   *
   * @remarks Keyed on the server name, not on a slot and not on the pool key. A
   *   slot is destroyed at idle eviction and rebuilt on the next acquire, so a
   *   per-slot flag would re-warn every `idleTtlMs` under intermittent load. The
   *   pool key would be correct but unbounded: it embeds the owner, which under
   *   the server's `header` and `allowlist` modes is caller-supplied, so a client
   *   varying it per request would grow this set without limit. The warning names
   *   only the server, so the set of configured server names is the natural — and
   *   naturally bounded — key.
   */
  function warnRelayDropped(o: AcquireOptions): void {
    if (o.relay === undefined || relayDroppedWarned.has(o.server.name)) return;
    relayDroppedWarned.add(o.server.name);
    logger.warn(
      { event: "mcp.pool.relay_dropped", mcp: o.server.name },
      "mcp server is shared, so its connection advertises no elicitation capability and it " +
        "cannot prompt a human; remove 'shared' from the server if it needs to",
    );
  }

  /**
   * Open a connection outside the pool.
   *
   * @param o - the acquire being served.
   * @param signal - the caller's cancel signal, or `undefined` for a shared
   *   connect other runs may await.
   * @param pooled - whether the connection will back a shared slot; a pooled one
   *   is opened without the relay.
   * @returns the opened connection.
   */
  async function openFresh(
    o: AcquireOptions,
    signal: AbortSignal | undefined,
    pooled = false,
  ): Promise<OpenedConnection> {
    if (admittedConnections >= maxConnections) {
      logger.warn(
        {
          event: "mcp.pool.limit",
          mcp: o.server.name,
          limit: maxConnections,
          admitted: admittedConnections,
        },
        "mcp connection limit reached; this server is not connected and the run continues " +
          "without its tools",
      );
      if (o.authorizationWait === "background") {
        throw new MCPBackgroundConnectDeferredError(maxConnections, "connections");
      }
      throw new MCPConnectionLimitError(maxConnections);
    }
    admittedConnections += 1;
    let capacityReleased = false;
    const releaseCapacity = (): void => {
      if (capacityReleased) return;
      capacityReleased = true;
      admittedConnections = Math.max(0, admittedConnections - 1);
    };
    const linked = linkedSignal(signal, shutdown.signal);
    let linkedOwnedByConnection = false;
    const initialHandle: InitialHandleTracker = {
      active: true,
      handle: undefined,
      registry: openingHandles,
      attempt: undefined,
      settled: false,
      failure: undefined,
    };
    const trackedFactory = withInitialHandleTracking(
      physicalConnects.factory,
      initialHandle,
      pendingConnectAttempts,
      trackHandleClose,
    );
    try {
      const opened = await openConnection({
        server: o.server,
        scope: scopeOf(o.owner),
        connectTimeoutMs: opts.connectTimeoutMs,
        callTimeoutMs: opts.callTimeoutMs,
        factory: trackedFactory,
        resourcesEnabled: opts.resourcesEnabled ?? true,
        ...(opts.timeoutStreakThreshold !== undefined
          ? { timeoutStreakThreshold: opts.timeoutStreakThreshold }
          : {}),
        ...(opts.healthPingIntervalMs !== undefined
          ? { healthPingIntervalMs: opts.healthPingIntervalMs }
          : {}),
        closeGraceMs,
        ...(opts.onConnectionEvent !== undefined ? { onEvent: opts.onConnectionEvent } : {}),
        logger,
        ...(o.relay && !pooled ? { relay: o.relay } : {}),
        signal: linked.signal,
        ...(o.authorizationWait === undefined ? {} : { authorizationWait: o.authorizationWait }),
      });
      manageConnectionClose(opened.conn, {
        disposeSignal: () => linked.dispose(),
        releaseCapacity,
      });
      linkedOwnedByConnection = true;
      return opened;
    } catch (error) {
      const attempt = initialHandle.attempt;
      if (error instanceof MCPAuthorizationPendingError) {
        retainPendingAdmission(error.completion, releaseCapacity);
      } else if (error instanceof MCPBackgroundConnectDeferredError) {
        releaseCapacity();
      } else if (attempt !== undefined && !initialHandle.settled) {
        logger.warn(
          {
            event: "mcp.connect.quarantined",
            mcp: o.server.name,
            transport: o.server.transport,
          },
          "mcp connect attempt outlived its bounded wait; its connection slot stays reserved " +
            "until the attempt unwinds",
        );
        void attempt.then(releaseCapacity, (attemptError: unknown) => {
          if (attemptError instanceof MCPAuthorizationPendingError) {
            retainPendingAdmission(attemptError.completion, releaseCapacity);
            return;
          }
          releaseCapacity();
        });
      } else if (initialHandle.failure instanceof MCPAuthorizationPendingError) {
        retainPendingAdmission(initialHandle.failure.completion, releaseCapacity);
      } else {
        releaseCapacity();
      }
      throw error;
    } finally {
      initialHandle.active = false;
      if (initialHandle.handle !== undefined) openingHandles.delete(initialHandle.handle);
      initialHandle.handle = undefined;
      initialHandle.registry = undefined;
      initialHandle.attempt = undefined;
      if (!linkedOwnedByConnection) linked.dispose();
    }
  }

  /**
   * Report that a pooled connection left the pool.
   *
   * @param reason - `ttl` and `max_idle` are the two ordinary warm-hold exits;
   *   `unhealthy` and `abandoned` are the two a lease never asked for.
   * @param slot - the slot being dropped.
   * @param key - its pool key, reported only as a digest.
   */
  function reportEvicted(
    reason: "ttl" | "max_idle" | "unhealthy" | "abandoned",
    slot: SharedSlot,
    key: string,
  ): void {
    logger.debug(
      {
        event: "mcp.pool.evicted",
        mcp: slot.mcpName,
        key_hash: poolKeyHash(key),
        idle_ms: slot.idleSince === undefined ? 0 : Date.now() - slot.idleSince,
        reason,
      },
      "pooled mcp connection was dropped; the next acquire pays a fresh handshake",
    );
  }

  function evict(key: string, slot: SharedSlot, reason: "ttl" | "max_idle"): void {
    if (slots.get(key) !== slot || slot.refcount > 0) return;
    if (slot.idleTimer !== undefined) clearTimeout(slot.idleTimer);
    slot.idleTimer = undefined;
    slots.delete(key);
    reportEvicted(reason, slot, key);
    const opened = slot.opened;
    if (opened) {
      const closing = trackClosure(() => opened.conn.close());
      detachObserved(() => closing, {
        operation: "mcp_pool_idle_close",
        workspace: opts.workspace,
        dedupeKey: `mcp_pool_idle_close\0${opts.workspace}\0${slot.mcpName}`,
        logger,
      });
    }
  }

  function armIdle(key: string, slot: SharedSlot): void {
    if (slot.idleTimer !== undefined || closed) return;
    slot.idleSince = Date.now();
    slot.idleTimer = setTimeout(() => evict(key, slot, "ttl"), idleTtlMs);
    unref(slot.idleTimer);
    const idle = [...slots.entries()]
      .filter(([, candidate]) => candidate.refcount === 0 && candidate.opened !== undefined)
      .sort((a, b) => (a[1].idleSince ?? 0) - (b[1].idleSince ?? 0));
    while (idle.length > maxIdleConnections) {
      const oldest = idle.shift();
      if (oldest !== undefined) evict(oldest[0], oldest[1], "max_idle");
    }
  }

  function releaseAcquireRef(key: string, slot: SharedSlot): void {
    slot.refcount -= 1;
    if (slot.refcount > 0 || slots.get(key) !== slot) return;
    if (slot.opened) armIdle(key, slot);
  }

  function makeFreshLease(opened: OpenedConnection): Lease {
    live.add(opened.conn);
    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      live.delete(opened.conn);
      await opened.conn.close();
    };
    return { conn: opened.conn, tools: opened.tools, release };
  }

  function makeSharedLease(key: string, slot: SharedSlot, opened: OpenedConnection): Lease {
    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      slot.refcount -= 1;
      if (slot.refcount > 0) return;
      if (closed || slots.get(key) !== slot || opened.conn.status !== "connected") {
        if (slots.get(key) === slot) slots.delete(key);
        if (!closed) await opened.conn.close();
        return;
      }
      armIdle(key, slot);
    };
    return { conn: opened.conn, tools: opened.tools, release };
  }

  async function acquire(o: AcquireOptions): Promise<Lease> {
    if (closed) throw new Error("connection manager closed");

    const poolable = o.server.transport === "stdio" && o.server.shared === true;
    if (!poolable) {
      const opened = await trackOpen(openFresh(o, o.signal));
      if (closed) {
        await opened.conn.close();
        throw new Error("connection manager closed");
      }
      return makeFreshLease(opened);
    }

    const key = poolKey(o.server, scopeOf(o.owner), o.poolSharing ?? sharing);
    warnRelayDropped(o);
    let slot = slots.get(key);

    if (
      slot &&
      slot.refcount === 0 &&
      slot.opened !== undefined &&
      slot.opened.conn.status !== "connected"
    ) {
      if (slot.idleTimer) clearTimeout(slot.idleTimer);
      slots.delete(key);
      reportEvicted("unhealthy", slot, key);
      const opened = slot.opened;
      const closing = trackClosure(() => opened.conn.close());
      detachObserved(() => closing, {
        operation: "mcp_pool_unhealthy_close",
        workspace: opts.workspace,
        dedupeKey: `mcp_pool_unhealthy_close\0${opts.workspace}\0${o.server.name}`,
        logger,
      });
      slot = undefined;
    }

    if (slot) {
      slot.refcount += 1;
      if (slot.idleTimer) {
        clearTimeout(slot.idleTimer);
        slot.idleTimer = undefined;
        slot.idleSince = undefined;
      }
      try {
        const opened = await awaitAbortable(slot.connPromise, o.signal);
        return makeSharedLease(key, slot, opened);
      } catch (err) {
        releaseAcquireRef(key, slot);
        throw err;
      }
    }

    const fresh: SharedSlot = {
      connPromise: trackOpen(openFresh(o, undefined, true)),
      refcount: 1,
      mcpName: o.server.name,
    };
    slots.set(key, fresh);
    fresh.connPromise.then(
      (c) => {
        fresh.opened = c;
        if (fresh.refcount === 0 && slots.get(key) === fresh) {
          slots.delete(key);
          reportEvicted("abandoned", fresh, key);
          const closing = trackClosure(() => c.conn.close());
          detachObserved(() => closing, {
            operation: "mcp_pool_abandoned_close",
            workspace: opts.workspace,
            dedupeKey: `mcp_pool_abandoned_close\0${opts.workspace}\0${o.server.name}`,
            logger,
          });
        }
      },
      () => {
        if (slots.get(key) === fresh) slots.delete(key);
      },
    );
    try {
      const opened = await awaitAbortable(fresh.connPromise, o.signal);
      return makeSharedLease(key, fresh, opened);
    } catch (err) {
      releaseAcquireRef(key, fresh);
      throw err;
    }
  }

  async function awaitCloseGrace(workItems: readonly Promise<unknown>[]): Promise<void> {
    if (workItems.length === 0) return;
    const work = Promise.all(
      workItems.map((item) =>
        bestEffort(() => item, {
          operation: "mcp_manager_close",
          workspace: opts.workspace,
          logger,
        }),
      ),
    );
    let timedOut = false;
    let resolveGrace!: () => void;
    const grace = new Promise<void>((resolve) => {
      resolveGrace = resolve;
    });
    const timer = scheduleCloseTimeout(() => {
      timedOut = true;
      resolveGrace();
    }, closeGraceMs);
    await Promise.race([work, grace]);
    timer.cancel();
    if (!timedOut) return;
    detachObserved(() => work, {
      operation: "mcp_manager_close_late",
      workspace: opts.workspace,
      logger,
    });
  }

  async function closeAllInner(): Promise<void> {
    closed = true;
    shutdown.abort(new Error("connection manager closed"));
    physicalConnects.close();
    const closingConnections = new WeakSet<MCPConnection>();
    const closeOnce = (connection: MCPConnection): Promise<void> => {
      if (closingConnections.has(connection)) return Promise.resolve();
      closingConnections.add(connection);
      return Promise.resolve().then(() => connection.close());
    };
    const closing: Promise<unknown>[] = [...live].map(closeOnce);
    const openingHandleCloses = [...openingHandles].map((handle) =>
      Promise.resolve().then(() => handle.close()),
    );
    openingHandles.clear();
    closing.push(...openingHandleCloses);
    const openings = [...pendingOpens];
    pendingOpens.clear();
    const connectAttempts = [...pendingConnectAttempts];
    pendingConnectAttempts.clear();
    const openingAndAdmissionDrain = Promise.allSettled(connectAttempts).then(async (attempts) => {
      await Promise.allSettled(
        attempts.flatMap((result) => (result.status === "fulfilled" ? [result.value.close()] : [])),
      );
      const settled = await Promise.allSettled(openings);
      await Promise.allSettled(
        settled.flatMap((result) =>
          result.status === "fulfilled" ? [closeOnce(result.value.conn)] : [],
        ),
      );
      const admissions = [...pendingAdmissions];
      pendingAdmissions.clear();
      await Promise.allSettled(admissions);
    });
    for (const slot of slots.values()) {
      if (slot.idleTimer) clearTimeout(slot.idleTimer);
      if (slot.opened) closing.push(closeOnce(slot.opened.conn));
    }
    const background = [...backgroundClosures];
    backgroundClosures.clear();
    slots.clear();
    live.clear();
    admittedConnections = 0;
    await awaitCloseGrace([...closing, ...background, openingAndAdmissionDrain]);
  }

  function closeAll(): Promise<void> {
    closeAllPromise ??= closeAllInner();
    return closeAllPromise;
  }

  return { acquire, closeAll };
}
