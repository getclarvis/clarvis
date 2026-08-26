import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import type { Principal } from "../auth/principals.ts";
import { SILENT_SERVER_LOGGERS, type ServerLoggers } from "../logging.ts";
import type { ResolvedHost } from "../host/run-host.ts";
import type { ConcurrencyGate } from "../host/live-runs.ts";
import { buildMcpServer, type McpServerBundle, type McpServerLimits } from "../mcp/server.ts";
import { observeServerTask } from "../tasks.ts";

/** One MCP Streamable HTTP session: a transport, a server and the runs it owns. */
export interface Session {
  readonly id: string;
  readonly owner: string;
  /**
   * The client this session speaks for, absent without authentication.
   *
   * @remarks Recorded from the credential that authenticated the request, not
   * from whatever the kernel resolver echoed back, so a resolver that does not
   * carry the principal cannot silently unbind the session.
   */
  readonly principal: Principal | undefined;
  /**
   * Adopt the principal a later request authenticated as.
   *
   * @param next - the freshly resolved caller.
   * @remarks The enrolment file is re-read on every request, so a role narrowed
   * mid-session must narrow the tools too. The caller's *identity* is checked
   * before this is reached; only its permissions are adopted here.
   */
  refreshPrincipal(next: Principal | undefined): void;
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly bundle: McpServerBundle;
  readonly resolved: ResolvedHost;
  lastSeenAt: number;
  close(reason: "delete" | "idle" | "shutdown", graceMs: number): Promise<void>;
}

/** The sessions one server process is holding. */
export interface SessionStore {
  get(id: string): Session | undefined;
  /** Register a session under the id its transport generated. */
  adopt(session: Session): void;
  remove(id: string): void;
  /** Reserve capacity before constructing an owner kernel and MCP server. */
  reserve(): SessionReservation | null;
  values(): Session[];
  closeAll(reason: "shutdown", graceMs: number): Promise<void>;
  /** Start the idle sweeper; returns its stop function. */
  startSweeper(idleMs: number): () => void;
  /** The admission cap and what is currently against it. */
  capacity(): SessionCapacity;
  readonly size: number;
}

/** How much of the session cap is spent, and on what. */
export interface SessionCapacity {
  /** The configured ceiling. */
  limit: number;
  /** Initialized sessions currently held. */
  live: number;
  /** Slots taken by an `initialize` that has not produced a session id yet. */
  reserved: number;
}

/** One race-safe admission slot for a not-yet-initialized MCP session. */
export interface SessionReservation {
  adopt(session: Session): void;
  release(): void;
}

export class SessionLimitError extends Error {
  readonly code = "resource_exhausted" as const;
  constructor(readonly limit: number) {
    super(`HTTP MCP session limit reached (${String(limit)}).`);
    this.name = "SessionLimitError";
  }
}

/** Resources whose ordering defines one session's close lifecycle. */
export interface SessionCloseTarget {
  /** Wait for the current run handles, bounded by the supplied milliseconds. */
  drain(graceMs: number): Promise<boolean>;
  /** Cancel every run still in flight; returns how many there were. */
  cancelAll(reason: "session_close" | "shutdown"): number;
  remove(): void;
  /** Release the owner kernel lease after cancelled runs got their settle window. */
  releaseOwner(): void;
  /** Close transport-facing server state; owner resources are no longer needed here. */
  closeServer(): Promise<void>;
  settleGraceMs: number;
  /** The session-bound diagnostic channel; already carries `session_id`. */
  logger?: Logger;
}

/**
 * Close one session without retiring its owner while cancelled runs still use it.
 *
 * @remarks A shutdown first offers its caller-supplied graceful drain window.
 * Every path that has to cancel then offers the fixed, explicitly bounded
 * `settleGraceMs` window before releasing the owner lease. A timeout is a valid
 * terminal outcome: shutdown must progress even if a provider never settles.
 * Lifecycle errors are rethrown only after removal and lease release, so a bad
 * run cannot turn the ordering fix into an owner-cache leak.
 */
export async function closeSessionLifecycle(
  target: SessionCloseTarget,
  reason: "delete" | "idle" | "shutdown",
  shutdownGraceMs: number,
): Promise<void> {
  const startedAt = Date.now();
  let failed = false;
  let firstFailure: unknown;
  let runsCancelled = 0;
  let drained = false;
  const remember = (error: unknown): void => {
    if (failed) return;
    failed = true;
    firstFailure = error;
  };

  let cancel = reason !== "shutdown" || shutdownGraceMs <= 0;
  if (!cancel) {
    try {
      drained = await target.drain(shutdownGraceMs);
      cancel = !drained;
    } catch (error) {
      remember(error);
      cancel = true;
    }
  }

  if (cancel) {
    try {
      runsCancelled = target.cancelAll(reason === "shutdown" ? "shutdown" : "session_close");
    } catch (error) {
      remember(error);
    }
    try {
      await target.drain(target.settleGraceMs);
    } catch (error) {
      remember(error);
    }
  }

  try {
    target.remove();
  } catch (error) {
    remember(error);
  }
  try {
    target.releaseOwner();
  } catch (error) {
    remember(error);
  }
  await target.closeServer().catch(() => undefined);

  reportClosed(
    target.logger ?? NOOP_LOGGER,
    reason,
    runsCancelled,
    drained,
    Date.now() - startedAt,
  );

  if (failed) throw firstFailure;
}

