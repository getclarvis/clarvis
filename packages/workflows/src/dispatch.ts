/**
 * The shared background-dispatch session every scheduled tool runs on.
 *
 * @remarks Both `run_work_items` and `run_round` start batches of leaders that
 * outlive the tool call that asked for them, and both must keep one invariant the
 * loop does not state anywhere near here: the finish gate accepts a lone
 * `submit_result` whenever `liveCount() === 0`
 * (`loop/src/runtime/capabilities/agents.ts`), so a driver whose live-child count
 * touches zero between batches lets the manager finish on top of a half-run
 * graph — and the `registry.seal()` that follows then refuses every remaining
 * registration silently.
 *
 * The session therefore carries a **baton**: the last handle of a finished batch
 * is held unsettled until the next batch has registered — and only when that
 * batch actually got a handle, or a refused registration would release it into
 * the same hole.
 *
 * {@link runOne} never rejects, either. Everything from the first trace record
 * onwards is inside one `try`/`finally`, so a fault — a throwing trace sink, a
 * handle that raises on settle — settles that unit as failed and releases its
 * semaphore permit and ledger reservation, rather than escaping into a
 * `Promise.all` that would abandon the whole batch mid-flight. Peak overlap against the
 * live-child ceiling is exactly one handle. Getting that wrong once is a silent
 * defect, which is why there is one implementation of it rather than two.
 *
 * A batch is **larger than the registry**, routinely: a round's unit count is
 * `items × fanout`, which reaches the hundreds, while the live-child ceiling is
 * a couple of dozen. The units the registry has no room for are therefore
 * **queued**, not dropped — {@link DispatchSession.run} registers and starts one
 * from the backlog each time a unit settles, so the semaphore stays saturated and
 * the batch's outcome count always equals its unit count. Dropping them was a
 * silent defect of exactly the kind this module exists to prevent: an audit
 * round asking for fifteen verifiers got seven, and the eight missing verdicts
 * were folded into {@link import("./rounds.ts").applyAccept}'s denominator as
 * "unavailable" — which is how an unverified finding comes to look like one that
 * survived verification.
 */
import type {
  AgentBuildContext,
  AgentRegistryPort,
  ComputeClock,
  ComputeRegion,
  Logger,
  Sampler,
} from "@clarvis/capability";
import { bind, createSampler, levelEnabled } from "@clarvis/capability";
import { registerBackgroundChild } from "@clarvis/supervision";
import type { BackgroundChildSpawn } from "@clarvis/supervision";
import { faultFields, outputTokensOf, withBoundLogger, workflowLogger } from "./log.ts";
import { describeLeaderResult } from "./result-text.ts";
import {
  recordWorkflowTrace,
  WORKFLOW_RUN_COMPLETED_TRACE_KIND,
  WORKFLOW_RUN_FAILED_TRACE_KIND,
  WORKFLOW_RUN_STARTED_TRACE_KIND,
} from "./trace-events.ts";
import { runLeader } from "./run-leader.ts";
import type { WorkflowCtx } from "./types.ts";

/** One leader a caller wants started. */
export interface DispatchUnit {
  /** Caller-side identity, echoed back on the outcome. */
  key: string;
  /** What the supervision tools show for this child. */
  title: string;
  /** The leader's full brief. */
  brief: string;
  profile?: string;
  expectSchema?: Record<string, unknown>;
  /** Authored round identity for human grouping in workflow monitors. */
  roundId?: string;
  /** Zero for the initial sequence, then one-based for repeat passes. */
  pass?: number;
  /** Zero-based item position selected by the round. */
  itemIndex?: number;
  /** Zero-based replica position for this item. */
  replica?: number;
  replicaCount?: number;
}

/** How one dispatched unit ended. */
export type DispatchStatus =
  "completed" | "failed" | "cancelled" | "blocked" | "budget_exhausted" | "unregistered";

/** The outcome of one unit, including the leader's structured result. */
export interface DispatchOutcome {
  key: string;
  status: DispatchStatus;
  /** The leader's own result — structured when `expectSchema` was set. */
  result: unknown;
}

