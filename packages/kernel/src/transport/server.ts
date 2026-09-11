import type {
  ConfigChangeKind,
  KernelCapabilities,
  Principal,
  WorkspaceRef,
  ProjectRef,
  ElicitationResponse,
  Message,
  RunHandle,
  RunResult,
} from "@clarvis/protocol";
import type { InProcessKernel } from "../kernel.ts";
import { sanitizeErrorMessage, suppressSecondaryRejection } from "@clarvis/capability";
import { kernelError } from "../core/errors.ts";
import { CLARVIS_WIRE_VERSION, M, N, type HelloParams } from "./wire.ts";
import {
  ORDINARY_OPERATIONS,
  SPECIAL_OPERATIONS,
  decodeOperationParams,
  type KernelOperationMetadata,
  type KernelServices,
  requireHosting,
} from "./operations.ts";
import { createUnavailableProviderAuthService } from "../subscriptions/unavailable.ts";
import { createHostingDispatcher } from "./hosting-server.ts";

/**
 * The sink a connection pushes server→client notifications through — one per
 * transport, supplied at {@link KernelServer.connect} time.
 *
 * @param method - a {@link N} notification method name.
 * @param params - the matching notification payload.
 */
export type NotificationSender = (method: string, params: unknown) => void | Promise<void>;

const DEFAULT_NOTIFICATION_TIMEOUT_MS = 30_000;
const MAX_NOTIFICATION_QUEUE_FRAMES = 1_024;
const MAX_NOTIFICATION_QUEUE_BYTES = 16 * 1024 * 1024;

interface PendingNotification {
  readonly method: string;
  readonly params: unknown;
  readonly bytes: number;
  readonly resolve: () => void;
}

interface NotificationChannel {
  notify(method: string, params: unknown): Promise<void>;
  close(): void;
}

/** Transport-owned terminal callback used when server→client delivery becomes impossible. */
export type TransportDisconnect = (reason: Error) => void;

/**
 * Serialize a connection's notifications behind finite count, byte, and time
 * bounds. A failed or stalled sink opens the circuit permanently, so an
 * unresolvable sender can retain at most one delivery rather than one per run
 * event. Closing interrupts the bounded wait without waiting for the sink.
 */