/**
 * Record one session's teardown.
 *
 * @param logger - the session-bound diagnostic channel.
 * @param reason - what closed it.
 * @param runsCancelled - runs the close had to cancel rather than let finish.
 * @param drained - whether the graceful drain window was enough.
 * @param durMs - how long the whole ordered teardown took.
 * @remarks Written after the ordering completes and before a remembered failure
 * is rethrown, so a session that closed badly is still recorded as having
 * closed.
 */
function reportClosed(
  logger: Logger,
  reason: "delete" | "idle" | "shutdown",
  runsCancelled: number,
  drained: boolean,
  durMs: number,
): void {
  logger.info(
    {
      event: "session.closed",
      reason,
      runs_cancelled: runsCancelled,
      drained,
      dur_ms: durMs,
    },
    "an MCP session closed; every run it held is gone, since a run exists only while its connection is open",
  );
}

/**
 * Record an admission the session cap refused.
 *
 * @param logger - the server's diagnostic channel.
 * @param capacity - the ceiling and what is against it.
 * @remarks Without this a `503` is the *only* trace of the refusal, and it is
 * held by the caller rather than by the operator whose cap produced it.
 */
export function reportCapacityExhausted(logger: Logger, capacity: SessionCapacity): void {
  logger.warn(
    {
      event: "session.capacity_exhausted",
      limit: capacity.limit,
      live: capacity.live,
      reserved: capacity.reserved,
    },
    "an MCP session was refused at the session cap; the caller received a 503 and may retry once one closes",
  );
}

/** Options for {@link createSessionStore}. */
export interface CreateSessionStoreOptions {
  maxSessions?: number;
  /** Where a refused admission is recorded. */
  logger?: Logger;
}

/** Build an empty {@link SessionStore}. */
export function createSessionStore(options: CreateSessionStoreOptions = {}): SessionStore {
  const maxSessions = Math.max(1, Math.floor(options.maxSessions ?? 128));
  const logger = options.logger ?? NOOP_LOGGER;
  const sessions = new Map<string, Session>();
  let reserved = 0;
  const capacity = (): SessionCapacity => ({
    limit: maxSessions,
    live: sessions.size,
    reserved,
  });
  const adopt = (session: Session): void => {
    if (!sessions.has(session.id) && sessions.size + reserved >= maxSessions) {
      reportCapacityExhausted(logger, capacity());
      throw new SessionLimitError(maxSessions);
    }
    sessions.set(session.id, session);
  };
  return {
    capacity,
    get: (id) => sessions.get(id),
    adopt,
    remove(id): void {
      sessions.delete(id);
    },
    reserve(): SessionReservation | null {
      if (sessions.size + reserved >= maxSessions) return null;
      reserved += 1;
      let settled = false;
      return {
        adopt(session): void {
          if (settled) throw new Error("session reservation already settled");
          settled = true;
          reserved -= 1;
          adopt(session);
        },
        release(): void {
          if (settled) return;
          settled = true;
          reserved -= 1;
        },
      };
    },
    values: () => [...sessions.values()],
    async closeAll(reason, graceMs): Promise<void> {
      await Promise.allSettled([...sessions.values()].map((s) => s.close(reason, graceMs)));
      sessions.clear();
    },
    startSweeper(idleMs): () => void {
      const timer = setInterval(
        () => {
          const cutoff = Date.now() - idleMs;
          for (const session of sessions.values()) {
            if (session.bundle.runs.size > 0) continue;
            if (session.lastSeenAt > cutoff) continue;
            observeServerTask("server_idle_session_close", () => session.close("idle", 0));
          }
        },
        Math.max(1_000, Math.floor(idleMs / 4)),
      );
      timer.unref?.();
      return () => clearInterval(timer);
    },
    get size(): number {
      return sessions.size;
    },
  };
}

/** Inputs for {@link createSession}. */
export interface CreateSessionOptions {
  resolved: ResolvedHost;
  limits: McpServerLimits;
  gate: ConcurrencyGate;
  store: SessionStore;
  reservation?: SessionReservation;
  version?: string;
  /** The caller that authenticated `initialize`; the session is bound to it. */
  principal?: Principal | undefined;
  /**
   * Whether the owner id was derived from an authenticated enrolment record.
   *
   * @remarks Bound onto every record this session writes. Only `token` owner
   * mode authenticates the owner; under the other three it is caller-supplied,
   * and a line naming an owner without saying so asserts a boundary that does
   * not exist.
   */
  ownerAuthenticated?: boolean;
  /** The channels every record from this session and its runs is written on. */
  logger?: ServerLoggers;
}

