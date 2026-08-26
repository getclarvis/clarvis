/**
 * The agent-supervision registry: one id space, one record per child, and the
 * reads the five supervision tools serve.
 *
 * @remarks One registry belongs to one run, and only that run's *entry* agent
 * can spawn — a leader is a separate `executeRun` with a registry of its own. So
 * "a parent reaches its direct children only" is structural rather than a rule
 * to enforce: a grandchild's id does not exist in this id space, and the
 * unknown-id path is courtesy, not the boundary.
 *
 * The registry knows nothing about delegation or workflows; producers register
 * into it.
 */
import {
  CodedError,
  isBuiltinTraceEntry,
  isBuiltinTraceEvent,
  NOOP_LOGGER,
  suppressSecondaryRejection,
  unref,
} from "@clarvis/capability";
import type { Logger } from "@clarvis/capability";
import type { SteerMessage } from "@clarvis/capability";
import type { TraceEntry } from "@clarvis/capability";
import type { TraceEvent } from "@clarvis/capability";
import { createAgentBuffer, type AgentBuffer } from "./buffer.ts";
import { mintAgentId } from "./ids.ts";
import {
  AGENTS_MAX_LIVE_CHILDREN,
  AGENTS_MAX_RETAINED_CHILDREN,
  AGENTS_MAX_TOTAL_BUFFER_BYTES,
} from "./settings.ts";
import {
  fromTraceEntry,
  fromTraceEvent,
  projectAgentEvent,
  waitAgeSeconds,
  type ProjectionState,
} from "./projection.ts";
import type {
  AgentControl,
  AgentHandle,
  AgentKind,
  AgentRegistration,
  AgentRegistryPort,
  AgentSettlement,
  AgentStatus,
  SettledStatus,
  WaitingOn,
} from "@clarvis/capability";

/** The effective per-run bounds the registry enforces. */
export interface AgentsLimits {
  bufferLines: number;
  bufferBytes: number;
  /** Aggregate retained activity-buffer payload across all child records. */
  maxTotalBufferBytes: number;
  pollMaxBytes: number;
  awaitTimeoutMs: number;
  /** Ceiling on children alive at once; a spawn past it is refused, not queued. */
  maxLiveChildren: number;
  /** How many settled children keep their buffer before the oldest is evicted. */
  maxRetainedChildren: number;
  /** Cap on inbox notices delivered in one iteration. */
  maxNoticesPerIteration: number;
  /** Consecutive failed children before the run is terminated for it. */
  maxConsecutiveFailedChildren: number;
  /** How many times finishing with live children is nudged before terminating. */
  finishNudges: number;
}

/** One row of `agent_list`. */
export interface AgentListEntry {
  id: string;
  kind: AgentKind;
  native_id: string;
  profile?: string;
  title: string;
  status: AgentStatus;
  started_at: number;
  iterations: number;
  tokens: number;
  waiting_on: WaitingOn;
  waiting_for_s?: number;
  last_activity_ms: number;
}

/** The body of an `agent_poll`. */
export interface AgentPollResult {
  id: string;
  running: boolean;
  status: AgentStatus;
  output: string;
  next_offset: number;
  truncated_head: number;
  result: string | null;
}

/** The body of an `agent_stop`. */
export interface AgentStopResult {
  id: string;
  status: AgentStatus;
  tail: string;
  iterations: number;
  tokens: number;
  already_settled: boolean;
}

/** A registry notice bound for the model's inbox at the next iteration top. */
export interface AgentNotice {
  text: string;
  /** Whether this notice is evidence the turn made progress. A settle that
   * *succeeded* is; a failure or a still-waiting report is not, or a child that
   * keeps failing would keep a doomed run alive forever. */
  progress: boolean;
}

/** What `waitAny` resolved with. */
export interface AgentSettledInfo {
  id: string;
  status: SettledStatus;
  result?: string;
}

/** A pending `waitAny`, disposable so a lost race leaves no waiter behind. */
export interface AgentWait {
  promise: Promise<AgentSettledInfo>;
  dispose(): void;
}

/** Raised when a wait names a child the registry does not track. */
export class UnknownAgentError extends CodedError {
  readonly code = "unknown_agent" as const;

  constructor(id: string) {
    super(`Unknown agent id '${id}'.`, { agent_id: id });
  }
}

/** What teardown had to abandon, for the run's usage warnings. */
export interface AgentTeardownReport {
  abandoned: string[];
  undrainedSteers: number;
}

