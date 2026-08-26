import type { Logger } from "@clarvis/capability";
import type { AuthLayer } from "../auth/bootstrap.ts";
import { AuthFailure } from "../auth/failure.ts";
import type { Principal } from "../auth/principals.ts";
import type { ServerEnv } from "../config/env.ts";
import { resolveOwnerId } from "../config/owner.ts";
import { createConcurrencyGate } from "../host/live-runs.ts";
import type { KernelResolver } from "../host/run-host.ts";
import {
  logHttpRequest,
  newRequestId,
  ownerFields,
  REQUEST_ID_HEADER,
  type RequestLogFields,
  type ServerLoggers,
} from "../logging.ts";
import { mapError } from "../mcp/errors.ts";
import type { McpServerLimits } from "../mcp/server.ts";
import { observeServerTask } from "../tasks.ts";
import type { ScheduleTimeout } from "../timing.ts";
import {
  bearerChallenge,
  handleAuthRoute,
  protectedResourceMetadataUrl,
  type AuthRouteDeps,
} from "./auth-routes.ts";
import { checkOriginAndHost, isInitializeBody, readJsonBody, rpcMethodOf } from "./guards.ts";
import { handleHealthz, handleReadyz, type ReadinessChecks } from "./health-routes.ts";
import { createRequestBudget } from "./request-budget.ts";
import { createSession, createSessionStore, reportCapacityExhausted } from "./sessions.ts";

/** Options for {@link serveClarvisMcpOverHttp}. */
export interface ServeHttpOptions {
  env: ServerEnv;
  resolveKernel: KernelResolver;
  /** Readiness inputs; when omitted `/readyz` reports ready as soon as it binds. */
  readiness?: Partial<ReadinessChecks>;
  version?: string;
  /**
   * The authentication layer.
   *
   * @remarks Required when `env.CLARVIS_SERVER_AUTH` is `required`; the server
   *   refuses to start without it rather than serving an endpoint the operator
   *   believes is protected.
   */
  auth?: AuthLayer;
  /** Internal deterministic-test seam for the initialization deadline. */
  scheduleTimeout?: ScheduleTimeout;
  /**
   * The channels this endpoint and everything under it writes through.
   *
   * @remarks Required, and deliberately not defaulted. A facade run as
   *   infrastructure for another application is the one host whose only account
   *   of what it did is its log; "no destination" is not a posture worth
   *   supporting, so it is not expressible. A silent server is asked for with
   *   `CLARVIS_LOG_LEVEL=silent`, which is a decision the operator makes rather
   *   than one a caller can omit into.
   */
  logger: ServerLoggers;
}

/** What one in-flight request has learned about itself, for its own log line. */
interface RequestScope {
  readonly reqId: string;
  readonly loggers: ServerLoggers;
  readonly fields: {
    req_bytes: number;
    session_id?: string;
    owner?: string;
    owner_authenticated?: boolean;
    client_id?: string;
    rpc_method?: string;
  };
}

/** Record a caller refused the owner it asked to act for. */
function reportImpersonationDenied(
  audit: Logger,
  principal: Principal,
  claimedOwner: string,
): void {
  audit.warn(
    {
      event: "authz.owner.impersonation_denied",
      client_id: principal.clientId,
      role: principal.role,
      claimed_owner: claimedOwner,
    },
    "a caller was refused an owner its role may not act for; no directory was created for that owner",
  );
}

/** Record a caller acting for an owner other than its own. */
function reportImpersonated(audit: Logger, principal: Principal, actingFor: string): void {
  audit.info(
    {
      event: "authz.owner.impersonated",
      client_id: principal.clientId,
      role: principal.role,
      owner: principal.owner,
      owner_authenticated: true,
      acting_for: actingFor,
    },
    "a caller opened a session for another owner; everything that session does is filed under the owner it claimed",
  );
}

/** Record a session whose initialization ran out of its deadline. */
function reportInitTimeout(
  logger: Logger,
  reqId: string,
  phase: "kernel_resolve" | "initialize",
  timeoutMs: number,
): void {
  logger.info(
    { event: "session.init.timeout", req_id: reqId, phase, timeout_ms: timeoutMs },
    "a session initialization exceeded its deadline; its reservation and any late resolution are released",
  );
}

