import {
  createLoopCalendar,
  sameLoopBinding,
  systemLoopClock,
  type LoopBinding,
  type LoopCalendar,
  type LoopClock,
  type LoopSchedule,
  type LoopTurnCompletion,
  type LoopUsage,
  type ScheduledTurnAdmission,
  type ScheduledTurnRequest,
} from "../../core/loop-schedule.ts";
import { LOOP_PROMPT_MAX_BYTES, type LoopCommand } from "./parser.ts";

/** One bounded in-memory registration, separate from the lifetime of its current run. */
export interface LoopJob {
  readonly id: string;
  readonly prompt: string;
  readonly schedule: LoopSchedule;
  readonly maxRuns: number;
  binding: LoopBinding;
  revision: number;
  state: "scheduled" | "paused" | "completed" | "cancelled";
  pauseReason?: string;
  admittedRuns: number;
  nextDueAt?: number;
  pending?: { occurrenceId: string; scheduledAt: number; eligibleAt: number; order: number };
  active?: {
    occurrenceId: string;
    executionId: string;
    scheduledAt: number;
    admittedAt: number;
    cancellation?: "requested" | "acknowledged" | "failed";
    cancellationError?: string;
  };
  lastResult?: {
    status: LoopTurnCompletion["status"];
    reason?: string;
    completedAt: number;
    executionId: string;
  };
  usage: LoopUsage;
}

/** All run effects remain behind the owning RunHost admission port. */
export interface LoopControllerDeps {
  binding(materialize?: boolean): LoopBinding | null;
  blockedReason(): string | null;
  submit(request: ScheduledTurnRequest): ScheduledTurnAdmission;
  clock?: LoopClock;
  notice?(message: string, job: Readonly<LoopJob>): void;
}