/** The engine seams a session needs. */
export interface DispatchDeps {
  ctx: WorkflowCtx;
  bc: AgentBuildContext;
  clock: ComputeClock | undefined;
  agents: AgentRegistryPort;
  /**
   * Wall clock for the capacity-stall report, defaulting to `Date.now`.
   *
   * @remarks Injectable only so a test can observe the stall report without
   * spending the five seconds the real backoff takes to reach it. Nothing in
   * the dispatch's behaviour depends on it.
   */
  now?: () => number;
}

/** A decision to skip a unit before it costs anything, with the reason why. */
export type DispatchGate = (unit: DispatchUnit) => { blocked: string } | null;

/** Settle one handle; the final call also carries the batch summary. */
type Settle = (summary?: string) => void;

/** A registered unit, or one an already-aborted run will never start. */
interface Registered {
  unit: DispatchUnit;
  runId: string;
  spawn: BackgroundChildSpawn | null;
}

/**
 * One batch, split by what the registry could admit right now.
 *
 * @remarks `backlog` preserves the tail of the caller's order: registration stops
 * at the first refusal rather than skipping ahead, so `entries` followed by
 * `backlog` is the batch as the caller wrote it.
 */
interface Batch {
  entries: Registered[];
  backlog: DispatchUnit[];
}

/** An empty batch, for the window between {@link DispatchSession.run} calls. */
function emptyBatch(): Batch {
  return { entries: [], backlog: [] };
}

/**
 * A live dispatch: batches of leaders started in the background, with the baton
 * held across every batch boundary.
 */
export interface DispatchSession {
  /** The handle the driver task should be adopted against. */
  readonly anchorId: string;
  /** The agent handle ids of the batch registered but not yet run, by unit key. */
  pendingHandles(): ReadonlyMap<string, string>;
  /**
   * How many of the pending batch are queued behind the live-child ceiling.
   *
   * @remarks Reported to the model beside {@link DispatchSession.pendingHandles},
   *   because a plan naming three running leaders out of fifteen units reads as
   *   "the other twelve were skipped" — which is what the caller should be able
   *   to rule out without counting handles.
   */
  queuedCount(): number;
  /**
   * Run the whole pending batch to completion, queued units included.
   *
   * @returns one outcome per unit the batch carried, in the caller's order.
   * @remarks Queued units are registered as slots free, so this resolves only
   *   once the backlog has drained. Slots held by children *outside* this batch
   *   are waited on rather than treated as a refusal, so a manager holding
   *   background sub-agents delays a queued unit instead of losing it. A unit is
   *   reported `unregistered` only when no slot can ever free for it — the
   *   registry is sealed, or this batch's own baton is all that is live. A unit
   *   still queued when the dispatch is cancelled is reported `cancelled` rather
   *   than started: a deliberate stop must reduce work, and the queue is where
   *   the work not yet paid for sits.
   */
  run(gate?: DispatchGate): Promise<DispatchOutcome[]>;
  /** True once a leader in this automatic dispatch was explicitly cancelled. */
  cancelled(): boolean;
  /**
   * Register the next batch, then release the previous batch's baton.
   *
   * @remarks The baton is released **only** when the new batch actually got a
   * handle. A batch the registry refused outright (sealed, or at
   * `maxLiveChildren`) would otherwise settle the previous one and let the live
   * count reach zero with rounds still pending — the exact hole the baton
   * exists to close.
   */
  advance(units: readonly DispatchUnit[]): void;
  /** Release the final baton, letting the live-child count reach zero. */
  end(summary: string): void;
}

/**
 * Begin a dispatch by registering its first batch.
 *
 * @returns the session, or `null` when the registry had no room for a single one
 *   of the first batch's units — which is the caller's cue to refuse outright
 *   rather than start something it cannot finish.
 */
