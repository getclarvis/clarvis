import type { Logger } from "@clarvis/capability";
import type {
  ElicitationRequest,
  Message,
  RunHandle,
  RunResult,
  StartRunParams,
} from "@clarvis/protocol";
import { mayRunAgent, type Principal } from "../auth/principals.ts";
import { SILENT_SERVER_LOGGERS, type ServerLoggers } from "../logging.ts";
import type { ResolvedHost } from "../host/run-host.ts";
import type { ConcurrencyGate, LiveRunTable } from "../host/live-runs.ts";
import { createElicitationController, resolvePosture } from "./elicitation.ts";
import { createNotificationSink, type SendNotification } from "./notify.ts";
import { errorResult, postureMeta, streamMeta, toolResult, type ToolResult } from "./results.ts";
import { serverError } from "./errors.ts";
import { observeServerTask } from "../tasks.ts";
import { scheduleSystemTimeout, type ScheduleTimeout } from "../timing.ts";

/** Everything the run handler needs that is not in the tool's arguments. */
export interface RunToolDeps {
  resolved: ResolvedHost;
  /** The caller this session was opened by, absent without authentication. */
  principal?: Principal | undefined;
  runs: LiveRunTable;
  gate: ConcurrencyGate;
  clientDeclaresElicitation: () => boolean;
  sendNotification: SendNotification;
  sendElicitRequest?: (
    request: { message: string; requestedSchema: Record<string, unknown> },
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ) => Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }>;
  getLevel: () => string;
  limits: {
    bufferMax: number;
    bufferMaxBytes: number;
    sendTimeoutMs: number;
    heartbeatMs: number;
    runMaxMs: number;
    settleGraceMs: number;
    elicitToolWaitMs: number;
    elicitRelayMs: number;
    allowRemoteGuardApproval: boolean;
  };
  /** Internal deterministic-test seam; production uses the host timer API. */
  scheduleTimeout?: ScheduleTimeout;
  /** The session-bound channels this run derives its own from. */
  logger?: ServerLoggers;
}

/**
 * Record a run something other than the model ended.
 *
 * @param logger - the diagnostic channel; the session's or the run's.
 * @param executionId - the run that was cancelled.
 * @param cancelledBy - what ended it.
 * @param elapsedMs - how long it had been running.
 * @remarks Shared with `buildMcpServer`'s `cancelAll` because a cancellation
 * reaches the caller only through the tool envelope — and if the connection is
 * what died, that envelope reaches nobody and the fact is otherwise lost.
 */
export function reportRunCancelled(
  logger: Logger,
  executionId: string,
  cancelledBy: "client" | "session_close" | "wall_clock" | "shutdown",
  elapsedMs: number,
): void {
  logger.warn(
    {
      event: "run.cancelled",
      execution_id: executionId,
      cancelled_by: cancelledBy,
      elapsed_ms: elapsedMs,
    },
    "a run was cancelled by something other than the model; its trace still persists",
  );
}

/**
 * Record a caller refused an agent its role does not list.
 *
 * @param audit - the session-bound audit channel.
 * @param principal - the caller.
 * @param agent - the agent it asked for, absent when it named none.
 */
function reportAgentDenied(audit: Logger, principal: Principal, agent: string | undefined): void {
  const { agents } = principal.permissions;
  audit.warn(
    {
      event: "authz.agent.denied",
      client_id: principal.clientId,
      role: principal.role,
      ...(agent !== undefined ? { agent } : {}),
      allowed: agents === "*" ? "*" : agents.join(","),
    },
    "a run was refused because the caller's role does not list that agent; a role with an allow list requires the agent argument",
  );
}

/** Record the constraints the facade had to impose on a run's request. */
function reportDowngraded(logger: Logger, executionId: string, downgrades: string[]): void {
  logger.info(
    {
      event: "run.posture.downgraded",
      execution_id: executionId,
      downgrades: downgrades.join("; "),
    },
    "the facade weakened this run's requested posture; the same list is in the result's posture block",
  );
}