function createNotificationChannel(
  send: NotificationSender,
  timeoutMs: number,
  onFailure: TransportDisconnect,
): NotificationChannel {
  const queue: PendingNotification[] = [];
  const interrupts = new Set<() => void>();
  let state: "open" | "failed" | "closed" = "open";
  let draining = false;
  let pendingFrames = 0;
  let pendingBytes = 0;

  const finish = (notification: PendingNotification): void => {
    pendingFrames -= 1;
    pendingBytes -= notification.bytes;
    notification.resolve();
  };

  const stop = (next: "failed" | "closed", reason?: Error): void => {
    if (state !== "open") return;
    state = next;
    for (const interrupt of interrupts) interrupt();
    interrupts.clear();
    let notification: PendingNotification | undefined;
    while ((notification = queue.shift()) !== undefined) finish(notification);
    if (next === "failed") {
      onFailure(reason ?? new Error("kernel notification channel failed"));
    }
  };

  const drain = async (): Promise<void> => {
    try {
      while (state === "open") {
        const notification = queue.shift();
        if (notification === undefined) return;

        let interrupt!: () => void;
        const interrupted = new Promise<"interrupted">((resolve) => {
          interrupt = () => resolve("interrupted");
          interrupts.add(interrupt);
        });
        let delivery: void | Promise<void>;
        try {
          delivery = send(notification.method, notification.params);
        } catch (error) {
          delivery = Promise.reject(
            error instanceof Error ? error : new Error("notification sender threw"),
          );
        }
        const delivered = Promise.resolve(delivery).then(
          () => ({ kind: "delivered" as const }),
          (error: unknown) => ({
            kind: "failed" as const,
            reason: error instanceof Error ? error : new Error("notification sender rejected"),
          }),
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<{ kind: "timed_out"; reason: Error }>((resolve) => {
          timer = setTimeout(
            () =>
              resolve({
                kind: "timed_out",
                reason: new Error(`notification sender stalled for ${String(timeoutMs)}ms`),
              }),
            timeoutMs,
          );
          timer.unref?.();
        });
        const outcome = await Promise.race([
          delivered,
          timedOut,
          interrupted.then(() => ({ kind: "interrupted" as const })),
        ]);
        if (timer !== undefined) clearTimeout(timer);
        interrupts.delete(interrupt);
        finish(notification);
        if (outcome.kind !== "delivered") {
          if (outcome.kind !== "interrupted") stop("failed", outcome.reason);
          return;
        }
      }
    } finally {
      draining = false;
    }
  };

  return {
    notify(method, params): Promise<void> {
      if (state !== "open") return Promise.resolve();
      let bytes: number;
      try {
        bytes = Buffer.byteLength(JSON.stringify({ method, params }), "utf8");
      } catch {
        stop("failed", new Error("notification payload is not serializable"));
        return Promise.resolve();
      }
      if (
        bytes > MAX_NOTIFICATION_QUEUE_BYTES ||
        pendingFrames >= MAX_NOTIFICATION_QUEUE_FRAMES ||
        pendingBytes + bytes > MAX_NOTIFICATION_QUEUE_BYTES
      ) {
        stop("failed", new Error("notification backpressure queue is full"));
        return Promise.resolve();
      }
      const queued = new Promise<void>((resolve) => {
        queue.push({ method, params, bytes, resolve });
        pendingFrames += 1;
        pendingBytes += bytes;
      });
      if (!draining) {
        draining = true;
        suppressSecondaryRejection(drain(), "the kernel notification channel");
      }
      return queued;
    },
    close(): void {
      stop("closed");
    },
  };
}

/**
 * One client session on a {@link KernelServer}: dispatch requests and tear the
 * session down.
 */
export interface KernelConnection {
  /**
   * Dispatch one wire request to its service and resolve the response body.
   *
   * @param method - a {@link M} method name.
   * @param params - the request parameters (an empty object is assumed when absent).
   * @returns the service result to send back as the `res` frame.
   * @throws a kernel error with code `invalid_request` for an unknown method, or
   *   `not_found` when a run-scoped call names no live run.
   */
  handle(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
  /**
   * Tear the session down: unsubscribe every config subscription and cancel every
   * ordinary live run started on this connection. Hosted observations are released;
   * their host context applies the explicit execution disconnect policy.
   */
  close(): void;
}

/** A server that accepts transports, binding each to its own notification sink. */
export interface KernelServer {
  /**
   * Open a new {@link KernelConnection} that pushes notifications through `send`.
   *
   * @param send - the per-connection sink for server→client notifications.
   * @param disconnect - closes the underlying transport and notifies its client
   *   when notification delivery has become impossible.
   */
  connect(send: NotificationSender, disconnect: TransportDisconnect): KernelConnection;
}

/** Options for {@link createKernelServer}. */
export interface KernelServerOptions {
  /** Capability overrides merged over {@link DEFAULT_CAPABILITIES} and advertised in `hello`. */
  capabilities?: Partial<KernelCapabilities>;
  /**
   * Host authorization policy evaluated before every operation except `hello`.
   *
   * @remarks Absence permits every operation after hello, for the process-owned stdio embedder.
   * `createFileRunHost` supplies both hooks: authentication resolves a live connection role and this
   * hook checks catalog access/sensitivity on every call. A socket host must supply both policies;
   * authentication by itself does not authorize the complete kernel service surface.
   */
  authorize?: (context: KernelAuthorizationContext) => boolean | Promise<boolean>;
  /**
   * Host resolver that authenticates and binds one hello request to owner services.
   *
   * @remarks Owner selection belongs here, never in an ordinary operation parameter.
   *
   * With this hook absent, the generic stdio embedding validates but does not authenticate `auth`;
   * hello returns no principal and remote subscription controls remain unavailable. The file run
   * host requires a token verifier, binds its own workspace/owner and advertises hosting only after
   * resolving an operator or observer. See {@link KernelServerOptions.authorize} for the paired
   * per-operation policy. Neither hook is an agent capability.
   */
  resolveConnection?: (
    params: HelloParams,
  ) => KernelConnectionContext | Promise<KernelConnectionContext>;
  /** Maximum time one server→client notification may occupy the serialized sink. */
  notificationTimeoutMs?: number;
}

/** Inputs supplied to a host's transport authorization policy. */
export interface KernelAuthorizationContext {
  /** Wire method being invoked. */
  readonly method: string;
  /** Catalog metadata describing access and sensitivity. */
  readonly metadata: KernelOperationMetadata;
  /** Connected principal, once authentication-aware hosts provide one. */
  readonly principal?: Principal;
  /** Workspace bound to this server. */
  readonly workspace: WorkspaceRef;
}

/** Host-resolved identity and owner services bound to one transport connection. */
export interface KernelConnectionContext {
  /** Authenticated principal when the host has one. */
  readonly principal?: Principal;
  /** Authorized workspace binding. */
  readonly workspace: WorkspaceRef;
  /** Project resolved by the host for this workspace. */
  readonly project: ProjectRef;
  /** Complete workspace-scoped service set; never borrowed from the primary kernel. */
  readonly services: KernelServices;
  /** Per-workspace capability view, when it differs from the server default. */
  readonly capabilities?: KernelCapabilities;
  /** Release a host-level connection lease. */
  readonly close?: () => void;
}

/**
 * Build the RPC front-end for an {@link InProcessKernel}: the server side of the
 * wire, mapping every {@link M} method onto a kernel service and pumping run
 * events out as {@link N} notifications.
 *
 * @param kernel - the in-process kernel whose services back the dispatch.
 * @param opts - optional capability overrides advertised in `hello`.
 * @returns a {@link KernelServer} whose per-connection dispatcher answers requests
 *   and, for each started run, streams its events, elicitations, and terminal
 *   result to that connection's sink.
 * @remarks A run started over a connection is tracked in a per-connection `live`
 *   map and removed when it finishes; steer/cancel/respond target that map (a
 *   missing run raises a `not_found` kernel error), while plans and config
 *   calls resolve straight through the kernel services. Closing
 *   the connection unsubscribes its config subscriptions and cancels every ordinary run it
 *   still holds. Hosted admissions instead subscribe through the injected hosting service:
 *   their root pump belongs to the shared registry, which applies explicit disconnect policy.
 *   A workflow is
 *   started through `runs.start` (the kernel routes it by the entry profile's
 *   `workflow` grant) and lands in the same `live` map, so its steer/cancel/respond
 *   dispatch through the ordinary run cases; only `workflows.get/list/delete`
 *   remain workflow-specific.
 */
export function createKernelServer(
  kernel: InProcessKernel,
  opts: KernelServerOptions = {},
): KernelServer {
  const notificationTimeoutMs = opts.notificationTimeoutMs ?? DEFAULT_NOTIFICATION_TIMEOUT_MS;
  if (!Number.isFinite(notificationTimeoutMs) || notificationTimeoutMs <= 0) {
    throw new RangeError("notificationTimeoutMs must be a positive finite number");
  }
  const capabilities: KernelCapabilities = { ...kernel.capabilities, ...opts.capabilities };
  const defaultContext: KernelConnectionContext = {
    project: kernel.project,
    workspace: kernel.workspace,
    services: {
      ...kernel.operatorServices,
      goals: kernel.goals,
      providerAuth: createUnavailableProviderAuthService(),
      ...kernel.defaultOwnerServices,
    },
  };
  const ordinary = new Map(ORDINARY_OPERATIONS.map((operation) => [operation.method, operation]));

  return {
    connect(send: NotificationSender, disconnect: TransportDisconnect): KernelConnection {
      let failConnection: TransportDisconnect = () => {};
      const notifications = createNotificationChannel(send, notificationTimeoutMs, (reason) =>
        failConnection(reason),
      );
      let context: KernelConnectionContext | undefined =
        opts.resolveConnection === undefined ? defaultContext : undefined;
      const live = new Map<
        string,
        { handle: RunHandle; resultSettled: boolean; streamSettled: boolean }
      >();
      const subs = new Map<string, { kind: "config" | "goals"; off: () => void }>();
      let releaseLifecycle: (() => void) | undefined;
      let connectionClosed = false;
      let helloStarted = false;
      let helloCompleted = false;

      const assertConnectionOpen = (): void => {
        if (connectionClosed) throw kernelError("unavailable", "kernel connection is closed");
      };

      const services = (): KernelServices => {
        if (context === undefined) {
          throw kernelError("unauthorized", "connection has not completed hello");
        }
        return context.services;
      };
      const hosted = createHostingDispatcher({
        service: () => requireHosting(services()),
        notify: (method, params) => notifications.notify(method, params),
      });

      const specialParams = (method: string, value: unknown): Record<string, unknown> => {
        const params = value === undefined ? {} : value;
        if (typeof params !== "object" || params === null || Array.isArray(params)) {
          throw kernelError("invalid_request", `operation '${method}' requires object params`);
        }
        const allowed: Readonly<Record<string, readonly string[]>> = {
          [M.hello]: ["wire_version", "clientInfo", "workspace", "auth"],
          [M.hostingStart]: ["input", "subscription_id"],
          [M.hostingAttach]: ["input", "subscription_id"],
          [M.hostingSteer]: ["subscription_id", "message"],
          [M.hostingCompact]: ["subscription_id", "request"],
          [M.hostingCancel]: ["subscription_id"],
          [M.hostingRespond]: ["subscription_id", "response"],
          [M.runsStart]: ["params"],
          [M.runsSteer]: ["execution_id", "message"],
          [M.runsCompact]: ["execution_id", "request", "options"],
          [M.runsCancel]: ["execution_id"],
          [M.runsRespond]: ["execution_id", "response"],
          [M.configSubscribe]: ["kinds", "subscription_id"],
          [M.configUnsubscribe]: ["subscription_id"],
          [M.goalsSubscribe]: ["session_id", "subscription_id"],
          [M.goalsUnsubscribe]: ["subscription_id"],
        };
        const keys = new Set(allowed[method] ?? []);
        if (!Object.keys(params).every((key) => keys.has(key))) {
          throw kernelError("invalid_request", `operation '${method}' has unknown params`);
        }
        return params as Record<string, unknown>;
      };

      const pump = (handle: RunHandle): void => {
        const state = live.get(handle.execution_id)!;
        const releaseIfSettled = (): void => {
          if (
            state.resultSettled &&
            state.streamSettled &&
            live.get(handle.execution_id) === state
          ) {
            live.delete(handle.execution_id);
          }
        };
        const releaseClosed = (): void => {
          if (live.get(handle.execution_id) === state) live.delete(handle.execution_id);
        };
        handle.onElicit((request) => {
          suppressSecondaryRejection(
            notifications.notify(N.runElicitation, { request }),
            "the kernel notification channel",
          );
        });
        suppressSecondaryRejection(
          (async () => {
            try {
              for await (const event of handle.events) {
                await notifications.notify(N.runEvent, {
                  execution_id: handle.execution_id,
                  event,
                });
              }
            } finally {
              state.streamSettled = true;
              releaseIfSettled();
              await notifications.notify(N.runStreamEnd, { execution_id: handle.execution_id });
            }
          })(),
          "the run event stream terminal channel",
        );
        const sendResult = async (result: RunResult): Promise<void> => {
          state.resultSettled = true;
          releaseIfSettled();
          await notifications.notify(N.runResult, {
            execution_id: handle.execution_id,
            result,
          });
        };
        suppressSecondaryRejection(
          handle.done.then(sendResult, (error: unknown) =>
            sendResult({
              execution_id: handle.execution_id,
              status: "failed",
              error: {
                code: "internal",
                message: sanitizeErrorMessage(
                  error instanceof Error ? error.message : String(error),
                ),
              },
            }),
          ),
          "the run.done terminal channel",
        );
        suppressSecondaryRejection(
          handle.closed.then(releaseClosed, releaseClosed),
          "the run.closed lifecycle channel",
        );
      };

      const liveOrThrow = (id: string): RunHandle => {
        const state = live.get(id);
        if (state === undefined || state.resultSettled) {
          throw kernelError("not_found", `no live run '${id}'`);
        }
        return state.handle;
      };

      const connection: KernelConnection = {
        async handle(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
          assertConnectionOpen();
          if (method !== M.hello && !helloCompleted) {
            throw kernelError("unauthorized", "connection has not completed hello");
          }
          const operation = ordinary.get(method);
          if (operation !== undefined) {
            const p = decodeOperationParams(operation, params ?? {});
            if (p === null) {
              throw kernelError(
                "invalid_request",
                `operation '${method}' has an invalid parameter envelope`,
              );
            }
            const allowed =
              opts.authorize === undefined ||
              (await opts.authorize({
                method,
                metadata: operation.metadata,
                ...(context?.principal !== undefined ? { principal: context.principal } : {}),
                workspace: context?.workspace ?? kernel.workspace,
              }));
            assertConnectionOpen();
            if (!allowed) throw kernelError("unauthorized", `operation '${method}' is not allowed`);
            const result = await operation.invoke(services(), p, signal);
            return result === undefined ? {} : result;
          }

          const p = specialParams(method, params);

          const special = Object.values(SPECIAL_OPERATIONS).find(
            (candidate) => candidate.method === method,
          );
          if (special !== undefined && special !== SPECIAL_OPERATIONS.hello) {
            const allowed =
              opts.authorize === undefined ||
              (await opts.authorize({
                method,
                metadata: special.metadata,
                ...(context?.principal !== undefined ? { principal: context.principal } : {}),
                workspace: context?.workspace ?? kernel.workspace,
              }));
            assertConnectionOpen();
            if (!allowed) throw kernelError("unauthorized", `operation '${method}' is not allowed`);
          }

          switch (method) {
            case M.hostingStart:
            case M.hostingAttach:
            case M.hostingSteer:
            case M.hostingCompact:
            case M.hostingCancel:
            case M.hostingRespond:
              return hosted.handle(method, p);
            case M.hello: {
              if (helloStarted) {
                throw kernelError(
                  "invalid_request",
                  "hello has already started on this connection",
                );
              }
              helloStarted = true;
              if (p.wire_version !== CLARVIS_WIRE_VERSION) {
                throw kernelError(
                  "unsupported",
                  `unsupported Clarvis wire version '${String(p.wire_version)}'`,
                );
              }
              if (
                (p.workspace !== undefined && typeof p.workspace !== "string") ||
                (p.auth !== undefined && typeof p.auth !== "string") ||
                (p.clientInfo !== undefined &&
                  (typeof p.clientInfo !== "object" ||
                    p.clientInfo === null ||
                    Array.isArray(p.clientInfo) ||
                    typeof (p.clientInfo as { name?: unknown }).name !== "string" ||
                    ((p.clientInfo as { version?: unknown }).version !== undefined &&
                      typeof (p.clientInfo as { version?: unknown }).version !== "string")))
              ) {
                throw kernelError("invalid_request", "hello has invalid identity parameters");
              }
              const resolved =
                opts.resolveConnection === undefined
                  ? defaultContext
                  : await opts.resolveConnection(p as unknown as HelloParams);
              if (connectionClosed) {
                resolved.close?.();
                throw kernelError("unavailable", "kernel connection is closed");
              }
              context = resolved;
              helloCompleted = true;
              return {
                wire_version: CLARVIS_WIRE_VERSION,
                capabilities: context.capabilities ?? capabilities,
                project: context.project,
                workspace: context.workspace,
                ...(context.principal !== undefined ? { principal: context.principal } : {}),
              };
            }

            case M.runsStart: {
              const runService = services().runs;
              const handle = await runService.start(
                p.params as Parameters<typeof runService.start>[0],
              );
              if (connectionClosed) {
                suppressSecondaryRejection(handle.cancel(), "the run.done terminal channel");
                throw kernelError("unavailable", "kernel connection is closed");
              }
              live.set(handle.execution_id, {
                handle,
                resultSettled: false,
                streamSettled: false,
              });
              pump(handle);
              return { execution_id: handle.execution_id };
            }
            case M.runsSteer:
              await liveOrThrow(p.execution_id as string).steer(p.message as Message | string);
              return {};
            case M.runsCompact: {
              const executionId = p.execution_id as string;
              const request = typeof p.request === "string" ? p.request : undefined;
              const options =
                typeof p.options === "object" && p.options !== null
                  ? (p.options as { mechanical_target_tokens?: number })
                  : undefined;
              const active = live.get(executionId)?.handle;
              if (active !== undefined) {
                if (options?.mechanical_target_tokens !== undefined) {
                  throw kernelError(
                    "invalid_request",
                    "mechanical context fitting requires a settled run",
                  );
                }
                await active.compact(request);
                return { status: "queued", execution_id: executionId };
              }
              return services().runs.compact(executionId, request, options);
            }
            case M.runsCancel:
              await liveOrThrow(p.execution_id as string).cancel();
              return {};
            case M.runsRespond:
              await liveOrThrow(p.execution_id as string).respond(
                p.response as ElicitationResponse,
              );
              return {};
            case M.goalsSubscribe: {
              const id = p.subscription_id;
              if (typeof id !== "string" || !/^[a-zA-Z0-9._:-]{1,256}$/u.test(id))
                throw kernelError("invalid_request", "Invalid goal subscription identity");
              if (subs.has(id)) throw kernelError("conflict", "Subscription is already active");
              if ([...subs.values()].filter((sub) => sub.kind === "goals").length >= 8)
                throw kernelError("resource_exhausted", "Goal subscription limit reached");
              let disposed = false;
              let unsubscribe: (() => void) | undefined;
              const off = (): void => {
                disposed = true;
                const release = unsubscribe;
                unsubscribe = undefined;
                release?.();
              };
              const subscription = { kind: "goals" as const, off };
              subs.set(id, subscription);
              try {
                unsubscribe = await services().goals.subscribe(p.session_id as string, (change) => {
                  if (!disposed)
                    suppressSecondaryRejection(
                      notifications.notify(N.goalChange, { subscription_id: id, change }),
                      "the kernel transport close channel",
                    );
                });
                if (disposed || connectionClosed) {
                  off();
                  assertConnectionOpen();
                }
                return {};
              } catch (error) {
                off();
                if (subs.get(id) === subscription) subs.delete(id);
                throw error;
              }
            }
            case M.goalsUnsubscribe: {
              const id = p.subscription_id;
              if (typeof id !== "string" || !/^[a-zA-Z0-9._:-]{1,256}$/u.test(id))
                throw kernelError("invalid_request", "Invalid goal subscription identity");
              const sub = subs.get(id);
              if (sub !== undefined && sub.kind !== "goals")
                throw kernelError("invalid_request", "Subscription is not a goal subscription");
              sub?.off();
              subs.delete(id);
              return {};
            }
            case M.configSubscribe: {
              const id = p.subscription_id as string;
              if (subs.has(id)) {
                throw kernelError("conflict", `subscription '${id}' is already active`);
              }
              const off = services().config.subscribe(p.kinds as ConfigChangeKind[], (change) => {
                suppressSecondaryRejection(
                  notifications.notify(N.configChange, { subscription_id: id, change }),
                  "the kernel transport close channel",
                );
              });
              subs.set(id, { kind: "config", off });
              return {};
            }
            case M.configUnsubscribe: {
              const id = p.subscription_id as string;
              const sub = subs.get(id);
              if (sub !== undefined && sub.kind !== "config") {
                throw kernelError(
                  "invalid_request",
                  `subscription '${id}' is not a config subscription`,
                );
              }
              sub?.off();
              subs.delete(id);
              return {};
            }
            default:
              throw kernelError("invalid_request", `unknown method '${method}'`);
          }
        },
        close(): void {
          if (connectionClosed) return;
          connectionClosed = true;
          notifications.close();
          hosted.close();
          for (const { off } of subs.values()) off();
          subs.clear();
          for (const { handle } of live.values())
            suppressSecondaryRejection(handle.cancel(), "the run.done terminal channel");
          live.clear();
          context?.close?.();
          releaseLifecycle?.();
          releaseLifecycle = undefined;
        },
      };
      failConnection = (reason): void => {
        connection.close();
        try {
          disconnect(reason);
        } catch {
          // A broken transport close cannot keep the kernel connection alive.
        }
      };
      releaseLifecycle = kernel.lifecycle.register({ close: () => connection.close() });
      return connection;
    },
  };
}