export function beginDispatch(
  deps: DispatchDeps,
  first: readonly DispatchUnit[],
): DispatchSession | null {
  const rootLogger = workflowLogger(deps.ctx);
  let pending = register(deps, first);
  const anchor = pending.entries.find(
    (entry): entry is Registered & { spawn: BackgroundChildSpawn } => entry.spawn !== null,
  );
  if (anchor === undefined) {
    const live = deps.agents.liveCount();
    rootLogger.warn(
      {
        event: "workflow.dispatch_refused",
        units: first.length,
        live_children: live,
        sealed: live === 0,
      },
      "the supervision registry admitted none of this batch, so the tool refuses outright rather than starting work it cannot finish",
    );
    return null;
  }
  const logger = bind(rootLogger, { dispatch_id: anchor.spawn.handle.id });
  logger.info(
    {
      event: "workflow.dispatch_begun",
      units: first.length,
      registered: pending.entries.filter((entry) => entry.spawn !== null).length,
      queued: pending.backlog.length,
      max_concurrency: deps.ctx.maxConcurrency,
      budget_tokens: deps.ctx.ledger.total,
      live_children: deps.agents.liveCount(),
    },
    "a batch of leaders was registered; anything queued starts as slots free rather than being dropped",
  );
  const sample = createSampler();
  const wait: CapacityWait = { since: 0, stalled: false };

  let baton: Settle | undefined;
  const budget = { exhausted: false };
  let cancellationObserved = false;
  const stopped = (): boolean => cancellationObserved || deps.ctx.signal.aborted;

  return {
    anchorId: anchor.spawn.handle.id,
    pendingHandles(): ReadonlyMap<string, string> {
      const ids = new Map<string, string>();
      for (const entry of pending.entries) {
        if (entry.spawn !== null) ids.set(entry.unit.key, entry.spawn.handle.id);
      }
      return ids;
    },
    queuedCount: () => pending.backlog.length,
    async run(gate?: DispatchGate): Promise<DispatchOutcome[]> {
      const batch = pending;
      pending = emptyBatch();
      const backlog = [...batch.backlog];
      const outcomes: DispatchOutcome[] = [];
      let outstanding = batch.entries.filter((entry) => entry.spawn !== null).length;
      let held: Settle | undefined;
      /**
       * Settle a unit's handle, or hold it back as this batch's baton.
       *
       * @remarks Settling on the spot is what frees the registry slot the next
       * queued unit needs, so a unit holds its handle back only when it is the
       * batch's last live one. `outstanding` is decremented here rather than
       * when the task resolves a microtask later: two units completing in the
       * same tick would otherwise both read the pre-decrement count, both
       * settle, and let the live-child count touch zero with work still queued.
       */
      const finish = (settle: Settle): void => {
        outstanding -= 1;
        if (outstanding > 0) {
          settle();
          return;
        }
        held?.();
        held = settle;
      };
      const tasks: Promise<void>[] = [];
      let slot = 0;
      const start = (entry: Registered): void => {
        const at = slot;
        slot += 1;
        tasks.push(
          runOne(deps, entry, gate, budget, finish, logger).then((outcome) => {
            outcomes[at] = outcome;
            if (outcome.status === "cancelled") cancellationObserved = true;
            pump();
          }),
        );
      };
      /**
       * Start as much of the backlog as the registry will now admit.
       *
       * @remarks A settled unit freed both a semaphore permit and a registry
       * slot, so the next queued unit can take them; registration is what paces
       * this, refusing while the registry is still full so the next settlement
       * retries. The order inside the loop is load-bearing: the replacement is
       * registered before the held handle is released, so the live-child count
       * has no window at zero, and it is released before the unit starts
       * because a unit the gate blocks settles synchronously and would
       * otherwise overwrite it.
       */
      const pump = (): void => {
        while (backlog.length > 0 && !stopped()) {
          const entry = registerOne(deps, backlog[0]!);
          if (entry === null) return;
          backlog.shift();
          outstanding += 1;
          held?.();
          held = undefined;
          start(entry);
        }
      };

      for (const entry of batch.entries) start(entry);
      pump();
      /**
       * How many of `tasks` have already been joined.
       *
       * @remarks `pump` is edge-triggered on this batch's own settlements, so
       * once every unit it started has finished it can no longer retry itself.
       * The backlog is not necessarily empty at that point: the registry
       * ceiling counts *every* live child, so background `delegate_task`
       * sub-agents and ad-hoc `run_leader` handles outside this batch can hold
       * it full. Waiting on them and retrying is what makes a refusal mean
       * "not yet"; treating it as terminal here is what dropped a backlog
       * outright.
       */
      let awaited = 0;
      let attempt = 0;
      for (;;) {
        if (awaited < tasks.length) {
          const inFlight = tasks.slice(awaited);
          awaited = tasks.length;
          await Promise.all(inFlight);
          continue;
        }
        if (backlog.length === 0 || stopped()) break;
        /**
         * Live children this dispatch still accounts for.
         *
         * @remarks Both batons count as ours: this batch's held handle, and the
         * previous batch's, which `advance` releases only once a new batch
         * registers. A dispatch that counted only the first waited on its own
         * handle to settle — which nothing but this loop could ever do.
         */
        const oursLive = (held === undefined ? 0 : 1) + (baton === undefined ? 0 : 1);
        const waiting = await waitForCapacity(deps, oursLive, attempt, backlog.length, {
          logger,
          sample,
          wait,
        });
        if (!waiting) break;
        const queued = backlog.length;
        pump();
        attempt = backlog.length < queued ? 0 : attempt + 1;
      }
      for (const unit of backlog) {
        outcomes[slot] = {
          key: unit.key,
          status: stopped() ? "cancelled" : "unregistered",
          result: undefined,
        };
        slot += 1;
      }
      if (held !== undefined) baton = held;
      return outcomes;
    },
    cancelled: () => cancellationObserved,
    /**
     * @remarks A deliberate stop is a control-plane intervention. Do not answer
     * it by silently scheduling the next wave or repeat pass; the manager can
     * start more work explicitly if that is still wanted.
     */
    advance(units: readonly DispatchUnit[]): void {
      if (stopped()) {
        logger.warn(
          {
            event: "workflow.dispatch_halted",
            reason: "cancelled",
            queued_dropped: units.length + pending.backlog.length,
          },
          "a leader in this dispatch was cancelled, so no later wave or repeat pass is scheduled and the units named here never start",
        );
        pending = emptyBatch();
        return;
      }
      const next = register(deps, units);
      const registered = next.entries.filter((entry) => entry.spawn !== null).length;
      const batonReleased = registered > 0;
      if (batonReleased) {
        baton?.();
        baton = undefined;
      }
      pending = next;
      if (!levelEnabled(logger, "debug")) return;
      logger.debug(
        {
          event: "workflow.wave_advanced",
          ...(units[0]?.roundId === undefined ? {} : { round_id: units[0].roundId }),
          ...(units[0]?.pass === undefined ? {} : { pass: units[0].pass }),
          units: units.length,
          registered,
          queued: next.backlog.length,
          baton_released: batonReleased,
        },
        "the next wave registered; the previous wave's baton is released only when this one actually got a handle, or the live-child count would touch zero mid-graph",
      );
    },
    end(summary: string): void {
      baton?.(summary);
      baton = undefined;
    },
  };
}