/** The token counters a finished run reports, flattened into scalar fields. */
function usageFields(result: RunResult): Record<string, number> {
  const usage = result.usage;
  if (usage === undefined) return {};
  return {
    usage_iterations: usage.iterations,
    usage_elapsed_ms: usage.elapsed_ms,
    ...(usage.input_tokens !== undefined ? { usage_input_tokens: usage.input_tokens } : {}),
    ...(usage.output_tokens !== undefined ? { usage_output_tokens: usage.output_tokens } : {}),
    ...(usage.cached_tokens !== undefined ? { usage_cached_tokens: usage.cached_tokens } : {}),
  };
}

/** The `clarvis_run` arguments after zod parsing. */
export interface RunToolArgs {
  prompt?: string;
  messages?: { role: "user" | "assistant"; content: unknown }[];
  agent?: string;
  execution_id?: string;
  continue_from?: string;
  memory?: "on" | "off";
  plans?: "off" | "on" | "review";
  skill?: { name: string; task?: string };
  output_schema?: Record<string, unknown>;
  elicitations: "auto_decline" | "await";
  elicitation_wait_ms?: number;
}

/** Race `promise` against a timer, resolving to `onTimeout` when it fires first. */
function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => T,
  scheduleTimeout: ScheduleTimeout = scheduleSystemTimeout,
): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timeoutState: { cancel: (() => void) | undefined } = { cancel: undefined };
    const finish = (value: T): void => {
      if (settled) return;
      settled = true;
      timeoutState.cancel?.();
      resolve(value);
    };
    const timeout = (): void => finish(onTimeout());
    timeoutState.cancel = scheduleTimeout(timeout, ms);
    void promise.then(finish, timeout);
  });
}

/** Wait for a set of lifecycle signals, treating rejection as terminal settlement. */
function settlesWithin(
  promises: readonly PromiseLike<unknown>[],
  ms: number,
  scheduleTimeout?: ScheduleTimeout,
): Promise<boolean> {
  return withDeadline(
    Promise.allSettled(promises).then(() => true),
    ms,
    () => false,
    scheduleTimeout ?? scheduleSystemTimeout,
  );
}

/**
 * Handle one `clarvis_run` call: start the run, stream it, and answer with its
 * result.
 *
 * @param args - the validated tool arguments.
 * @param deps - host, session tables and limits; see {@link RunToolDeps}.
 * @param extra - the MCP request's abort signal and progress token.
 * @returns the tool result carrying the run's outcome, posture and stream stats.
 * @remarks The tool call *is* the run: it blocks on the handle until the run
 *   settles, and the caller learns the run's id from the first notification (or
 *   by supplying `execution_id` itself). Steering and cancellation arrive as
 *   separate calls on the same session and find the handle through
 *   {@link LiveRunTable}. Because abort listeners do not replay an abort that
 *   happened while `runs.start()` awaited, the post-registration state check
 *   closes that window synchronously.
 */