/** Construction options. */
export interface AgentRegistryOptions {
  limits: AgentsLimits;
  logger?: Logger;
  /** Called on every ingested line. The orchestrator pokes the compute clock
   * here: a leader's events land on the leader's own trace and would otherwise
   * never reach the manager's stall watchdog, timing out a healthy fan-out. */
  onActivity?: () => void;
  /** Internal deterministic-test seam; production uses an unref'ed host timer. */
  scheduleTimeout?: (callback: () => void, delayMs: number) => () => void;
}

/** The full registry: the producer port plus everything the tools read. */
export interface AgentRegistry extends AgentRegistryPort {
  list(): AgentListEntry[];
  has(id: string): boolean;
  poll(id: string, opts: { offset?: number; match?: RegExp }): AgentPollResult | null;
  stop(id: string, reason: string): AgentStopResult | null;
  steer(id: string, message: SteerMessage): { ok: boolean; status: AgentStatus } | null;
  waitAny(ids?: readonly string[]): AgentWait;
  liveIds(): string[];
  /** Route one of the run's own trace entries to the child that produced it. */
  ingestTraceEntry(entry: TraceEntry): void;
  /** Take and clear the queued inbox notices, capped per iteration. */
  takeNotices(): AgentNotice[];
  /** True once a child failed `maxConsecutiveFailedChildren` times in a row. */
  failingStreakExceeded(): boolean;
  /** Refuse further registrations; the run is finishing. */
  seal(): void;
  sealed(): boolean;
  /** Abort every live child and wait, bounded, for the adopted tasks. */
  teardown(graceMs: number): Promise<AgentTeardownReport>;
}

/** Everything the registry holds about one child. */
interface ChildRecord {
  id: string;
  kind: AgentKind;
  nativeId: string;
  title: string;
  profile?: string;
  status: AgentStatus;
  waitingOn: WaitingOn;
  startedAt: number;
  lastActivityAt: number;
  iterations: number;
  tokens: number;
  result: string | null;
  buffer: AgentBuffer;
  projection: ProjectionState;
  control: AgentControl;
  task?: Promise<unknown>;
}

const TAIL_BYTES = 2048;

/**
 * Create a run-scoped {@link AgentRegistry}.
 */