/**
 * Render the queued tail of a batch for the plan text a tool answers with.
 *
 * @param queued - {@link DispatchSession.queuedCount} at the moment of the answer.
 * @returns a leading-space sentence, or the empty string when nothing is queued.
 * @remarks Named rather than inlined twice because it is the only thing telling
 *   the manager that the units missing from the plan's handle list are waiting
 *   rather than skipped — and a manager that concludes "skipped" re-dispatches
 *   them.
 */
export function describeQueued(queued: number): string {
  if (queued <= 0) return "";
  return ` ${String(queued)} more are queued and start as slots free — they need no action from you.`;
}

/**
 * Claim a registry handle for as much of one batch as the registry will admit.
 *
 * @remarks Registration stops at the first refusal instead of probing further:
 * the ceiling is a count, so a unit the registry refused means every later one
 * would be refused too, and skipping ahead would only scramble the caller's
 * order. On an already-aborted run every unit is admitted as an unregistered
 * entry rather than queued, so {@link beginDispatch} still refuses outright
 * instead of returning a session whose queue can never drain.
 */
function register(deps: DispatchDeps, units: readonly DispatchUnit[]): Batch {
  const batch = emptyBatch();
  let full = false;
  for (const unit of units) {
    if (deps.ctx.signal.aborted) {
      batch.entries.push({ unit, runId: deps.ctx.runDeps.generateExecutionId(), spawn: null });
      continue;
    }
    if (full) {
      batch.backlog.push(unit);
      continue;
    }
    const entry = registerOne(deps, unit);
    if (entry === null) {
      full = true;
      batch.backlog.push(unit);
      continue;
    }
    batch.entries.push(entry);
  }
  return batch;
}

/** First retry delay while waiting for a registry slot outside this batch. */
const CAPACITY_POLL_MS = 25;

/** Ceiling the retry delay backs off to, so a long-lived foreign child is cheap to wait on. */
const CAPACITY_POLL_MAX_MS = 500;

