import { randomUUID } from "node:crypto";
import type { Logger, MCPStatus, ToolResult } from "@clarvis/capability";
import {
  NOOP_LOGGER,
  bestEffort,
  bind,
  createSampler,
  detachObserved,
  levelEnabled,
  sanitizeErrorMessage,
  unref,
} from "@clarvis/capability";
import { runMCPRequest } from "./client.ts";
import type { MCPClientHandle } from "./client.ts";
import { isMcpProtocolError, isMcpRequestTimeout } from "./errors.ts";
import { MCPAuthorizationPendingError } from "./oauth.ts";
import {
  abortedResult,
  authorizationPendingResult,
  becameUnavailableResult,
  interruptedResult,
  runtimeErrorResult,
  timeoutResult,
  unavailableResult,
} from "./tool-results.ts";
import type { ConnectionEvent } from "./connection.ts";

export interface ResilientSessionOptions {
  initialHandle: MCPClientHandle;
  reconnect: () => Promise<MCPClientHandle>;
  mcpName: string;
  callTimeoutMs: number;
  connectTimeoutMs: number;
  reprobeCooldownMs: number;
  timeoutStreakThreshold: number;
  healthPingIntervalMs: number;
  /** Grace for reconnect/handle shutdown before late completion is detached. */
  closeGraceMs?: number;
  signal?: AbortSignal;
  eventBase: Omit<ConnectionEvent, "connection_id" | "state" | "cause">;
  onEvent?: (event: ConnectionEvent) => void;
  logger?: Logger;
  runtime?: ResilientSessionRuntime;
}

export interface ResilientSessionTimer {
  cancel(): void;
}

/**
 * Why a reconnect was attempted.
 *
 * @remarks Carried as `trigger` on the three `mcp.reconnect.*` records, which
 *   keeps `reason` free to mean what it means everywhere else in this package:
 *   the sanitized text of the failure being reported.
 */
export type ReconnectTrigger = "transport_error" | "reprobe" | "health_ping_failed";

/** How one `mcp.call.done` record classifies the call it closes. */
export type McpCallOutcome =
  "ok" | "timeout" | "protocol" | "transport" | "aborted" | "unavailable";

function errorText(error: unknown): string {
  return sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
}

export interface ResilientSessionRuntime {
  now(): number;
  schedule(callback: () => void | Promise<void>, delayMs: number): ResilientSessionTimer;
}

const SYSTEM_RUNTIME: ResilientSessionRuntime = {
  now: Date.now,
  schedule(callback, delayMs) {
    // The system timer intentionally detaches the promise; the scheduled body observes its work.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    const timer = setTimeout(callback, delayMs);
    unref(timer);
    return { cancel: () => clearTimeout(timer) };
  },
};

/** Default grace for MCP lifecycle work during shutdown. */
export const DEFAULT_MCP_CLOSE_GRACE_MS = 2_000;
/** A programmatic caller cannot turn a shutdown grace into an unbounded wait. */
export const MAX_MCP_CLOSE_GRACE_MS = 30_000;

/** Normalize an optional programmatic shutdown grace to a finite hard bound. */
export function normalizeMcpCloseGraceMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MCP_CLOSE_GRACE_MS;
  return Math.min(MAX_MCP_CLOSE_GRACE_MS, Math.max(0, Math.floor(value)));
}

export interface ResilientSession {
  readonly status: MCPStatus;
  invoke(
    label: string,
    run: (
      handle: MCPClientHandle,
      opts: { signal?: AbortSignal; timeout: number },
    ) => Promise<unknown>,
    onResult: (raw: unknown) => ToolResult,
    signal?: AbortSignal,
  ): Promise<ToolResult>;
  close(): Promise<void>;
}