/** A running HTTP endpoint. */
export interface ServeHandle {
  /** The port actually bound (useful when the caller asked for `0`). */
  readonly port: number;
  /**
   * Stop accepting, drain in-flight runs, then close every session.
   *
   * @remarks The drain is not a barrier against a concurrent `initialize`, and
   * the window is nameable: `accepting` is checked before the owner is resolved
   * and the session slot reserved, and `closeAll` drains a snapshot of the
   * sessions map, which a reservation adopting itself after that snapshot is not
   * in. Such a session survives the graceful drain and is torn down by the
   * forced `server.stop(true)` that follows — so its in-flight runs are
   * cancelled rather than given `graceMs` to finish. Re-checking `accepting`
   * after resolution would narrow the window, not close it; closing it means
   * making the drain wait on outstanding reservations, which nothing does today.
   * Prefer {@link ServeHandle.stopAccepting} ahead of `close` for a real drain:
   * it flips the flag while the server keeps serving, so the window empties on
   * its own before anything is torn down.
   */
  close(graceMs?: number): Promise<void>;
  /** Flip readiness off without closing, so a load balancer drains first. */
  stopAccepting(): void;
}

/**
 * Serve the MCP facade over Streamable HTTP.
 *
 * @param opts - environment, kernel resolver and readiness inputs.
 * @returns the handle; see {@link ServeHandle}.
 * @remarks Binds immediately so `/healthz` answers while the kernel is still
 *   constructing — which matters because the first trace-retention sweep runs
 *   synchronously inside kernel construction and can take a while on a large
 *   mounted volume.
 *
 *   **What bounds a caller here is capacity, not rate.** The limits assembled
 *   below cap concurrent sessions, concurrent runs globally and per owner,
 *   stream buffers, body size and per-run wall clock; there is no request-rate
 *   limiter on this endpoint at all. The one that exists —
 *   {@link import("../auth/issuer.ts").createTokenIssuer | the token issuer}'s
 *   per-client and per-peer attempt limiters — guards credential *guessing* on
 *   `/token`, and that is a different question from request volume.
 *
 *   So an authenticated client can issue MCP requests as fast as it likes, and
 *   `initialize` attempts are bounded only by
 *   `CLARVIS_SERVER_MAX_SESSIONS`. That is a posture rather than an oversight,
 *   and it rests on a deployment shape stated elsewhere in this package: one
 *   container per config directory, with enrolled clients, behind whatever
 *   ingress the operator already runs. It stops holding the moment this is
 *   exposed to callers the operator has not enrolled — and under `--auth off`
 *   the bind address is the only boundary there is.
 */