/**
 * Sleep, resolving early if the run is aborted.
 *
 * @remarks The listener is removed on both paths, so a dispatch that waits many
 * times over a long run does not accumulate abort listeners on the run signal.
 */
function delayOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** How long a deadline-free wait may run before it is reported once as a stall. */
const CAPACITY_STALL_MS = 5000;

/** The sampler key the capacity poll counts its own occurrences under. */
const CAPACITY_SAMPLE_KEY = "capacity";

/** One dispatch's memory of how long it has been waiting on a foreign child. */
interface CapacityWait {
  since: number;
  stalled: boolean;
}

/** The diagnostics one dispatch shares across every capacity poll it makes. */
interface CapacityLog {
  logger: Logger;
  sample: Sampler;
  wait: CapacityWait;
}

/**
 * Wait for a child outside this batch to free a registry slot.
 *
 * @param oursLive - live children this dispatch still accounts for: its own
 *   batons. Every unit it started has already settled by this point, so any
 *   remaining live child beyond these belongs to something else.
 * @param attempt - consecutive refusals so far, which sets the backoff.
 * @param queued - how much of the batch is still waiting to be registered.
 * @param log - the session's logger, sampler and stall memory.
 * @returns `true` when another registration attempt is worth making, `false`
 *   when the refusal is structural — the registry is sealed, or this batch's own
 *   baton is the only live child, so nothing can free a slot for it.
 * @remarks {@link AgentRegistryPort} publishes a live count and no settlement
 * signal, and widening that port is a contract change rather than a
 * convenience, so this polls. The wait is bounded by the run rather than by a
 * deadline of its own: it resolves the moment `ctx.signal` aborts, and the
 * manager's own run timeout ends the run underneath it. A deadline here would
 * only restore the silent drop under a different name.
 *
 * That absence of a deadline is exactly why it says so. A round of hundreds of
 * units behind a live-child ceiling, or one stuck `delegate_task`, is
 * indistinguishable from a hung manager from the outside. The per-poll record
 * is sampled, and one `info` names the stall after
 * {@link CAPACITY_STALL_MS} so the fact survives at a production level.
 */
async function waitForCapacity(
  deps: DispatchDeps,
  oursLive: number,
  attempt: number,
  queued: number,
  log: CapacityLog,
): Promise<boolean> {
  if (deps.ctx.signal.aborted) return false;
  const foreignLive = deps.agents.liveCount() - oursLive;
  if (foreignLive <= 0) return false;
  const delay = Math.min(CAPACITY_POLL_MAX_MS, CAPACITY_POLL_MS * 2 ** Math.min(attempt, 10));
  const now = deps.now ?? Date.now;
  if (attempt === 0) {
    log.wait.since = now();
    log.wait.stalled = false;
  }
  reportCapacityWait(log, {
    queued,
    attempt,
    delay,
    foreignLive,
    elapsed: now() - log.wait.since,
  });
  await delayOrAbort(delay, deps.ctx.signal);
  return !deps.ctx.signal.aborted;
}

/**
 * Say that this dispatch is parked, sampled, and once at `info` when it stalls.
 *
 * @param log - the session's logger, sampler and stall memory.
 * @param p - the poll's own numbers.
 * @remarks Split out so the sampling policy and the once-per-stall latch are one
 *   readable unit rather than five statements inside a polling loop.
 */
function reportCapacityWait(
  log: CapacityLog,
  p: { queued: number; attempt: number; delay: number; foreignLive: number; elapsed: number },
): void {
  const fields = {
    queued: p.queued,
    attempt: p.attempt,
    delay_ms: p.delay,
    foreign_live: p.foreignLive,
  };
  if (p.attempt === 0 || log.sample(CAPACITY_SAMPLE_KEY)) {
    log.logger.debug(
      { event: "workflow.capacity_wait", ...fields },
      "the queued tail of this batch is waiting on a child outside it to free a registry slot",
    );
  }
  if (log.wait.stalled || p.elapsed < CAPACITY_STALL_MS) return;
  log.wait.stalled = true;
  log.logger.info(
    { event: "workflow.capacity_stalled", ...fields, waited_ms: p.elapsed },
    "this batch has been waiting on foreign children for seconds with no deadline; a manager that looks hung is queued behind them, not stuck",
  );
}