export function createResilientSession(options: ResilientSessionOptions): ResilientSession {
  const runtime = options.runtime ?? SYSTEM_RUNTIME;
  const closeGraceMs = normalizeMcpCloseGraceMs(options.closeGraceMs);
  let handle = options.initialHandle;
  let status: MCPStatus = "connected";
  let reconnecting: Promise<boolean> | null = null;
  let unavailableUntil = 0;
  let generation = 0;
  let transportFailStreak = 0;
  let timeoutStreak = 0;
  let lastFailedGeneration = -1;
  let closed = false;
  let inFlight = 0;
  let lastActivityAt = runtime.now();
  let healthTimer: ResilientSessionTimer | undefined;
  let pinging = false;
  let unavailableEmitted = false;
  let closePromise: Promise<void> | undefined;
  const connectionId = randomUUID();
  const logger = bind(options.logger ?? NOOP_LOGGER, { connection_id: connectionId });
  const callDoneEnabled = levelEnabled(logger, "debug");
  const sampleCall = createSampler();

  const awaitLifecycle = async (run: () => unknown, operation: string): Promise<void> => {
    const work = bestEffort(run, {
      operation,
      workspace: options.eventBase.scope.workspace,
      dedupeKey: `${operation}\0${options.eventBase.scope.workspace}\0${options.mcpName}`,
      logger,
    });
    let timedOut = false;
    let resolveGrace!: () => void;
    const grace = new Promise<void>((resolve) => {
      resolveGrace = resolve;
    });
    const timer = runtime.schedule(() => {
      timedOut = true;
      resolveGrace();
    }, closeGraceMs);
    await Promise.race([work, grace]);
    timer.cancel();
    if (!timedOut) return;
    detachObserved(() => work, {
      operation: `${operation}_late`,
      workspace: options.eventBase.scope.workspace,
      dedupeKey: `${operation}_late\0${options.eventBase.scope.workspace}\0${options.mcpName}`,
      logger,
    });
  };

  const emit = (state: ConnectionEvent["state"], cause?: ConnectionEvent["cause"]): void => {
    if (!options.onEvent || (closed && state !== "closed")) return;
    try {
      options.onEvent({
        connection_id: connectionId,
        ...options.eventBase,
        state,
        ...(cause ? { cause } : {}),
      });
    } catch {}
  };

  const markUnavailable = (cause?: ConnectionEvent["cause"]): void => {
    const wasUnavailable = status === "unavailable";
    status = "unavailable";
    unavailableUntil = runtime.now() + options.reprobeCooldownMs;
    if (!wasUnavailable && !unavailableEmitted) {
      unavailableEmitted = true;
      logger.warn(
        {
          event: "mcp.unavailable",
          ...(cause ? { cause } : {}),
          cooldown_ms: options.reprobeCooldownMs,
        },
        "mcp server went unavailable; its tools answer as unavailable until the cooldown expires",
      );
      emit("unavailable", cause);
    }
  };

  const reconnectOnce = async (trigger: ReconnectTrigger): Promise<boolean> => {
    status = "lost";
    const stale = handle;
    const startedAt = runtime.now();
    logger.debug(
      { event: "mcp.reconnect.begin", generation, trigger },
      "mcp connection was lost; reopening it before the next call",
    );
    try {
      await awaitLifecycle(() => stale.close(), "mcp_stale_handle_close");
      const fresh = await options.reconnect();
      if (closed) {
        await awaitLifecycle(() => fresh.close(), "mcp_closed_reconnect_handle_close");
        return false;
      }
      handle = fresh;
      generation += 1;
      status = "connected";
      unavailableUntil = 0;
      timeoutStreak = 0;
      logger.info(
        { event: "mcp.reconnect.ok", generation, duration_ms: runtime.now() - startedAt, trigger },
        "mcp connection reopened; calls resume on the new transport",
      );
      if (unavailableEmitted) {
        unavailableEmitted = false;
        logger.info(
          { event: "mcp.recovered" },
          "mcp server answered again; its tools are callable",
        );
        emit("recovered");
      }
      return true;
    } catch (error) {
      logger.warn(
        {
          event: "mcp.reconnect.failed",
          generation,
          duration_ms: runtime.now() - startedAt,
          trigger,
          reason: errorText(error),
        },
        "mcp reconnect failed; the server stays unavailable and its tools answer as unavailable",
      );
      markUnavailable("reconnect_failed");
      return false;
    }
  };

  const ensureReconnected = (
    observedGeneration: number,
    trigger: ReconnectTrigger,
  ): Promise<boolean> => {
    if (generation !== observedGeneration) return Promise.resolve(status === "connected");
    if (!reconnecting) reconnecting = reconnectOnce(trigger).finally(() => (reconnecting = null));
    return reconnecting;
  };

  const runHealthCheck = async (): Promise<void> => {
    if (pinging || closed || status !== "connected" || inFlight > 0) return;
    if (runtime.now() - lastActivityAt < options.healthPingIntervalMs) return;
    pinging = true;
    try {
      await runMCPRequest(
        handle,
        () =>
          handle.client.ping({
            timeout: options.connectTimeoutMs,
            ...(options.signal ? { signal: options.signal } : {}),
          }),
        options.signal,
      );
      lastActivityAt = runtime.now();
      timeoutStreak = 0;
    } catch (error) {
      logger.debug(
        { event: "mcp.health.ping_failed", reason: errorText(error) },
        "mcp health ping failed; the connection is reopened before the next call",
      );
      if (closed || status !== "connected" || inFlight > 0) return;
      await bestEffort(() => ensureReconnected(generation, "health_ping_failed"), {
        operation: "mcp_health_reconnect",
        workspace: options.eventBase.scope.workspace,
        dedupeKey: `mcp_health_reconnect\0${options.eventBase.scope.workspace}\0${options.mcpName}`,
        logger,
      });
    } finally {
      pinging = false;
    }
  };

  const armHealthCheck = (): void => {
    if (options.healthPingIntervalMs <= 0 || closed) return;
    healthTimer = runtime.schedule(() => {
      const check = runHealthCheck().finally(armHealthCheck);
      detachObserved(() => check, {
        operation: "mcp_health_check",
        workspace: options.eventBase.scope.workspace,
        dedupeKey: `mcp_health_check\0${options.eventBase.scope.workspace}\0${options.mcpName}`,
        logger,
      });
      return check;
    }, options.healthPingIntervalMs);
  };

  const session: ResilientSession = {
    get status() {
      return status;
    },
    async invoke(label, run, onResult, signal) {
      if (signal?.aborted) return abortedResult(label);
      if (closed) return unavailableResult(options.mcpName);
      if (reconnecting && !(await reconnecting))
        return signal?.aborted ? abortedResult(label) : unavailableResult(options.mcpName);
      if (status === "unavailable") {
        if (runtime.now() < unavailableUntil) return unavailableResult(options.mcpName);
        if (!(await ensureReconnected(generation, "reprobe")))
          return signal?.aborted ? abortedResult(label) : unavailableResult(options.mcpName);
      }
      if (signal?.aborted) return abortedResult(label);
      const callGeneration = generation;
      const callStartedAt = callDoneEnabled ? runtime.now() : 0;
      let outcome: McpCallOutcome = "transport";
      const cancelled = (): ToolResult => {
        outcome = "aborted";
        return abortedResult(label, true);
      };
      inFlight += 1;
      try {
        const raw = await runMCPRequest(
          handle,
          () =>
            run(handle, {
              timeout: options.callTimeoutMs,
              ...(signal ? { signal } : {}),
            }),
          signal,
        );
        transportFailStreak = 0;
        timeoutStreak = 0;
        lastActivityAt = runtime.now();
        outcome = "ok";
        return onResult(raw);
      } catch (err) {
        lastActivityAt = runtime.now();
        // Once `run` has been invoked the request may already have reached the
        // server. Cancellation is still reported as cancellation, but callers
        // must reconcile mutations before issuing a new idempotency key.
        if (signal?.aborted) return cancelled();
        if (err instanceof MCPAuthorizationPendingError) {
          outcome = "unavailable";
          return authorizationPendingResult(options.mcpName);
        }
        if (isMcpRequestTimeout(err)) {
          outcome = "timeout";
          timeoutStreak += 1;
          if (timeoutStreak === options.timeoutStreakThreshold) {
            logger.warn(
              {
                event: "mcp.timeout_streak",
                streak: timeoutStreak,
                threshold: options.timeoutStreakThreshold,
                call_timeout_ms: options.callTimeoutMs,
              },
              "mcp server timed out often enough to be treated as unavailable; its tools stop " +
                "being called until the cooldown expires",
            );
          }
          if (timeoutStreak >= options.timeoutStreakThreshold) {
            markUnavailable("timeout");
            return becameUnavailableResult(options.mcpName, err);
          }
          return timeoutResult(label, options.callTimeoutMs);
        }
        if (isMcpProtocolError(err)) {
          outcome = "protocol";
          return runtimeErrorResult(label, err);
        }
        if (callGeneration !== lastFailedGeneration) {
          lastFailedGeneration = callGeneration;
          transportFailStreak += 1;
        }
        if (transportFailStreak >= 2) {
          markUnavailable("transport");
          return signal?.aborted ? cancelled() : becameUnavailableResult(options.mcpName, err);
        }
        if (!(await ensureReconnected(callGeneration, "transport_error")))
          return signal?.aborted ? cancelled() : becameUnavailableResult(options.mcpName, err);
        return signal?.aborted ? cancelled() : interruptedResult(label, err);
      } finally {
        inFlight -= 1;
        if (callDoneEnabled && sampleCall(label)) {
          logger.debug(
            {
              event: "mcp.call.done",
              label,
              duration_ms: runtime.now() - callStartedAt,
              outcome,
            },
            "mcp call finished",
          );
        }
      }
    },
    close() {
      closePromise ??= (async (): Promise<void> => {
        const first = !closed;
        closed = true;
        healthTimer?.cancel();
        healthTimer = undefined;
        if (first) emit("closed");
        const pendingReconnect = reconnecting;
        if (pendingReconnect !== null) {
          await awaitLifecycle(() => pendingReconnect, "mcp_close_pending_reconnect");
        }
        await awaitLifecycle(() => handle.close(), "mcp_session_handle_close");
      })();
      return closePromise;
    },
  };

  armHealthCheck();
  return session;
}