/** Session-scoped controls; no method persists a registration or dispatches slash/shell text. */
export interface LoopController {
  list(): readonly Readonly<LoopJob>[];
  get(id: string): Readonly<LoopJob>;
  create(input: Extract<LoopCommand, { kind: "create" }>): Readonly<LoopJob>;
  pause(id: string): void;
  resume(id: string): Readonly<LoopJob>;
  cancel(id: string, running?: boolean): void;
  invalidateSession(id: string, reason: "switch" | "clear" | "teardown"): void;
  refresh(): void;
  blockedReason(): string | null;
  executionBlockedReason(): string | null;
  setInteractionGate(gate: () => string | null, executionGate?: () => string | null): void;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

interface Registration {
  job: LoopJob;
  calendar?: LoopCalendar;
  dueElapsed?: number;
  lastCronAt?: number;
  cancel?: () => Promise<void>;
}

const MAX_SESSION_JOBS = 10;
const MAX_RESIDENT_JOBS = 100;
const MAX_WAKE_MS = 30_000;

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/**
 * Keep one pending occurrence per job and one admitted automatic turn per host.
 * Human activity blocks admission; elapsed intervals restart only after physical completion.
 */
export function createLoopController(deps: LoopControllerDeps): LoopController {
  const clock = deps.clock ?? systemLoopClock;
  const registrations = new Map<string, Registration>();
  const listeners = new Set<() => void>();
  let interactionGate = (): string | null => "TUI is not ready";
  let executionGate = (): string | null => null;
  let sequence = 0;
  let pendingOrder = 0;
  let activeJob: string | undefined;
  let stopWake: (() => void) | undefined;
  let disposed = false;

  const publish = (): void => {
    for (const listener of listeners) listener();
  };
  const notice = (message: string, job: LoopJob): void => deps.notice?.(message, job);
  const current = (): LoopBinding | null => deps.binding();
  const live = (job: LoopJob): boolean => job.state === "scheduled" || job.state === "paused";
  const requireJob = (id: string): Registration => {
    const registration = registrations.get(id);
    if (!registration || registration.job.binding.sessionId !== current()?.sessionId)
      throw new Error(`No loop ${id} in this conversation. Use /loop list.`);
    return registration;
  };
  const executionBlockedReason = (): string | null => deps.blockedReason() ?? executionGate();
  const blockedReason = (): string | null => executionBlockedReason() ?? interactionGate();

  const suspend = (
    registration: Registration,
    reason: string,
    state: "paused" | "cancelled" = "paused",
  ): void => {
    const job = registration.job;
    if (!live(job)) return;
    job.revision += 1;
    job.state = state;
    job.pauseReason = reason;
    delete job.pending;
    delete job.nextDueAt;
    delete registration.dueElapsed;
    notice(`${job.id} ${state}: ${reason}`, job);
  };

  const arm = (registration: Registration): void => {
    const job = registration.job;
    if (job.schedule.kind === "interval") {
      const at = clock.now() + job.schedule.everyMs;
      const elapsed = clock.elapsed() + job.schedule.everyMs;
      if (
        !Number.isSafeInteger(at) ||
        !Number.isFinite(elapsed) ||
        !Number.isFinite(new Date(at).getTime())
      )
        throw new Error("Interval is too large for the current clock.");
      registration.dueElapsed = elapsed;
      job.nextDueAt = at;
    } else {
      const next = registration.calendar!.next(
        Math.max(clock.now(), registration.lastCronAt ?? -Infinity),
      );
      if (next === null) throw new Error("Cron has no future occurrence.");
      job.nextDueAt = next;
    }
  };

  const scheduleWake = (immediate = false): void => {
    stopWake?.();
    stopWake = undefined;
    if (disposed) return;
    const scheduled = [...registrations.values()].filter(({ job }) => job.state === "scheduled");
    if (scheduled.length === 0) return;
    const remaining = scheduled.map(({ job, dueElapsed }) =>
      dueElapsed !== undefined
        ? dueElapsed - clock.elapsed()
        : (job.nextDueAt ?? Infinity) - clock.now(),
    );
    const delay = immediate ? 0 : Math.max(1, Math.min(MAX_WAKE_MS, ...remaining));
    stopWake = clock.wake(tick, delay);
  };

  const validateBindings = (): void => {
    const binding = current();
    const blocked = executionBlockedReason();
    for (const registration of registrations.values()) {
      const job = registration.job;
      if (job.state !== "scheduled") continue;
      if (!sameLoopBinding(job.binding, binding))
        suspend(
          registration,
          job.binding.sessionId === binding?.sessionId
            ? "Execution configuration or session generation changed; resume explicitly."
            : "Conversation changed; resume explicitly.",
        );
      else if (blocked !== null) suspend(registration, `${blocked}; resume explicitly.`);
    }
  };

  const settle = (
    registration: Registration,
    receipt: Extract<ScheduledTurnAdmission, { status: "admitted" }>,
    result: LoopTurnCompletion,
  ): void => {
    const job = registration.job;
    if (job.active?.executionId !== receipt.executionId) return;
    const reason = result.reason ? errorMessage(result.reason) : undefined;
    job.lastResult = {
      status: result.status,
      ...(reason ? { reason } : {}),
      completedAt: clock.now(),
      executionId: receipt.executionId,
    };
    for (const key of ["input", "output", "costUsd"] as const) {
      const value = result.usage[key];
      const total = job.usage[key];
      if (value === undefined || total === undefined) delete job.usage[key];
      else job.usage[key] = total + value;
    }
    delete job.active;
    delete registration.cancel;
    if (activeJob === job.id) activeJob = undefined;
    if (!disposed && job.state === "scheduled") {
      if (result.status !== "completed")
        suspend(
          registration,
          reason ?? `Run ${result.status}; inspect its result before resuming.`,
        );
      else if (job.admittedRuns >= job.maxRuns) {
        job.state = "completed";
        delete job.nextDueAt;
        delete job.pending;
      } else if (job.schedule.kind === "interval") {
        try {
          arm(registration);
        } catch (error) {
          suspend(registration, errorMessage(error));
        }
      }
    }
    if (!disposed) {
      notice(
        `${job.id} run ${job.admittedRuns}/${job.maxRuns}: ${result.status}${reason ? `: ${reason}` : ""}`,
        job,
      );
      publish();
      scheduleWake(true);
    }
  };

  function tick(): void {
    stopWake = undefined;
    if (disposed) return;
    validateBindings();
    const at = clock.now();
    for (const registration of registrations.values()) {
      const job = registration.job;
      if (job.state !== "scheduled" || job.admittedRuns >= job.maxRuns) continue;
      try {
        let due: number | undefined;
        if (registration.dueElapsed !== undefined) {
          const remaining = registration.dueElapsed - clock.elapsed();
          job.nextDueAt = at + remaining;
          if (remaining <= 0) {
            due = job.nextDueAt;
            delete registration.dueElapsed;
            delete job.nextDueAt;
          }
        } else if (
          job.schedule.kind === "cron" &&
          job.nextDueAt !== undefined &&
          job.nextDueAt <= at
        ) {
          due = registration.calendar!.latest(at) ?? job.nextDueAt;
          const next = registration.calendar!.next(
            Math.max(at, registration.lastCronAt ?? -Infinity),
          );
          if (next === null) {
            suspend(registration, "Cron has no future occurrence.");
            continue;
          }
          job.nextDueAt = next;
          if (due <= (registration.lastCronAt ?? -Infinity)) due = undefined;
          else registration.lastCronAt = due;
        }
        if (due !== undefined) {
          job.pending = {
            occurrenceId: `${job.id}:${job.revision}:${job.schedule.kind === "cron" ? due : job.admittedRuns + 1}`,
            scheduledAt: due,
            eligibleAt: job.pending?.eligibleAt ?? due,
            order: job.pending?.order ?? ++pendingOrder,
          };
        }
      } catch (error) {
        suspend(registration, errorMessage(error));
      }
    }
    if (activeJob === undefined && blockedReason() === null) {
      const eligible = [...registrations.values()]
        .filter(
          ({ job }) =>
            job.state === "scheduled" && job.pending !== undefined && job.active === undefined,
        )
        .sort(
          (left, right) =>
            left.job.pending!.eligibleAt - right.job.pending!.eligibleAt ||
            left.job.pending!.order - right.job.pending!.order,
        );
      const registration = eligible[0];
      if (registration) {
        const job = registration.job;
        const pending = job.pending!;
        const revision = job.revision;
        let receipt: ScheduledTurnAdmission;
        try {
          receipt = deps.submit({
            binding: job.binding,
            prompt: job.prompt,
            occurrenceId: pending.occurrenceId,
            valid: () =>
              !disposed &&
              job.state === "scheduled" &&
              job.revision === revision &&
              sameLoopBinding(job.binding, current()),
          });
        } catch (error) {
          receipt = { status: "refused", reason: errorMessage(error) };
        }
        if (receipt.status === "admitted") {
          job.admittedRuns += 1;
          if (job.admittedRuns >= job.maxRuns) delete job.nextDueAt;
          job.active = {
            occurrenceId: pending.occurrenceId,
            executionId: receipt.executionId,
            scheduledAt: pending.scheduledAt,
            admittedAt: at,
          };
          delete job.pending;
          const admitted = receipt;
          registration.cancel = () => admitted.cancel();
          activeJob = job.id;
          notice(
            `${job.id} occurrence ${job.admittedRuns}/${job.maxRuns} | due ${new Date(pending.scheduledAt).toISOString()} | admitted ${new Date(at).toISOString()} | ${receipt.executionId}`,
            job,
          );
          void admitted.completion.then(
            (result) => settle(registration, admitted, result),
            (error: unknown) =>
              settle(registration, admitted, {
                status: "unknown",
                reason: errorMessage(error),
                usage: {},
              }),
          );
        } else if (receipt.status === "refused") suspend(registration, receipt.reason);
      }
    }
    publish();
    scheduleWake();
  }

  return {
    list: () =>
      [...registrations.values()]
        .map(({ job }) => job)
        .filter((job) => job.binding.sessionId === current()?.sessionId),
    get: (id) => requireJob(id).job,
    create(input) {
      if (disposed) throw new Error("The loop host is closed.");
      if (!Number.isSafeInteger(input.maxRuns) || input.maxRuns < 1)
        throw new Error("--max-runs requires a positive safe integer.");
      if (
        !input.prompt.trim() ||
        new TextEncoder().encode(input.prompt).byteLength > LOOP_PROMPT_MAX_BYTES
      )
        throw new Error("A non-empty prompt of at most 64 KiB is required.");
      if (
        input.schedule.kind === "interval" &&
        (!Number.isSafeInteger(input.schedule.everyMs) ||
          input.schedule.everyMs < 60_000 ||
          input.schedule.everyMs % 60_000 !== 0)
      )
        throw new Error("Use a positive integer duration in m, h or d (minimum 1m).");
      const blocked = executionBlockedReason();
      if (blocked !== null) throw new Error(blocked);
      const binding = deps.binding(true);
      if (!binding) throw new Error("Choose a runnable agent and conversation first.");
      const existing = [...registrations.values()];
      if (
        existing.filter(({ job }) => job.binding.sessionId === binding.sessionId && live(job))
          .length >= MAX_SESSION_JOBS
      )
        throw new Error("At most 10 live loops per conversation; cancel one first.");
      if (registrations.size >= MAX_RESIDENT_JOBS) {
        const retired = existing.find(({ job }) => !live(job) && !job.active);
        if (retired) registrations.delete(retired.job.id);
        else throw new Error("At most 100 loops per TUI; cancel an existing loop first.");
      }
      const registration: Registration = {
        job: {
          id: `loop_${(++sequence).toString(36)}`,
          prompt: input.prompt,
          schedule: { ...input.schedule },
          maxRuns: input.maxRuns,
          binding: { ...binding },
          revision: 1,
          state: "scheduled",
          admittedRuns: 0,
          usage: { input: 0, output: 0, costUsd: 0 },
        },
        ...(input.schedule.kind === "cron"
          ? { calendar: createLoopCalendar(input.schedule.expression, input.schedule.timezone) }
          : {}),
      };
      arm(registration);
      registrations.set(registration.job.id, registration);
      publish();
      scheduleWake();
      return registration.job;
    },
    pause(id) {
      suspend(requireJob(id), "Paused by you.");
      publish();
      scheduleWake();
    },
    resume(id) {
      const registration = requireJob(id);
      if (registration.job.state !== "paused") throw new Error("Only paused loops can be resumed.");
      if (registration.job.active)
        throw new Error("Wait for this loop's active execution to close before resuming.");
      if (registration.job.admittedRuns >= registration.job.maxRuns)
        throw new Error("This loop has reached --max-runs; create a new loop.");
      const blocked = executionBlockedReason();
      if (blocked !== null) throw new Error(blocked);
      const binding = current();
      if (!binding) throw new Error("Conversation is not ready.");
      arm(registration);
      registration.job.binding = binding;
      registration.job.revision += 1;
      registration.job.state = "scheduled";
      delete registration.job.pauseReason;
      publish();
      scheduleWake();
      return registration.job;
    },
    cancel(id, running = false) {
      const registration = requireJob(id);
      const job = registration.job;
      suspend(registration, "Cancelled by you.", "cancelled");
      if (
        running &&
        job.active &&
        registration.cancel &&
        job.active.cancellation !== "requested" &&
        job.active.cancellation !== "acknowledged"
      ) {
        const active = job.active;
        active.cancellation = "requested";
        delete active.cancellationError;
        void Promise.resolve()
          .then(registration.cancel)
          .then(
            () => {
              if (job.active === active) {
                active.cancellation = "acknowledged";
                publish();
              }
            },
            (error: unknown) => {
              if (job.active !== active) return;
              active.cancellation = "failed";
              active.cancellationError = errorMessage(error);
              notice(
                `${job.id} cancellation failed: ${active.cancellationError}; execution is still owned.`,
                job,
              );
              publish();
            },
          );
      }
      publish();
      scheduleWake();
    },
    invalidateSession(id, reason) {
      for (const registration of registrations.values()) {
        if (registration.job.binding.sessionId === id)
          suspend(
            registration,
            reason === "clear"
              ? "Conversation cleared or deleted."
              : "Conversation or connection closed; resume explicitly.",
            reason === "clear" ? "cancelled" : "paused",
          );
      }
      publish();
      scheduleWake();
    },
    refresh() {
      if (!disposed) {
        validateBindings();
        publish();
        scheduleWake(true);
      }
    },
    blockedReason,
    executionBlockedReason,
    setInteractionGate(gate, safetyGate) {
      interactionGate = gate;
      executionGate = safetyGate ?? (() => null);
      scheduleWake(true);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopWake?.();
      stopWake = undefined;
      for (const registration of registrations.values())
        suspend(registration, "TUI closed.", "cancelled");
      registrations.clear();
      listeners.clear();
    },
  };
}