/**
 * Register one unit as a background child.
 *
 * @returns the registered unit, or `null` when the registry is sealed or at its
 *   live-children ceiling — which is a "not yet", not a "never".
 */
function registerOne(deps: DispatchDeps, unit: DispatchUnit): Registered | null {
  const runId = deps.ctx.runDeps.generateExecutionId();
  const spawn = registerBackgroundChild(deps.agents, deps.bc.trace, {
    kind: "leader",
    nativeId: runId,
    title: unit.title,
    ...(unit.profile !== undefined ? { profile: unit.profile } : {}),
  });
  return spawn === null ? null : { unit, runId, spawn };
}

/**
 * Report one leader's terminal outcome at the level its status deserves.
 *
 * @param logger - the unit-scoped logger.
 * @param ok - whether the leader completed.
 * @param fields - the outcome's own numbers.
 * @remarks Deliberately thin against the durable trace, which already carries
 *   `workflow_run_completed` / `workflow_run_failed` and is what the user and
 *   the kernel read. What survives here is only what the edge omits — the
 *   metered output tokens and the wall time — and the fact that an operator
 *   grepping one `event` can see every leader of a fan-out in issue order.
 */
export function reportSettled(logger: Logger, ok: boolean, fields: Record<string, unknown>): void {
  const record = { event: "workflow.leader_settled", ...fields };
  if (ok) {
    logger.info(record, "a leader finished; its result is folded into the round it belongs to");
    return;
  }
  logger.warn(
    record,
    "a leader ended without completing; the round keeps it in the denominator rather than treating it as absent",
  );
}

/**
 * Run one registered unit, or record why it was never dispatched.
 *
 * @param sessionLogger - the dispatch-scoped logger; this narrows it to the unit
 *   and the leader run, and hands that narrowed logger down to the leader's own
 *   engine deps so everything the leader says is attributable to its wave.
 */