/**
 * Record one session reaching `initialize`.
 *
 * @param logger - the session-bound diagnostic channel.
 * @param sessionsLive - how many sessions the store now holds, this one included.
 */
function reportOpened(logger: Logger, sessionsLive: number): void {
  logger.info(
    { event: "session.opened", sessions_live: sessionsLive },
    "an MCP session was initialized; the runs it starts live only as long as it does",
  );
}

/**
 * Record a role narrowed under a live session.
 *
 * @param audit - the session-bound audit channel.
 * @param from - the role the session was opened with.
 * @param to - the role the enrolment table now gives the same client.
 * @remarks Only on a change. `auth.json` is re-read on every request, so a
 * session that keeps its role would emit this on every call otherwise.
 */
function reportNarrowed(audit: Logger, from: string | undefined, to: string | undefined): void {
  audit.info(
    {
      event: "auth.principal.narrowed",
      ...(from !== undefined ? { from_role: from } : {}),
      ...(to !== undefined ? { to_role: to } : {}),
    },
    "a live session adopted a changed role; the new permissions apply to its next tool call, not at reconnect",
  );
}

/**
 * Create a session: an MCP server bound to one owner, over its own transport.
 *
 * @param opts - the resolved host, limits and the store to register into.
 * @returns the transport, plus a handle the store adopts once the transport has
 *   generated a session id.
 * @remarks Stateful mode is required, not a preference: without a session id
 *   every POST would land on a fresh transport and `clarvis_steer` could never
 *   reach the run a still-pending `clarvis_run` started.
 *
 *   Closing a session cancels every run it holds — a run exists only while its
 *   connection is open — and the drain happens *before* the close, since closing
 *   tears down the very streams the runs are writing to.
 */
export function createSession(opts: CreateSessionOptions): {
  transport: WebStandardStreamableHTTPServerTransport;
  connect: () => Promise<void>;
  /** Release a resolved host when initialize never produced a session id. */
  disposeIfUninitialized: () => Promise<void>;
  /** Close an initialized session, or release all provisional resources. */
  dispose: () => Promise<void>;
} {
  let principal = opts.principal;
  const sessionId = crypto.randomUUID();
  const loggers = (opts.logger ?? SILENT_SERVER_LOGGERS).child({
    session_id: sessionId,
    owner: opts.resolved.owner,
    owner_authenticated: opts.ownerAuthenticated === true,
    ...(principal !== undefined ? { client_id: principal.clientId } : {}),
  });
  const bundle = buildMcpServer({
    resolved: opts.resolved,
    limits: opts.limits,
    gate: opts.gate,
    getPrincipal: () => principal,
    logger: loggers,
    ...(opts.version !== undefined ? { version: opts.version } : {}),
  });

  let session: Session | undefined;
  let closing: Promise<void> | undefined;
  let resolvedReleased = false;
  const releaseResolved = (): void => {
    if (resolvedReleased) return;
    resolvedReleased = true;
    opts.resolved.release?.();
  };
  let provisionalDisposal: Promise<void> | undefined;
  const disposeIfUninitialized = (): Promise<void> => {
    if (session !== undefined) return Promise.resolve();
    opts.reservation?.release();
    releaseResolved();
    provisionalDisposal ??= bundle.server.close().catch(() => undefined);
    return provisionalDisposal;
  };

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId,
    onsessioninitialized: (id: string) => {
      const initialized: Session = {
        id,
        owner: opts.resolved.owner,
        get principal(): Principal | undefined {
          return principal;
        },
        refreshPrincipal(next): void {
          const previous = principal;
          principal = next;
          if (previous?.role !== next?.role)
            reportNarrowed(loggers.audit, previous?.role, next?.role);
        },
        transport,
        bundle,
        resolved: opts.resolved,
        lastSeenAt: Date.now(),
        close(reason, graceMs): Promise<void> {
          closing ??= closeSessionLifecycle(
            {
              drain: (waitMs) => bundle.drain(waitMs),
              cancelAll: (cancelReason) => bundle.cancelAll(cancelReason),
              remove: () => opts.store.remove(id),
              releaseOwner: releaseResolved,
              closeServer: () => bundle.server.close(),
              settleGraceMs: opts.limits.settleGraceMs,
              logger: loggers.log,
            },
            reason,
            graceMs,
          );
          return closing;
        },
      };
      if (opts.reservation !== undefined) opts.reservation.adopt(initialized);
      else opts.store.adopt(initialized);
      session = initialized;
      reportOpened(loggers.log, opts.store.size);
    },
    onsessionclosed: (id: string) => {
      observeServerTask("server_deleted_session_close", () =>
        opts.store.get(id)?.close("delete", 0),
      );
    },
  });

  return {
    transport,
    connect: () => bundle.server.connect(transport),
    disposeIfUninitialized,
    dispose(): Promise<void> {
      if (session !== undefined) return session.close("delete", 0);
      return disposeIfUninitialized();
    },
  };
}