export async function handleRunTool(
  args: RunToolArgs,
  deps: RunToolDeps,
  extra: { signal?: AbortSignal; progressToken?: string | number },
): Promise<ToolResult> {
  if ((args.prompt === undefined) === (args.messages === undefined)) {
    return errorResult("invalid_request", "supply exactly one of `prompt` or `messages`");
  }

  const loggers = deps.logger ?? SILENT_SERVER_LOGGERS;
  const { principal } = deps;
  if (principal !== undefined && !mayRunAgent(principal, args.agent)) {
    reportAgentDenied(loggers.audit, principal, args.agent);
    return errorResult(
      "forbidden",
      args.agent === undefined
        ? `role '${principal.role}' is restricted to named agents, so \`agent\` is required`
        : `role '${principal.role}' may not run agent '${args.agent}'`,
      { role: principal.role, agents: principal.permissions.agents },
    );
  }

  const messages: Message[] =
    args.prompt !== undefined
      ? [{ role: "user", content: args.prompt }]
      : (args.messages as unknown as Message[]);

  const posture = resolvePosture({
    clientDeclaresElicitation: deps.clientDeclaresElicitation(),
    requested: args.elicitations,
    ...(args.plans !== undefined ? { requestedPlans: args.plans } : {}),
    allowRemoteGuardApproval: deps.limits.allowRemoteGuardApproval,
    ...(principal !== undefined
      ? { roleAllowsGuardApproval: principal.permissions.guardConfirmations === "relay" }
      : {}),
  });

  const fail = (err: unknown): ToolResult => {
    const mapped = err as { code?: string; message?: string };
    return errorResult(
      (mapped.code as never) ?? "internal",
      mapped.message ?? String(err),
      (err as { details?: Record<string, unknown> }).details,
    );
  };

  let release: (() => void) | undefined;
  try {
    release = deps.gate.acquire(deps.resolved.owner, principal?.permissions.maxRuns);
  } catch (err) {
    return fail(err);
  }

  const params: StartRunParams = {
    messages,
    ...(args.agent !== undefined ? { agent: args.agent } : {}),
    ...(args.execution_id !== undefined ? { execution_id: args.execution_id } : {}),
    ...(args.continue_from !== undefined ? { continue_from: args.continue_from } : {}),
    ...(args.memory !== undefined ? { memory: args.memory } : {}),
    ...(posture.plans_effective !== undefined ? { plans: posture.plans_effective } : {}),
    ...(posture.prompt_cache_ttl !== undefined
      ? { prompt_cache_ttl: posture.prompt_cache_ttl }
      : {}),
    ...(args.skill !== undefined ? { skill: args.skill } : {}),
    ...(args.output_schema !== undefined ? { output_schema: args.output_schema } : {}),
  };

  if (args.execution_id !== undefined && deps.runs.get(args.execution_id) !== undefined) {
    release();
    return fail(
      serverError("conflict", `run '${args.execution_id}' is already in flight on this session`, {
        execution_id: args.execution_id,
      }),
    );
  }

  let handle: RunHandle;
  try {
    handle = await deps.resolved.host.runs.start(params);
  } catch (err) {
    release();
    return fail(err);
  }

  const runLog = loggers.child({ execution_id: handle.execution_id }).log;
  const sink = createNotificationSink({
    sendNotification: deps.sendNotification,
    ...(extra.progressToken !== undefined ? { progressToken: extra.progressToken } : {}),
    getLevel: deps.getLevel,
    bufferMax: deps.limits.bufferMax,
    bufferMaxBytes: deps.limits.bufferMaxBytes,
    sendTimeoutMs: deps.limits.sendTimeoutMs,
    ...(deps.scheduleTimeout === undefined ? {} : { scheduleTimeout: deps.scheduleTimeout }),
    logger: runLog,
  });
  const controller = createElicitationController({
    posture,
    publish: (request: ElicitationRequest) => {
      sink.onEvent({
        type: "elicitation_requested",
        at: Date.now(),
        question: request.prompt,
      });
      sink.notify({
        method: "notifications/message",
        params: {
          level: "notice",
          logger: "clarvis.elicit",
          data: { type: "elicitation_pending", request },
        },
      });
    },
    ...(deps.sendElicitRequest !== undefined ? { sendRequest: deps.sendElicitRequest } : {}),
    ...(extra.signal !== undefined ? { signal: extra.signal } : {}),
    toolWaitMs: args.elicitation_wait_ms ?? deps.limits.elicitToolWaitMs,
    relayWaitMs: deps.limits.elicitRelayMs,
    logger: runLog,
  });

  runLog.info(
    {
      event: "run.started",
      execution_id: handle.execution_id,
      ...(args.agent !== undefined ? { agent: args.agent } : {}),
      elicitation_posture: posture.elicitation,
      ...(posture.plans_effective !== undefined
        ? { plans_effective: posture.plans_effective }
        : {}),
      ...(args.continue_from !== undefined ? { continue_from: args.continue_from } : {}),
    },
    "a run started; the tool call blocks until it settles, so its duration is the caller's",
  );
  if (posture.downgrades.length > 0) {
    reportDowngraded(runLog, handle.execution_id, posture.downgrades);
  }

  let finishLifecycle!: () => void;
  const lifecycleDone = new Promise<void>((resolve) => {
    finishLifecycle = resolve;
  });
  try {
    controller.attach(handle);
    deps.runs.add({
      executionId: handle.execution_id,
      owner: deps.resolved.owner,
      handle,
      startedAt: Date.now(),
      elicit: controller,
      lifecycleDone,
    });
  } catch (err) {
    controller.dispose();
    const cancel = Promise.resolve().then(() => handle.cancel());
    await settlesWithin([cancel, handle.closed], deps.limits.settleGraceMs, deps.scheduleTimeout);
    release();
    finishLifecycle();
    return fail(err);
  }

  const live = deps.runs.require(handle.execution_id);
  const markCancelled = (by: "client" | "wall_clock"): void => {
    if (live.cancelledBy !== undefined) return;
    live.cancelledBy = by;
    reportRunCancelled(runLog, handle.execution_id, by, Date.now() - live.startedAt);
  };
  const onAbort = (): void => {
    markCancelled("client");
    observeServerTask("server_client_abort_cancel", () => handle.cancel());
  };
  let wallClock: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let controlsStopped = false;
  let lifecycleWaited = false;
  const stopRunControls = (): void => {
    if (controlsStopped) return;
    controlsStopped = true;
    if (heartbeat !== undefined) clearInterval(heartbeat);
    if (wallClock !== undefined) clearTimeout(wallClock);
    extra.signal?.removeEventListener("abort", onAbort);
    controller.dispose();
  };

  try {
    extra.signal?.addEventListener("abort", onAbort, { once: true });
    if (extra.signal?.aborted) onAbort();

    wallClock = setTimeout(() => {
      markCancelled("wall_clock");
      observeServerTask("server_wall_clock_cancel", () => handle.cancel());
    }, deps.limits.runMaxMs);
    wallClock.unref?.();

    heartbeat = setInterval(() => sink.heartbeat(), deps.limits.heartbeatMs);
    heartbeat.unref?.();

    sink.notify({
      method: "notifications/message",
      params: {
        level: "info",
        logger: "clarvis.run",
        data: {
          type: "run_accepted",
          execution_id: handle.execution_id,
          owner: deps.resolved.owner,
          posture,
          wall_clock_ms: deps.limits.runMaxMs,
        },
      },
    });

    const eventIterator = handle.events[Symbol.asyncIterator]();
    const pump = (async () => {
      for (;;) {
        const next = await eventIterator.next();
        if (next.done) return;
        sink.onEvent(next.value);
      }
    })().catch(() => undefined);

    let result: RunResult;
    try {
      result = await handle.done;
    } catch (err) {
      result = {
        execution_id: handle.execution_id,
        status: "failed",
        error: { code: "internal", message: err instanceof Error ? err.message : String(err) },
      };
    }
    stopRunControls();

    const streamSettled = await settlesWithin(
      [pump, handle.closed],
      deps.limits.settleGraceMs,
      deps.scheduleTimeout,
    );
    sink.seal(!streamSettled);
    if (!streamSettled) {
      const returned = Promise.resolve().then(() => eventIterator.return?.());
      await settlesWithin(
        [returned, handle.closed],
        deps.limits.settleGraceMs,
        deps.scheduleTimeout,
      );
    }
    lifecycleWaited = true;
    await sink.flush();

    const stats = sink.stats();
    const envelope: Record<string, unknown> = {
      execution_id: result.execution_id,
      status: result.status,
      ...(result.result !== undefined ? { result: result.result } : {}),
      ...(live.cancelledBy === "wall_clock"
        ? { ended_reason: "server_wall_clock_cap" }
        : result.ended_reason !== undefined
          ? { ended_reason: result.ended_reason }
          : {}),
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
      posture,
      stream: stats,
    };

    runLog.info(
      {
        event: "run.finished",
        execution_id: result.execution_id,
        status: result.status,
        dur_ms: Date.now() - live.startedAt,
        ...(envelope.ended_reason !== undefined
          ? { ended_reason: envelope.ended_reason as string }
          : {}),
        ...(live.cancelledBy !== undefined ? { cancelled_by: live.cancelledBy } : {}),
        ...usageFields(result),
        events_sent: stats.events_sent,
        events_dropped: stats.events_dropped,
        wedged: stats.wedged,
        truncated: stats.truncated,
      },
      "a run finished and its result is on its way back; the persisted trace is the record, this is the accounting",
    );
    return toolResult(envelope, { ...streamMeta(stats), ...postureMeta(posture) });
  } finally {
    stopRunControls();
    if (!lifecycleWaited) {
      const cancel = Promise.resolve().then(() => handle.cancel());
      await settlesWithin([cancel, handle.closed], deps.limits.settleGraceMs, deps.scheduleTimeout);
    }
    deps.runs.delete(handle.execution_id);
    release();
    finishLifecycle();
  }
}