async function runOne(
  deps: DispatchDeps,
  entry: Registered,
  gate: DispatchGate | undefined,
  budget: { exhausted: boolean },
  finish: (settle: Settle) => void,
  sessionLogger: Logger,
): Promise<DispatchOutcome> {
  const { unit, runId, spawn } = entry;
  if (spawn === null) return { key: unit.key, status: "unregistered", result: undefined };

  const { handle, controller, steerQueue } = spawn;
  const correlation = {
    unit_key: unit.key,
    leader_run_id: runId,
    agent_id: handle.id,
    ...(unit.roundId === undefined ? {} : { round_id: unit.roundId }),
    ...(unit.pass === undefined ? {} : { pass: unit.pass }),
    ...(unit.itemIndex === undefined ? {} : { item_index: unit.itemIndex }),
    ...(unit.replica === undefined ? {} : { replica: unit.replica }),
  };
  const logger = bind(sessionLogger, correlation);
  const settleWith = (status: "completed" | "failed" | "stopped", text: string): Settle => {
    return (summary?: string): void => {
      handle.settled({ status, result: summary === undefined ? text : `${text}\n\n${summary}` });
      steerQueue.close();
    };
  };
  const skip = (status: DispatchStatus, text: string): DispatchOutcome => {
    finish(settleWith("failed", text));
    return { key: unit.key, status, result: undefined };
  };

  const blocked = gate?.(unit);
  if (blocked !== null && blocked !== undefined) {
    return skip("blocked", `'${unit.key}' was not run: ${blocked.blocked}`);
  }
  const exhausted = `'${unit.key}' was not run: the token budget was exhausted`;
  if (budget.exhausted) return skip("budget_exhausted", exhausted);
  const reservation = deps.ctx.ledger.reserve(deps.ctx.maxConcurrency);
  if (reservation === null) {
    budget.exhausted = true;
    deps.ctx.onBudgetExhausted?.();
    logger.warn(
      {
        event: "workflow.budget_exhausted",
        total: deps.ctx.ledger.total,
        spent: deps.ctx.ledger.spent(),
        at_unit: unit.key,
        max_concurrency: deps.ctx.maxConcurrency,
      },
      "the tree output-token ceiling left no headroom to reserve, so this unit and every later one in the batch are skipped unrun",
    );
    return skip("budget_exhausted", exhausted);
  }

  const unitCtx: WorkflowCtx = {
    ...deps.ctx,
    deps: withBoundLogger(deps.ctx.deps, correlation),
    signal: AbortSignal.any([deps.ctx.signal, controller.signal]),
    steerForLeader: (id) => (id === runId ? steerQueue : deps.ctx.steerForLeader?.(id)),
    onLeaderEvent: (id, event) => {
      if (id === runId) handle.ingest(event);
      deps.ctx.onLeaderEvent?.(id, event);
    },
  };

  try {
    await deps.ctx.semaphore.acquire(unitCtx.signal);
  } catch {
    reservation.release();
    finish(settleWith("stopped", `'${unit.key}' was cancelled while waiting for a slot`));
    return { key: unit.key, status: "cancelled", result: undefined };
  }

  if (unitCtx.signal.aborted) {
    reservation.release();
    deps.ctx.semaphore.release();
    finish(settleWith("stopped", `'${unit.key}' was cancelled before it started`));
    return { key: unit.key, status: "cancelled", result: undefined };
  }

  let region: ComputeRegion | undefined;
  try {
    recordWorkflowTrace(deps.bc.trace, WORKFLOW_RUN_STARTED_TRACE_KIND, {
      run_id: runId,
      parent_run_id: deps.ctx.managerRunId,
      title: unit.title,
      task: unit.brief,
      ...(unit.profile !== undefined ? { profile: unit.profile } : {}),
      ...(unit.roundId !== undefined ? { round_id: unit.roundId } : {}),
      ...(unit.pass !== undefined ? { pass: unit.pass } : {}),
      ...(unit.itemIndex !== undefined ? { item_index: unit.itemIndex } : {}),
      ...(unit.replica !== undefined ? { replica: unit.replica } : {}),
      ...(unit.replicaCount !== undefined ? { replica_count: unit.replicaCount } : {}),
    });
    region = deps.clock?.enterBackground();
    const result = await runLeader(
      {
        title: unit.title,
        prompt: unit.brief,
        ...(unit.profile !== undefined ? { profile: unit.profile } : {}),
        ...(unit.expectSchema !== undefined ? { expectSchema: unit.expectSchema } : {}),
      },
      unitCtx,
      runId,
      reservation,
    );
    const ok = result.status === "completed";
    const cancelled = result.status === "cancelled";
    reportSettled(logger, ok, {
      leader_run_id: runId,
      status: result.status,
      output_tokens: outputTokensOf(result.usage.by_agent),
      elapsed_ms: result.usage.elapsed_ms,
      ...(result.error === undefined ? {} : { error_code: result.error.code }),
    });
    recordWorkflowTrace(
      deps.bc.trace,
      ok ? WORKFLOW_RUN_COMPLETED_TRACE_KIND : WORKFLOW_RUN_FAILED_TRACE_KIND,
      {
        run_id: runId,
        parent_run_id: deps.ctx.managerRunId,
        status: result.status,
        ...(result.error !== undefined ? { error: result.error } : {}),
      },
    );
    finish(
      settleWith(
        ok ? "completed" : cancelled ? "stopped" : "failed",
        `'${unit.key}' ${result.status}: ${describeLeaderResult(result)}`,
      ),
    );
    return {
      key: unit.key,
      status: ok ? "completed" : cancelled ? "cancelled" : "failed",
      result: result.result,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { event: "workflow.leader_faulted", leader_run_id: runId, ...faultFields(err) },
      "a unit's leader threw outside its own error handling; the unit settles as failed and the stack exists only here",
    );
    try {
      recordWorkflowTrace(deps.bc.trace, WORKFLOW_RUN_FAILED_TRACE_KIND, {
        run_id: runId,
        parent_run_id: deps.ctx.managerRunId,
        status: "error",
        error: { code: "leader_run_failed", message },
      });
    } catch (sinkErr) {
      logger.error(
        {
          event: "workflow.trace_sink_failed",
          leader_run_id: runId,
          kind: WORKFLOW_RUN_FAILED_TRACE_KIND,
          ...faultFields(sinkErr),
        },
        "the trace sink threw while recording this leader's failure, so the durable workflow record is missing that edge",
      );
    }
    finish(settleWith("failed", `'${unit.key}' error: ${message}`));
    return { key: unit.key, status: "failed", result: undefined };
  } finally {
    region?.leave();
    reservation.release();
    deps.ctx.semaphore.release();
  }
}