export function createAgentRegistry(opts: AgentRegistryOptions): AgentRegistry {
  const { limits } = opts;
  const logger = opts.logger ?? NOOP_LOGGER;
  const nonnegativeIntAtMost = (value: number, max: number): number =>
    Number.isFinite(value) ? Math.min(max, Math.max(0, Math.floor(value))) : max;
  // Programmatic test/host callers historically use zero to close admission
  // completely even though settings require a positive live ceiling.
  const maxLiveChildren = nonnegativeIntAtMost(limits.maxLiveChildren, AGENTS_MAX_LIVE_CHILDREN);
  const maxRetainedChildren = Math.max(
    1,
    nonnegativeIntAtMost(limits.maxRetainedChildren, AGENTS_MAX_RETAINED_CHILDREN),
  );
  const maxTotalBufferBytes = Number.isFinite(limits.maxTotalBufferBytes)
    ? Math.min(AGENTS_MAX_TOTAL_BUFFER_BYTES, Math.max(0, Math.floor(limits.maxTotalBufferBytes)))
    : AGENTS_MAX_TOTAL_BUFFER_BYTES;
  const configuredBufferBytes = Number.isFinite(limits.bufferBytes)
    ? Math.max(0, Math.floor(limits.bufferBytes))
    : 0;
  // A record retains its buffer after settlement, so reserve for both the live
  // and retained ceilings. This fixed per-child slice makes the aggregate
  // invariant independent of settlement/registration ordering.
  const bufferBytesPerChild = Math.min(
    configuredBufferBytes,
    Math.floor(maxTotalBufferBytes / (maxLiveChildren + maxRetainedChildren)),
  );
  const records = new Map<string, ChildRecord>();
  const byNative = new Map<string, string>();
  const order: string[] = [];
  const tasks = new Set<Promise<unknown>>();
  const waiters = new Set<(info: AgentSettledInfo) => void>();
  let notices: AgentNotice[] = [];
  let consecutiveFailures = 0;
  let isSealed = false;

  const scheduleTimeout =
    opts.scheduleTimeout ??
    ((callback: () => void, delayMs: number): (() => void) => {
      const timer = setTimeout(callback, delayMs);
      unref(timer);
      return () => clearTimeout(timer);
    });

  const isLive = (r: ChildRecord): boolean => r.status === "running" || r.status === "waiting";

  /**
   * Report a registration the registry turned away.
   *
   * @param nativeId - the producer's own id for the child that was refused.
   * @param reason - `sealed` when the run is finishing, `at_capacity` when the
   *   live ceiling is already met.
   * @param live - children alive at the moment of the refusal.
   * @remarks The capacity arm matters more than the sealed one: a fan-out that
   *   silently serializes because it keeps hitting the ceiling is
   *   indistinguishable, from the outside, from one that chose to run its
   *   children one at a time.
   */
  const logSpawnRefused = (
    nativeId: string,
    reason: "sealed" | "at_capacity",
    live: number,
  ): void => {
    logger.debug(
      {
        event: "agents.spawn_refused",
        native_id: nativeId,
        reason,
        live,
        max_live_children: maxLiveChildren,
      },
      "a child registration was refused; the producer answers its caller without an agent handle",
    );
  };

  /**
   * Report a steer the child never received.
   *
   * @param agentId - the child the steer was addressed to.
   * @param status - the child's status at the moment it was refused.
   */
  const logSteerRefused = (agentId: string, status: AgentStatus): void => {
    logger.debug(
      { event: "agents.steer_refused", agent_id: agentId, status },
      "a steer was not delivered to the child; the parent is told, and the message is dropped",
    );
  };

  /**
   * Report a control port that threw while stopping a child.
   *
   * @param agentId - the child whose port threw.
   * @param phase - `stop` for an explicit `agent_stop`, `teardown` for the
   *   run's own shutdown sweep.
   * @param err - whatever the port threw.
   * @remarks The child is settled either way; a port that cannot be reached is
   *   not a reason to leave a record live forever.
   */
  const logStopPortThrew = (agentId: string, phase: "stop" | "teardown", err: unknown): void => {
    logger.debug(
      {
        event: "agents.stop_port_threw",
        agent_id: agentId,
        phase,
        cause: err instanceof Error ? err.message : String(err),
      },
      "a child's stop port threw; the child is settled regardless",
    );
  };

  const touch = (r: ChildRecord): void => {
    r.lastActivityAt = Date.now();
    opts.onActivity?.();
  };

  const evictRetained = (): void => {
    const settled = order.filter((id) => {
      const r = records.get(id);
      return r !== undefined && !isLive(r);
    });
    let excess = settled.length - maxRetainedChildren;
    for (const id of settled) {
      if (excess <= 0) break;
      const r = records.get(id);
      if (r === undefined) continue;
      records.delete(id);
      byNative.delete(r.nativeId);
      const at = order.indexOf(id);
      if (at !== -1) order.splice(at, 1);
      excess -= 1;
    }
  };

  const appendLine = (r: ChildRecord, line: string | null): void => {
    if (line === null) return;
    r.buffer.append(line);
    touch(r);
  };

  const noticeLabel = (r: ChildRecord): string =>
    `${r.id} (${r.kind} ${JSON.stringify(r.title.slice(0, 60))})`;

  const settle = (r: ChildRecord, s: AgentSettlement): void => {
    if (!isLive(r)) return;
    r.status = s.status;
    r.waitingOn = null;
    r.result = s.result ?? null;
    if (s.iterations !== undefined) r.iterations = s.iterations;
    if (s.tokens !== undefined) r.tokens = s.tokens;
    r.lastActivityAt = Date.now();

    if (s.status === "completed") consecutiveFailures = 0;
    else if (s.status === "failed") consecutiveFailures += 1;

    const outcome = s.result === undefined ? "" : `: ${s.result.slice(0, 400)}`;
    notices.push({
      text: `[agents] ${noticeLabel(r)} ${s.status}${outcome}`,
      progress: s.status === "completed",
    });

    for (const wake of [...waiters]) {
      waiters.delete(wake);
      wake({ id: r.id, status: s.status, ...(s.result !== undefined ? { result: s.result } : {}) });
    }
    evictRetained();
  };

  const handleFor = (r: ChildRecord): AgentHandle => ({
    id: r.id,
    ingest(event: TraceEvent): void {
      appendLine(r, projectAgentEvent(fromTraceEvent(event), r.projection, Date.now()));
      if (
        isBuiltinTraceEvent(event) &&
        (event.type === "subagent_iteration" || event.type === "lead_iteration")
      ) {
        r.iterations = Math.max(r.iterations, event.iteration);
        r.tokens += event.input_tokens + event.output_tokens;
      }
    },
    waiting(on: WaitingOn): void {
      if (!isLive(r)) return;
      r.status = on === null ? "running" : "waiting";
      r.waitingOn = on;
      if (on === null) r.projection.waitingSince = undefined;
      touch(r);
    },
    settled(s: AgentSettlement): void {
      settle(r, s);
    },
  });

  return {
    register(registration: AgentRegistration): AgentHandle | null {
      const live = [...records.values()].filter(isLive).length;
      if (isSealed) {
        logSpawnRefused(registration.nativeId, "sealed", live);
        return null;
      }
      if (live >= maxLiveChildren) {
        logSpawnRefused(registration.nativeId, "at_capacity", live);
        return null;
      }
      const id = mintAgentId(new Set(records.keys()));
      const now = Date.now();
      const record: ChildRecord = {
        id,
        kind: registration.kind,
        nativeId: registration.nativeId,
        title: registration.title,
        ...(registration.profile !== undefined ? { profile: registration.profile } : {}),
        status: "running",
        waitingOn: null,
        startedAt: now,
        lastActivityAt: now,
        iterations: 0,
        tokens: 0,
        result: null,
        buffer: createAgentBuffer({
          maxLines: limits.bufferLines,
          maxBytes: bufferBytesPerChild,
        }),
        projection: {},
        control: registration.control,
      };
      records.set(id, record);
      byNative.set(registration.nativeId, id);
      order.push(id);
      return handleFor(record);
    },

    adopt(id: string, task: Promise<unknown>): void {
      const record = records.get(id);
      const tracked = task.catch((err: unknown) => {
        logger.debug(
          { agent_id: id, err: err instanceof Error ? err.message : String(err) },
          "agents: background child task rejected",
        );
      });
      if (record !== undefined) record.task = tracked;
      tasks.add(tracked);
      suppressSecondaryRejection(
        tracked.finally(() => tasks.delete(tracked)),
        "the tracked task catch/logger channel",
      );
    },

    liveCount: () => [...records.values()].filter(isLive).length,
    liveIds: () => [...records.values()].filter(isLive).map((r) => r.id),
    has: (id) => records.has(id),
    sealed: () => isSealed,

    list(): AgentListEntry[] {
      const now = Date.now();
      return order.flatMap((id) => {
        const r = records.get(id);
        if (r === undefined) return [];
        const waitingFor = waitAgeSeconds(r.projection, now);
        return [
          {
            id: r.id,
            kind: r.kind,
            native_id: r.nativeId,
            ...(r.profile !== undefined ? { profile: r.profile } : {}),
            title: r.title,
            status: r.status,
            started_at: r.startedAt,
            iterations: r.iterations,
            tokens: r.tokens,
            waiting_on: r.waitingOn,
            ...(r.waitingOn !== null && waitingFor !== undefined
              ? { waiting_for_s: waitingFor }
              : {}),
            last_activity_ms: now - r.lastActivityAt,
          },
        ];
      });
    },

    poll(id, pollOpts): AgentPollResult | null {
      const r = records.get(id);
      if (r === undefined) return null;
      const read = r.buffer.read(
        pollOpts.offset ?? 0,
        limits.pollMaxBytes,
        pollOpts.match ?? undefined,
      );
      const marker = read.more
        ? `\n[... more output buffered; continue with offset=${String(read.nextOffset)} ...]`
        : "";
      return {
        id: r.id,
        running: isLive(r),
        status: r.status,
        output: read.text + marker,
        next_offset: read.nextOffset,
        truncated_head: read.truncatedHead,
        result: r.result,
      };
    },

    stop(id, reason): AgentStopResult | null {
      const r = records.get(id);
      if (r === undefined) return null;
      const already = !isLive(r);
      if (!already) {
        try {
          r.control.stop(reason);
        } catch (err) {
          logStopPortThrew(r.id, "stop", err);
        }
        settle(r, { status: "stopped", result: `stopped by parent: ${reason}` });
      }
      const tail = r.buffer.read(Math.max(0, r.buffer.tail() - TAIL_BYTES), TAIL_BYTES);
      return {
        id: r.id,
        status: r.status,
        tail: tail.text,
        iterations: r.iterations,
        tokens: r.tokens,
        already_settled: already,
      };
    },

    steer(id, message): { ok: boolean; status: AgentStatus } | null {
      const r = records.get(id);
      if (r === undefined) return null;
      if (!isLive(r)) {
        logSteerRefused(r.id, r.status);
        return { ok: false, status: r.status };
      }
      const ok = r.control.steer(message);
      if (ok) touch(r);
      else logSteerRefused(r.id, r.status);
      return { ok, status: r.status };
    },

    waitAny(ids): AgentWait {
      if (ids !== undefined) {
        for (const id of ids) {
          if (!records.has(id)) {
            return { promise: Promise.reject(new UnknownAgentError(id)), dispose() {} };
          }
        }
        for (const id of ids) {
          const record = records.get(id)!;
          if (!isLive(record)) {
            return {
              promise: Promise.resolve({
                id: record.id,
                status: record.status as SettledStatus,
                ...(record.result !== null ? { result: record.result } : {}),
              }),
              dispose() {},
            };
          }
        }
      }
      const scope = ids === undefined ? undefined : new Set(ids);
      let wake: ((info: AgentSettledInfo) => void) | undefined;
      const promise = new Promise<AgentSettledInfo>((resolve) => {
        const listener = (info: AgentSettledInfo): void => {
          if (scope !== undefined && !scope.has(info.id)) {
            waiters.add(listener);
            return;
          }
          resolve(info);
        };
        wake = listener;
        waiters.add(listener);
      });
      return {
        promise,
        dispose(): void {
          if (wake !== undefined) waiters.delete(wake);
        },
      };
    },

    ingestTraceEntry(entry: TraceEntry): void {
      const detail = entry.detail as { subagent_instance_id?: unknown } | null;
      const native =
        detail !== null && typeof detail.subagent_instance_id === "string"
          ? detail.subagent_instance_id
          : undefined;
      if (native === undefined) return;
      const id = byNative.get(native);
      if (id === undefined) return;
      const r = records.get(id);
      if (r === undefined) return;
      appendLine(r, projectAgentEvent(fromTraceEntry(entry), r.projection, Date.now()));
      if (isBuiltinTraceEntry(entry) && entry.kind === "subagent_iteration") {
        r.iterations = Math.max(r.iterations, entry.detail.iteration);
        r.tokens += entry.detail.input_tokens + entry.detail.output_tokens;
      }
    },

    takeNotices(): AgentNotice[] {
      const cap = Math.max(1, limits.maxNoticesPerIteration);
      if (notices.length <= cap) {
        const out = notices;
        notices = [];
        return out;
      }
      const shown = notices.slice(0, cap);
      const hidden = notices.length - cap;
      notices = [];
      return [
        ...shown,
        {
          text: `[agents] +${String(hidden)} more child updates this turn; call agent_list to see them all.`,
          progress: false,
        },
      ];
    },

    failingStreakExceeded: () =>
      limits.maxConsecutiveFailedChildren > 0 &&
      consecutiveFailures >= limits.maxConsecutiveFailedChildren,

    seal(): void {
      isSealed = true;
    },

    async teardown(graceMs): Promise<AgentTeardownReport> {
      isSealed = true;
      const abandoned: string[] = [];
      const taskCount = tasks.size;
      for (const r of records.values()) {
        if (!isLive(r)) continue;
        try {
          r.control.stop("the run is finishing");
        } catch (err) {
          logStopPortThrew(r.id, "teardown", err);
        }
      }
      if (tasks.size > 0) {
        let cancelGrace: (() => void) | undefined;
        const grace = new Promise<void>((resolve) => {
          cancelGrace = scheduleTimeout(resolve, Math.max(0, graceMs));
        });
        try {
          await Promise.race([Promise.allSettled([...tasks]), grace]);
        } finally {
          cancelGrace?.();
        }
      }
      let undrainedSteers = 0;
      for (const r of records.values()) {
        undrainedSteers += r.control.undrained?.() ?? 0;
        if (isLive(r)) {
          abandoned.push(r.id);
          settle(r, { status: "cancelled", result: "abandoned when the run finished" });
        }
        r.buffer.freeze();
      }
      notices = [];
      for (const w of waiters) waiters.delete(w);
      if (abandoned.length > 0 || undrainedSteers > 0) {
        logger.warn(
          {
            event: "agents.teardown_abandoned",
            abandoned,
            undrained_steers: undrainedSteers,
            grace_ms: graceMs,
            tasks: taskCount,
          },
          "the run finished on top of live children; they were cancelled and any queued steer was dropped",
        );
      }
      return { abandoned, undrainedSteers };
    },
  };
}