export function serveClarvisMcpOverHttp(opts: ServeHttpOptions): ServeHandle {
  const { env, auth } = opts;
  if (env.CLARVIS_SERVER_AUTH === "required" && auth === undefined) {
    throw new Error(
      "CLARVIS_SERVER_AUTH=required but no authentication layer was supplied; refusing to serve " +
        "an endpoint the operator believes is protected",
    );
  }
  if (env.CLARVIS_SERVER_AUTH !== "required" && auth !== undefined) {
    throw new Error(
      "an authentication layer was supplied while CLARVIS_SERVER_AUTH is off; one switch decides " +
        "whether this endpoint is protected, and a disagreement between the two is a mistake in " +
        "whichever direction it is resolved",
    );
  }
  const startedAt = Date.now();
  const { logger } = opts;
  const requestLogMode = env.CLARVIS_SERVER_LOG_REQUESTS;
  const ownerAuthenticated = env.CLARVIS_SERVER_OWNER_MODE === "token";
  const store = createSessionStore({
    maxSessions: env.CLARVIS_SERVER_MAX_SESSIONS,
    logger: logger.log,
  });
  const gate = createConcurrencyGate({
    perOwner: env.CLARVIS_SERVER_MAX_RUNS_PER_OWNER,
    global: env.CLARVIS_SERVER_MAX_RUNS,
    logger: logger.log,
  });
  const limits: McpServerLimits = {
    maxRuns: env.CLARVIS_SERVER_MAX_RUNS,
    maxRunsPerOwner: env.CLARVIS_SERVER_MAX_RUNS_PER_OWNER,
    bufferMax: env.CLARVIS_SERVER_STREAM_BUFFER_MAX,
    bufferMaxBytes: env.CLARVIS_SERVER_STREAM_BUFFER_BYTES,
    sendTimeoutMs: env.CLARVIS_SERVER_STREAM_SEND_TIMEOUT_MS,
    heartbeatMs: env.CLARVIS_SERVER_HEARTBEAT_MS,
    runMaxMs: env.CLARVIS_SERVER_RUN_MAX_MS,
    settleGraceMs: env.CLARVIS_SERVER_RUN_SETTLE_GRACE_MS,
    elicitToolWaitMs: env.CLARVIS_SERVER_ELICIT_TOOL_WAIT_MS,
    elicitRelayMs: env.CLARVIS_SERVER_ELICIT_RELAY_MS,
    allowRemoteGuardApproval: env.CLARVIS_SERVER_ALLOW_REMOTE_GUARD_APPROVAL,
  };
  const guards = {
    allowedOrigins: env.CLARVIS_SERVER_ALLOWED_ORIGINS,
    allowedHosts: env.CLARVIS_SERVER_ALLOWED_HOSTS,
    maxBodyBytes: env.CLARVIS_SERVER_MAX_BODY_BYTES,
  };
  const ownerAllowlist = new Set(env.CLARVIS_SERVER_OWNER_ALLOWLIST);

  let accepting = true;
  const stopSweeper = store.startSweeper(env.CLARVIS_SERVER_SESSION_IDLE_MS);

  const readiness: ReadinessChecks = {
    kernel: opts.readiness?.kernel ?? (() => true),
    config: opts.readiness?.config ?? (() => Promise.resolve(true)),
    model: opts.readiness?.model ?? (() => Promise.resolve(true)),
    mcp: opts.readiness?.mcp ?? (() => true),
    accepting: () => accepting,
  };

  const rpcError = (err: unknown, reqId: string, explicitStatus?: number): Response => {
    const mapped = mapError(err);
    const status =
      explicitStatus ??
      (mapped.code === "invalid_request"
        ? 400
        : mapped.code === "unauthorized"
          ? 401
          : mapped.code === "forbidden"
            ? 403
            : mapped.code === "not_found"
              ? 404
              : mapped.code === "conflict"
                ? 409
                : mapped.code === "cancelled"
                  ? 408
                  : mapped.code === "resource_exhausted" || mapped.code === "unavailable"
                    ? 503
                    : 500);
    return Response.json(
      {
        jsonrpc: "2.0",
        error: { code: -32600, message: mapped.message, data: { ...mapped, req_id: reqId } },
      },
      { status },
    );
  };

  const authFailure = (err: AuthFailure, reqId: string): Response =>
    Response.json(
      { error: err.code, error_description: err.message, req_id: reqId },
      {
        status: err.status,
        headers:
          err.status === 401 && auth !== undefined
            ? {
                "www-authenticate": bearerChallenge(
                  protectedResourceMetadataUrl(auth.config),
                  err.code,
                ),
              }
            : {},
      },
    );

  const handle = async (
    request: Request,
    bound: { requestIP(request: Request): { address: string } | null },
    url: URL,
    scope: RequestScope,
  ): Promise<Response> => {
    const { reqId } = scope;
    const log = scope.loggers.log;
    const audit = scope.loggers.audit;

    if (auth !== undefined) {
      const deps: AuthRouteDeps = {
        config: auth.config,
        key: auth.key,
        issuer: auth.issuer,
        peer: bound.requestIP(request)?.address,
        audit,
      };
      const answered = handleAuthRoute(url.pathname, request, deps);
      if (answered !== undefined) return answered;
    }

    if (url.pathname !== env.CLARVIS_SERVER_PATH) {
      return new Response("not found", { status: 404 });
    }

    const blocked = checkOriginAndHost(request, guards, log);
    if (blocked !== undefined) return blocked;

    let principal: Principal | undefined;
    if (auth !== undefined) {
      try {
        principal = await auth.authenticator.authenticate(request);
      } catch (err) {
        if (err instanceof AuthFailure) return authFailure(err, reqId);
        return rpcError(err, reqId, 500);
      }
      scope.fields.client_id = principal.clientId;
    }

    let body: unknown;
    try {
      const read = await readJsonBody(request, guards.maxBodyBytes, log);
      body = read.body;
      scope.fields.req_bytes = read.bytes;
      scope.fields.rpc_method = rpcMethodOf(read.body);
    } catch (err) {
      return rpcError(err, reqId, 400);
    }

    const sessionId = request.headers.get("mcp-session-id");
    const existing = sessionId !== null ? store.get(sessionId) : undefined;
    if (existing !== undefined) {
      scope.fields.session_id = existing.id;
      Object.assign(scope.fields, ownerFields(existing.owner, env.CLARVIS_SERVER_OWNER_MODE));
      if (existing.principal?.clientId !== principal?.clientId) {
        audit.warn(
          {
            event: "auth.session.mismatch",
            session_id: existing.id,
            ...(existing.principal !== undefined
              ? { expected_client: existing.principal.clientId }
              : {}),
            ...(principal !== undefined ? { presented_client: principal.clientId } : {}),
          },
          "a session was driven by a credential other than the one that opened it; the mcp-session-id is not a bearer credential of its own",
        );
        return authFailure(
          new AuthFailure(403, "session_mismatch", "this session belongs to another client"),
          reqId,
        );
      }
      if (
        env.CLARVIS_SERVER_OWNER_MODE === "token" &&
        existing.principal !== undefined &&
        principal !== undefined &&
        existing.principal.owner !== principal.owner
      ) {
        audit.warn(
          {
            event: "auth.session.stale",
            session_id: existing.id,
            client_id: principal.clientId,
            from_owner: existing.principal.owner,
            to_owner: principal.owner,
            owner_authenticated: true,
          },
          "a live session cannot adopt a change of owner; the client must open a new one",
        );
        return authFailure(
          new AuthFailure(
            403,
            "session_stale",
            "this client's owner changed; open a new session to reach the new one",
          ),
          reqId,
        );
      }
      existing.refreshPrincipal(principal);
      existing.lastSeenAt = Date.now();
      return existing.transport.handleRequest(
        request,
        body !== undefined ? { parsedBody: body } : undefined,
      );
    }

    if (!isInitializeBody(body)) {
      return rpcError(
        { code: "invalid_request", message: "missing or unknown mcp-session-id" },
        reqId,
        400,
      );
    }
    if (!accepting) {
      return rpcError({ code: "unavailable", message: "server is shutting down" }, reqId, 503);
    }

    const claimedOwner = request.headers.get(env.CLARVIS_SERVER_OWNER_HEADER);
    let owner: string;
    try {
      owner = resolveOwnerId({
        headers: request.headers,
        mode: env.CLARVIS_SERVER_OWNER_MODE,
        header: env.CLARVIS_SERVER_OWNER_HEADER,
        fixed: env.CLARVIS_SERVER_OWNER,
        allowlist: ownerAllowlist,
        principal,
      });
    } catch (err) {
      if (err instanceof AuthFailure) {
        if (err.code === "owner_not_permitted" && principal !== undefined) {
          reportImpersonationDenied(audit, principal, claimedOwner ?? "");
        }
        return authFailure(err, reqId);
      }
      return rpcError(err, reqId, 400);
    }
    Object.assign(scope.fields, ownerFields(owner, env.CLARVIS_SERVER_OWNER_MODE));
    if (principal !== undefined && ownerAuthenticated && owner !== principal.owner) {
      reportImpersonated(audit, principal, owner);
    }

    let resolved;
    const reservation = store.reserve();
    if (reservation === null) {
      reportCapacityExhausted(log, store.capacity());
      return rpcError(
        { code: "resource_exhausted", message: "HTTP MCP session capacity is full" },
        reqId,
        503,
      );
    }
    const budget = createRequestBudget({
      signal: request.signal,
      timeoutMs: env.CLARVIS_SERVER_SESSION_INIT_TIMEOUT_MS,
      ...(opts.scheduleTimeout === undefined ? {} : { scheduleTimeout: opts.scheduleTimeout }),
    });
    try {
      if (budget.interruption !== undefined) {
        reservation.release();
        return rpcError(budget.interruption, reqId, budget.interruption.status);
      }
      const resolving = Promise.resolve().then(() =>
        opts.resolveKernel({
          sessionId: undefined,
          owner,
          headers: request.headers,
          principal,
        }),
      );
      const resolution = await budget.race(resolving);
      if (resolution.state === "interrupted") {
        reservation.release();
        reportInitTimeout(log, reqId, "kernel_resolve", env.CLARVIS_SERVER_SESSION_INIT_TIMEOUT_MS);
        observeServerTask("server_late_kernel_resolution_release", async () => {
          const late = await resolving.catch(() => undefined);
          late?.release?.();
        });
        return rpcError(resolution.interruption, reqId, resolution.interruption.status);
      }
      if (resolution.state === "rejected") {
        reservation.release();
        return rpcError(resolution.reason, reqId);
      }
      resolved = resolution.value;

      let session: ReturnType<typeof createSession>;
      try {
        session = createSession({
          resolved,
          limits,
          gate,
          store,
          reservation,
          principal,
          ownerAuthenticated,
          logger,
          ...(opts.version !== undefined ? { version: opts.version } : {}),
        });
      } catch (err) {
        reservation.release();
        resolved.release?.();
        return rpcError(err, reqId);
      }

      const initializing = async (): Promise<Response> => {
        await session.connect();
        const response = await session.transport.handleRequest(
          request,
          body !== undefined ? { parsedBody: body } : undefined,
        );
        await session.disposeIfUninitialized();
        return response;
      };
      const initialization = initializing();
      const initialized = await budget.race(initialization);
      if (initialized.state === "interrupted") {
        reportInitTimeout(log, reqId, "initialize", env.CLARVIS_SERVER_SESSION_INIT_TIMEOUT_MS);
        const disposal = session.dispose();
        observeServerTask("server_interrupted_session_dispose", () => disposal);
        return rpcError(initialized.interruption, reqId, initialized.interruption.status);
      }
      if (initialized.state === "rejected") {
        await session.dispose();
        return rpcError(initialized.reason, reqId);
      }
      return initialized.value;
    } finally {
      budget.dispose();
    }
  };

  const server = Bun.serve({
    hostname: env.CLARVIS_SERVER_HOST,
    port: env.CLARVIS_SERVER_PORT,
    idleTimeout: 0,
    fetch: async (request, bound): Promise<Response> => {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") return handleHealthz(startedAt);
      if (url.pathname === "/readyz") return handleReadyz(readiness);

      const reqId = newRequestId();
      const scope: RequestScope = {
        reqId,
        loggers: logger.child({ req_id: reqId }),
        fields: { req_bytes: 0 },
      };
      const began = Date.now();
      const response = await handle(request, bound, url, scope);
      response.headers.set(REQUEST_ID_HEADER, reqId);
      logHttpRequest(scope.loggers.log, requestLogMode, {
        method: request.method,
        path: url.pathname,
        status: response.status,
        dur_ms: Date.now() - began,
        ...scope.fields,
      } satisfies RequestLogFields);
      return response;
    },
  });

  return {
    get port(): number {
      return server.port ?? env.CLARVIS_SERVER_PORT;
    },
    stopAccepting(): void {
      accepting = false;
    },
    async close(graceMs = 0): Promise<void> {
      accepting = false;
      stopSweeper();
      await store.closeAll("shutdown", graceMs);
      await server.stop(true);
    },
  };
}
